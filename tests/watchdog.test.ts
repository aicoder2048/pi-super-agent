import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Kernel } from "../src/kernel/kernel.ts";
import { openStore } from "../src/kernel/store.ts";
import { CONVERSATION_THREAD_ID } from "../src/kernel/types.ts";
import { checkWatchdog, Watchdog } from "../src/watchdog/watchdog.ts";
import { hostPid } from "../src/heartbeat.ts";
import { until } from "./helpers/fakes.ts";

const MIN = 60_000;
const config = { heartbeatStaleMs: 2 * MIN, restartGraceMs: 3 * MIN };
const base = { now: 100 * MIN, heartbeatAt: 99 * MIN, tickets: [], problems: [] };

test("心跳新鲜、没有卡住的任务和系统问题时，什么也不做", () => {
	assert.deepEqual(checkWatchdog(base, config), { restartHost: false, notices: [] });
});

test("宿主没有心跳或心跳过期时要求重启", () => {
	assert.equal(checkWatchdog({ ...base, heartbeatAt: undefined }, config).restartHost, true);
	assert.equal(checkWatchdog({ ...base, heartbeatAt: 97 * MIN }, config).restartHost, true);
	assert.equal(checkWatchdog({ ...base, heartbeatAt: 98.5 * MIN }, config).restartHost, false);
});

test("看板行标着久无进展的任务发一条通知，同一段停滞只对应一个触发 id", () => {
	const stuck = { id: "tkt_a", name: "tkt_a「跑回归」", stall: { since: 60 * MIN, minutes: 40 } };
	const fresh = { id: "tkt_b", name: "tkt_b「刚开始」", stall: null };
	const { notices } = checkWatchdog({ ...base, tickets: [stuck, fresh] }, config);
	assert.equal(notices.length, 1);
	assert.match(notices[0].body, /跑回归.*40 分钟没有进展/);
	const later = checkWatchdog({ ...base, now: 110 * MIN, heartbeatAt: 109 * MIN, tickets: [{ ...stuck, stall: { since: 60 * MIN, minutes: 50 } }] }, config);
	assert.equal(later.notices[0].id, notices[0].id);
});

test("连续失败的待执行动作作为系统问题通知", () => {
	const { notices } = checkWatchdog({ ...base, problems: [{ kind: "channel.reply", lastError: "socket closed", since: 95 * MIN }] }, config);
	assert.equal(notices.length, 1);
	assert.match(notices[0].body, /channel\.reply.*socket closed/);
});

test("同一段系统问题只通知一次（Watchdog 重启也不重复），该类动作成功过后再失败才算新的一段", () => {
	const now = { t: 1_000 * MIN };
	const clock = { now: () => now.t };
	const stateDir = mkdtempSync(join(tmpdir(), "psa-wd-"));
	const kernel = new Kernel({ db: openStore(join(stateDir, "state.db")), clock, sourcePolicy: () => "candidate" });
	const newWatchdog = () => new Watchdog({ stateDir, clock, config: { ...config, heartbeatStaleMs: Number.MAX_SAFE_INTEGER }, startHost: () => {} });
	const problemIds = () => new Set(readdirSync(join(stateDir, "inbox")).filter((f) => f.endsWith(".json"))
		.map((f) => JSON.parse(readFileSync(join(stateDir, "inbox", f), "utf8")).id as string)
		.filter((id) => id.startsWith("problem:")));
	const failFor = (minutes: number, wd: Watchdog) => {
		for (let m = 0; m < minutes; m += 3) {
			for (const a of kernel.dueActions()) if (a.kind === "channel.reply") kernel.failAction(a.id, "channel down");
			wd.checkOnce();
			now.t += 3 * MIN;
		}
	};
	writeFileSync(join(stateDir, "heartbeat.json"), JSON.stringify({ pid: 1, at: now.t }));
	const said = (body: string) => kernel.submitTrigger({ source: "conversation", externalId: body, threads: [{ id: CONVERSATION_THREAD_ID }], sender: "user", body, occurredAt: now.t }).triggerId;
	kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "第一段", cause: said("一") });
	failFor(60, newWatchdog());
	failFor(60, newWatchdog());
	assert.equal(problemIds().size, 1);
	kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "送达成功", cause: said("二") });
	for (const a of kernel.dueActions()) kernel.completeAction(a.id);
	const wd = newWatchdog();
	wd.checkOnce();
	kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "第二段", cause: said("三") });
	failFor(60, wd);
	assert.equal(problemIds().size, 2);
});

function stateWithStuckTicket(now: { t: number }) {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-wd-"));
	const kernel = new Kernel({ db: openStore(join(stateDir, "state.db")), clock: { now: () => now.t }, sourcePolicy: () => "candidate" });
	const { triggerId } = kernel.submitTrigger({ source: "conversation", externalId: "u", threads: [{ id: CONVERSATION_THREAD_ID }], sender: "user", body: "跑回归", occurredAt: now.t });
	const [opened] = kernel.route([{ kind: "open_ticket", basis: "request", triggerId, title: "跑回归", brief: "跑" }]);
	kernel.claimSlot((opened as { ticketId: string }).ticketId);
	return stateDir;
}

test("Watchdog 一次检查：心跳过期就拉起宿主，卡住的任务投递到通用来源，宽限期内不重复拉起", () => {
	const now = { t: 0 };
	const stateDir = stateWithStuckTicket(now);
	writeFileSync(join(stateDir, "heartbeat.json"), JSON.stringify({ pid: 1, at: 0 }));
	now.t = 31 * MIN;
	let restarts = 0;
	const wd = new Watchdog({ stateDir, clock: { now: () => now.t }, config, startHost: () => { restarts++; } });
	wd.checkOnce();
	assert.equal(restarts, 1);
	const drops = readdirSync(join(stateDir, "inbox")).filter((f) => f.endsWith(".json"));
	assert.equal(drops.length, 1);
	const drop = JSON.parse(readFileSync(join(stateDir, "inbox", drops[0]), "utf8"));
	assert.equal(drop.source, "watchdog");
	assert.match(drop.body, /跑回归/);
	now.t += 1 * MIN;
	wd.checkOnce();
	assert.equal(restarts, 1);
	now.t += 3 * MIN;
	wd.checkOnce();
	assert.equal(restarts, 2);
});

test("Watchdog 用内核配置里的阈值判断久无进展：阈值 10 分钟时，11 分钟没有进展就通知", () => {
	const now = { t: 0 };
	const stateDir = stateWithStuckTicket(now);
	writeFileSync(join(stateDir, "heartbeat.json"), JSON.stringify({ pid: 1, at: 11 * MIN }));
	const wd = new Watchdog({ stateDir, clock: { now: () => now.t }, config, kernel: { stuckMs: 10 * MIN }, startHost: () => {} });
	now.t = 9 * MIN;
	wd.checkOnce();
	assert.equal(existsSync(join(stateDir, "inbox")), false, "9 分钟还不算");
	now.t = 11 * MIN;
	wd.checkOnce();
	const drops = readdirSync(join(stateDir, "inbox")).filter((f) => f.endsWith(".json"));
	assert.equal(drops.length, 1);
	assert.match(JSON.parse(readFileSync(join(stateDir, "inbox", drops[0]), "utf8")).body, /跑回归.*11 分钟/);
});

function freshHeartbeatWatchdog(pid: number) {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-wd-"));
	writeFileSync(join(stateDir, "heartbeat.json"), JSON.stringify({ pid, at: Date.now() }));
	const started = { count: 0 };
	const wd = new Watchdog({ stateDir, clock: { now: () => Date.now() }, config, startHost: () => { started.count++; } });
	return { stateDir, wd, started };
}

test("心跳还新鲜但记录的宿主已经退出（比如刚被正常停下）时，第一次检查就拉起宿主", async () => {
	const gone = spawn(process.execPath, ["-e", "", "src/host/main.ts"], { stdio: "ignore" });
	await once(gone, "exit");
	const { wd, started } = freshHeartbeatWatchdog(gone.pid!);
	wd.checkOnce();
	assert.equal(started.count, 1);
});

test("心跳新鲜且记录的 pid 是活着的宿主时，不拉起", async (t) => {
	const host = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "src/host/main.ts"], { stdio: "ignore" });
	t.after(() => host.kill("SIGKILL"));
	const { stateDir, wd, started } = freshHeartbeatWatchdog(host.pid!);
	await until(() => hostPid(stateDir) === host.pid, "宿主进程被认出", 5000);
	wd.checkOnce();
	assert.equal(started.count, 0);
});
