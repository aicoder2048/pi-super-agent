import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, exitOnConfigError } from "../config-error.ts";
import { hostPid, liveHeartbeat, writeFileAtomic } from "../heartbeat.ts";
import { defaultStateDir, loadConfig } from "../host/config.ts";
import * as agent from "./launch-agent.ts";

const PI_CLI = "@earendil-works/pi-coding-agent/dist/cli.js";
// Longer than launchd's exit timeout, after which it SIGKILLs the watchdog.
const BOOTOUT_WAIT_MS = 25_000;
const HOST_STOP_MS = 15_000;
const BOOTSTRAP_NEEDS_GUI = 125;

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const uid = process.getuid!();

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function isExecutable(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function launchctl(args: string[]): { code: number; output: string } {
	const run = spawnSync("launchctl", args, { encoding: "utf8" });
	return { code: run.status ?? 1, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

const launchctlPrint = (label: agent.ServiceLabel) => launchctl(["print", `gui/${uid}/${label}`]);

function launchdState(label: agent.ServiceLabel): agent.LaunchdState {
	const { code, output } = launchctlPrint(label);
	return agent.parseLaunchctlPrint(code, output);
}

function installedOnDisk(plistFile: string): agent.InstalledAgent {
	const json = spawnSync("plutil", ["-convert", "json", "-o", "-", plistFile], { encoding: "utf8" });
	if (json.status !== 0) throw new ConfigError(`${plistFile} 读不出来：${json.stderr.trim()}，重跑 just service-install`);
	return agent.installedAgent(JSON.parse(json.stdout), plistFile);
}

/** Runs `npm root -g` under the plist's env alone, so a node that cannot find Pi under launchd fails here instead of looping under KeepAlive. */
function preflight(input: agent.LaunchAgentInput): string {
	loadConfig(input.stateDir);
	const env = agent.serviceEnvironment(input);
	const npm = spawnSync("npm", ["root", "-g"], { cwd: input.repo, env, encoding: "utf8" });
	const cli = npm.status === 0 ? join(npm.stdout.trim(), PI_CLI) : undefined;
	if (!cli || !existsSync(cli)) {
		throw new ConfigError(`用服务的环境（PATH=${env.PATH}）跑 npm root -g 找不到 Pi（${cli ?? npm.stderr.trim()}）。先用这个 node 全局安装 Pi，再重跑 just service-install`);
	}
	const bash = agent.findOnPath("bash", env.PATH, isExecutable);
	if (!bash) throw new ConfigError(`服务的 PATH（${env.PATH}）里找不到 bash，成员要用它`);
	const passed = `[service] 预检通过：node ${input.node}，npm root -g 找到 Pi，bash ${bash}${input.just ? `，just ${input.just}` : ""}，config.json 能加载`;
	return input.just ? passed : `${passed}\n[service] PATH 里找不到 just：module-builder 的专家队跑不了 just module new/check/try。装上 just 或把它的目录加进 PATH，再重跑 just service-install`;
}

function bootout(label: agent.ServiceLabel): void {
	launchctl(["bootout", `gui/${uid}/${label}`]);
	const deadline = Date.now() + BOOTOUT_WAIT_MS;
	while (launchdState(label).kind !== "not_loaded") {
		if (Date.now() > deadline) throw new ConfigError(`${label} 在 ${BOOTOUT_WAIT_MS / 1000} 秒内没有从 launchd 卸下`);
		sleep(200);
	}
}

function install(label: agent.ServiceLabel): void {
	if (uid === 0) throw new ConfigError("不要用 sudo 运行：LaunchAgent 装在你自己的账户下");
	const findTool = (name: string) => agent.findOnPath(name, process.env.PATH ?? "", isExecutable);
	const node = findTool("node");
	if (!node) throw new ConfigError("PATH 里找不到 node");
	if (!isExecutable(join(dirname(node), "npm"))) throw new ConfigError(`${dirname(node)} 里没有 npm：服务用 node 旁边的 npm 找全局安装的 Pi`);
	const input: agent.LaunchAgentInput = { label, node, repo, home: homedir(), stateDir: defaultStateDir(), just: findTool("just"), uv: findTool("uv") };
	const plistFile = agent.plistPath(input.home, label);
	console.log(preflight(input));
	const desired = agent.launchAgentPlist(input);
	const onDisk = existsSync(plistFile) ? readFileSync(plistFile, "utf8") : undefined;
	const steps = agent.planInstall({ onDisk, desired, launchd: launchdState(label) });
	if (steps.length === 0) {
		console.log(`[service] ${label} 已安装且没有变化，什么也没做`);
		return;
	}
	for (const step of steps) {
		if (step === "bootout") bootout(label);
		if (step === "write") {
			mkdirSync(dirname(plistFile), { recursive: true });
			writeFileAtomic(plistFile, desired);
		}
		if (step === "bootstrap") {
			const { code, output } = launchctl(["bootstrap", `gui/${uid}`, plistFile]);
			if (code === BOOTSTRAP_NEEDS_GUI) throw new ConfigError(`launchctl bootstrap 需要这台 Mac 的图形界面已登录（gui/${uid}）：${output.trim()}`);
			if (code !== 0) throw new ConfigError(`launchctl bootstrap 失败（退出码 ${code}）：${output.trim()}`);
		}
	}
	console.log(`[service] 已安装 ${label}：${plistFile}`);
	console.log(`[service] 看门狗日志 ${agent.watchdogLogPath(input.stateDir)}，宿主日志 ${join(input.stateDir, "host.log")}`);
	const warning = agent.nvmWarning(node);
	if (warning) console.log(warning);
}

function stopHost(stateDir: string): void {
	const pid = hostPid(stateDir);
	if (!pid) return;
	process.kill(pid, "SIGTERM");
	const deadline = Date.now() + HOST_STOP_MS;
	while (alive(pid) && Date.now() < deadline) sleep(200);
	if (alive(pid)) process.kill(pid, "SIGKILL");
	console.log(`[service] 已停止宿主 ${pid}`);
}

function uninstall(label: agent.ServiceLabel): void {
	const plistFile = agent.plistPath(homedir(), label);
	const onDisk = existsSync(plistFile);
	const print = launchctlPrint(label);
	const steps = agent.planUninstall({ onDisk, launchd: agent.parseLaunchctlPrint(print.code, print.output) });
	if (steps.length === 0) {
		console.log(`[service] ${label} 没有安装，什么也没做`);
		return;
	}
	const stateDir = onDisk ? installedOnDisk(plistFile).stateDir : agent.jobStateDir(print.output);
	for (const step of steps) {
		if (step === "bootout") bootout(label);
		if (step === "stop_host" && stateDir) stopHost(stateDir);
		if (step === "stop_host" && !stateDir) console.log(`[service] plist 已不在，launchd 里也读不出 ${label} 的 PSA_STATE_DIR，没有停宿主；它若还在跑，请自己停掉`);
		if (step === "remove") rmSync(plistFile, { force: true });
	}
	console.log(`[service] 已停止并移除 ${label}`);
}

function status(label: agent.ServiceLabel): void {
	const plistFile = agent.plistPath(homedir(), label);
	const installed = existsSync(plistFile) ? installedOnDisk(plistFile) : undefined;
	const lines = agent.statusLines({
		label,
		plistFile,
		installed,
		launchd: launchdState(label),
		nodeExists: installed ? isExecutable(installed.node) : true,
		heartbeat: installed && liveHeartbeat(installed.stateDir),
		now: Date.now(),
	});
	console.log(lines.join("\n"));
}

const commands = { install, uninstall, status };
const command = process.argv[2];
if (!(command in commands)) {
	console.error("用法：node --import ./src/pi-runtime.mjs src/service/cli.ts install|uninstall|status");
	process.exit(2);
}
try {
	commands[command as keyof typeof commands](agent.parseServiceLabel(process.env.PSA_SERVICE_LABEL));
} catch (error) {
	exitOnConfigError(error);
}
