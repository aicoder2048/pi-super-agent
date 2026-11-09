import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Kernel } from "../src/kernel/kernel.ts";
import { openStore } from "../src/kernel/store.ts";
import { CONVERSATION_THREAD_ID } from "../src/kernel/types.ts";
import { checkWatchdog, Watchdog } from "../src/watchdog/watchdog.ts";

const MIN = 60_000;
const config = { heartbeatStaleMs: 2 * MIN, stuckMs: 30 * MIN, restartGraceMs: 3 * MIN };
const base = { now: 100 * MIN, heartbeatAt: 99 * MIN, tickets: [], problems: [] };

test("心跳新鲜、没有卡住的任务和系统问题时，什么也不做", () => {
	assert.deepEqual(checkWatchdog(base, config), { restartHost: false, notices: [] });
});

test("宿主没有心跳或心跳过期时要求重启", () => {
	assert.equal(checkWatchdog({ ...base, heartbeatAt: undefined }, config).restartHost, true);
	assert.equal(checkWatchdog({ ...base, heartbeatAt: 97 * MIN }, config).restartHost, true);
	assert.equal(checkWatchdog({ ...base, heartbeatAt: 98.5 * MIN }, config).restartHost, false);
});

test("执行中的任务 30 分钟没有进展时发一条通知，同一段停滞只对应一个触发 id", () => {
	const stuck = { id: "tkt_a", title: "跑回归", stage: "running" as const, lastProgressAt: 60 * MIN };
	const fresh = { id: "tkt_b", title: "刚开始", stage: "running" as const, lastProgressAt: 90 * MIN };
	const idle = { id: "tkt_c", title: "空闲", stage: "idle" as const, lastProgressAt: 10 * MIN };
	const { notices } = checkWatchdog({ ...base, tickets: [stuck, fresh, idle] }, config);
	assert.equal(notices.length, 1);
	assert.match(notices[0].body, /跑回归.*40 分钟没有进展/);
	const later = checkWatchdog({ ...base, now: 110 * MIN, heartbeatAt: 109 * MIN, tickets: [stuck] }, config);
	assert.equal(later.notices[0].id, notices[0].id);
});

test("连续失败的待执行动作作为系统问题通知", () => {
	const { notices } = checkWatchdog({ ...base, problems: [{ kind: "channel.reply", lastError: "socket closed", since: 95 * MIN }] }, config);
	assert.equal(notices.length, 1);
	assert.match(notices[0].body, /channel\.reply.*socket closed/);
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
