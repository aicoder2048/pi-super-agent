import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostOptions, modelSelectors, watchedSources } from "../src/host/wiring.ts";
import { Host } from "../src/host/host.ts";
import { Modules } from "../src/modules.ts";
import { KEY_NAMES } from "../src/sources/market/key.ts";
import { until } from "./helpers/fakes.ts";

const config = {
	models: {
		router: { provider: "openai-codex", id: "gpt-6.1-terra" },
		worker: { provider: "openai-codex", id: "gpt-6.1-sol" },
		fallback: { provider: "deepseek", id: "deepseek-flash" },
	},
	probePrimaryMinutes: 15,
};

test("Router 和 Worker 各有一个选择器，主模型分别是各自的配置", () => {
	const { router, worker } = modelSelectors(config, { now: () => 0 });
	assert.deepEqual(router.current().model, config.models.router);
	assert.deepEqual(worker.current().model, config.models.worker);
});

test("Pi 自己的重试用完后，第一次最终的限流错误就切到回退模型", () => {
	const { router } = modelSelectors(config, { now: () => 0 });
	assert.deepEqual(router.onError("429 Too Many Requests"), { switched: true, notify: true });
	assert.deepEqual(router.current().model, config.models.fallback);
});

test("试探主模型的间隔取配置里的分钟数", () => {
	const now = { t: 0 };
	const { worker } = modelSelectors({ ...config, probePrimaryMinutes: 5 }, { now: () => now.t });
	worker.onError("429");
	now.t = 4 * 60_000;
	assert.equal(worker.forTurn().probing, false);
	now.t = 5 * 60_000;
	assert.equal(worker.forTurn().probing, true);
});

test("一个选择器回退不影响另一个", () => {
	const { router, worker } = modelSelectors(config, { now: () => 0 });
	worker.onError("429");
	assert.equal(router.current().fellBack, false);
});


async function fauxRuntime(failOn: (id: string) => boolean) {
	const faux = fauxProvider({ models: [{ id: "router" }, { id: "worker" }, { id: "fallback" }] });
	const reply = (_c: unknown, _o: unknown, _s: unknown, model: { id: string }) =>
		failOn(model.id) ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit reached" }) : fauxAssistantMessage(fauxText("ok"));
	faux.setResponses(Array.from({ length: 50 }, () => reply));
	const modelRuntime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "psa-auth-")), "a.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	return { modelRuntime, provider: faux.getModel().provider };
}

function hostConfig(provider: string, fallbackId = "fallback") {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-wire-"));
	return {
		stateDir, kernel: {}, bgMaxMinutes: 120, fallbackDailyTokens: 1000, retryAttempts: 0, probePrimaryMinutes: 15,
		heartbeatSeconds: 30, watchdog: { intervalMinutes: 3, stuckMinutes: 30, staleSeconds: 120 }, modulesDirs: [], webPort: 0, sources: {},
		models: { router: { provider, id: "router" }, worker: { provider, id: "worker" }, fallback: { provider, id: fallbackId } },
	};
}

test("入口：配置里的回退模型不存在时，启动前就报错", async () => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	assert.throws(
		() => createHostOptions({ config: hostConfig(provider, "missing"), modules: Modules.load([]), modelRuntime, log: () => {} }),
		/找不到模型 .*missing/,
	);
});

test("入口：按真实接线启动的宿主，Router 遇到最终的限流错误会切到回退模型", async (t) => {
	const { modelRuntime, provider } = await fauxRuntime((id) => id === "router");
	const options = createHostOptions({ config: hostConfig(provider), modules: Modules.load([]), modelRuntime, log: () => {} });
	const host = await Host.start(options);
	t.after(() => host.stop());
	host.say("你好");
	await until(() => (host.router as any).session.model?.id === "fallback", "Router 切到回退模型", 5000);
});

test("在替你盯着：每个来源一项，带上管它的规则（使用者的在前）和定时器，忽略的来源不算", () => {
	const mod = (name: string, manifest: Partial<import("../src/modules.ts").ModuleManifest>, rules: { id: string; text: string; sources: string[] }[]) =>
		({ name, dir: `/m/${name}`, manifest: { name, ...manifest }, rules, skillsDir: undefined });
	const modules = new Modules(
		[
			mod("market", { sources: [{ name: "quotes" }, { name: "spam", mode: "ignore" }] }, [{ id: "market/drop", text: "跌多了提醒我\n细节", sources: ["quotes"] }]),
			mod("digest", { timers: [{ id: "am", everyMinutes: 1440, thread: "thr_am", body: "早报" }] }, []),
		],
		[{ id: "user/mail", text: "有人找我先看一遍", sources: ["inbox", "quotes"] }],
		[],
	);
	assert.deepEqual(watchedSources(modules, modules.timers()), [
		{ source: "inbox", timers: [], rules: [{ id: "user/mail", text: "有人找我先看一遍", by: "user" }] },
		{ source: "quotes", timers: [], rules: [{ id: "user/mail", text: "有人找我先看一遍", by: "user" }, { id: "market/drop", text: "跌多了提醒我\n细节", by: "module" }] },
		{ source: "digest", timers: [{ everyMinutes: 1440, body: "早报" }], rules: [] },
	]);
});

const REPO_MODULES = new URL("../modules", import.meta.url).pathname;

function withoutKeyVars(t: import("node:test").TestContext) {
	const saved = Object.fromEntries(KEY_NAMES.map((k) => [k, process.env[k]]));
	for (const k of KEY_NAMES) delete process.env[k];
	t.after(() => {
		for (const k of KEY_NAMES) if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	});
}

test("真实接线：美股行情出现在关注的来源里，用人话标题和一句说明；没有密钥时写明「未配置行情密钥」", async (t) => {
	withoutKeyVars(t);
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const logs: string[] = [];
	const options = createHostOptions({ config: hostConfig(provider), modules: Modules.load([REPO_MODULES]), modelRuntime, log: (l) => logs.push(l) });
	const host = await Host.start(options);
	t.after(() => host.stop());
	const entry = host.snapshot().watching.find((w) => w.source === "us-market")!;
	assert.deepEqual(
		{ title: entry.title, description: entry.description, problem: entry.problem },
		{ title: "美股行情", description: "交易时段每分钟看一遍自选股，涨跌到档或放量时提醒", problem: "未配置行情密钥" },
	);
	assert.equal(logs.filter((l) => l.includes("未配置行情密钥")).length, 1);
});

test("真实接线：宿主从环境变量读到密钥，日志只写来源不写密钥", async (t) => {
	withoutKeyVars(t);
	process.env.MASSIVE_API_KEY = "sk-wire-secret";
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const logs: string[] = [];
	const options = createHostOptions({ config: hostConfig(provider), modules: Modules.load([REPO_MODULES]), modelRuntime, log: (l) => logs.push(l) });
	assert.deepEqual(options.feeds?.map((f) => f.source), ["us-market"]);
	assert.ok(logs.some((l) => l.includes("环境变量 MASSIVE_API_KEY")));
	assert.ok(!logs.some((l) => l.includes("sk-wire-secret")));
});

test("真实接线：config.json 里 sources.us-market 拼错字段时启动前报错；模块写了未知的 feed kind 也报错并列出可用的", async (t) => {
	withoutKeyVars(t);
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const config = { ...hostConfig(provider), sources: { "us-market": { watchlst: ["AMD"] } } };
	assert.throws(() => createHostOptions({ config, modules: Modules.load([REPO_MODULES]), modelRuntime, log: () => {} }), /config\.json.*watchlst/);
	const odd = new Modules([{ name: "odd", dir: "/m/odd", manifest: { name: "odd", sources: [{ name: "odd", feed: { kind: "carrier-pigeon" } }] }, rules: [], skillsDir: undefined }], [], []);
	assert.throws(() => createHostOptions({ config: hostConfig(provider), modules: odd, modelRuntime, log: () => {} }), /carrier-pigeon.*massive-stocks/);
});

test("宿主运行模块声明的来源：随宿主启停，触发进内核，游标存在自己名下", async (t) => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	let stopped = false;
	const options = createHostOptions({ config: hostConfig(provider), modules: Modules.load([]), modelRuntime, log: () => {} });
	const host = await Host.start({
		...options,
		feeds: [{
			source: "fake",
			lookupHelp: "",
			create: (ctx) => ({
				start() {
					ctx.submit({ source: "fake", externalId: "e1", threads: [{ id: "thr_fake:a" }], sender: "fake", body: "动了", occurredAt: ctx.clock.now() });
					ctx.writeCursor("c1");
				},
				stop() { stopped = true; },
				problem: () => undefined,
				lookup: async () => 0,
			}),
		}],
	});
	let hostStopped = false;
	t.after(() => (hostStopped ? undefined : host.stop()));
	assert.deepEqual(host.kernel.triggerLog().map((x) => [x.source, x.externalId]), [["fake", "e1"]]);
	assert.equal(host.kernel.sourceCursor("fake"), "c1");
	await host.stop();
	hostStopped = true;
	assert.ok(stopped);
});
