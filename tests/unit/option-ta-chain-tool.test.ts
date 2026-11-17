import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach } from "node:test";
import { bsPutPrice } from "../../docs/modules/examples/option-ta/options-math.ts";
import chain from "../../docs/modules/examples/option-ta/tools/chain/index.ts";

type Reply = Record<string, any>;
type Canned = unknown | { status: number; headers?: Record<string, string>; body?: unknown };

const sample = (name: string) => JSON.parse(readFileSync(new URL(`../../docs/modules/option-ta-p1/samples/${name}.json`, import.meta.url), "utf8")).body;
const BASE = "https://api.massive.com/v3/snapshot/options";
const CLOSED_NOW = "2026-11-17T09:30:00Z";

let calls: { url: string; auth: string | undefined }[] = [];
const realFetch = globalThis.fetch;
const savedKey = process.env["POLYGON_API_KEY"];

function serve(replies: Record<string, Canned>) {
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.["Authorization"] });
		if (!Object.hasOwn(replies, String(url))) throw new Error(`unexpected fetch ${url}`);
		const reply = replies[String(url)] as Record<string, unknown>;
		const replay = typeof reply?.["status"] === "number";
		const body = replay ? reply["body"] ?? {} : reply;
		return new Response(JSON.stringify(body), { status: replay ? (reply["status"] as number) : 200, headers: { "content-type": "application/json", ...((replay && reply["headers"]) as Record<string, string>) } });
	}) as typeof fetch;
}

beforeEach(() => {
	calls = [];
	process.env["POLYGON_API_KEY"] = "test-key";
});
afterEach(() => {
	globalThis.fetch = realFetch;
	if (savedKey === undefined) delete process.env["POLYGON_API_KEY"];
	else process.env["POLYGON_API_KEY"] = savedKey;
});

const run = (input: Record<string, unknown>) => chain(input as never) as Promise<Reply>;
const spyPutsUrl = `${BASE}/SPY?contract_type=put&expiration_date=2026-11-20&strike_price.gte=720&strike_price.lte=740&limit=250`;

test("正常：按到期日、类型、行权价范围取一页，滤掉二元期权，供应方 IV 和希腊值原样带单位", async () => {
	serve({ [spyPutsUrl]: sample("chain-spy-puts-filtered") });
	const out = await run({ symbol: "spy", expiry: "2026-11-20", right: "put", strike_min: 720, strike_max: 740, now: CLOSED_NOW });
	assert.equal(out.status, "OK");
	assert.deepEqual(calls, [{ url: spyPutsUrl, auth: "Bearer test-key" }]);
	assert.equal(out.symbol, "SPY");
	assert.equal(out.skipped_binary, 1);
	assert.deepEqual(out.contracts.map((c: Reply) => c.contract), ["O:SPY261120P00725000", "O:SPY261120P00730000", "O:SPY261120P00735000"]);
	const atm = out.contracts[1];
	assert.equal(atm.right, "put");
	assert.equal(atm.strike, 730);
	assert.equal(atm.expiry, "2026-11-20");
	assert.equal(atm.bid, 3.72);
	assert.equal(atm.ask, 3.75);
	assert.equal(atm.mid, 3.735);
	assert.equal(atm.open_interest, 61605);
	assert.equal(atm.iv, 0.2163);
	assert.equal(atm.iv_source, "供应方");
	assert.equal(atm.delta, -0.348);
	assert.equal(atm.greeks_source, "供应方");
	assert.equal(atm.break_even, 726.265);
	assert.equal(atm.quote_at, "2026-11-16 16:14 美东");
	assert.equal(out.underlying.price, 736.172);
	assert.equal(out.underlying.delay, "延迟 15 分钟");
	assert.equal(out.pages, 1);
	assert.equal(out.truncated, false);
	assert.match(out.units, /IV 是小数/);
});

test("休市：标「休市」并写明取数时刻，说明 IV 不是收盘 IV", async () => {
	serve({ [spyPutsUrl]: sample("chain-spy-puts-filtered") });
	const out = await run({ symbol: "SPY", expiry: "2026-11-20", right: "put", strike_min: 720, strike_max: 740, now: CLOSED_NOW });
	assert.equal(out.market, "休市");
	assert.equal(out.fetched_at, "2026-11-17 04:30 美东");
	assert.match(out.market_note, /不是收盘 IV/);
});

test("盘中：交易时段内、报价是今天的，标「盘中」，没有休市说明", async () => {
	serve({ [spyPutsUrl]: sample("chain-spy-puts-filtered") });
	const out = await run({ symbol: "SPY", expiry: "2026-11-20", right: "put", strike_min: 720, strike_max: 740, now: "2026-11-16T20:00:00Z" });
	assert.equal(out.market, "盘中");
	assert.equal(out.market_note, undefined);
});

const nvdaUrl = `${BASE}/NVDA?expiration_date.gte=2026-11-18&expiration_date.lte=2026-11-20&limit=250`;
const nvdaOnePage = () => ({ ...sample("chain-nvda-missing-greeks"), next_url: undefined });

test("缺 IV 和希腊值：有双边报价就用中间价反解，标「自算」；没有就标「无数据」，不当 0", async () => {
	serve({ [nvdaUrl]: nvdaOnePage() });
	const out = await run({ symbol: "NVDA", expiry_from: "2026-11-18", expiry_to: "2026-11-20", now: CLOSED_NOW });
	assert.equal(out.status, "OK");
	const by = Object.fromEntries(out.contracts.map((c: Reply) => [c.contract, c]));
	assert.equal(by["O:B1VDA261120C00150000"], undefined);
	const deep = by["O:NVDA261118P00175000"];
	assert.equal(deep.iv_source, "自算");
	assert.equal(deep.greeks_source, "自算");
	assert.ok(deep.iv > 0);
	const repriced = bsPutPrice(155.32, 175, deep.iv, deep.dte);
	assert.ok(Math.abs(repriced - 19.975) < 0.01, `BS at the self-computed IV gives ${repriced}, not the mid 19.975`);
	assert.ok(deep.delta < -0.9 && deep.delta >= -1);
	const far = by["O:NVDA261118C00295000"];
	assert.equal(far.iv, null);
	assert.equal(far.iv_source, "无数据");
	assert.equal(far.delta, null);
	assert.equal(far.greeks_source, "无数据");
	assert.equal(far.mid, null);
	assert.equal(by["O:NVDA261118P00150000"].iv_source, "供应方");
});

test("分页：跟 next_url 取下一页，每页都带 Authorization 头", async () => {
	const whole = sample("chain-nvda-missing-greeks");
	const next = whole.next_url as string;
	serve({ [nvdaUrl]: { ...whole, results: whole.results.slice(0, 2) }, [next]: { status: "OK", results: whole.results.slice(2) } });
	const out = await run({ symbol: "NVDA", expiry_from: "2026-11-18", expiry_to: "2026-11-20", now: CLOSED_NOW });
	assert.equal(out.pages, 2);
	assert.equal(out.truncated, false);
	assert.equal(out.contracts.length, 4);
	assert.deepEqual(calls.map((c) => c.auth), ["Bearer test-key", "Bearer test-key"]);
	assert.equal(calls[1]!.url, next);
});

test("分页有上限：next_url 不断时停下，标 truncated", async () => {
	const whole = sample("chain-nvda-missing-greeks");
	const loop = whole.next_url as string;
	serve({ [nvdaUrl]: whole, [loop]: whole });
	const out = await run({ symbol: "NVDA", expiry_from: "2026-11-18", expiry_to: "2026-11-20", now: CLOSED_NOW });
	assert.equal(out.truncated, true);
	assert.ok(calls.length >= 2 && calls.length <= 10, `fetched ${calls.length} pages`);
	assert.equal(out.pages, calls.length);
});

test("应答体 status ERROR：回 UPSTREAM_ERROR 和原因，不抛错", async () => {
	serve({ [spyPutsUrl]: { status: "ERROR", error: "Unknown API Key" } });
	const out = await run({ symbol: "SPY", expiry: "2026-11-20", right: "put", strike_min: 720, strike_max: 740, now: CLOSED_NOW });
	assert.equal(out.status, "UPSTREAM_ERROR");
	assert.match(out.reason, /Unknown API Key/);
});

test("HTTP 429：回 RATE_LIMITED", async () => {
	serve({ [spyPutsUrl]: { status: 429, headers: { "retry-after": "30" }, body: {} } });
	const out = await run({ symbol: "SPY", expiry: "2026-11-20", right: "put", strike_min: 720, strike_max: 740, now: CLOSED_NOW });
	assert.equal(out.status, "RATE_LIMITED");
	assert.match(out.reason, /429/);
});

test("HTTP 5xx：回 UPSTREAM_ERROR", async () => {
	serve({ [spyPutsUrl]: { status: 503, body: {} } });
	const out = await run({ symbol: "SPY", expiry: "2026-11-20", right: "put", strike_min: 720, strike_max: 740, now: CLOSED_NOW });
	assert.equal(out.status, "UPSTREAM_ERROR");
	assert.match(out.reason, /503/);
});

test("缺 key：不发请求，回 NO_KEY 和补 key 的命令", async () => {
	delete process.env["POLYGON_API_KEY"];
	serve({});
	const out = await run({ symbol: "SPY", expiry: "2026-11-20", now: CLOSED_NOW });
	assert.equal(out.status, "NO_KEY");
	assert.match(out.reason, /just module secret option-ta POLYGON_API_KEY/);
	assert.equal(calls.length, 0);
});

test("没给到期日：回 INVALID_INPUT，不发请求", async () => {
	serve({});
	const out = await run({ symbol: "SPY", now: CLOSED_NOW });
	assert.equal(out.status, "INVALID_INPUT");
	assert.equal(calls.length, 0);
});

test("没有符合条件的标准合约：回 NO_DATA", async () => {
	serve({ [spyPutsUrl]: { status: "OK", results: [sample("chain-spy-puts-filtered").results[0]] } });
	const out = await run({ symbol: "SPY", expiry: "2026-11-20", right: "put", strike_min: 720, strike_max: 740, now: CLOSED_NOW });
	assert.equal(out.status, "NO_DATA");
});
