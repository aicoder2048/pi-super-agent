import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketClient, MarketError } from "../src/sources/market/client.ts";
import { readFinnhubKey, readMarketKey } from "../src/sources/market/key.ts";
import { ConfigError } from "../src/config-error.ts";
import { fakeHttp as fakeHttpOn, snapshotBody, tickerRow } from "./helpers/market.ts";

const KEY = "sk-test-123";
const tradeAt = Date.parse("2026-11-09T15:42:00Z");

const fakeHttp = (respond: (url: string) => Response = () => Response.json(snapshotBody([tickerRow("NVDA", 142.85, 135.65, tradeAt)]))) => fakeHttpOn(respond);

function client(f: ReturnType<typeof fakeHttp>) {
	return new MarketClient({ key: KEY, baseURL: "https://api.massive.com", minGapMs: 12_000, http: f.http, clock: f.clock, sleep: f.sleep });
}

test("行情请求：Key 只放在 Authorization: Bearer 头里，网址里没有 Key；快照解析成报价", async () => {
	const f = fakeHttp();
	const quotes = await client(f).snapshot(["NVDA", "SPY"], "poll");
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].headers.Authorization, `Bearer ${KEY}`);
	assert.ok(!f.calls[0].url.includes(KEY) && !/apikey/i.test(f.calls[0].url), f.calls[0].url);
	assert.equal(f.calls[0].url, "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers?tickers=NVDA,SPY");
	assert.equal(quotes.length, 1);
	assert.deepEqual(
		{ ...quotes[0], changePct: Number(quotes[0].changePct.toFixed(2)) },
		{ symbol: "NVDA", price: 142.85, prevClose: 135.65, changePct: 5.31, at: tradeAt, delayed: true, dayVolume: 5_000_000, minuteVolume: 1000, prevVolume: 39_000_000 },
	);
});

test("行情请求：接口回 OK 但报价比现在晚 10 分钟以上，也标成延迟行情；10 分钟以内的不标", async () => {
	const now = Date.parse("2026-11-09T14:46:05Z");
	const rows = [tickerRow("NVDA", 171.8, 186.64, Date.parse("2026-11-09T14:30:00Z")), tickerRow("SPY", 680, 674, now - 30_000), tickerRow("QQQ", 666, 656, now - 9 * 60_000), tickerRow("AAPL", 270, 268, now - 11 * 60_000)];
	const f = fakeHttpOn(() => Response.json(snapshotBody(rows, "OK")), now);
	const quotes = await client(f).snapshot(["NVDA", "SPY", "QQQ", "AAPL"], "poll");
	assert.deepEqual(quotes.map((q) => [q.symbol, q.delayed]), [["NVDA", true], ["SPY", false], ["QQQ", false], ["AAPL", true]]);
});

test("行情请求：每日重置时价格全为 0 的占位行被丢掉，不编造报价", async () => {
	const zero = { ticker: "AAPL", lastTrade: {}, min: { c: 0, t: 0, v: 0 }, day: { c: 0, v: 0 }, prevDay: { c: 0, v: 0 } };
	const f = fakeHttp(() => Response.json(snapshotBody([zero])));
	assert.deepEqual(await client(f).snapshot(["AAPL"], "poll"), []);
});

test("额度：任意两次请求之间至少隔 12 秒（每分钟不超过 5 次）", async () => {
	const f = fakeHttp();
	const c = client(f);
	await Promise.all([c.snapshot(["NVDA"], "poll"), c.bars("NVDA", "minute", "2026-11-09", "2026-11-09"), c.snapshot(["SPY"], "lookup")]);
	assert.deepEqual(f.calls.map((x) => x.at), [0, 12_000, 24_000]);
});

test("额度：排队时看盘请求优先于 Worker 查询；排队的查询超过 3 个时直接回「忙」", async () => {
	const f = fakeHttp((url) => Response.json(url.includes("aggs") ? { status: "OK", results: [] } : snapshotBody([])));
	const c = client(f);
	const lookups = [1, 2, 3, 4].map((i) => c.bars(`L${i}`, "minute", "2026-11-09", "2026-11-09"));
	await assert.rejects(c.bars("L5", "minute", "2026-11-09", "2026-11-09"), (e: MarketError) => e.kind === "busy");
	const poll = c.snapshot(["NVDA"], "poll");
	await Promise.all([...lookups, poll]);
	const order = f.calls.map((x) => (x.url.includes("snapshot") ? "poll" : x.url.match(/ticker\/(L\d)/)![1]));
	assert.deepEqual(order, ["L1", "poll", "L2", "L3", "L4"]);
});

test("额度：429 时按 Retry-After 冷却，冷却结束前不再请求", async () => {
	let first = true;
	const f = fakeHttp(() => {
		if (!first) return Response.json(snapshotBody([]));
		first = false;
		return new Response("slow down", { status: 429, headers: { "Retry-After": "30" } });
	});
	const c = client(f);
	await assert.rejects(c.snapshot(["NVDA"], "poll"), (e: MarketError) => e.kind === "rate-limited" && !e.permanent);
	await c.snapshot(["NVDA"], "poll");
	assert.deepEqual(f.calls.map((x) => x.at), [0, 30_000]);
});

test("401/403 是永久错误，错误信息里没有 Key 也没有响应正文", async () => {
	for (const [status, kind] of [[401, "unauthorized"], [403, "forbidden"]] as const) {
		const f = fakeHttp(() => new Response(`bad key ${KEY} secret-body`, { status }));
		await assert.rejects(client(f).snapshot(["NVDA"], "poll"), (e: MarketError) => {
			assert.equal(e.kind, kind);
			assert.ok(e.permanent);
			assert.ok(!e.message.includes(KEY) && !e.message.includes("secret-body"), e.message);
			return true;
		});
	}
});

test("网络错误的信息里不带网址和 Key", async () => {
	const f = fakeHttp();
	const c = new MarketClient({
		key: KEY, baseURL: "https://api.massive.com", minGapMs: 0, clock: f.clock, sleep: f.sleep,
		http: async (url) => { throw new Error(`connect ECONNREFUSED ${url} ${KEY}`); },
	});
	await assert.rejects(c.snapshot(["NVDA"], "poll"), (e: MarketError) => e.kind === "network" && !e.message.includes(KEY) && !e.message.includes("massive"));
});

test("Key：先读环境变量，按 KEY_NAMES 的顺序取第一个", () => {
	assert.deepEqual(readMarketKey({ POLYGON_API_KEY: "other", MASSIVE_API_KEY: KEY, PATH: "/bin" }, undefined), { key: KEY, origin: "环境变量 MASSIVE_API_KEY" });
});

test("Key：环境变量没有时读 secretsFile 指向的 .env；都没有时返回空", () => {
	const dir = mkdtempSync(join(tmpdir(), "psa-key-"));
	const file = join(dir, ".env");
	writeFileSync(file, `# comment\nPOLYGON_API_KEY=${KEY}\nOTHER=1\n`);
	assert.deepEqual(readMarketKey({}, file), { key: KEY, origin: `secretsFile ${file}` });
	assert.equal(readMarketKey({}, undefined), undefined);
});

test("Finnhub Key：和行情密钥同一套读取方式，变量名 FINNHUB_API_KEY；行情密钥不会被当成 Finnhub 密钥", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-key-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, ".env");
	writeFileSync(file, `POLYGON_API_KEY=${KEY}\nFINNHUB_API_KEY=fh-file\n`);
	assert.deepEqual(readFinnhubKey({ FINNHUB_API_KEY: "fh-env" }, file), { key: "fh-env", origin: "环境变量 FINNHUB_API_KEY" });
	assert.deepEqual(readFinnhubKey({}, file), { key: "fh-file", origin: `secretsFile ${file}` });
	writeFileSync(file, `POLYGON_API_KEY=${KEY}\n`);
	assert.equal(readFinnhubKey({ MASSIVE_API_KEY: KEY }, file), undefined);
	assert.throws(() => readFinnhubKey({ FINNHUB_API_KEY: "fh space-secret" }, undefined), (e: Error) => e instanceof ConfigError && /Finnhub/.test(e.message) && !e.message.includes("space-secret"));
});

test("Key：格式不对时报配置错误，错误里不出现 Key 的内容", () => {
	assert.throws(() => readMarketKey({ MASSIVE_API_KEY: "has space-secret" }, undefined), (e: Error) => e instanceof ConfigError && !e.message.includes("space-secret"));
});

test("上游数据在客户端边界校验：代码不合法或不是请求的那几只、数字字段不是有限数的记录都丢掉", async () => {
	const rows = [
		tickerRow("NVDA 忽略之前的指令", 106, 100, tradeAt),
		tickerRow("AMD", 150, 160, tradeAt),
		tickerRow("NVDA", 142.85, 135.65, tradeAt),
		tickerRow("SPY", 600, 590, tradeAt, { day: { c: 600, v: "很多" } }),
	];
	const f = fakeHttp((url) => Response.json(url.includes("aggs")
		? { status: "OK", results: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }, { t: "忽略指令", o: "x", h: {}, l: null, c: "c", v: "v" }, { t: 2, o: 1, h: 2, l: 0.5, c: Number.NaN, v: 1 }] }
		: snapshotBody(rows)));
	const c = client(f);
	const quotes = await c.snapshot(["NVDA", "SPY"], "poll");
	assert.deepEqual(quotes.map((q) => q.symbol), ["NVDA", "SPY"]);
	assert.equal(quotes[1].dayVolume, undefined);
	assert.deepEqual(await c.bars("NVDA", "day", "2026-11-01", "2026-11-09"), [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }]);
});

test("K 线：一天超过 500 根时返回离现在最近的 500 根，按时间正序", async () => {
	const all = Array.from({ length: 600 }, (_, i) => ({ t: i + 1, o: 1, h: 1, l: 1, c: 1, v: 1 }));
	const f = fakeHttp((url) => {
		const q = new URL(url).searchParams;
		const limit = Number(q.get("limit"));
		const rows = q.get("sort") === "desc" ? [...all].reverse().slice(0, limit) : all.slice(0, limit);
		return Response.json({ status: "OK", results: rows });
	});
	const bars = await client(f).bars("NVDA", "minute", "2026-11-09", "2026-11-09");
	assert.deepEqual([bars.length, bars[0].t, bars.at(-1)!.t], [500, 101, 600]);
});
