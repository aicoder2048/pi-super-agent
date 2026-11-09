import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MarketClient, MarketError } from "../src/sources/market/client.ts";
import { loadMarketKey } from "../src/sources/market/key.ts";
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

test("Key：先读环境变量，读完从 process 环境里删掉三个变量名，Worker 子进程继承不到", () => {
	const env: NodeJS.ProcessEnv = { MASSIVE_API_KEY: KEY, POLYGON_API_KEY: "other", PATH: "/bin" };
	const loaded = loadMarketKey(env, undefined);
	assert.deepEqual(loaded, { key: KEY, origin: "环境变量 MASSIVE_API_KEY" });
	assert.deepEqual(env, { PATH: "/bin" });
});

test("Key：环境变量没有时读 secretsFile 指向的 .env；都没有时返回空", () => {
	const dir = mkdtempSync(join(tmpdir(), "psa-key-"));
	const file = join(dir, ".env");
	writeFileSync(file, `# comment\nPOLYGON_API_KEY=${KEY}\nOTHER=1\n`);
	assert.deepEqual(loadMarketKey({}, file), { key: KEY, origin: `secretsFile ${file}` });
	assert.equal(loadMarketKey({}, undefined), undefined);
	assert.equal(loadMarketKey({}, join(dir, "missing.env")), undefined);
});

test("Key：格式不对时报配置错误，错误里不出现 Key 的内容", () => {
	assert.throws(() => loadMarketKey({ MASSIVE_API_KEY: "has space-secret" }, undefined), (e: Error) => e instanceof ConfigError && !e.message.includes("space-secret"));
});
