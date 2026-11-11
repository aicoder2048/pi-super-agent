import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError } from "../src/config-error.ts";
import {
	DEFAULT_LABEL,
	findOnPath,
	installedAgent,
	launchAgentPlist,
	nvmWarning,
	parseLaunchctlPrint,
	parseServiceLabel,
	planInstall,
	planUninstall,
	servicePath,
	statusLines,
	type LaunchAgentInput,
	type LaunchdState,
} from "../src/service/launch-agent.ts";

const darwin = { skip: process.platform !== "darwin" };

const input: LaunchAgentInput = {
	label: DEFAULT_LABEL,
	node: "/opt/homebrew/bin/node",
	repo: "/Users/u/PiSuperAgent",
	home: "/Users/u",
	stateDir: "/Users/u/.pi-super-agent",
};

function plistFile(xml: string): string {
	const file = join(mkdtempSync(join(tmpdir(), "psa-plist-")), "agent.plist");
	writeFileSync(file, xml);
	return file;
}

function plutilJson(xml: string): any {
	return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", plistFile(xml)], { encoding: "utf8" }));
}

test("生成的 plist 过 plutil -lint", darwin, () => {
	const lint = spawnSync("plutil", ["-lint", plistFile(launchAgentPlist(input))], { encoding: "utf8" });
	assert.equal(lint.status, 0, lint.stdout + lint.stderr);
});

test("plist 读回来：node 和入口、仓库目录、PATH 第一项、状态目录、看门狗日志、开机和保活都写对", darwin, () => {
	const plist = plutilJson(launchAgentPlist(input));
	assert.equal(plist.Label, "com.pi-super-agent.watchdog");
	assert.deepEqual(plist.ProgramArguments, ["/opt/homebrew/bin/node", "--import", "./src/pi-runtime.mjs", "src/watchdog/main.ts"]);
	assert.equal(plist.WorkingDirectory, "/Users/u/PiSuperAgent");
	assert.equal(plist.EnvironmentVariables.HOME, "/Users/u");
	assert.equal(plist.EnvironmentVariables.PATH.split(":")[0], "/opt/homebrew/bin");
	assert.equal(plist.EnvironmentVariables.PSA_STATE_DIR, "/Users/u/.pi-super-agent");
	assert.equal(plist.StandardOutPath, "/Users/u/.pi-super-agent/watchdog.log");
	assert.equal(plist.StandardErrorPath, "/Users/u/.pi-super-agent/watchdog.log");
	assert.equal(plist.RunAtLoad, true);
	assert.equal(plist.KeepAlive, true);
});

test("路径里有空格、中文、& 和 < 时 plist 仍然合法，值逐字读回", darwin, () => {
	const odd = { ...input, node: "/Users/我 的/node <22>/bin/node", repo: "/Users/我 的/Pi & 代理", home: "/Users/我 的", stateDir: "/tmp/状态 目录 & <x>" };
	const file = plistFile(launchAgentPlist(odd));
	assert.equal(spawnSync("plutil", ["-lint", file]).status, 0);
	const plist = plutilJson(launchAgentPlist(odd));
	assert.equal(plist.ProgramArguments[0], odd.node);
	assert.equal(plist.WorkingDirectory, odd.repo);
	assert.equal(plist.EnvironmentVariables.HOME, odd.home);
	assert.equal(plist.EnvironmentVariables.PATH.split(":")[0], "/Users/我 的/node <22>/bin");
	assert.equal(plist.EnvironmentVariables.PSA_STATE_DIR, odd.stateDir);
	assert.equal(plist.StandardOutPath, "/tmp/状态 目录 & <x>/watchdog.log");
});

test("同一输入生成的 plist 字节相同，换了 node 就不同", () => {
	assert.equal(launchAgentPlist({ ...input }), launchAgentPlist(input));
	assert.notEqual(launchAgentPlist({ ...input, node: "/usr/local/bin/node" }), launchAgentPlist(input));
});

test("服务的 PATH：node 的目录在最前、不重复，系统目录里有 /bin 给 bash 用", () => {
	const brew = servicePath("/opt/homebrew/bin/node").split(":");
	assert.equal(brew[0], "/opt/homebrew/bin");
	assert.equal(brew.filter((d) => d === "/opt/homebrew/bin").length, 1);
	const nvm = servicePath("/Users/u/.nvm/versions/node/v22.23.4/bin/node").split(":");
	assert.equal(nvm[0], "/Users/u/.nvm/versions/node/v22.23.4/bin");
	assert.ok(nvm.includes("/bin"));
});

test("findOnPath 像 shell 一样取 PATH 里第一个可执行的，保留符号链接，跳过相对路径和不可执行的", () => {
	const dir = mkdtempSync(join(tmpdir(), "psa-path-"));
	for (const d of ["a", "b", "c"]) mkdirSync(join(dir, d));
	writeFileSync(join(dir, "b", "node"), "#!/bin/sh\n");
	chmodSync(join(dir, "b", "node"), 0o755);
	symlinkSync(join(dir, "b", "node"), join(dir, "a", "node"));
	writeFileSync(join(dir, "c", "node"), "not executable");
	const isExecutable = (file: string) => spawnSync("test", ["-x", file]).status === 0;
	assert.equal(findOnPath("node", `${join(dir, "c")}:${join(dir, "a")}:${join(dir, "b")}`, isExecutable), join(dir, "a", "node"));
	assert.equal(findOnPath("node", `relative:${join(dir, "c")}`, () => true), join(dir, "c", "node"));
	assert.equal(findOnPath("node", join(dir, "c"), isExecutable), undefined);
});

const RUNNING = `gui/501/com.pi-super-agent.watchdog = {
	active count = 1
	path = /Users/u/Library/LaunchAgents/com.pi-super-agent.watchdog.plist
	type = LaunchAgent
	state = running

	program = /opt/homebrew/bin/node
	environment = {
		PATH => /opt/homebrew/bin:/usr/bin:/bin
		state = active
	}

	domain = gui/501 [100023]
	runs = 2
	pid = 746
	last exit code = (never exited)

	endpoints = {
		"x" = {
			state = waiting
		}
	}
}
`;
const STOPPED = RUNNING.replace("\tstate = running", "\tstate = not running").replace("\tpid = 746\n", "").replace("(never exited)", "78: EX_CONFIG");

test("parseLaunchctlPrint：已加载在跑、已加载没在跑、退出码 113 未加载、读不懂", () => {
	assert.deepEqual(parseLaunchctlPrint(0, RUNNING), { kind: "running", pid: 746, runs: 2 });
	assert.deepEqual(parseLaunchctlPrint(0, STOPPED), { kind: "stopped", lastExit: "78: EX_CONFIG" });
	const killed = RUNNING.replace("\tstate = running", "\tstate = spawn scheduled").replace("\tpid = 746\n", "\tlast terminating signal = Killed: 9\n");
	assert.deepEqual(parseLaunchctlPrint(0, killed), { kind: "stopped", lastExit: "Killed: 9" });
	assert.deepEqual(parseLaunchctlPrint(113, "Could not find service"), { kind: "not_loaded" });
	assert.equal(parseLaunchctlPrint(0, "gui/501/x = {\n\tpid = 3\n}\n").kind, "unknown");
	assert.deepEqual(parseLaunchctlPrint(5, "Input/output error\nmore"), { kind: "unknown", detail: "Input/output error" });
});

const running: LaunchdState = { kind: "running", pid: 746, runs: 1 };
const stopped: LaunchdState = { kind: "stopped", lastExit: "1" };
const notLoaded: LaunchdState = { kind: "not_loaded" };

test("planInstall：已加载且没变什么也不做；变了先卸再写再加载；没加载时补齐；每种情况执行完再算一次都是空", () => {
	const desired = launchAgentPlist(input);
	const cases: [string | undefined, LaunchdState, string[]][] = [
		[desired, running, []],
		[desired, stopped, []],
		["old", running, ["bootout", "write", "bootstrap"]],
		[desired, notLoaded, ["bootstrap"]],
		["old", notLoaded, ["write", "bootstrap"]],
		[undefined, notLoaded, ["write", "bootstrap"]],
	];
	for (const [onDisk, launchd, steps] of cases) {
		assert.deepEqual(planInstall({ onDisk, desired, launchd }), steps, `${onDisk === desired ? "same" : onDisk ?? "none"} ${launchd.kind}`);
		assert.deepEqual(planInstall({ onDisk: desired, desired, launchd: running }), []);
	}
});

test("planInstall 读不懂 launchd 的状态时拒绝动手", () => {
	assert.throws(() => planInstall({ onDisk: undefined, desired: "x", launchd: { kind: "unknown", detail: "坏了" } }), ConfigError);
});

test("planUninstall：装着时卸载、停宿主、删文件；只剩文件时也停宿主；什么都没有时什么也不做", () => {
	assert.deepEqual(planUninstall({ onDisk: true, launchd: running }), ["bootout", "stop_host", "remove"]);
	assert.deepEqual(planUninstall({ onDisk: true, launchd: notLoaded }), ["stop_host", "remove"]);
	assert.deepEqual(planUninstall({ onDisk: false, launchd: stopped }), ["bootout", "stop_host"]);
	assert.deepEqual(planUninstall({ onDisk: false, launchd: notLoaded }), []);
});

test("node 来自 nvm 时安装提示换版本要重装，Homebrew 的 node 不提示", () => {
	assert.match(nvmWarning("/Users/u/.nvm/versions/node/v22.23.4/bin/node") ?? "", /nvm.*重跑 just service-install/s);
	assert.equal(nvmWarning("/opt/homebrew/bin/node"), undefined);
});

test("installedAgent 从磁盘上的 plist 读回 node、仓库目录和状态目录，缺字段时报错并带上文件名", darwin, () => {
	const json = plutilJson(launchAgentPlist({ ...input, stateDir: "/tmp/psa 状态" }));
	assert.deepEqual(installedAgent(json, "/x.plist"), { node: "/opt/homebrew/bin/node", repo: "/Users/u/PiSuperAgent", stateDir: "/tmp/psa 状态" });
	assert.throws(() => installedAgent({ ...json, ProgramArguments: undefined }, "/x.plist"), (e: Error) => e instanceof ConfigError && e.message.includes("/x.plist"));
});

test("statusLines 分清运行中、已停止、写了没加载、未安装，并报出失效的 node 和心跳", () => {
	const installed = { node: "/opt/homebrew/bin/node", repo: "/r", stateDir: "/s" };
	const base = { label: DEFAULT_LABEL, plistFile: "/p.plist", installed, launchd: running, nodeExists: true, heartbeat: { pid: 4300, at: 88_000 }, now: 100_000 };
	const first = (over: object) => statusLines({ ...base, ...over })[0];
	assert.match(first({}), /运行中.*746/);
	assert.match(first({ launchd: stopped }), /已停止.*1/);
	assert.match(first({ launchd: notLoaded }), /没有加载/);
	assert.match(first({ launchd: notLoaded, installed: undefined, heartbeat: undefined }), /未安装/);
	assert.match(first({ launchd: { kind: "unknown", detail: "怪输出" } }), /怪输出/);
	assert.match(statusLines(base).join("\n"), /12 秒前.*4300/);
	assert.match(statusLines({ ...base, nodeExists: false }).join("\n"), /重跑 just service-install/);
});

test("parseServiceLabel：空值用默认 label，带斜杠、空格、以横线开头的拒绝", () => {
	assert.equal(parseServiceLabel(undefined), DEFAULT_LABEL);
	assert.equal(parseServiceLabel(""), DEFAULT_LABEL);
	assert.equal(parseServiceLabel("com.pi-super-agent.lane3"), "com.pi-super-agent.lane3");
	for (const bad of ["a/b", " x", "-x", "a b"]) assert.throws(() => parseServiceLabel(bad), ConfigError, bad);
});
