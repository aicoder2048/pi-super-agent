import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostConnection } from "../src/client/connection.ts";
import type { HostToClient } from "../src/client/protocol.ts";
import { loadConfig } from "../src/host/config.ts";
import { Host } from "../src/host/host.ts";
import { createHostOptions } from "../src/host/wiring.ts";
import type { WorkerEvents, WorkerSpec } from "../src/host/workers.ts";
import { Modules } from "../src/modules.ts";
import { defaultWorkerModels, FakeSpawner, fauxRouter, ids, openOnConversation, startHost, tempStateDir, until, type Brain } from "./helpers/fakes.ts";

const replyOnReport: Brain = (cards) =>
	cards.flatMap((card) => {
		if (card.startsWith("[对话]")) return openOnConversation(card);
		if (card.startsWith("[Worker 汇报]")) return [{ name: "reply", args: { text: `结果：${card.split("\n")[1]}`, cause: ids(card, "tkt") } }];
		return [];
	});

function fakeClock() {
	const clock = { t: Date.now(), now: () => clock.t };
	return clock;
}

function client(socketPath: string) {
	const got: HostToClient[] = [];
	const conn = new HostConnection({ socketPath, onMessage: (m) => got.push(m), retryMs: 30 });
	conn.open();
	return { conn, of: <T extends HostToClient["type"]>(type: T) => got.filter((m) => m.type === type) as Extract<HostToClient, { type: T }>[] };
}

async function fauxRuntime() {
	const faux = fauxProvider({ models: [{ id: "router" }, { id: "worker" }, { id: "fallback" }] });
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("ok"))));
	const modelRuntime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "psa-auth-")), "a.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	return { modelRuntime, provider: faux.getModel().provider };
}

function wiringConfig(provider: string, retryAttempts = 3) {
	return {
		stateDir: tempStateDir(), kernel: {}, bgMaxMinutes: 120, fallbackDailyTokens: 1000, consultTimeoutSeconds: 180, retryAttempts, probePrimaryMinutes: 15,
		heartbeatSeconds: 30, watchdog: { intervalMinutes: 3, stuckMinutes: 30, staleSeconds: 120 }, modulesDirs: [], webPort: 0, sources: {},
		models: { router: { provider, id: "router" }, worker: { provider, id: "worker" }, fallback: { provider, id: "fallback" } },
	};
}

test("故事 7：Worker 提问以 [Worker 提问] 卡片到达 Router，Router 以该任务为 cause 回复，任务进入等回答", async (t) => {
	const brain: Brain = (cards) =>
		cards.flatMap((card) => {
			if (card.startsWith("[对话]")) return openOnConversation(card);
			if (card.startsWith("[Worker 提问]")) return [{ name: "reply", args: { text: "需要你选：A 还是 B？", cause: ids(card, "tkt") } }];
			return [];
		});
	const { host, router, said } = await startHost(brain, (w) => {
		w.report({ status: "progress", summary: "需要确认", question: "用 A 方案还是 B 方案？" });
		w.settle();
	});
	t.after(() => host.stop());
	host.say("帮我部署");
	await until(() => said().includes("需要你选：A 还是 B？"), "提问的回复到达对话");
	const card = router.batches.flat().find((c) => c.startsWith("[Worker 提问]"));
	assert.ok(card, JSON.stringify(router.batches));
	assert.match(card, /问题：用 A 方案还是 B 方案？/);
	const ticket = host.kernel.listTickets()[0];
	assert.equal(ids(card, "tkt"), ticket.id);
	assert.equal(ticket.stage, "awaiting_answer");
});

test("故事 10：定时器到点产生来源为 timer 的触发，Router 收到它的 [候选触发] 卡片", async (t) => {
	const clock = fakeClock();
	const { host, router } = await startHost(() => [], () => {}, {
		clock,
		timers: [{ id: "t1", everyMinutes: 1, thread: "daily", body: "例行检查" }],
	});
	t.after(() => host.stop());
	clock.t += 60_000;
	host.timer.tick();
	await until(() => router.batches.flat().some((c) => c.startsWith("[候选触发]")), "候选触发卡片");
	const card = router.batches.flat().find((c) => c.startsWith("[候选触发]"))!;
	assert.match(card, /来源 timer/);
	assert.match(card, /例行检查/);
	const found = host.kernel.read(ids(card, "trg")!);
	assert.equal(found?.type === "trigger" && found.trigger.source, "timer");
});

test("故事 12：使用者规则文件里的规则进入按真实接线启动的 Router 系统提示词", async (t) => {
	const { modelRuntime, provider } = await fauxRuntime();
	const rulesFile = join(mkdtempSync(join(tmpdir(), "psa-rules-")), "rules.md");
	writeFileSync(rulesFile, "## watch-ci\n来源: ci\nCI 失败时开任务\n");
	const host = await Host.start(createHostOptions({ config: wiringConfig(provider), modules: Modules.load([], rulesFile), modelRuntime, log: () => {} }));
	t.after(() => host.stop());
	const prompt: string = (host.router as any).session.systemPrompt;
	assert.match(prompt, /user\/watch-ci/);
	assert.match(prompt, /CI 失败时开任务/);
});

test("故事 20：查看任务时收到 Worker 会话文件里的历史消息，系统消息被去掉", async (t) => {
	const stateDir = tempStateDir();
	const { host } = await startHost(replyOnReport, () => {}, { stateDir });
	const c = client(host.socketPath);
	t.after(async () => { c.conn.close(); await host.stop(); });
	host.say("看日志");
	await until(() => host.kernel.listTickets().length === 1, "任务");
	const ticket = host.kernel.getTicket(host.kernel.listTickets()[0].id)!;
	const assistant = { role: "assistant", content: [{ type: "text", text: "日志里没有错误" }] };
	const dir = join(stateDir, "sessions", "workers");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `2026-11-08T00-00-00_${ticket.workerSessionId}.jsonl`),
		[
			{ type: "session", id: ticket.workerSessionId },
			{ type: "message", message: { role: "system", content: "你是 Worker" } },
			{ type: "message", message: assistant },
		].map((e) => JSON.stringify(e)).join("\n") + "\n",
	);
	await until(() => c.conn.connected, "连接");
	c.conn.watch(ticket.id);
	await until(() => c.of("transcript_history").length === 1, "过程历史");
	assert.deepEqual(c.of("transcript_history")[0].messages, [assistant]);
});

test("故事 22：使用者说完就关掉客户端，任务照常完成，新客户端的快照里有结果回复", async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const { host } = await startHost(replyOnReport, async (w) => {
		await gate;
		w.report({ status: "ready", summary: "周报写好了" });
		w.settle();
	});
	t.after(() => host.stop());
	const first = client(host.socketPath);
	await until(() => first.conn.connected, "连接");
	first.conn.say("写周报");
	await until(() => host.kernel.listTickets()[0]?.stage === "running", "Worker 在执行");
	first.conn.close();
	release();
	await until(() => host.kernel.listTickets()[0].stage === "closed", "任务关闭");
	await host.settled();
	const second = client(host.socketPath);
	t.after(() => second.conn.close());
	await until(() => second.of("snapshot").length === 1, "新客户端快照");
	assert.ok(second.of("snapshot")[0].conversation.some((l) => l.who === "router" && l.text === "结果：周报写好了"), JSON.stringify(second.of("snapshot")[0].conversation));
});

test("故事 23：宿主重启后，执行中任务的 Worker 沿用原来的会话，Router 会话也保留了历史", async (t) => {
	const stateDir = tempStateDir();
	const start = async () => {
		const spawner = new FakeSpawner(() => {});
		const host = await Host.start({ stateDir, createRouter: fauxRouter(replyOnReport, { persist: true }).createRouter, createSpawner: () => spawner, log: () => {}, workerModels: defaultWorkerModels() });
		spawner.request = (...a) => host.workers.handleRequest(...a);
		return { host, spawner };
	};
	const first = await start();
	first.host.say("整理照片");
	await until(() => first.spawner.workers.size === 1 && first.host.kernel.listTickets()[0].stage === "running", "Worker 执行中");
	await first.host.settled();
	const before = [...first.spawner.workers.values()][0].spec.sessionId;
	await first.host.stop();

	const second = await start();
	t.after(() => second.host.stop());
	await until(() => second.spawner.workers.size === 1, "重新拉起 Worker");
	assert.equal([...second.spawner.workers.values()][0].spec.sessionId, before);
	assert.ok((second.host.router as any).session.messages.length > 0);
});

test("故事 27：拉起 Worker 失败时，唤醒动作退避后重试，Worker 最终收到任务说明", async (t) => {
	const clock = fakeClock();
	class FlakySpawner extends FakeSpawner {
		attempts = 0;
		override async spawn(spec: WorkerSpec, events: WorkerEvents) {
			if (++this.attempts === 1) throw new Error("boom");
			return super.spawn(spec, events);
		}
	}
	const spawner = new FlakySpawner(() => {});
	const host = await Host.start({ stateDir: tempStateDir(), clock, createRouter: fauxRouter(replyOnReport).createRouter, createSpawner: () => spawner, log: () => {}, workerModels: defaultWorkerModels() });
	spawner.request = (...a) => host.workers.handleRequest(...a);
	t.after(() => host.stop());
	host.say("备份数据库");
	await until(() => spawner.attempts === 1 && host.kernel.listTickets()[0]?.stage !== "running", "第一次拉起失败");
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(spawner.attempts, 1);
	clock.t += 5_001;
	host.dispatcher.kick();
	await until(() => spawner.workers.size === 1 && spawner.workers.values().next().value!.inputs.length === 1, "重试后 Worker 收到输入");
	assert.equal(spawner.attempts, 2);
	assert.match(spawner.workers.values().next().value!.inputs[0], /备份数据库/);
});

test("故事 28：没有配置文件时，Router 和 Worker 用 openai-codex，回退用 deepseek", () => {
	const config = loadConfig(mkdtempSync(join(tmpdir(), "psa-cfg-")));
	assert.equal(config.models.router.provider, "openai-codex");
	assert.equal(config.models.worker.provider, "openai-codex");
	assert.equal(config.models.fallback.provider, "deepseek");
});

test("故事 29：按真实接线启动的 Router 打开了 Pi 的自动重试，次数取配置的 retryAttempts", async (t) => {
	for (const retryAttempts of [3, 5]) {
		const { modelRuntime, provider } = await fauxRuntime();
		const host = await Host.start(createHostOptions({ config: wiringConfig(provider, retryAttempts), modules: Modules.load([]), modelRuntime, log: () => {} }));
		t.after(() => host.stop());
		const settings = (host.router as any).session.settingsManager;
		assert.equal(settings.getRetryEnabled(), true);
		assert.equal(settings.getRetrySettings().maxRetries, retryAttempts);
	}
});
