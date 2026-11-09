import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Kernel } from "../src/kernel/kernel.ts";
import { openStore } from "../src/kernel/store.ts";
import { MarketClient } from "../src/sources/market/client.ts";
import { MarketSource, marketFeed } from "../src/sources/market/source.ts";
import { parseMarketSettings } from "../src/sources/market/settings.ts";
import { ConfigError } from "../src/config-error.ts";
import { fakeHttp, snapshotBody, tickerRow } from "./helpers/market.ts";

const T = (iso: string) => Date.parse(iso);
const DEFAULTS = {
	watchlist: ["NVDA", "SPY"],
	bands: { default: [3, 5, 8], bySymbol: { SPY: [1.5, 2, 3] } },
	volumeSpikeX: 5,
	everySeconds: 60,
	minGapMs: 0,
	baseURL: "https://api.massive.com",
};

function market(options: { dbPath?: string; respond?: (url: string, now: number) => Response } = {}) {
	const dbPath = options.dbPath ?? join(mkdtempSync(join(tmpdir(), "psa-market-")), "state.db");
	const prices: Record<string, number> = { NVDA: 100, SPY: 600 };
	const { clock, calls, http } = fakeHttp((url, now) =>
		options.respond ? options.respond(url, now) : Response.json(snapshotBody(Object.entries(prices).map(([s, p]) => tickerRow(s, p, s === "SPY" ? 600 : 100, now - 60_000)))),
	T("2026-11-09T15:00:00Z"));
	const kernel = new Kernel({ db: openStore(dbPath), clock, sourcePolicy: (t) => (t.source === "watchdog" ? "notice" : "candidate") });
	const client = new MarketClient({ key: "k", baseURL: DEFAULTS.baseURL, minGapMs: 0, http, clock, sleep: async () => {} });
	const logs: string[] = [];
	let failWrite = false;
	const source = new MarketSource({
		source: "us-market",
		title: "美股行情",
		settings: parseMarketSettings(DEFAULTS, undefined, "test"),
		client,
		ctx: {
			clock,
			submit: (t) => void kernel.submitTrigger(t),
			readCursor: () => kernel.sourceCursor("us-market"),
			writeCursor: (v) => {
				if (failWrite) {
					failWrite = false;
					throw new Error("宿主在写游标前崩溃");
				}
				kernel.setSourceCursor("us-market", v);
			},
			log: (l) => logs.push(l),
		},
	});
	const triggers = () => kernel.triggerLog().map((t) => ({ source: t.source, externalId: t.externalId, disposition: t.disposition })).reverse();
	return { source, kernel, clock, prices, requests: calls, logs, triggers, dbPath, crashBeforeCursor: () => { failWrite = true; } };
}

test("看盘：周末不发任何请求", async () => {
	const m = market();
	m.clock.t = T("2026-11-07T15:00:00Z");
	await m.source.tick();
	assert.deepEqual([m.requests.length, m.triggers()], [0, []]);
});

test("看盘：盘中 NVDA 涨 5.3% 提交一条到 Router 的触发；同一价格再看一次不重复", async () => {
	const m = market();
	m.prices.NVDA = 105.3;
	await m.source.tick();
	await m.source.tick();
	assert.deepEqual(m.triggers(), [{ source: "us-market", externalId: "NVDA:2026-11-09:up5", disposition: "to_router" }]);
	assert.equal(m.requests.length, 2);
});

test("持久：重启后（同一个状态库、新的看盘实例）同一档位不再报，更高的档位照报", async () => {
	const first = market();
	first.prices.NVDA = 105.3;
	await first.source.tick();
	const second = market({ dbPath: first.dbPath });
	second.prices.NVDA = 105.6;
	await second.source.tick();
	second.prices.NVDA = 108.2;
	await second.source.tick();
	assert.deepEqual(second.triggers().map((t) => t.externalId), ["NVDA:2026-11-09:up5", "NVDA:2026-11-09:up8"]);
});

test("持久：提交触发之后、写游标之前崩溃，重放这一轮也只存一条", async () => {
	const m = market();
	m.prices.NVDA = 105.3;
	m.crashBeforeCursor();
	await assert.rejects(m.source.tick(), /崩溃/);
	await m.source.tick();
	assert.deepEqual(m.triggers().map((t) => t.externalId), ["NVDA:2026-11-09:up5"]);
});

test("订阅：任务订阅了当天的线程后，同一只股票的下一档直达这个任务；第二天的波动回到 Router", async () => {
	const m = market();
	m.prices.NVDA = 103.4;
	await m.source.tick();
	const [first] = m.kernel.triggerLog();
	const [opened] = m.kernel.route([{ kind: "open_ticket", basis: "rule", ruleId: "us-market/big-move", title: "NVDA 异动", brief: "核实", triggerId: first.id, threads: ["thr_us-market:NVDA:2026-11-09"] }]);
	assert.ok(opened.ok);
	m.prices.NVDA = 105.3;
	await m.source.tick();
	m.clock.t = T("2026-11-10T15:00:00Z");
	await m.source.tick();
	assert.deepEqual(m.triggers().map((t) => [t.externalId, t.disposition]), [
		["NVDA:2026-11-09:up3", "opened_ticket"],
		["NVDA:2026-11-09:up5", "delivered"],
		["NVDA:2026-11-10:up5", "to_router"],
	]);
});

test("节假日：开盘半小时后仍没有今天的报价，当天不再请求", async () => {
	const m = market({ respond: () => Response.json(snapshotBody([tickerRow("NVDA", 110, 100, T("2026-11-06T20:59:00Z"))])) });
	for (let t = T("2026-11-09T14:30:00Z"); t <= T("2026-11-09T21:00:00Z"); t += 60_000) {
		m.clock.t = t;
		await m.source.tick();
	}
	assert.deepEqual([m.requests.length, m.triggers()], [30, []]);
});

test("节假日：宿主 10:05 才起来、第一次响应碰巧没有新鲜报价，不会因此当天停看", async () => {
	let empty = true;
	const m = market({ respond: (_url, now) => Response.json(snapshotBody(empty ? [] : [tickerRow("NVDA", 105.3, 100, now)])) });
	m.clock.t = T("2026-11-09T15:05:00Z");
	await m.source.tick();
	empty = false;
	m.clock.t += 60_000;
	await m.source.tick();
	assert.deepEqual([m.requests.length, m.triggers().map((t) => t.externalId)], [2, ["NVDA:2026-11-09:up5"]]);
});

test("节假日判断只看今天是否见过新鲜报价：盘中见过之后，一次空响应不会让当天停看", async () => {
	let empty = false;
	const m = market({ respond: (_url, now) => Response.json(snapshotBody(empty ? [] : [tickerRow("NVDA", 100, 100, now)])) });
	await m.source.tick();
	empty = true;
	m.clock.t += 60_000;
	await m.source.tick();
	empty = false;
	m.clock.t += 60_000;
	await m.source.tick();
	assert.equal(m.requests.length, 3);
});

test("没有密钥：看盘停用，页面上的问题写「未配置行情密钥」，查询直接拒绝", async () => {
	const logs: string[] = [];
	const spec = marketFeed({ source: "us-market", title: "美股行情", settings: DEFAULTS, override: undefined, where: "test", secretsFile: undefined, env: {}, log: (l) => logs.push(l) });
	const feed = spec.create({ clock: { now: () => T("2026-11-09T15:00:00Z") }, submit: () => assert.fail("不该提交"), readCursor: () => undefined, writeCursor: () => {}, log: () => {} });
	feed.start();
	assert.equal(feed.problem(), "未配置行情密钥");
	await assert.rejects(feed.lookup("session", {}), /停用.*未配置行情密钥/);
	feed.stop();
	assert.match(logs.join("\n"), /未配置行情密钥/);
});

test("401：看盘停用、记一行日志、之后不再请求", async () => {
	const m = market({ respond: () => new Response("nope", { status: 401 }) });
	await m.source.tick();
	m.clock.t += 60_000;
	await m.source.tick();
	assert.equal(m.requests.length, 1);
	assert.match(m.source.problem()!, /401/);
	assert.equal(m.logs.filter((l) => /停用/.test(l)).length, 1);
});

test("连续 15 分钟取不到行情时提交一条通知让幕僚长告诉使用者，只提交一次；恢复后清零", async () => {
	let down = true;
	const m = market({ respond: (_url, now) => (down ? new Response("", { status: 502 }) : Response.json(snapshotBody([tickerRow("NVDA", 100, 100, now)]))) });
	for (let i = 0; i <= 20; i++) {
		await m.source.tick();
		m.clock.t += 60_000;
	}
	const notices = () => m.triggers().filter((t) => t.source === "watchdog");
	assert.equal(notices().length, 1);
	assert.match(m.kernel.triggerLog()[0].body, /15 分钟.*HTTP 502/);
	assert.match(m.source.problem()!, /HTTP 502/);
	down = false;
	await m.source.tick();
	assert.equal(m.source.problem(), undefined);
	down = true;
	for (let i = 0; i <= 15; i++) {
		m.clock.t += 60_000;
		await m.source.tick();
	}
	assert.equal(notices().length, 2);
});

test("查询：quote 返回数字报价，bars 返回 K 线，session 返回交易时段", async () => {
	const m = market({
		respond: (url) => url.includes("/aggs/")
			? Response.json({ status: "OK", results: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, vw: 1.2, n: 3 }] })
			: Response.json(snapshotBody([tickerRow("AMD", 150, 160, T("2026-11-09T14:59:00Z"))])),
	});
	assert.deepEqual(await m.source.lookup("quote", { symbols: ["AMD"] }), [
		{ symbol: "AMD", price: 150, prevClose: 160, changePct: -6.25, at: T("2026-11-09T14:59:00Z"), delayed: true, dayVolume: 5_000_000 },
	]);
	assert.ok(m.requests.at(-1)!.url.endsWith("tickers=AMD"));
	assert.deepEqual(await m.source.lookup("bars", { symbol: "AMD", span: "minute", from: "2026-11-09", to: "2026-11-09" }), [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }]);
	assert.ok(m.requests.at(-1)!.url.includes("/v2/aggs/ticker/AMD/range/1/minute/2026-11-09/2026-11-09"));
	assert.deepEqual(await m.source.lookup("session", {}), { nyDate: "2026-11-09", phase: "regular" });
});

test("查询：参数严格校验，不合法的代码、日期、多余字段和未知操作都直接拒绝且不发请求", async () => {
	const m = market();
	const bad: [string, unknown, RegExp][] = [
		["quote", { symbols: ["A/../B"] }, /symbols/],
		["quote", { symbols: [] }, /symbols/],
		["quote", { symbols: ["NVDA"], note: "x" }, /note/],
		["bars", { symbol: "NVDA", span: "second", from: "2026-11-09", to: "2026-11-09" }, /span/],
		["bars", { symbol: "NVDA", span: "day", from: "2026-11-09?apiKey=x", to: "2026-11-09" }, /from/],
		["news", {}, /quote.*bars.*session/],
	];
	for (const [op, args, error] of bad) await assert.rejects(m.source.lookup(op, args), error, `${op} ${JSON.stringify(args)}`);
	assert.equal(m.requests.length, 0);
});

test("设置：config.json 的覆盖按字段替换模块默认值；拼错字段名或地址不在白名单时报配置错误", () => {
	assert.deepEqual(parseMarketSettings(DEFAULTS, { watchlist: ["amd", "brk.b"] }, "x").watchlist, ["AMD", "BRK.B"]);
	assert.throws(() => parseMarketSettings(DEFAULTS, { watchlst: ["AMD"] }, "config.json"), (e: Error) => e instanceof ConfigError && /watchlst/.test(e.message));
	assert.throws(() => parseMarketSettings(DEFAULTS, { baseURL: "https://evil.example" }, "x"), ConfigError);
	assert.throws(() => parseMarketSettings(DEFAULTS, { watchlist: ["NV DA"] }, "x"), ConfigError);
	assert.throws(() => parseMarketSettings(DEFAULTS, { bands: { default: [] } }, "x"), ConfigError);
});

test("设置：数字字段必须是有限的数、该是整数的是整数、在上下限之内；字符串数字、超大值、错类型都报配置错误并写出字段路径", () => {
	const bad: [unknown, RegExp][] = [
		[{ minGapMs: "12000" }, /minGapMs/],
		[{ minGapMs: 12000.5 }, /minGapMs/],
		[{ minGapMs: 3e9 }, /minGapMs/],
		[{ everySeconds: 3e6 }, /everySeconds/],
		[{ everySeconds: "60" }, /everySeconds/],
		[{ everySeconds: 30.5 }, /everySeconds/],
		[{ volumeSpikeX: "6" }, /volumeSpikeX/],
		[{ volumeSpikeX: Number.POSITIVE_INFINITY }, /volumeSpikeX/],
		[{ bands: { default: ["3", 5] } }, /bands\.default/],
		[{ bands: { default: [3, 1e9] } }, /bands\.default/],
		[{ bands: { default: [3, 5], bySymbol: { SPY: [1, "2"] } } }, /bands\.bySymbol\.SPY/],
		[{ bands: { default: [3, 5], bySymbol: { "S P Y": [1, 2] } } }, /bands\.bySymbol/],
		[{ bands: { default: [3, 5], bySymbol: [] } }, /bands\.bySymbol/],
		[{ watchlist: Array.from({ length: 51 }, (_, i) => `S${i}`) }, /watchlist/],
		["watchlist", /sources/],
	];
	for (const [override, field] of bad) {
		assert.throws(() => parseMarketSettings(DEFAULTS, override, "sources.us-market"), (e: Error) => e instanceof ConfigError && field.test(e.message), JSON.stringify(override));
	}
	assert.deepEqual(parseMarketSettings(DEFAULTS, { everySeconds: 15, minGapMs: 12000, volumeSpikeX: 2.5 }, "x").everySeconds, 15);
});

test("取不到行情的计时只算轮询窗口内：收盘后一次失败加第二天开盘一次失败不发通知，第二天连续 15 分钟才发；跨收盘的故障第二天还会再通知", async () => {
	let down = true;
	const m = market({ respond: (_url, now) => (down ? new Response("", { status: 502 }) : Response.json(snapshotBody([tickerRow("NVDA", 100, 100, now)]))) });
	const notices = () => m.kernel.triggerLog().filter((t) => t.source === "watchdog").map((t) => t.body);
	const tickAt = async (iso: string) => {
		m.clock.t = T(iso);
		await m.source.tick();
	};
	await tickAt("2026-11-09T21:15:00Z");
	await tickAt("2026-11-09T21:30:00Z");
	await tickAt("2026-11-10T14:30:00Z");
	assert.deepEqual(notices(), []);
	for (let minute = 31; minute <= 45; minute++) await tickAt(`2026-11-10T14:${minute}:00Z`);
	assert.equal(notices().length, 1);
	assert.match(notices()[0], /连续 15 分钟/);
	await tickAt("2026-11-10T20:40:00Z");
	await tickAt("2026-11-10T21:00:00Z");
	await tickAt("2026-11-10T21:30:00Z");
	for (let minute = 30; minute <= 45; minute++) await tickAt(`2026-11-11T14:${minute}:00Z`);
	assert.equal(notices().length, 2);
	assert.match(notices()[0], /连续 15 分钟/);
	down = false;
});
