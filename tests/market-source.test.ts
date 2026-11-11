import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Kernel } from "../src/kernel/kernel.ts";
import { openStore } from "../src/kernel/store.ts";
import { MarketClient } from "../src/sources/market/client.ts";
import { FinnhubClient } from "../src/sources/market/finnhub.ts";
import { MarketSource, marketFeed, type MarketSourceOptions } from "../src/sources/market/source.ts";
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

function market(options: { dbPath?: string; respond?: (url: string, now: number) => Response; paced?: boolean } = {}) {
	const dbPath = options.dbPath ?? join(mkdtempSync(join(tmpdir(), "psa-market-")), "state.db");
	const prices: Record<string, number> = { NVDA: 100, SPY: 600 };
	const prevCloses: Record<string, number> = { SPY: 600 };
	const { clock, calls, http, sleep } = fakeHttp((url, now) =>
		options.respond ? options.respond(url, now) : Response.json(snapshotBody(Object.entries(prices).map(([s, p]) => tickerRow(s, p, prevCloses[s] ?? 100, now - 60_000)))),
	T("2026-11-09T15:00:00Z"));
	const kernel = new Kernel({ db: openStore(dbPath), clock, sourcePolicy: (t) => (t.source === "watchdog" ? "notice" : "candidate") });
	const client = new MarketClient({ key: "sk-test-secret", baseURL: DEFAULTS.baseURL, minGapMs: options.paced ? 12_000 : 0, http, clock, sleep: options.paced ? sleep : async () => {} });
	const logs: string[] = [];
	let failWrite = false;
	const sourceOptions: MarketSourceOptions = {
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
			readUserData: () => kernel.sourceUserData("us-market"),
			writeUserData: (v) => kernel.setSourceUserData("us-market", v),
			post: (line) => void kernel.postHostLine("us-market", line),
			raised: (externalId) => kernel.raised("us-market", externalId),
			log: (l) => logs.push(l),
		},
	};
	const source = new MarketSource(sourceOptions);
	const triggers = () => kernel.triggerLog().map((t) => ({ source: t.source, externalId: t.externalId, disposition: t.disposition })).reverse();
	return { source, options: sourceOptions, kernel, clock, prices, prevCloses, requests: calls, logs, triggers, dbPath, crashBeforeCursor: () => { failWrite = true; } };
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
	assert.throws(() => feed.tripwires("list", {}), /停用.*未配置行情密钥/);
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
	assert.deepEqual(await m.source.lookup("quote", { symbols: ["AMD"] }), {
		quotes: [{ symbol: "AMD", price: 150, prevClose: 160, changePct: -6.25, at: T("2026-11-09T14:59:00Z"), delayed: true, dayVolume: 5_000_000 }],
		fromCache: false,
		cachedAgeMs: 0,
	});
	assert.ok(m.requests.at(-1)!.url.endsWith("tickers=AMD"));
	assert.deepEqual(await m.source.lookup("bars", { symbol: "AMD", span: "minute", from: "2026-11-09", to: "2026-11-09" }), { bars: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }], fromCache: false, cachedAgeMs: 0 });
	assert.ok(m.requests.at(-1)!.url.includes("/v2/aggs/ticker/AMD/range/1/minute/2026-11-09/2026-11-09"));
	assert.deepEqual(await m.source.lookup("session", {}), { nyDate: "2026-11-09", phase: "regular", fromCache: false, cachedAgeMs: 0 });
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

test("查询自选股时复用不到一个轮询周期的看盘快照，不多花请求；自选以外的代码和过期的快照才去请求", async () => {
	const m = market();
	m.prices.NVDA = 102;
	await m.source.tick();
	m.clock.t += 30_000;
	const { quotes: [nvda], fromCache, cachedAgeMs } = (await m.source.lookup("quote", { symbols: ["NVDA"] })) as { quotes: { symbol: string; price: number }[]; fromCache: boolean; cachedAgeMs: number };
	assert.deepEqual([nvda.symbol, nvda.price, m.requests.length, fromCache, cachedAgeMs], ["NVDA", 102, 1, true, 30_000]);
	await m.source.lookup("quote", { symbols: ["NVDA", "AMD"] });
	assert.deepEqual([m.requests.length, m.requests.at(-1)!.url.endsWith("tickers=AMD")], [2, true]);
	m.clock.t += 31_000;
	await m.source.lookup("quote", { symbols: ["NVDA"] });
	assert.equal(m.requests.length, 3);
});

test("查询：indicators 用默认窗口取 K 线（日线 400 天、小时线 30 天、分钟线 4 天，截至纽约今天）并返回程序算好的指标", async () => {
	const day = 86_400_000;
	const results = Array.from({ length: 60 }, (_, i) => ({ t: T("2026-08-01T04:00:00Z") + i * day, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1000 }));
	const m = market({ respond: () => Response.json({ status: "OK", results: [...results].reverse() }) });
	const r = (await m.source.lookup("indicators", { symbol: "nvda", span: "day" })) as Record<string, unknown>;
	assert.ok(m.requests.at(-1)!.url.includes("/v2/aggs/ticker/NVDA/range/1/day/2025-10-05/2026-11-09?"));
	assert.ok(m.requests.at(-1)!.url.includes("limit=5000"));
	assert.equal(r.symbol, "NVDA");
	assert.equal(r.span, "day");
	assert.equal(r.from, "2025-10-05");
	assert.equal(r.to, "2026-11-09");
	assert.equal(r.bars, 60);
	assert.deepEqual(r.lastBar, { start: results.at(-1)!.t, end: results.at(-1)!.t + 16 * 3_600_000, partial: false });
	assert.equal(r.lastPrice, 159);
	assert.equal(r.sma20, 149.5);
	assert.deepEqual(r.sma200, { insufficient: { need: 200, have: 60 } });
	await m.source.lookup("indicators", { symbol: "NVDA", span: "hour" });
	assert.ok(m.requests.at(-1)!.url.includes("/range/1/hour/2026-10-10/2026-11-09?"));
	await m.source.lookup("indicators", { symbol: "NVDA", span: "minute", to: "2026-11-06" });
	assert.ok(m.requests.at(-1)!.url.includes("/range/1/minute/2026-11-02/2026-11-06?"));
	await m.source.lookup("indicators", { symbol: "NVDA", span: "day", from: "2026-01-02", to: "2026-03-02" });
	assert.ok(m.requests.at(-1)!.url.includes("/range/1/day/2026-01-02/2026-03-02?"));
});

test("查询：indicators 没有 K 线时报错，参数不合法时不发请求", async () => {
	const m = market({ respond: () => Response.json({ status: "OK", results: [] }) });
	await assert.rejects(m.source.lookup("indicators", { symbol: "NVDA", span: "day" }), /没有.*K 线/);
	const before = m.requests.length;
	const bad: unknown[] = [
		{ symbol: "NVDA", span: "week" },
		{ symbol: "NV/DA", span: "day" },
		{ symbol: "NVDA", span: "day", from: "2026-1-2" },
		{ symbol: "NVDA", span: "day", limit: 5 },
		{ symbol: "NVDA", span: "day", from: "2026-11-09", to: "2026-11-01" },
	];
	for (const args of bad) await assert.rejects(m.source.lookup("indicators", args), /indicators/, JSON.stringify(args));
	assert.equal(m.requests.length, before);
});

test("查询：earnings 走 Finnhub 客户端，用纽约今天找下次财报；没有 Finnhub 密钥时只有 earnings 报错，其余查询照常", async () => {
	const m = market({ respond: () => Response.json(snapshotBody([tickerRow("AMD", 150, 160, T("2026-11-09T14:59:00Z"))])) });
	await assert.rejects(m.source.lookup("earnings", { symbol: "NVDA" }), /未配置 FINNHUB_API_KEY/);
	assert.equal((await m.source.lookup("quote", { symbols: ["AMD"] }) as { quotes: unknown[] }).quotes.length, 1);
	const f = fakeHttp((url) => Response.json(url.includes("/calendar/") ? { earningsCalendar: [{ date: "2026-11-19", hour: "amc", symbol: "NVDA" }] } : []), T("2026-11-09T15:00:00Z"));
	const withKey = market();
	const source = new MarketSource({ ...withKey.options, earnings: new FinnhubClient({ key: "fh", minGapMs: 0, http: f.http, clock: f.clock, sleep: f.sleep }) });
	assert.deepEqual(await source.lookup("earnings", { symbol: "nvda" }), { symbol: "NVDA", next: { date: "2026-11-19", hour: "amc" }, quarters: [], fromCache: false, cachedAgeMs: 0 });
	assert.ok(f.calls[0]!.url.includes("from=2025-10-05&to=2027-03-09"));
	await assert.rejects(source.lookup("earnings", { symbol: "NVDA", span: "day" }), /span/);
	await assert.rejects(source.lookup("earnings", { symbol: "N V" }), /symbol/);
	assert.equal(f.calls.length, 2);
});

test("密钥接线：marketFeed 从 secretsFile 读 FINNHUB_API_KEY，日志只写来源；没有时写明 earnings 不可用", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-fh-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, ".env");
	writeFileSync(file, "MASSIVE_API_KEY=mk-secret\nFINNHUB_API_KEY=fh-secret\n");
	const logs: string[] = [];
	marketFeed({ source: "us-market", title: "美股行情", settings: DEFAULTS, override: undefined, where: "test", secretsFile: file, env: {}, log: (l) => logs.push(l) });
	assert.match(logs.join("\n"), /Finnhub 密钥来自 secretsFile/);
	assert.ok(!/mk-secret|fh-secret/.test(logs.join("\n")));
	writeFileSync(file, "MASSIVE_API_KEY=mk-secret\n");
	marketFeed({ source: "us-market", title: "美股行情", settings: DEFAULTS, override: undefined, where: "test", secretsFile: file, env: {}, log: (l) => logs.push(l) });
	assert.match(logs.at(-1)!, /未配置 FINNHUB_API_KEY/);
});

test("Finnhub 密钥格式不对：只有 earnings 停用并说明原因，美股行情其余查询照常，日志和错误里没有密钥", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-fh-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, ".env");
	writeFileSync(file, "MASSIVE_API_KEY=mk-secret\nFINNHUB_API_KEY=\"fh bad-secret\"\n");
	const logs: string[] = [];
	const spec = marketFeed({ source: "us-market", title: "美股行情", settings: DEFAULTS, override: undefined, where: "test", secretsFile: file, env: {}, log: (l) => logs.push(l) });
	const feed = spec.create({ clock: { now: () => T("2026-11-09T15:00:00Z") }, submit: () => {}, readCursor: () => undefined, writeCursor: () => {}, readUserData: () => undefined, writeUserData: () => {}, post: () => {}, raised: () => false, log: () => {} });
	t.after(() => feed.stop());
	assert.equal(feed.problem(), undefined);
	assert.deepEqual(await feed.lookup("session", {}), { nyDate: "2026-11-09", phase: "regular", fromCache: false, cachedAgeMs: 0 });
	await assert.rejects(feed.lookup("earnings", { symbol: "NVDA" }), (e: Error) => /earnings 不可用.*Finnhub 密钥.*空白/.test(e.message) && !e.message.includes("bad-secret"));
	assert.match(logs.join("\n"), /Finnhub 密钥.*空白/);
	assert.ok(!/bad-secret|mk-secret/.test(logs.join("\n")));
});

const BARS = { status: "OK", results: [{ t: T("2026-11-06T05:00:00Z"), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] };
type Fresh = { fromCache: boolean; cachedAgeMs: number };

test("缓存：同时来的 5 个相同 indicators 查询只发 1 个请求，都拿到结果", async () => {
	const m = market({ respond: () => Response.json(BARS) });
	const results = (await Promise.all([1, 2, 3, 4, 5].map(() => m.source.lookup("indicators", { symbol: "NVDA", span: "day" })))) as { lastPrice: number }[];
	assert.equal(m.requests.length, 1);
	assert.deepEqual(results.map((r) => r.lastPrice), [1.5, 1.5, 1.5, 1.5, 1.5]);
});

test("缓存 TTL：bars/indicators 日线 10 分钟、小时线 2 分钟、分钟线 60 秒；indicators 复用缓存的 K 线；结果写明是否来自缓存和年龄", async () => {
	for (const [span, ttl] of [["day", 600_000], ["hour", 120_000], ["minute", 60_000]] as const) {
		for (const op of ["indicators", "bars"]) {
			const m = market({ respond: () => Response.json(BARS) });
			const args = op === "bars" ? { symbol: "NVDA", span, from: "2026-11-02", to: "2026-11-06" } : { symbol: "NVDA", span };
			assert.deepEqual(pick(await m.source.lookup(op, args)), { fromCache: false, cachedAgeMs: 0 });
			m.clock.t += ttl - 1;
			assert.deepEqual(pick(await m.source.lookup(op, args)), { fromCache: true, cachedAgeMs: ttl - 1 }, `${op} ${span}`);
			assert.equal(m.requests.length, 1, `${op} ${span}`);
			m.clock.t += 1;
			assert.deepEqual(pick(await m.source.lookup(op, args)), { fromCache: false, cachedAgeMs: 0 });
			assert.equal(m.requests.length, 2, `${op} ${span}`);
		}
	}
});

const pick = (r: unknown) => ({ fromCache: (r as Fresh).fromCache, cachedAgeMs: (r as Fresh).cachedAgeMs });

test("缓存 TTL：quote 不在轮询快照里时缓存 30 秒；earnings 缓存 6 小时；session 现算不发请求", async () => {
	const m = market({ respond: () => Response.json(snapshotBody([tickerRow("AMD", 150, 160, T("2026-11-09T14:59:00Z"))])) });
	await m.source.lookup("quote", { symbols: ["AMD"] });
	m.clock.t += 29_999;
	assert.deepEqual(pick(await m.source.lookup("quote", { symbols: ["AMD"] })), { fromCache: true, cachedAgeMs: 29_999 });
	m.clock.t += 1;
	await m.source.lookup("quote", { symbols: ["AMD"] });
	assert.equal(m.requests.length, 2);
	await m.source.lookup("session", {});
	assert.equal(m.requests.length, 2);

	const f = fakeHttp((url) => Response.json(url.includes("/calendar/") ? { earningsCalendar: [] } : []), T("2026-11-09T15:00:00Z"));
	const e = market();
	const source = new MarketSource({ ...e.options, earnings: new FinnhubClient({ key: "fh", minGapMs: 0, http: f.http, clock: f.clock, sleep: f.sleep }) });
	await source.lookup("earnings", { symbol: "NVDA" });
	e.clock.t += 6 * 3_600_000 - 1;
	assert.deepEqual(pick(await source.lookup("earnings", { symbol: "NVDA" })), { fromCache: true, cachedAgeMs: 6 * 3_600_000 - 1 });
	await source.lookup("earnings", { symbol: "AMD" });
	assert.equal(f.calls.length, 4);
	e.clock.t += 1;
	await source.lookup("earnings", { symbol: "NVDA" });
	assert.equal(f.calls.length, 6);
});

test("缓存键：每个参数不同都是不同的请求；参数相同才复用", async () => {
	const m = market({ respond: () => Response.json(BARS) });
	const base = { symbol: "NVDA", span: "minute", from: "2026-11-02", to: "2026-11-06" };
	for (const args of [base, { ...base, symbol: "AMD" }, { ...base, span: "hour" }, { ...base, from: "2026-11-03" }, { ...base, to: "2026-11-05" }]) await m.source.lookup("bars", args);
	assert.equal(m.requests.length, 5);
	await m.source.lookup("bars", { ...base });
	await m.source.lookup("indicators", { symbol: "NVDA", span: "minute", from: "2026-11-02", to: "2026-11-06" });
	await m.source.lookup("indicators", { symbol: "NVDA", span: "minute", from: "2026-11-02", to: "2026-11-05" });
	assert.equal(m.requests.length, 7);
	const q = market();
	for (const symbols of [["AMD"], ["AMD", "TSLA"], ["TSLA"], ["TSLA", "AMD"]]) await q.source.lookup("quote", { symbols });
	assert.equal(q.requests.length, 3);
});

test("缓存上限：最多 200 条，最久没用的先淘汰", async () => {
	const m = market({ respond: () => Response.json(BARS) });
	const day = (i: number) => new Date(T("2026-01-01T12:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
	for (let i = 0; i <= 200; i++) await m.source.lookup("bars", { symbol: "NVDA", span: "day", from: day(i), to: day(i) });
	assert.equal(m.requests.length, 201);
	await m.source.lookup("bars", { symbol: "NVDA", span: "day", from: day(200), to: day(200) });
	assert.equal(m.requests.length, 201);
	await m.source.lookup("bars", { symbol: "NVDA", span: "day", from: day(0), to: day(0) });
	assert.equal(m.requests.length, 202);
});

test("日志：每次查询一行，写操作、来源（缓存/合用/上游）、排队等待和总耗时，不写密钥", async () => {
	const m = market({ paced: true, respond: () => Response.json(BARS) });
	m.logs.length = 0;
	await Promise.all([
		m.source.lookup("bars", { symbol: "NVDA", span: "day", from: "2026-11-02", to: "2026-11-06" }),
		m.source.lookup("bars", { symbol: "AMD", span: "day", from: "2026-11-02", to: "2026-11-06" }),
		m.source.lookup("bars", { symbol: "AMD", span: "day", from: "2026-11-02", to: "2026-11-06" }),
	]);
	await m.source.lookup("bars", { symbol: "NVDA", span: "day", from: "2026-11-02", to: "2026-11-06" });
	await m.source.lookup("quote", { symbols: ["NV/DA"] }).catch(() => {});
	assert.equal(m.logs.length, 5, m.logs.join("\n"));
	assert.match(m.logs[0]!, /lookup bars NVDA day 2026-11-02～2026-11-06：上游，排队 0ms，总计 \d+ms/);
	assert.match(m.logs[1]!, /lookup bars AMD day .*：上游，排队 12000ms，总计 12000ms/);
	assert.match(m.logs[2]!, /lookup bars AMD day .*：合用进行中的请求，排队 0ms，总计 12000ms/);
	assert.match(m.logs[3]!, /lookup bars NVDA day .*：缓存（\d+ms 前），排队 0ms，总计 0ms/);
	assert.match(m.logs[4]!, /lookup quote：失败（quote 的 symbols 必须是/);
	assert.ok(!m.logs.join("\n").includes("sk-test-secret"));
});

const COST = { symbol: "NVDA", condition: { kind: "cost", pct: 10, basis: 120, shares: 100 } };
const receipts = (m: ReturnType<typeof market>) => m.kernel.conversation().filter((l) => l.who === "receipt").map((l) => l.text);

test("盯盘条件：set 之后重启宿主（同一个状态库、新的 MarketSource），list 里还在", () => {
	const m = market();
	m.source.tripwires("set", COST);
	const again = market({ dbPath: m.dbPath });
	assert.deepEqual(again.source.tripwires("list", {}).tripwires, [{ symbol: "NVDA", kind: "cost", pct: 10, dir: "either", hasShares: true }]);
});

test("盯盘条件：网页的收据写出成本价和股数，回给助手的 echo 和清单都没有", () => {
	const m = market();
	const reply = m.source.tripwires("set", COST);
	const [receipt] = receipts(m);
	assert.match(receipt, /NVDA 成本价 120、100 股/);
	assert.match(reply.echo, /^已添加：NVDA 相对成本价涨跌超过 10% 时提醒/);
	assert.doesNotMatch(JSON.stringify(reply), /120|100 股|"shares"|"basis"/);
});

test("盯盘条件：list 在网页贴一张整份清单的收据，不改状态库", () => {
	const m = market();
	m.source.tripwires("set", COST);
	const stored = m.kernel.sourceUserData("us-market");
	const reply = m.source.tripwires("list", {});
	assert.equal(reply.echo, "现在共 1 条。");
	assert.equal(receipts(m).length, 2);
	assert.match(receipts(m)[1], /^现在共 1 条：\nNVDA 成本价 120、100 股/);
	assert.equal(m.kernel.sourceUserData("us-market"), stored);
});

test("盯盘条件：设成本条件时上一轮看盘有这只的新鲜报价，收据写出现在已在线外", async () => {
	const m = market();
	await m.source.tick();
	m.source.tripwires("set", { symbol: "NVDA", condition: { kind: "cost", pct: 10, basis: 80 } });
	assert.match(receipts(m)[0], /现在已在 \+25\.0%，回到线内后再越过才提醒/);
});

test("盯盘条件：改不成时报错给助手，状态库和网页都不动", () => {
	const m = market();
	assert.throws(() => m.source.tripwires("set", { symbol: "NVDA", condition: { kind: "cost", pct: 10 } }), /没改成：NVDA：新的 cost 条件缺少 basis/);
	assert.throws(() => m.source.tripwires("watch", {}), /未知操作 watch/);
	assert.equal(m.kernel.sourceUserData("us-market"), undefined);
	assert.deepEqual(receipts(m), []);
});

test("盯盘条件：状态库里的清单读不出来时，problem() 写明，set 和 list 被拒，原来的数据不被覆盖", () => {
	const m = market();
	m.kernel.setSourceUserData("us-market", "{坏了");
	const broken = market({ dbPath: m.dbPath });
	assert.match(broken.source.problem() ?? "", /盯盘条件清单读不出来/);
	assert.throws(() => broken.source.tripwires("set", COST), /盯盘条件清单读不出来/);
	assert.throws(() => broken.source.tripwires("list", {}), /盯盘条件清单读不出来/);
	assert.equal(broken.kernel.sourceUserData("us-market"), "{坏了");
});

const alerts = (m: ReturnType<typeof market>) => m.kernel.conversation().filter((l) => l.who === "alert").map((l) => l.text);
const tickersOf = (url: string) => new URL(url).searchParams.get("tickers")!.split(",");

test("盯盘提醒：只在盯盘条件里的股票（AMD）并进同一次快照请求，不多发请求；它涨 9% 不触发 big-move 档位", async () => {
	const m = market();
	m.source.tripwires("set", { symbol: "AMD", condition: { kind: "day", pct: 20 } });
	m.prices.AMD = 109;
	await m.source.tick();
	assert.equal(m.requests.length, 1);
	assert.deepEqual(tickersOf(m.requests[0]!.url), ["NVDA", "SPY", "AMD"]);
	assert.deepEqual([m.triggers(), alerts(m)], [[], []]);
});

test("盯盘提醒：成本条件今天越过 +10% 线（昨收还在线内）贴一条提醒；同价再看、重启后再看都不重复；当天把线改成 8% 另贴一条", async () => {
	const m = market();
	m.source.tripwires("set", COST);
	m.prevCloses.NVDA = 125;
	m.prices.NVDA = 132.48;
	await m.source.tick();
	assert.deepEqual(alerts(m), ["NVDA 相对成本价 +10.40%，到了你设的 +10% 提醒线。现价 132.48。报价时间 09:59 ET（延迟行情）。"]);
	await m.source.tick();
	const again = market({ dbPath: m.dbPath });
	Object.assign(again.prevCloses, m.prevCloses);
	again.prices.NVDA = 132.48;
	await again.source.tick();
	assert.equal(alerts(again).length, 1);
	again.source.tripwires("set", { symbol: "NVDA", condition: { kind: "cost", pct: 8 } });
	await again.source.tick();
	assert.equal(alerts(again).length, 2);
	assert.ok(again.kernel.raised("us-market", "NVDA:2026-11-09:cost-up-8"));
});

test("盯盘提醒：昨收已经在成本线外，今天没有越过，不提醒", async () => {
	const m = market();
	m.source.tripwires("set", COST);
	m.prevCloses.NVDA = 133;
	m.prices.NVDA = 135;
	await m.source.tick();
	assert.deepEqual(alerts(m), []);
});

test("盯盘提醒：当天涨跌条件 5%（不限方向）涨 5.3% 贴一条，同一天跌到 -5.1% 再贴一条跌的", async () => {
	const m = market();
	m.source.tripwires("set", { symbol: "NVDA", condition: { kind: "day", pct: 5 } });
	m.prices.NVDA = 105.3;
	await m.source.tick();
	m.prices.NVDA = 94.9;
	await m.source.tick();
	assert.deepEqual(alerts(m).map((t) => t.split("，")[0]), ["NVDA 涨 +5.30%", "NVDA 跌 -5.10%"]);
	assert.ok(m.kernel.raised("us-market", "NVDA:2026-11-09:day-down-5"));
});

test("盯盘提醒：不是今天常规时段的报价（昨天的旧价、收盘后的盘后价）不提醒", async () => {
	let at = T("2026-11-06T20:59:00Z");
	const m = market({ respond: () => Response.json(snapshotBody([tickerRow("NVDA", 110, 100, at)])) });
	m.source.tripwires("set", { symbol: "NVDA", condition: { kind: "day", pct: 5 } });
	await m.source.tick();
	m.clock.t = T("2026-11-09T21:10:00Z");
	at = T("2026-11-09T21:05:00Z");
	await m.source.tick();
	assert.equal(m.requests.length, 2);
	assert.deepEqual(alerts(m), []);
});

test("盯盘提醒：提醒文字没有成本价和股数", async () => {
	const m = market();
	m.source.tripwires("set", { symbol: "NVDA", condition: { kind: "cost", pct: 10, basis: 120, shares: 37 } });
	m.source.tripwires("set", { symbol: "SPY", condition: { kind: "cost", pct: 3, basis: 580, shares: 46, dir: "up" } });
	Object.assign(m.prevCloses, { NVDA: 125, SPY: 590 });
	Object.assign(m.prices, { NVDA: 132.48, SPY: 610 });
	await m.source.tick();
	assert.equal(alerts(m).length, 2);
	for (const text of alerts(m)) assert.doesNotMatch(text, /120|37|580|46/);
});

test("盯盘提醒：用 tripwires 改的条件下一轮看盘就生效，不用重启", async () => {
	const m = market();
	m.prices.NVDA = 105.3;
	await m.source.tick();
	assert.deepEqual(alerts(m), []);
	m.source.tripwires("set", { symbol: "NVDA", condition: { kind: "day", pct: 5 } });
	await m.source.tick();
	assert.equal(alerts(m).length, 1);
	m.source.tripwires("remove", { symbol: "NVDA" });
	m.prices.NVDA = 94.9;
	await m.source.tick();
	assert.equal(alerts(m).length, 1);
});

test("盯盘提醒：贴提醒抛错时记一行日志，big-move 触发照常提交、游标照常写", async () => {
	const m = market();
	m.source.tripwires("set", { symbol: "NVDA", condition: { kind: "day", pct: 5 } });
	m.options.ctx.post = () => {
		throw new Error("提醒行格式不对");
	};
	m.prices.NVDA = 105.3;
	await m.source.tick();
	await m.source.tick();
	assert.deepEqual(m.triggers().map((t) => t.externalId), ["NVDA:2026-11-09:up5"]);
	assert.match(m.logs.join("\n"), /盯盘提醒.*提醒行格式不对/);
});

test("盯盘条件：只在盯盘条件里的股票也被看盘轮询，给它设成本条件时收据同样写出现在已在线外", async () => {
	const m = market();
	m.source.tripwires("set", { symbol: "AMD", condition: { kind: "day", pct: 20 } });
	m.prices.AMD = 100;
	await m.source.tick();
	m.source.tripwires("set", { symbol: "AMD", condition: { kind: "cost", pct: 10, basis: 80 } });
	assert.match(receipts(m)[1], /现在已在 \+25\.0%，回到线内后再越过才提醒/);
});
