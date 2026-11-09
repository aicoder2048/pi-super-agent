import { execFileSync, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { readHeartbeat } from "../heartbeat.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type HostConfig } from "../host/config.ts";
import { exitOnStartupError } from "../host/startup-error.ts";
import { Watchdog } from "./watchdog.ts";

let config: HostConfig;
try {
	config = loadConfig();
} catch (error) {
	exitOnStartupError(error);
}
const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);
const repo = fileURLToPath(new URL("../..", import.meta.url));
const intervalMs = config.watchdog.intervalMinutes * 60_000;
const HOST_ENTRY = "src/host/main.ts";

function commandOf(pid: number): string | undefined {
	try {
		return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

// The pid in heartbeat.json may have been reused by an unrelated process since the host died.
function killHungHost(): void {
	const pid = readHeartbeat(config.stateDir)?.pid;
	if (!pid || pid === process.pid || !commandOf(pid)?.includes(HOST_ENTRY)) return;
	process.kill(pid, "SIGKILL");
	log(`[watchdog] 已结束没有心跳的宿主进程 ${pid}`);
}

function startHost(): void {
	killHungHost();
	const out = openSync(join(config.stateDir, "host.log"), "a");
	const child = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", HOST_ENTRY], {
		cwd: repo,
		env: { ...process.env, PSA_STATE_DIR: config.stateDir },
		detached: true,
		stdio: ["ignore", out, out],
	});
	child.unref();
	log(`[watchdog] 已拉起宿主，pid ${child.pid}，日志 ${join(config.stateDir, "host.log")}`);
}

const watchdog = new Watchdog({
	stateDir: config.stateDir,
	clock: { now: () => Date.now() },
	config: {
		heartbeatStaleMs: config.watchdog.staleSeconds * 1000,
		stuckMs: config.watchdog.stuckMinutes * 60_000,
		restartGraceMs: Math.max(intervalMs, Number(process.env.PSA_RESTART_GRACE_MS ?? 60_000)),
	},
	startHost,
	log,
});

log(`[watchdog] 已启动，每 ${config.watchdog.intervalMinutes} 分钟检查一次，状态目录 ${config.stateDir}`);
watchdog.checkOnce();
setInterval(() => watchdog.checkOnce(), intervalMs);
