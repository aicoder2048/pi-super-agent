import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { until } from "./helpers/fakes.ts";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function stateDir() {
	const dir = mkdtempSync(join(tmpdir(), "psa-wdmain-"));
	writeFileSync(join(dir, "config.json"), JSON.stringify({ heartbeatSeconds: 0.1, watchdog: { intervalMinutes: 0.005, staleSeconds: 0.5 }, webPort: 0 }));
	return dir;
}

function startWatchdog(dir: string): ChildProcess {
	return spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/watchdog/main.ts"], {
		env: { ...process.env, PSA_STATE_DIR: dir },
		stdio: "ignore",
	});
}

const heartbeatPid = (dir: string) => {
	const file = join(dir, "heartbeat.json");
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid : undefined;
};

function cleanup(dir: string, ...procs: (ChildProcess | number | undefined)[]) {
	return () => {
		for (const p of [...procs, heartbeatPid(dir)]) {
			const pid = typeof p === "number" ? p : p?.pid;
			if (pid && alive(pid)) process.kill(pid, "SIGKILL");
		}
	};
}

test("没有心跳时，Watchdog 拉起宿主，宿主开始写心跳", async (t) => {
	const dir = stateDir();
	const wd = startWatchdog(dir);
	t.after(cleanup(dir, wd));
	await until(() => { const pid = heartbeatPid(dir); return !!pid && pid !== wd.pid && alive(pid); }, "宿主写出心跳", 15000);
});

test("心跳过期且记录的 pid 不是宿主进程时，不杀它，仍然拉起宿主", async (t) => {
	const dir = stateDir();
	const bystander = spawn("sleep", ["60"], { stdio: "ignore" });
	writeFileSync(join(dir, "heartbeat.json"), JSON.stringify({ pid: bystander.pid, at: 0 }));
	const wd = startWatchdog(dir);
	t.after(cleanup(dir, wd, bystander));
	await until(() => { const pid = heartbeatPid(dir); return !!pid && pid !== bystander.pid && alive(pid); }, "新宿主写出心跳", 15000);
	assert.ok(alive(bystander.pid!), "无关进程不能被杀");
});

test("心跳过期且记录的 pid 是卡住的宿主时，先杀掉再拉起新的", async (t) => {
	const dir = stateDir();
	const hung = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "src/host/main.ts"], { stdio: "ignore" });
	writeFileSync(join(dir, "heartbeat.json"), JSON.stringify({ pid: hung.pid, at: 0 }));
	const wd = startWatchdog(dir);
	t.after(cleanup(dir, wd, hung));
	await until(() => !alive(hung.pid!), "卡住的宿主被杀", 15000);
	await until(() => { const pid = heartbeatPid(dir); return !!pid && pid !== hung.pid && alive(pid); }, "新宿主写出心跳", 15000);
});

test("宿主日志 host.log 带着网页 token，Watchdog 新建它时就是 0600", async (t) => {
	const dir = stateDir();
	const wd = startWatchdog(dir);
	t.after(cleanup(dir, wd));
	const log = join(dir, "host.log");
	await until(() => existsSync(log) && readFileSync(log, "utf8").includes("token="), "host.log 里有网页网址", 15000);
	assert.equal(statSync(log).mode & 0o777, 0o600);
});

test("已有的 host.log 权限比 0600 宽时，Watchdog 拉起宿主前收紧到 0600", async (t) => {
	const dir = stateDir();
	const log = join(dir, "host.log");
	writeFileSync(log, "旧日志\n", { mode: 0o644 });
	const wd = startWatchdog(dir);
	t.after(cleanup(dir, wd));
	await until(() => readFileSync(log, "utf8").includes("token="), "host.log 里有网页网址", 15000);
	assert.equal(statSync(log).mode & 0o777, 0o600);
});

test("终端 Ctrl+C：Watchdog 先停掉它拉起的宿主，再打印「已停止」并以 0 退出", async (t) => {
	const dir = stateDir();
	const wd = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/watchdog/main.ts"], {
		env: { ...process.env, PSA_STATE_DIR: dir },
		stdio: ["ignore", "ignore", "pipe"],
		detached: true,
	});
	t.after(cleanup(dir, wd));
	const exited = new Promise<number | null>((r) => wd.on("exit", (code) => r(code)));
	let stderr = "";
	wd.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
	await until(() => { const pid = heartbeatPid(dir); return !!pid && pid !== wd.pid && alive(pid); }, "宿主写出心跳", 15000);
	const hostPid = heartbeatPid(dir)!;
	process.kill(-wd.pid!, "SIGINT");
	assert.equal(await exited, 0, stderr);
	assert.match(stderr, /\[watchdog\] 已停止/);
	assert.ok(!alive(hostPid), "宿主应已停止");
});
