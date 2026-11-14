import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostOptions, modelSelectors, telegramOptions, watchedSources } from "../src/host/wiring.ts";
import { memberProviders } from "../src/host/config.ts";
import { Host } from "../src/host/host.ts";
import { Modules } from "../src/modules.ts";
import { FINNHUB_KEY_NAMES, KEY_NAMES } from "../src/sources/market/key.ts";
import { servedAsHost, until } from "./helpers/fakes.ts";
import { FakeInbox } from "./helpers/fake-gmail.ts";
import { startFakeGoogle, type FakeGoogle } from "./helpers/fake-google.ts";
import { liveRegistry, ModuleStore } from "../src/modules/live.ts";
import type { ComponentName, Digest, ModuleName } from "../src/modules/manifest.ts";

const fixed = (modules: Modules) => ({ live: liveRegistry(modules), kitFor: (domain: string) => modules.kitFor(domain), cards: () => [], setSwitch: () => false, onChange: () => {} });

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

async function firstBlock(host: Host): Promise<string> {
	host.say("你好");
	const session = (host.router as any).session;
	const block = () => (session.messages as { role: string; content: string }[]).find((m) => m.role === "custom" && m.content.startsWith("[名单和规则]"))?.content;
	await until(() => block() !== undefined, "幕僚长收到名单和规则");
	return block()!.split("\n\n[")[0]!;
}

function hostConfig(provider: string, fallbackId = "fallback") {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-wire-"));
	return {
		stateDir, kernel: {}, bgMaxMinutes: 120, fallbackDailyTokens: 1000, dispatchTimeoutSeconds: 60, dispatchCodingTimeoutSeconds: 600, dispatchStallSeconds: 45, maxConcurrentExperts: 2, retryAttempts: 0, probePrimaryMinutes: 15,
		heartbeatSeconds: 30, watchdog: { intervalMinutes: 3, stuckMinutes: 30, staleSeconds: 120 }, modulesDirs: [], webPort: 0, webHosts: [], sources: {}, ocr: { engine: "off" as const },
		models: { router: { provider, id: "router" }, worker: { provider, id: "worker" }, fallback: { provider, id: fallbackId } },
	};
}

test("入口：配置里的回退模型不存在时，启动前就报错", async () => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	assert.throws(
		() => createHostOptions({ config: hostConfig(provider, "missing"), modules: fixed(Modules.load([])), modelRuntime, log: () => {} }),
		/找不到模型 .*missing/,
	);
});

test("入口：按真实接线启动的宿主，Router 遇到最终的限流错误会切到回退模型", async (t) => {
	const { modelRuntime, provider } = await fauxRuntime((id) => id === "router");
	const options = createHostOptions({ config: hostConfig(provider), modules: fixed(Modules.load([])), modelRuntime, log: () => {} });
	const host = await Host.start(options);
	t.after(() => host.stop());
	host.say("你好");
	await until(() => (host.router as any).session.model?.id === "fallback", "Router 切到回退模型", 5000);
});

test("在替你盯着：每个来源一项，带上管它的规则（使用者的在前）和定时器，忽略的来源不算", () => {
	const mod = (name: string, manifest: Partial<import("../src/modules.ts").ModuleManifest>, rules: { id: string; text: string; sources: string[] }[]) =>
		({ name, dir: `/m/${name}`, manifest: { name, ...manifest }, rules, skillsDir: undefined, state: { enabled: true, by: "default" as const } });
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
const RETIRED_MODULES = new URL("./fixtures/retired", import.meta.url).pathname;
const withRetired = (options?: Parameters<typeof Modules.load>[1]) => Modules.load([REPO_MODULES, RETIRED_MODULES], options);

function withoutKeyVars(t: import("node:test").TestContext) {
	const names = [...KEY_NAMES, ...FINNHUB_KEY_NAMES];
	const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
	for (const k of names) delete process.env[k];
	t.after(() => {
		for (const k of names) if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	});
}

test("真实接线：美股行情出现在关注的来源里，用人话标题和一句说明；没有密钥时写明「未配置行情密钥」", async (t) => {
	withoutKeyVars(t);
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const logs: string[] = [];
	const options = createHostOptions({ config: hostConfig(provider), modules: fixed(withRetired()), modelRuntime, log: (l) => logs.push(l) });
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
	const options = createHostOptions({ config: hostConfig(provider), modules: fixed(withRetired()), modelRuntime, log: (l) => logs.push(l) });
	assert.deepEqual(options.feeds?.map((f) => f.source), ["us-market"]);
	assert.ok(logs.some((l) => l.includes("环境变量 MASSIVE_API_KEY")));
	assert.ok(!logs.some((l) => l.includes("sk-wire-secret")));
});

test("真实接线：config.json 里 sources.us-market 拼错字段时启动前报错；模块写了未知的 feed kind 也报错并列出可用的", async (t) => {
	withoutKeyVars(t);
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const config = { ...hostConfig(provider), sources: { "us-market": { watchlst: ["AMD"] } } };
	assert.throws(() => createHostOptions({ config, modules: fixed(withRetired()), modelRuntime, log: () => {} }), /config\.json.*watchlst/);
	const odd = new Modules([{ name: "odd", dir: "/m/odd", manifest: { name: "odd", sources: [{ name: "odd", feed: { kind: "carrier-pigeon" } }] }, rules: [], skillsDir: undefined, state: { enabled: true, by: "default" } }], [], []);
	assert.throws(() => createHostOptions({ config: hostConfig(provider), modules: fixed(odd), modelRuntime, log: () => {} }), /carrier-pigeon.*massive-stocks/);
});

test("真实接线：us-market 退役以后 config.json 里还留着 sources.us-market：启动前报错，说删掉哪一项", async (t) => {
	withoutKeyVars(t);
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const config = { ...hostConfig(provider), sources: { "us-market": { everySeconds: 300 } } };
	assert.throws(() => createHostOptions({ config, modules: fixed(Modules.load([REPO_MODULES])), modelRuntime, log: () => {} }), (e: Error) => e.name === "ConfigError" && /us-market 已经退役，删掉 .*config\.json 里的 sources\.us-market/.test(e.message));
	assert.doesNotThrow(() => createHostOptions({ config: hostConfig(provider), modules: fixed(Modules.load([REPO_MODULES])), modelRuntime, log: () => {} }));
});

test("真实接线：config.json 的 sources 里写了没有 feed 的来源名时启动前报错，列出可配置的来源", async (t) => {
	withoutKeyVars(t);
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const config = { ...hostConfig(provider), sources: { "us-markt": { watchlist: ["AMD"] } } };
	assert.throws(() => createHostOptions({ config, modules: fixed(withRetired()), modelRuntime, log: () => {} }), (e: Error) => e.name === "ConfigError" && /us-markt.*us-market/.test(e.message));
});

test("宿主运行模块声明的来源：随宿主启停，触发进内核，游标和使用者数据存在自己名下", async (t) => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	let stopped = false;
	let readBack: string | undefined;
	const options = createHostOptions({ config: hostConfig(provider), modules: fixed(Modules.load([])), modelRuntime, log: () => {} });
	const host = await Host.start({
		...options,
		feeds: [{
			source: "fake",
			lookupHelp: "",
			status: "运行",
			create: (ctx) => ({
				start() {
					ctx.submit({ source: "fake", externalId: "e1", threads: [{ id: "thr_fake:a" }], sender: "fake", body: "动了", occurredAt: ctx.clock.now() });
					ctx.writeCursor("c1");
					ctx.writeUserData("d1");
					readBack = ctx.readUserData();
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
	assert.equal(host.kernel.sourceUserData("fake"), "d1");
	assert.equal(readBack, "d1");
	await host.stop();
	hostStopped = true;
	assert.ok(stopped);
});

test("真实接线：关掉 us-market 后不运行它的看盘，config.json 里留着它的 sources 设置也不报错", async (t) => {
	withoutKeyVars(t);
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const config = { ...hostConfig(provider), sources: { "us-market": { watchlist: ["AMD"] } } };
	const modules = withRetired({ switches: { values: { "us-market": false }, file: "config.json" } });
	const options = createHostOptions({ config, modules: fixed(modules), modelRuntime, log: () => {} });
	assert.deepEqual(options.feeds, []);
	assert.ok(!options.watching?.some((w) => w.source === "us-market"));
});

test("真实接线：关掉 us-market 时有行情密钥也不建看盘，不开 lookup 和 tripwire，领域簿和幕僚长的名册里都没有它", async (t) => {
	withoutKeyVars(t);
	process.env.MASSIVE_API_KEY = "sk-wiring-fake";
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const modules = withRetired({ switches: { values: { "us-market": false }, file: "config.json" } });
	const options = createHostOptions({ config: hostConfig(provider), modules: fixed(modules), modelRuntime, log: () => {} });
	assert.deepEqual(options.feeds, []);
	assert.equal(options.domains!.kitFor("us-market", null), undefined);
	assert.ok(!options.domains!.book().has("us-market"));
	const host = await Host.start(options);
	t.after(() => host.stop());
	assert.equal(host.feeds.size, 0);
	assert.doesNotMatch((host.router as any).session.systemPrompt, /us-market（/);
});

function writeFiles(dir: string, files: Record<string, string>): string {
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	return dir;
}
const memberFile = (name: string, title: string, extra = "") => `---\nname: ${name}\ntitle: ${title}\ndescription: ${title}的说明\n${extra}---\n`;
const moduleFiles = (name: string, manifest: object, files: Record<string, string> = {}) =>
	Object.fromEntries(Object.entries({ "module.json": JSON.stringify({ name, ...manifest }), ...files }).map(([path, text]) => [`${name}/${path}`, text]));
const NEWS_MODULE = moduleFiles("news", { title: "新闻", description: "查新闻、核对报道来源", team: "新闻队" }, { "agents/news.md": memberFile("news-researcher", "新闻研究员") });
const loadWith = (config: ReturnType<typeof hostConfig>, ...dirs: string[]) => Modules.load([...dirs, join(config.stateDir, "modules")], { stateDir: config.stateDir, allowedProviders: memberProviders(config) });

test("真实接线：仓库模块目录和状态目录 modules/ 里的模块都是领域，进了内核的领域簿；幕僚长收到的名册只列写了说明的，不列成员", async (t) => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const config = hostConfig(provider);
	writeFiles(join(config.stateDir, "modules"), NEWS_MODULE);
	const modulesDir = writeFiles(mkdtempSync(join(tmpdir(), "psa-mods-")), {
		...moduleFiles("watch", { title: "看盘", description: "盯行情", team: "看盘队", sources: [{ name: "quotes" }] }, { "rules.md": "## drop\n跌多了开任务\n", "agents/analyst.md": memberFile("market-analyst", "行情分析师") }),
		...moduleFiles("mail", { sources: [{ name: "mail" }] }),
	});
	const options = createHostOptions({ config, modules: fixed(loadWith(config, modulesDir)), modelRuntime, log: () => {} });
	assert.deepEqual([...options.domains!.book()], [["mail", { team: null, onRoster: false }], ["watch", { team: "看盘队", onRoster: true, title: "看盘" }], ["news", { team: "新闻队", onRoster: true, title: "新闻" }]]);
	const host = await Host.start(options);
	t.after(() => host.stop());
	const block = await firstBlock(host);
	assert.ok(block.includes("\n- watch（看盘）：盯行情\n- news（新闻）：查新闻、核对报道来源\n"), block);
	assert.doesNotMatch(block, /news-researcher|新闻研究员|market-analyst|行情分析师|mail（/);
});

test("真实接线：没有任何模块时没有领域", async () => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const options = createHostOptions({ config: hostConfig(provider), modules: fixed(Modules.load([])), modelRuntime, log: () => {} });
	assert.deepEqual([...options.domains!.book()], []);
});

test("真实接线：成员的模型只能用 router 或 worker 的提供方，回退模型的提供方不算；提供方对了但模型不存在也在启动前报错", async () => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const withModel = (model: string) => {
		const config = hostConfig(provider);
		config.models.fallback = { provider: "deepseek", id: "deepseek-flash" };
		writeFiles(join(config.stateDir, "modules"), moduleFiles("news", { team: "新闻队" }, { "agents/news.md": memberFile("news-researcher", "新闻研究员", `model: ${model}\n`) }));
		return { config, file: join(config.stateDir, "modules/news/agents/news.md") };
	};
	const paid = withModel("deepseek/deepseek-flash");
	assert.throws(() => loadWith(paid.config), (e: Error) => e.message.startsWith(paid.file) && /拒绝使用 deepseek\/deepseek-flash/.test(e.message));
	const missing = withModel(`${provider}/no-such-model`);
	assert.throws(() => createHostOptions({ config: missing.config, modules: fixed(loadWith(missing.config)), modelRuntime, log: () => {} }), (e: Error) => e.message.startsWith(missing.file) && /找不到模型 .*no-such-model/.test(e.message));
});

test("真实接线：router 和 worker 的提供方不同时，成员的模型用其中哪一家都行，别家的不行", () => {
	const loadMember = (model: string) => {
		const config = hostConfig("openai-codex");
		config.models.worker = { provider: "deepseek", id: "worker" };
		writeFiles(join(config.stateDir, "modules"), moduleFiles("news", { team: "新闻队" }, { "agents/news.md": memberFile("news-researcher", "新闻研究员", `model: ${model}\n`) }));
		return loadWith(config).modules[0].team!.members[0].model;
	};
	assert.deepEqual(loadMember("deepseek/deepseek-flash"), { provider: "deepseek", id: "deepseek-flash" });
	assert.deepEqual(loadMember("openai-codex/gpt-6.1-sol"), { provider: "openai-codex", id: "gpt-6.1-sol" });
	assert.throws(() => loadMember("faux/any"), /拒绝使用 faux\/any.*提供方：openai-codex、deepseek$/);
});

test("真实接线：宿主知道每个领域的助手能派给谁，时限和并发上限取自配置；没有加载的模块答不上来", async () => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const config = hostConfig(provider);
	writeFiles(join(config.stateDir, "modules"), NEWS_MODULE);
	const { dispatch, domains } = createHostOptions({ config, modules: fixed(loadWith(config)), modelRuntime, log: () => {} });
	assert.deepEqual(domains!.kitFor("news", null)!.crew.map((m) => [m.name, m.title]), [["news-researcher", "新闻研究员"]]);
	assert.equal(domains!.kitFor("old", null), undefined);
	assert.deepEqual(dispatch, { timeoutMs: 60_000, codingTimeoutMs: 600_000, stallMs: 45_000, maxConcurrent: 2 });
});

test("真实接线：仓库里的玩具行情模块按领域交出自己的 skills/", async () => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const modules = Modules.load([REPO_MODULES], { switches: { values: { "toy-market": true }, file: "config.json" } });
	const { domains } = createHostOptions({ config: hostConfig(provider), modules: fixed(modules), modelRuntime, log: () => {} });
	assert.equal(domains!.kitFor("toy-market", null)!.skillsDir, join(REPO_MODULES, "toy-market/skills"));
});

const TG_TOKEN = "123456789:AAH-fake_token_for_wiring_tests_00";

function telegramConfig(secrets?: string) {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-tg-"));
	let secretsFile: string | undefined;
	if (secrets !== undefined) writeFileSync((secretsFile = join(stateDir, "secrets.env")), secrets);
	return { stateDir, secretsFile, telegram: { allowedUserIds: [42] } };
}

test("Telegram 接线：没写 telegram 段时不建客户端，也不读 token", () => {
	assert.equal(telegramOptions({ ...telegramConfig(), telegram: undefined }, { TELEGRAM_BOT_TOKEN: "garbage" }, () => {}), undefined);
});

test("Telegram 接线：写了 telegram 段但环境变量和 secretsFile 里都没有 token 时启动前报错", () => {
	assert.throws(() => telegramOptions(telegramConfig("OTHER=1\n"), {}, () => {}), (e: Error) => e.name === "ConfigError" && /TELEGRAM_BOT_TOKEN/.test(e.message) && /config\.json/.test(e.message));
});

test("Telegram 接线：token 先读环境变量再读 secretsFile；日志写来源不写 token；名单交给客户端", () => {
	const logs: string[] = [];
	const fromFile = telegramOptions(telegramConfig(`TELEGRAM_BOT_TOKEN=${TG_TOKEN}\n`), {}, (l) => logs.push(l))!;
	assert.equal(fromFile.api.botId, 123456789);
	assert.deepEqual([...fromFile.allowedUserIds], [42]);
	const fromEnv = telegramOptions(telegramConfig("TELEGRAM_BOT_TOKEN=987654321:AAH-other_token_in_the_secrets_file\n"), { TELEGRAM_BOT_TOKEN: TG_TOKEN }, (l) => logs.push(l))!;
	assert.equal(fromEnv.api.botId, 123456789);
	assert.match(logs[0], /\[telegram\] bot token 来自secretsFile /);
	assert.equal(logs[1], "[telegram] bot token 来自环境变量 TELEGRAM_BOT_TOKEN");
	assert.ok(!logs.some((l) => l.includes(TG_TOKEN.split(":")[1])));
});

test("Telegram 接线：token 格式不对时启动前报错，报错里没有 token", () => {
	assert.throws(() => telegramOptions(telegramConfig(), { TELEGRAM_BOT_TOKEN: "not-a-token-AAH-secret-part" }, () => {}), (e: Error) => e.name === "ConfigError" && !e.message.includes("secret-part"));
});

test("真实接线：config 里有 telegram 段时宿主选项带上 Telegram 客户端", async (t) => {
	withoutKeyVars(t);
	const saved = process.env.TELEGRAM_BOT_TOKEN;
	process.env.TELEGRAM_BOT_TOKEN = TG_TOKEN;
	t.after(() => (saved === undefined ? delete process.env.TELEGRAM_BOT_TOKEN : (process.env.TELEGRAM_BOT_TOKEN = saved)));
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const options = createHostOptions({ config: { ...hostConfig(provider), telegram: { allowedUserIds: [42] } }, modules: fixed(Modules.load([])), modelRuntime, log: () => {} });
	assert.equal(options.telegram?.api.botId, 123456789);
	assert.equal(createHostOptions({ config: hostConfig(provider), modules: fixed(Modules.load([])), modelRuntime, log: () => {} }).telegram, undefined);
});

test("接线把模块表交给宿主时不拍快照：换表以后宿主的领域簿和成员都是新表的；钉着版本的任务问钉住的副本", async () => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const empty = Modules.load([]);
	const repo = servedAsHost(Modules.load([REPO_MODULES]));
	const live = liveRegistry(empty);
	const pinned = { skillsDir: "/copy/skills", prepare: undefined, crew: [], granted: [] };
	const options = createHostOptions({ config: hostConfig(provider), modules: { live, kitFor: (domain, pin) => (pin === null ? live.current().kitFor(domain) : pinned) }, modelRuntime, log: () => {} });
	assert.deepEqual([...options.domains!.book().keys()], []);
	live.publish(repo);
	assert.deepEqual([...options.domains!.book().keys()], ["module-builder", "pi-pi"]);
	assert.equal(options.domains!.kitFor("pi-pi", null)!.crew.length, 9);
	assert.equal(options.domains!.kitFor("tax", "abc"), pinned);
});

async function envProbe(secretsText: string) {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const config = hostConfig(provider);
	const pkg = join(mkdtempSync(join(tmpdir(), "psa-wire-pkg-")), "personal-tax");
	cpSync(join(import.meta.dirname, "../docs/modules/architecture/sample/personal-tax"), pkg, { recursive: true });
	mkdirSync(join(pkg, "tools/env-probe"));
	writeFileSync(join(pkg, "tools/env-probe/tool.json"), JSON.stringify({ title: "密钥", description: "回显密钥", effect: "read", secrets: ["PERSONAL_TAX__KEY"], input: { x: { type: "text", title: "x" } }, output: { named: { type: "text", title: "n" } } }));
	writeFileSync(join(pkg, "tools/env-probe/index.ts"), "export default () => ({ named: process.env.PERSONAL_TAX__KEY ?? null });");
	const secretsFile = join(config.stateDir, "secrets.env");
	writeFileSync(secretsFile, secretsText);
	const modules = servedAsHost(Modules.load([join(pkg, "..")]));
	const digest = modules.book.get("personal-tax")!.digest! as Digest;
	new ModuleStore(join(config.stateDir, "module-store")).keep("personal-tax" as ModuleName, digest, pkg);
	const logs: string[] = [];
	const options = createHostOptions({ config: { ...config, secretsFile }, modules: fixed(modules), modelRuntime, log: (l) => logs.push(l) });
	const caller = { who: "worker" as const, ticket: "tkt_1", pin: { module: "personal-tax" as ModuleName, digest }, basis: "request" as const, member: null, heardOthers: false };
	return { reply: await options.gateway!.call(caller, { kind: "tool", name: "env-probe" as ComponentName, input: {} }), logs };
}

test("入口：宿主的 Gateway 从状态目录的模块副本里跑工具，密钥值取自 secretsFile，每次调用记一行日志", async () => {
	const { reply, logs } = await envProbe("PERSONAL_TAX__KEY=from-file\n");
	assert.deepEqual(reply, { ok: true, output: { named: "from-file" } });
	assert.ok(logs.some((l) => l.startsWith("[gateway] personal-tax tools/env-probe")), logs.join("\n"));
});

test("入口：宿主进程环境里的同名变量到不了模块代码，模块的密钥只取自 secretsFile", async (t) => {
	process.env.PERSONAL_TAX__KEY = "from-host-env";
	t.after(() => delete process.env.PERSONAL_TAX__KEY);
	assert.deepEqual((await envProbe("PERSONAL_TAX__KEY=from-file\n")).reply, { ok: true, output: { named: "from-file" } });
	assert.deepEqual((await envProbe("OTHER=x\n")).reply, { ok: true, output: { named: null } });
});

async function draftProbe(t: TestContext, feedFixtures: boolean, oauthUrl: (google: FakeGoogle) => string | undefined) {
	const box = new FakeInbox();
	const sent = box.drafts;
	const google = await startFakeGoogle({ refreshTokens: { "1//draft": "https://www.googleapis.com/auth/gmail.compose" }, routes: box.routes });
	t.after(() => google.close());
	const url = oauthUrl(google);
	if (url === undefined) delete process.env.PSA_GOOGLE_OAUTH_URL;
	else process.env.PSA_GOOGLE_OAUTH_URL = url;
	t.after(() => delete process.env.PSA_GOOGLE_OAUTH_URL);
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const config = hostConfig(provider);
	const pkg = join(mkdtempSync(join(tmpdir(), "psa-wire-pkg-")), "mail");
	mkdirSync(join(pkg, "tools/echo"), { recursive: true });
	writeFileSync(join(pkg, "module.json"), JSON.stringify({ schema: 1, name: "mail", version: "0.1.0", title: "邮件", description: "测试" }));
	writeFileSync(join(pkg, "tools/echo/tool.json"), JSON.stringify({ title: "草稿", description: "草稿", effect: "write", port: "gmail.createDraft", input: { x: { type: "text", title: "x" } }, output: { draftId: { type: "text", title: "d" } } }));
	writeFileSync(join(pkg, "tools/echo/index.ts"), 'export default () => ({ draft: { raw: "To: ann@example.com\\r\\nSubject: hi\\r\\n\\r\\nok", threadId: "t-1" } });');
	const secretsFile = join(config.stateDir, "secrets.env");
	writeFileSync(secretsFile, `GOOGLE_OAUTH_CLIENT_ID=${google.client.id}\nGOOGLE_OAUTH_CLIENT_SECRET=${google.client.secret}\nGMAIL_DRAFT_REFRESH_TOKEN=1//draft\n`);
	const modules = servedAsHost(Modules.load([join(pkg, "..")]));
	const digest = modules.book.get("mail")!.digest! as Digest;
	new ModuleStore(join(config.stateDir, "module-store")).keep("mail" as ModuleName, digest, pkg);
	const options = createHostOptions({ config: { ...config, secretsFile, feedFixtures }, modules: fixed(modules), modelRuntime, log: () => {} });
	const caller = { who: "worker" as const, ticket: "tkt_1", pin: { module: "mail" as ModuleName, digest }, basis: "request" as const, member: null, heardOthers: false };
	return { reply: await options.gateway!.call(caller, { kind: "tool", name: "echo" as ComponentName, input: {} }), google, sent };
}

test("入口：宿主的 Gateway 用 secretsFile 里写草稿的 token 经口子建草稿", async (t) => {
	const { reply, google, sent } = await draftProbe(t, false, (g) => g.url);
	assert.ok(reply.ok, JSON.stringify(reply));
	assert.equal((reply.output as { draftId: string }).draftId, "r-1");
	assert.deepEqual(google.log, ["POST /token", "POST /gmail/v1/users/me/drafts"]);
	assert.equal(sent.length, 1);
});

test("入口：fixtures 预演的宿主不建真草稿", async (t) => {
	const { reply, google } = await draftProbe(t, true, () => undefined);
	assert.equal(reply.ok, false);
	assert.match(reply.ok ? "" : String((reply.refusal as { note: string }).note), /fixtures/);
	assert.deepEqual(google.log, []);
});

test("入口：宿主的 Gateway 查模块知识，索引建在状态目录的 modules-data/<模块>/index/knowledge.db", async () => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const config = hostConfig(provider);
	const pkg = join(mkdtempSync(join(tmpdir(), "psa-wire-pkg-")), "personal-health");
	cpSync(join(import.meta.dirname, "../docs/modules/architecture/sample/personal-health"), pkg, { recursive: true });
	const modules = servedAsHost(Modules.load([join(pkg, "..")]));
	const digest = modules.book.get("personal-health")!.digest! as Digest;
	new ModuleStore(join(config.stateDir, "module-store")).keep("personal-health" as ModuleName, digest, pkg);
	const options = createHostOptions({ config, modules: fixed(modules), modelRuntime, log: () => {} });
	const caller = { who: "worker" as const, ticket: "tkt_1", pin: { module: "personal-health" as ModuleName, digest }, basis: "request" as const, member: null, heardOthers: false };
	const reply = await options.gateway!.call(caller, { kind: "knowledge", op: "search", query: "复查" });
	assert.equal(reply.ok && reply.passages?.[0]?.doc, "tumor-marker-basics");
	assert.ok(existsSync(join(config.stateDir, "modules-data/personal-health/index/knowledge.db")));
});

test("真实接线：模块包的 feed 交给调度器，写进 private 数据的 feed 算私密来源；config 的 feedFixtures 打开预演", async () => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const root = mkdtempSync(join(tmpdir(), "psa-wire-feeds-"));
	const pkg = join(root, "lab");
	mkdirSync(join(pkg, "data", "readings"), { recursive: true });
	mkdirSync(join(pkg, "feeds", "tick"), { recursive: true });
	mkdirSync(join(pkg, "feeds", "drop"), { recursive: true });
	writeFileSync(join(pkg, "module.json"), JSON.stringify({ schema: 1, name: "lab", version: "0.1.0" }));
	writeFileSync(join(pkg, "data", "readings", "collection.json"), JSON.stringify({ title: "读数", kind: "series", class: "private", fields: { value: { type: "number", title: "数值" } } }));
	writeFileSync(join(pkg, "feeds", "tick", "feed.json"), JSON.stringify({ title: "整点", connector: "timer", every: "1h", notice: "到点了" }));
	writeFileSync(join(pkg, "feeds", "drop", "feed.json"), JSON.stringify({ title: "投递", connector: "inbox", into: "readings" }));
	const modules = servedAsHost(Modules.load([root]));
	const options = createHostOptions({ config: { ...hostConfig(provider), feedFixtures: true }, modules: fixed(modules), modelRuntime, log: () => {} });
	assert.deepEqual(options.moduleFeeds?.feeds().map((f) => f.source).sort(), ["lab/drop", "lab/tick"]);
	assert.equal(options.moduleFeeds?.fixtures, true);
	assert.deepEqual(options.moduleFeeds?.feeds().map((f) => [f.source, f.private]).sort(), [["lab/drop", true], ["lab/tick", false]]);
	assert.equal(options.sourcePolicy?.({ source: "lab/tick", externalId: "x", threads: [], sender: "lab/tick", body: "到点了", occurredAt: 0 }), "candidate");
});

test("入口：宿主带上 config 里的 OCR（助手的 ocr 和模块工具的 port 用的是同一个）；关掉时它一读就说没开", async () => {
	const { modelRuntime, provider } = await fauxRuntime(() => false);
	const optionsWith = (ocr: object) => createHostOptions({ config: { ...hostConfig(provider), ocr } as never, modules: fixed(Modules.load([])), modelRuntime, log: () => {} });
	const on = optionsWith({ engine: "vision", maxPages: 20, timeoutSeconds: 60 });
	assert.equal(typeof on.ocr?.read, "function");
	await assert.rejects(optionsWith({ engine: "off" }).ocr!.read("/tmp/scan.png"), /这台宿主没开 OCR/);
});
