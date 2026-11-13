import assert from "node:assert/strict";
import test from "node:test";
import { Host } from "../src/host/host.ts";
import type { Router } from "../src/host/router.ts";
import { defaultWorkerModels, FakeSpawner, fauxRouter, ids, openOnConversation, tempStateDir, until, type Brain } from "./helpers/fakes.ts";

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

test("清屏时对话里一行都没有，也换一个新的 Router 会话", async (t) => {
	const { host } = await hostWith(tempStateDir(), opensTickets);
	t.after(() => host.stop());
	const session = () => (host.router as Router).session;
	const oldId = session().sessionManager.getSessionId();
	assert.equal(host.kernel.conversation().length, 0);
	host.clearConversation();
	await until(() => session().sessionManager.getSessionId() !== oldId, "清屏后换了会话");
});

test("对话里一行都没有时清屏，宿主重启后也不接回清屏前的会话", async (t) => {
	const stateDir = tempStateDir();
	const first = await hostWith(stateDir, opensTickets);
	t.after(() => first.host.stop());
	const session = () => (first.host.router as Router).session;
	first.host.kernel.submitTrigger({ source: "generic", externalId: "mail-1", threads: [{ id: "thr_mail" }], sender: "mail", body: "清屏之间来的信", occurredAt: Date.now() });
	await until(() => JSON.stringify(session().messages).includes("清屏之间来的信") && !session().isStreaming, "信进了会话");
	const holding = session().sessionManager.getSessionId();
	assert.equal(first.host.kernel.conversation().length, 0);
	first.host.clearConversation();
	await until(() => session().sessionManager.getSessionId() !== holding, "空对话清屏也换了会话");
	await first.host.stop();

	const second = await hostWith(stateDir, opensTickets);
	t.after(() => second.host.stop());
	const restarted = (second.host.router as Router).session;
	assert.notEqual(restarted.sessionManager.getSessionId(), holding);
	assert.ok(!JSON.stringify(restarted.messages).includes("清屏之间来的信"), "重启后没有接回空对话清屏前的会话");
});

test("清屏后 Router 正在开新会话时说的话，送进新会话并得到回复", async (t) => {
	const echo: Brain = (cards) => cards.flatMap((c) => (c.startsWith("[对话]") ? [{ name: "reply", args: { text: `回：${c.split("使用者：")[1]!.split("\n")[0]}`, cause: ids(c, "trg") } }] : []));
	const { host } = await hostWith(tempStateDir(), echo);
	t.after(() => host.stop());
	const replies = () => [...host.kernel.conversation(500), ...(host.kernel.cleared(500)?.lines ?? [])].filter((l) => l.who === "router").map((l) => l.text);
	host.say("零");
	await until(() => replies().includes("回：零"), "第一句");
	const session = () => (host.router as Router).session;
	const oldId = session().sessionManager.getSessionId();
	host.clearConversation();
	const said: string[] = [];
	while (session().sessionManager.getSessionId() === oldId) {
		said.push(`话${said.length}`);
		host.say(said.at(-1)!);
		await new Promise((r) => setImmediate(r));
	}
	await until(() => said.every((s) => replies().includes(`回：${s}`)), `新会话打开前后说的 ${said.length} 句话都得到回复`, 5000);
});
