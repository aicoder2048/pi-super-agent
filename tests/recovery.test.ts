import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Host } from "../src/host/host.ts";
import { defaultWorkerModels, FakeSpawner, fauxRouter, ids, tempStateDir, until, type Brain, type WorkerScript } from "./helpers/fakes.ts";

const titles = ["执行中", "空闲", "等回答", "受阻"];
const brain: Brain = (cards) =>
	cards.flatMap((card) => card.startsWith("[对话]") && card.includes("开四个")
		? [{ name: "route", args: { decisions: titles.map((title) => ({ kind: "open_ticket", basis: "request", triggerId: ids(card, "trg"), title, brief: title })) } }]
		: []);

const firstRun: WorkerScript = (w, input) => {
	if (input.includes("执行中")) return;
	if (input.includes("等回答")) w.report({ status: "progress", summary: "需要确认", question: "用 A 还是 B？" });
	else if (input.includes("受阻")) w.report({ status: "blocked", summary: "缺少权限" });
	else w.report({ status: "progress", summary: "做了一半" });
	w.settle();
};

async function start(stateDir: string, script: WorkerScript, extra = {}) {
	const spawner = new FakeSpawner(script);
	const host = await Host.start({ stateDir, createRouter: fauxRouter(brain).createRouter, createSpawner: () => spawner, log: () => {}, workerModels: defaultWorkerModels(), config: { maxWorkers: 4 }, ...extra });
	spawner.request = (...a) => host.workers.handleRequest(...a);
	return { host, spawner };
}

test("重启恢复：执行中的任务带恢复说明重新拉起，空闲、等回答、受阻的任务保持原状", async (t) => {
	const stateDir = tempStateDir();
	const first = await start(stateDir, firstRun);
	first.host.say("开四个任务");
	const stageOf = (h: Host, title: string) => h.kernel.listTickets().find((r) => r.title === title)?.stage;
	await until(() => stageOf(first.host, "执行中") === "running" && stageOf(first.host, "空闲") === "idle"
		&& stageOf(first.host, "等回答") === "awaiting_answer" && stageOf(first.host, "受阻") === "blocked_or_failed", "四种状态就位");
	const firstResume = [...first.spawner.workers.values()].map((w) => w.spec.resume);
	await first.host.stop();
	assert.deepEqual(firstResume, [false, false, false, false], "新任务第一次拉起不算恢复会话");

	const second = await start(stateDir, (w) => { w.report({ status: "ready", summary: "恢复后完成" }); w.settle(); });
	t.after(() => second.host.stop());
	const runningId = second.host.kernel.listTickets().find((r) => r.title === "执行中")!.id;
	await until(() => second.spawner.workers.get(runningId)?.inputs.length === 1, "执行中的任务被重新拉起");
	assert.match(second.spawner.workers.get(runningId)!.inputs[0], /恢复说明/);
	assert.equal(second.spawner.workers.get(runningId)!.spec.resume, true, "重启后拉起已经起过的任务算恢复会话");
	await second.host.settled();
	assert.deepEqual(second.spawner.spawned, [runningId]);
	assert.equal(stageOf(second.host, "空闲"), "idle");
	assert.equal(stageOf(second.host, "等回答"), "awaiting_answer");
	assert.equal(stageOf(second.host, "受阻"), "blocked_or_failed");
});

test("宿主定时写心跳文件，Watchdog 据此判断它是否在响应", async (t) => {
	const stateDir = tempStateDir();
	const { host } = await start(stateDir, () => {}, { heartbeatMs: 20 });
	t.after(() => host.stop());
	const file = join(stateDir, "heartbeat.json");
	await until(() => existsSync(file), "心跳文件");
	const first = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(first.pid, process.pid);
	await until(() => JSON.parse(readFileSync(file, "utf8")).at > first.at, "心跳更新");
});
