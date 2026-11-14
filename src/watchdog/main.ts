import { spawn } from "node:child_process";
import { fchmodSync, fstatSync, openSync, readFileSync } from "node:fs";
import { HOST_ENTRY, hostPid } from "../heartbeat.ts";
import { constants } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type HostConfig } from "../host/config.ts";
import { exitOnConfigError } from "../config-error.ts";
import { telegramOptions } from "../host/telegram/options.ts";
import { Phone } from "./phone.ts";
import { errorLine, Watchdog } from "./watchdog.ts";

let config: HostConfig;
try {
	config = loadConfig();
} catch (error) {
	exitOnConfigError(error);
}
const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);
const repo = fileURLToPath(new URL("../..", import.meta.url));
const intervalMs = config.watchdog.intervalMinutes * 60_000;
const HOST_STOP_MS = 15_000;

function killHungHost(): void {
	const pid = hostPid(config.stateDir);
	if (!pid) return;
	process.kill(pid, "SIGKILL");
	log(`[watchdog] 已结束没有心跳的宿主进程 ${pid}`);
}

// The host prints its web token URL, so the log is as private as the web-token file.
function openHostLog(): number {
	const fd = openSync(join(config.stateDir, "host.log"), "a", 0o600);
	if (fstatSync(fd).mode & 0o077) fchmodSync(fd, 0o600);
	return fd;
}

// A Watchdog that cannot reach the phone must still restart the host, so a bad Telegram setup is logged, not fatal.
function phone(): Phone | undefined {
	try {
		const telegram = telegramOptions(config, process.env, log);
		return telegram && new Phone({ api: telegram.api, chats: [...telegram.allowedUserIds], log });
	} catch (error) {
		log(`[watchdog] 宿主停了没法发到 Telegram：${(error as Error).message}`);
		return undefined;
	}
}

let logOffsetAtStart = 0;

// The host's log since the latest start: a host that cannot start writes little, so reading it whole is cheap.
function lastHostError(): string | undefined {
	try {
		return errorLine(readFileSync(join(config.stateDir, "host.log")).subarray(logOffsetAtStart).toString("utf8"));
	} catch {
		return undefined;
	}
}

// Only the host this watchdog launched; a host the user started elsewhere keeps running on Ctrl+C.
let launched: { pid: number; exited: Promise<void> } | undefined;

function startHost(): void {
	killHungHost();
	const out = openHostLog();
	logOffsetAtStart = fstatSync(out).size;
	const child = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", HOST_ENTRY], {
		cwd: repo,
		env: { ...process.env, PSA_STATE_DIR: config.stateDir },
		detached: true,
		stdio: ["ignore", out, out],
	});
	child.unref();
	const exited = new Promise<void>((r) => child.once("exit", () => r()));
	const pid = child.pid!;
	launched = { pid, exited };
	void exited.then(() => launched?.pid === pid && (launched = undefined));
	log(`[watchdog] 已拉起宿主，pid ${child.pid}，日志 ${join(config.stateDir, "host.log")}`);
}

const toPhone = phone();
const watchdog = new Watchdog({
	stateDir: config.stateDir,
	clock: { now: () => Date.now() },
	config: {
		heartbeatStaleMs: config.watchdog.staleSeconds * 1000,
		restartGraceMs: Math.max(intervalMs, Number(process.env.PSA_RESTART_GRACE_MS ?? 60_000)),
	},
	kernel: config.kernel,
	startHost,
	log,
	tell: toPhone && ((text, silent) => toPhone.tell(text, silent)),
	lastError: lastHostError,
});

let checks: NodeJS.Timeout | undefined;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		if (stopping) {
			log(`[watchdog] 再次收到 ${signal}，立即退出`);
			process.exit(128 + constants.signals[signal]);
		}
		stopping = true;
		clearInterval(checks);
		const host = launched;
		log(`[watchdog] 收到 ${signal}，正在停止${host ? `宿主 ${host.pid}` : ""}`);
		if (host) {
			process.kill(host.pid, "SIGTERM");
			const timedOut = await Promise.race([host.exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), HOST_STOP_MS))]);
			if (timedOut) {
				log(`[watchdog] 宿主 ${host.pid} 在 ${HOST_STOP_MS / 1000} 秒内没有停下，不再等它；Watchdog 退出`);
				process.exit(1);
			}
		}
		log("[watchdog] 已停止");
		process.exit(0);
	});
}

log(`[watchdog] 已启动，每 ${config.watchdog.intervalMinutes} 分钟检查一次，状态目录 ${config.stateDir}`);
watchdog.checkOnce();
checks = setInterval(() => watchdog.checkOnce(), intervalMs);
