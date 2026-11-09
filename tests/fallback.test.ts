import assert from "node:assert/strict";
import test from "node:test";
import { ModelSelector } from "../src/model-selector.ts";
import { FakeSpawner, fauxRouter, ids, openOnConversation, startHost, until, type Brain } from "./helpers/fakes.ts";

const primary = { provider: "openai-codex", id: "gpt-6.1-sol" };
const fallback = { provider: "deepseek", id: "deepseek-flash" };
const workerSelector = () => new ModelSelector({ primary, fallback, probeEveryMs: 15 * 60_000, clock: { now: () => Date.now() } });

const brain: Brain = (cards) =>
	cards.flatMap((card) => {
		if (card.startsWith("[对话]")) return openOnConversation(card);
		if (card.startsWith("[通知]")) return [{ name: "reply", args: { text: `通知：${card.slice(5, 40)}` } }];
		if (card.startsWith("[Worker 汇报]")) return [{ name: "reply", args: { text: `结果：${card.split("\n")[1]}`, ticketId: ids(card, "tkt") } }];
		return [];
	});

test("Worker 遇到最终的限流错误：切到回退模型继续做，使用者经 Router 收到一次通知", async (t) => {
	const { host, spawner, said } = await startHost(brain, (w, input) => {
		if (w.model === "openai-codex/gpt-6.1-sol") return w.settle("429 Too Many Requests");
		w.report({ status: "ready", summary: `用 ${w.model} 做完了` });
		w.settle();
	}, { workerModels: { selector: workerSelector(), fallbackDailyTokens: 1_000_000 } });
	t.after(() => host.stop());
	host.say("任务一");
	await until(() => said().some((s) => s.startsWith("结果：")), "回退后完成");
	assert.ok(said().includes("结果：用 deepseek/deepseek-flash 做完了"));
	assert.equal(said().filter((s) => s.startsWith("通知：")).length, 1);
	assert.equal(host.kernel.listTickets()[0].fellBack, true);
	host.say("任务二");
	await until(() => said().filter((s) => s.startsWith("结果：")).length === 2, "第二个任务直接用回退模型");
	assert.equal(said().filter((s) => s.startsWith("通知：")).length, 1);
	assert.equal(spawner.spawned.length, 2);
});

test("回退模型今日用量超过上限：Worker 汇报受阻并停下，Router 仍能回应", async (t) => {
	const selector = workerSelector();
	selector.onError("429");
	const { host, spawner, said } = await startHost(brain, (w) => {
		w.report({ status: "ready", summary: "不该运行" });
		w.settle();
	}, { workerModels: { selector, fallbackDailyTokens: 0 } });
	t.after(() => host.stop());
	host.say("先用一点用量");
	await until(() => host.kernel.listTickets().length === 1, "第一个任务");
	await until(() => host.kernel.listTickets()[0].stage === "blocked_or_failed", "受阻");
	assert.equal(spawner.spawned.length, 0);
	assert.match(host.kernel.listTickets()[0].latestSummary!, /回退模型.*上限/);
	await until(() => said().some((s) => s.startsWith("结果：")), "Router 转告受阻");
});

test("用量按日累计：超过上限后，Worker 一轮结束时就停下汇报受阻", async (t) => {
	const selector = workerSelector();
	selector.onError("429");
	const { host } = await startHost(brain, (w) => {
		host.kernel.recordUsage(w.spec.ticketId, { provider: "deepseek", tokensIn: 150, tokensOut: 0 });
		w.settle();
	}, { workerModels: { selector, fallbackDailyTokens: 100 } });
	t.after(() => host.stop());
	host.say("大任务");
	await until(() => host.kernel.listTickets()[0]?.stage === "blocked_or_failed", "一轮后受阻");
	await until(() => host.workers.liveCount() === 0, "Worker 停下");
});

test("Router 遇到最终的限流错误时切到回退模型，并处理完被打断的消息", async (t) => {
	let errors = 0;
	const router = fauxRouter((cards, n, results) => brain(cards, n, results), {
		models: ["primary", "fallback"],
		failOn: (modelId) => (modelId === "primary" ? (errors++, "429 rate limit reached") : undefined),
	});
	const { host, said } = await startHost(() => [], (w) => { w.report({ status: "ready", summary: "好了" }); w.settle(); }, { createRouter: router.createRouter });
	t.after(() => host.stop());
	host.say("查天气");
	await until(() => said().some((s) => s.startsWith("结果：")), "回退后处理完");
	assert.ok(errors >= 1);
	assert.equal((host.router as any).session.model.id, "fallback");
	assert.equal(said().filter((s) => s.startsWith("通知：")).length, 1);
});

test("Router 会话自行开启自动压缩和自动重试，不受全局设置影响", async (t) => {
	const { host } = await startHost(() => [], () => {});
	t.after(() => host.stop());
	const session = (host.router as any).session;
	assert.equal(session.autoCompactionEnabled, true);
	assert.equal(session.autoRetryEnabled, true);
	assert.equal(session.steeringMode, "all");
});

test("已在运行的 Worker 超过回退上限后，不再投递新的输入，任务受阻并停下", async (t) => {
	const selector = workerSelector();
	selector.onError("429");
	const { host, spawner } = await startHost(brain, (w) => {
		host.kernel.recordUsage(w.spec.ticketId, { provider: "deepseek", tokensIn: 500, tokensOut: 0 });
		host.kernel.note({ ticketId: w.spec.ticketId, text: "这一轮进行中又来了一条补充" });
		w.report({ status: "progress", summary: "做了一部分" });
		w.settle();
	}, { workerModels: { selector, fallbackDailyTokens: 400 } });
	t.after(() => host.stop());
	host.say("大任务");
	await until(() => host.kernel.listTickets()[0]?.stage === "blocked_or_failed", "受阻");
	const id = host.kernel.listTickets()[0].id;
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(spawner.workers.get(id)!.inputs.length, 1);
	assert.equal(host.workers.liveCount(), 0);
});

test("Router 在回退模型上的用量计入每日累计", async (t) => {
	const router = fauxRouter(brain, { models: ["primary", "fallback"], failOn: (id) => (id === "primary" ? "429 rate limit" : undefined) });
	const { host } = await startHost(() => [], (w) => w.settle(), { createRouter: router.createRouter });
	t.after(() => host.stop());
	host.say("你好");
	await until(() => (host.router as any).session.model?.id === "fallback", "切到回退模型");
	const provider = (host.router as any).session.model.provider;
	await until(() => host.kernel.usageToday(provider) > 0, "回退模型用量被计入");
});
