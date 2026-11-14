import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ModelSelector } from "../src/model-selector.ts";
import { BotApi, BotToken } from "../src/host/telegram/bot-api.ts";
import type { HostOptions } from "../src/host/host.ts";
import { FAKE_BOT_TOKEN, FakeTelegram } from "./helpers/fake-telegram.ts";
import { FakeSpawner, fauxRouter, ids, openOnConversation, tempStateDir, until, type Brain, type WorkerScript } from "./helpers/fakes.ts";
import { Host } from "../src/host/host.ts";

const USER = 42;
const primary = { provider: "openai-codex", id: "gpt-6.1-sol" };
const fallback = { provider: "deepseek", id: "deepseek-flash" };
const workerSelector = () => new ModelSelector({ primary, fallback, probeEveryMs: 15 * 60_000, clock: { now: () => Date.now() } });

const brain: Brain = (cards) =>
	cards.flatMap((card) => {
		if (card.startsWith("[对话]")) return openOnConversation(card);
		if (card.startsWith("[通知]")) return [{ name: "reply", args: { text: `通知：${card.split("\n")[0].slice(0, 60)}`, cause: card.match(/act_[\w-]+/)?.[0] } }];
		if (card.startsWith("[Worker 汇报]")) return [{ name: "reply", args: { text: `结果：${card.split("\n")[1]}`, cause: ids(card, "tkt") } }];
		return [];
	});

interface Setup {
	failOn?: (modelId: string) => string | undefined;
	models?: string[];
	script?: WorkerScript;
	options?: Partial<HostOptions>;
}

async function healthHost(t: TestContext, { failOn, models, script = (w) => (w.report({ status: "ready", summary: "好了" }), w.settle()), options = {} }: Setup = {}) {
	const tg = await FakeTelegram.start();
	const router = fauxRouter(brain, { failOn, models });
	const spawner = new FakeSpawner(script);
	const host = await Host.start({
		stateDir: tempStateDir(),
		createRouter: router.createRouter,
		createSpawner: () => spawner,
		log: () => {},
		workerModels: { selector: workerSelector(), fallbackDailyTokens: 1_000_000 },
		telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 2, minGapMs: 20, backoffMs: [100, 200], conflictBackoffMs: 200, stopGraceMs: 500 } },
		...options,
	});
	spawner.request = (...args) => host.workers.handleRequest(...args);
	t.after(async () => {
		await host.stop();
		await tg.close();
	});
	const said = () => host.kernel.conversation().filter((m) => m.who === "router").map((m) => m.text);
	const active = () => host.snapshot().health.active;
	const sentToUser = () => tg.sent.filter((m) => m.chatId === USER);
	const phone = () => sentToUser().map((m) => m.text);
	// Telegram writes only to chats that have spoken, and that first line goes to the Router too.
	tg.userSays(USER, "你好");
	await until(() => host.kernel.conversation().some((l) => l.who === "user"), "手机上的第一句到了");
	return { host, tg, said, active, phone, sentToUser, spawner };
}

test("幕僚长的模型一直 500：不靠幕僚长自己说，第二次失败时横幅亮起，Telegram 收到一条 ⚠️", async (t) => {
	const { active, phone, sentToUser } = await healthHost(t, { failOn: () => "500 Internal Server Error" });
	await until(() => active().length === 1, "幕僚长模型的警报");
	const [alarm] = active();
	assert.equal(alarm.id, "model:router");
	assert.equal(alarm.area, "model");
	assert.equal(alarm.subject, "幕僚长模型");
	assert.equal(alarm.cause, "provider");
	assert.ok(alarm.count >= 2);
	assert.match(alarm.lastError, /500/);
	await until(() => phone().some((m) => m.startsWith("🔔 ⚠️")), "Telegram 的 🔔 ⚠️");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(phone().filter((m) => m.startsWith("🔔 ⚠️")).length, 1, "同一个警报只发一次");
	assert.match(phone().find((m) => m.startsWith("🔔 ⚠️"))!, /幕僚长模型.*500/);
	assert.equal(sentToUser().find((m) => m.text.startsWith("🔔 ⚠️"))!.silent, false, "警报响铃");
});

test("幕僚长的模型 401：第一次就亮，建议检查登录或密钥", async (t) => {
	const { active } = await healthHost(t, { failOn: () => "401 Unauthorized: invalid api key" });
	await until(() => active().length === 1, "鉴权警报");
	assert.equal(active()[0].cause, "auth");
	assert.equal(active()[0].count, 1);
	assert.match(active()[0].advice, /登录|密钥/);
});

test("模型恢复后警报解除：横幅上没了，进最近恢复，Telegram 收到一条 ✅", async (t) => {
	let failures = 0;
	const { host, active, phone, said, sentToUser } = await healthHost(t, { failOn: () => (failures < 8 ? (failures++, "503 Service Unavailable") : undefined) });
	await until(() => active().length === 1, "先亮");
	await until(() => said().some((s) => s.startsWith("结果：")), "恢复后处理完");
	await until(() => active().length === 0, "解除");
	assert.deepEqual(host.snapshot().health.recent.map((a) => a.id), ["model:router"]);
	await until(() => phone().some((m) => m.startsWith("🔔 ✅")), "Telegram 的 🔔 ✅");
	assert.match(phone().find((m) => m.startsWith("🔔 ✅"))!, /幕僚长模型/);
	assert.equal(sentToUser().find((m) => m.text.startsWith("🔔 ✅"))!.silent, true, "恢复不响铃");
});

test("幕僚长的主模型限流：切到回退模型时就亮「已切到回退」，不再让幕僚长去说", async (t) => {
	const { active, said } = await healthHost(t, { models: ["primary", "fallback"], failOn: (id) => (id === "primary" ? "429 rate limit reached" : undefined) });
	await until(() => said().some((s) => s.startsWith("结果：")), "回退后处理完");
	assert.deepEqual(active().map((a) => a.id), ["model:router:fallback"]);
	assert.equal(active()[0].cause, "quota");
	assert.match(active()[0].advice, /回退模型/);
	assert.equal(said().filter((s) => s.startsWith("通知：")).length, 0, "额度用尽不再交给幕僚长转告");
});

test("助手的主模型限流：亮「助手模型已切到回退」，助手用回退模型做完", async (t) => {
	const { active, said } = await healthHost(t, {
		script: (w) => {
			if (w.model === "openai-codex/gpt-6.1-sol") return w.settle("429 Too Many Requests");
			w.report({ status: "ready", summary: `用 ${w.model} 做完了` });
			w.settle();
		},
	});
	await until(() => said().some((s) => s.startsWith("结果：")), "回退后完成");
	assert.deepEqual(active().map((a) => a.id), ["model:worker:fallback"]);
	assert.equal(said().filter((s) => s.startsWith("通知：")).length, 0);
});

test("两个助手同时在主模型上被限流：第二个看到已切到回退，不误报「主模型和回退模型都被限流」", async (t) => {
	const waiting: (() => void)[] = [];
	const { host, active, phone } = await healthHost(t, {
		script: async (w) => {
			if (w.model === "openai-codex/gpt-6.1-sol") {
				await new Promise<void>((resolve) => {
					waiting.push(resolve);
					if (waiting.length === 2) for (const go of waiting) go();
				});
				return w.settle("429 Too Many Requests");
			}
			w.report({ status: "ready", summary: `用 ${w.model} 做完了` });
			w.settle();
		},
	});
	host.say("第二个");
	await until(() => phone().filter((m) => m.includes("结果：")).length >= 2, "两个都用回退模型做完，结果发到了手机");
	assert.ok(!phone().some((m) => /都被限流/.test(m)), "没有误报主模型和回退模型都被限流");
	assert.deepEqual(host.snapshot().health.recent, [], "没有亮过又马上恢复的警报");
	assert.deepEqual(active().map((a) => a.id), ["model:worker:fallback"]);
});

test("助手的主模型和回退模型都限流：第一次就亮，说两个都被限流", async (t) => {
	const { active } = await healthHost(t, { script: (w) => w.settle("429 Too Many Requests") });
	await until(() => active().some((a) => a.id === "model:worker"), "助手模型的警报");
	assert.match(active().find((a) => a.id === "model:worker")!.advice, /都被限流/);
	assert.equal(active().find((a) => a.id === "model:worker")!.count, 1);
});

test("幕僚长的主模型和回退模型都限流：第一次就亮，说两个都被限流", async (t) => {
	const { active } = await healthHost(t, { models: ["primary", "fallback"], failOn: () => "429 rate limit reached" });
	await until(() => active().some((a) => a.id === "model:router"), "幕僚长模型的警报");
	assert.match(active().find((a) => a.id === "model:router")!.advice, /都被限流/);
});

test("助手的模型连着出错：一次不亮，两次连着失败才亮「助手模型」，下一轮成功就解除", async (t) => {
	let rounds = 0;
	const { host, active } = await healthHost(t, {
		script: (w) => {
			rounds++;
			if (rounds <= 2) return w.settle("502 Bad Gateway");
			w.report({ status: "ready", summary: "好了" });
			w.settle();
		},
	});
	await until(() => rounds === 1 && host.kernel.listTickets()[0]?.stage === "blocked_or_failed", "第一轮失败");
	assert.deepEqual(active(), [], "一次失败不亮");
	host.say("第二个");
	await until(() => active().some((a) => a.id === "model:worker"), "助手模型的警报");
	host.say("再来一个");
	await until(() => host.snapshot().health.recent.some((a) => a.id === "model:worker"), "解除");
	assert.ok(!active().some((a) => a.id === "model:worker"));
});

test("回退模型今日用量到上限：亮一条，说清楚要等主模型恢复或明天", async (t) => {
	const selector = workerSelector();
	selector.onError("429");
	const { active } = await healthHost(t, { options: { workerModels: { selector, fallbackDailyTokens: 0 } } });
	await until(() => active().some((a) => a.id === "model:fallback-cap"), "上限警报");
	assert.match(active().find((a) => a.id === "model:fallback-cap")!.lastError, /上限/);
});

test("阈值来自配置：modelFailuresBeforeAlarm 设成 4，三次失败还不亮", async (t) => {
	let failures = 0;
	const { active } = await healthHost(t, { failOn: () => (failures++, "500 Internal Server Error"), options: { health: { modelFailuresBeforeAlarm: 100, feedFailuresBeforeAlarm: 3 } } });
	await until(() => failures >= 12, "失败了几轮");
	assert.deepEqual(active(), []);
});
