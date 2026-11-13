import assert from "node:assert/strict";
import test from "node:test";
import { Host } from "../src/host/host.ts";
import type { Router } from "../src/host/router.ts";
import { defaultWorkerModels, FakeSpawner, fauxRouter, openOnConversation, tempStateDir, until, type Brain } from "./helpers/fakes.ts";

const opensTickets: Brain = (cards) => cards.flatMap((c) => (c.startsWith("[对话]") ? openOnConversation(c) : []));

async function hostWith(stateDir: string, brain: Brain, routerOptions = {}) {
	const router = fauxRouter(brain, { persist: true, ...routerOptions });
	const spawner = new FakeSpawner((w) => w.settle());
	const host = await Host.start({ stateDir, createRouter: router.createRouter, createSpawner: () => spawner, log: () => {}, workerModels: defaultWorkerModels() });
	spawner.request = (...a) => host.workers.handleRequest(...a);
	return { host, router };
}

const titles = (host: Host) => host.kernel.listTickets().map((r) => r.title).sort();

test("Router 处理到一半时宿主停掉，重启后接着处理那句话", async (t) => {
	const stateDir = tempStateDir();
	const first = await hostWith(stateDir, () => new Promise(() => {}));
	t.after(() => first.host.stop());
	first.host.say("查下周的航班");
	await until(() => first.router.batches.length === 1, "第一轮开始");
	await first.host.stop();

	const second = await hostWith(stateDir, opensTickets);
	t.after(() => second.host.stop());
	await until(() => titles(second.host).length === 1, "重启后处理了那句话");
	assert.deepEqual(titles(second.host), ["查下周的航班"]);
});

test("Router 忙时到达、还没写进会话的话，宿主停掉后重启会重新送达", async (t) => {
	const stateDir = tempStateDir();
	const first = await hostWith(stateDir, () => new Promise(() => {}));
	t.after(() => first.host.stop());
	first.host.say("任务甲");
	await until(() => first.router.batches.length === 1, "第一轮开始");
	first.host.say("任务乙");
	await new Promise((r) => setTimeout(r, 100));
	await first.host.stop();

	const second = await hostWith(stateDir, opensTickets);
	t.after(() => second.host.stop());
	await until(() => titles(second.host).length === 2, "两句话都被处理");
	assert.deepEqual(titles(second.host), ["任务乙", "任务甲"]);
});

test("Router 一轮以普通模型错误结束时，退避后重试，直到处理完", async (t) => {
	let calls = 0;
	const { host } = await hostWith(tempStateDir(), opensTickets, { failOn: () => (++calls <= 4 ? "500 Internal Server Error" : undefined) });
	t.after(() => host.stop());
	host.say("整理下载目录");
	await until(() => titles(host).length === 1, "错误之后重试并处理完", 5000);
});

test("清屏换一个新的 Router 会话：会话 id 变了，新会话里没有清屏前的话，宿主重启后也不接回旧会话", async (t) => {
	const stateDir = tempStateDir();
	const first = await hostWith(stateDir, opensTickets);
	t.after(() => first.host.stop());
	first.host.say("记一下旧的话");
	await until(() => titles(first.host).length === 1, "第一句处理完");
	const session = () => (first.host.router as Router).session;
	const oldId = session().sessionManager.getSessionId();
	const remembers = (s: Router["session"]) => JSON.stringify(s.messages).includes("记一下旧的话");
	assert.ok(remembers(session()), "清屏前会话里有这句话");
	first.host.clearConversation();
	await until(() => session().sessionManager.getSessionId() !== oldId, "清屏后换了会话");
	assert.ok(!remembers(session()), "新会话里没有清屏前的话");
	await first.host.stop();

	const second = await hostWith(stateDir, opensTickets);
	t.after(() => second.host.stop());
	const restarted = (second.host.router as Router).session;
	assert.notEqual(restarted.sessionManager.getSessionId(), oldId);
	assert.ok(!remembers(restarted), "重启后没有接回清屏前的会话");
	assert.deepEqual(titles(second.host), ["记一下旧的话"], "任务还在");
});
