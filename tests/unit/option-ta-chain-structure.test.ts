import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import type { ChainRow } from "../../docs/modules/examples/option-ta/chain-rows.ts";
import { gexStructure, maxPainByExpiry, oiStructure, unusualVolume, UNUSUAL_MIN_VOLUME, UNUSUAL_VOLUME_OI_RATIO } from "../../docs/modules/examples/option-ta/chain-structure.ts";
import chain from "../../docs/modules/examples/option-ta/tools/chain/index.ts";

type Reply = Record<string, any>;
const row = (right: "put" | "call", strike: number, expiry: string, oi: number | null, gamma: number | null, volume: number | null = null): ChainRow => ({
	contract: `O:XYZ${expiry.slice(2).replaceAll("-", "")}${right === "put" ? "P" : "C"}${String(strike * 1000).padStart(8, "0")}`,
	right, strike, expiry, dte: 10, bid: 1, ask: 1.2, mid: 1.1, quote_at: null, open_interest: oi, volume, iv: 0.3, iv_source: "供应方", delta: 0.5, gamma, theta: -0.1, vega: 0.1, greeks_source: "供应方", break_even: null,
});

test("oi：每个到期日的 put、call 未平仓和 P/C 比，跨到期按行权价合计的墙，没有未平仓的行按 0 计并数出来", () => {
	const rows = [row("put", 95, "2026-12-04", 1000, 0.02, 30), row("put", 100, "2026-12-04", 500, 0.03), row("call", 105, "2026-12-04", 400, 0.02), row("put", 95, "2026-12-11", 300, 0.01), row("call", 105, "2026-12-11", null, 0.01)];
	const out = oiStructure(rows, 100);
	assert.deepEqual(out.by_expiry, [
		{ expiry: "2026-12-04", put_oi: 1500, call_oi: 400, pc_oi: 3.75, put_volume: 30, call_volume: 0, max_pain: 100 },
		{ expiry: "2026-12-11", put_oi: 300, call_oi: 0, pc_oi: null, put_volume: 0, call_volume: 0, max_pain: 95 },
	]);
	assert.deepEqual(out.put_walls_below, [{ strike: 95, put_oi: 1300, call_oi: 0, vs_spot: -0.05 }, { strike: 100, put_oi: 500, call_oi: 0, vs_spot: 0 }]);
	assert.deepEqual(out.call_walls_above, [{ strike: 105, put_oi: 0, call_oi: 400, vs_spot: 0.05 }]);
	assert.equal(out.rows_without_oi, 1);
	assert.match(out.note, /前一交易日/);
});

test("oi：墙分正股上下——上方的 put（价内）不算下方的墙，下方的 call 不算上方的墙；没有正股价时不分墙", () => {
	const rows = [row("put", 120, "2026-12-04", 9000, 0.01), row("put", 90, "2026-12-04", 100, 0.01), row("call", 80, "2026-12-04", 9000, 0.01), row("call", 110, "2026-12-04", 50, 0.01)];
	const out = oiStructure(rows, 100);
	assert.deepEqual(out.put_walls_below.map((w) => w.strike), [90]);
	assert.deepEqual(out.call_walls_above.map((w) => w.strike), [110]);
	assert.deepEqual(oiStructure(rows, null).put_walls_below, []);
});

test("max-pain：某个到期日未平仓全是 0 或缺失时最大痛点为空，不报最低行权价", () => {
	const rows = [row("put", 90, "2026-12-04", null, null), row("call", 110, "2026-12-04", 0, null), row("put", 100, "2026-12-04", 0, null)];
	assert.deepEqual(maxPainByExpiry(rows, 100).by_expiry[0], { expiry: "2026-12-04", max_pain: null, vs_spot: null, put_oi: 0, call_oi: 0 });
	assert.equal(oiStructure(rows, 100).by_expiry[0]!.max_pain, null);
});

test("max-pain：买方总赔付最少的行权价，和正股价比的比例；没有正股价时比例为空", () => {
	const rows = [row("put", 90, "2026-12-04", 100, null), row("put", 100, "2026-12-04", 100, null), row("call", 110, "2026-12-04", 1000, null)];
	assert.deepEqual(maxPainByExpiry(rows, 104).by_expiry, [{ expiry: "2026-12-04", max_pain: 100, vs_spot: -0.0385, put_oi: 200, call_oi: 1000 }]);
	assert.equal(maxPainByExpiry(rows, null).by_expiry[0]!.vs_spot, null);
});

test("gex：call 墙在正股上方、put 墙在下方，净 GEX 和正负档；没有 gamma 的行不计入并数出来；未平仓少时可信度为低", () => {
	const rows = [row("put", 95, "2026-12-04", 2000, 0.02), row("put", 105, "2026-12-04", 9000, 0.05), row("call", 105, "2026-12-04", 3000, 0.03), row("call", 95, "2026-12-04", 9000, 0.05), row("call", 110, "2026-12-04", 100, null)];
	const out = gexStructure(rows, 100);
	assert.equal(out.call_wall?.strike, 105);
	assert.equal(out.put_wall?.strike, 95, "105 的 put 在正股上方，不算 put 墙");
	assert.ok(out.put_wall!.gex < 0);
	assert.equal(out.net_gex, Math.round((0.03 * 3000 + 0.05 * 9000 - 0.02 * 2000 - 0.05 * 9000) * 100 * 100 * 100 * 0.01), "按正股变动 1% 的美元");
	assert.match(out.regime, /^正 gamma/);
	assert.equal(out.spot_position, "在 put 墙和 call 墙之间");
	assert.equal(out.rows_without_gamma, 1);
	assert.equal(out.total_oi, 23100);
	assert.equal(out.confidence, "一般");
	assert.match(gexStructure([row("call", 105, "2026-12-04", 10, 0.03)], 100).confidence, /^低/);
	assert.match(out.note, /模型估计/);
});

test("gex：没有一行同时带 gamma 和未平仓时，正负档为空、可信度标低，不报成负 gamma", () => {
	const out = gexStructure([row("put", 95, "2026-12-04", 9000, null), row("call", 105, "2026-12-04", 9000, null)], 100);
	assert.equal(out.regime, null);
	assert.match(out.confidence, /^低：没有同时带 gamma/);
});

test(`unusual-volume：成交量 ≥ 未平仓 ${UNUSUAL_VOLUME_OI_RATIO} 倍且 ≥ ${UNUSUAL_MIN_VOLUME} 张，边界算入；未平仓为 0 算、倍数为空；未平仓或成交量缺失不判断，分别数出来`, () => {
	const rows = [row("call", 110, "2026-12-04", 400, 0.01, 900), row("call", 115, "2026-12-04", 0, 0.01, 600), row("call", 120, "2026-12-04", 250, 0.01, 500), row("put", 95, "2026-12-04", 400, 0.01, 800), row("put", 90, "2026-12-04", 400, 0.01, 799), row("put", 85, "2026-12-04", 10, 0.01, 499), row("put", 80, "2026-12-04", 10, 0.01, null), row("put", 75, "2026-12-04", null, 0.01, 600)];
	const out = unusualVolume(rows, "盘中");
	assert.deepEqual(out.contracts.map((c) => [c.strike, c.volume, c.volume_oi]), [[110, 900, 2.25], [95, 800, 2], [115, 600, null], [120, 500, 2]]);
	assert.equal(out.rows_without_volume, 1);
	assert.equal(out.rows_without_oi, 1);
	assert.equal(out.more, 0);
	assert.match(unusualVolume(rows, "休市").note, /^休市：成交量是上一个交易日/);
});

const BASE = "https://api.massive.com/v3/snapshot/options";
const NOW = "2026-11-17T20:00:00Z";
const snap = (right: "put" | "call", strike: number, oi: number, gamma: number, volume: number) => ({
	details: { contract_type: right, exercise_style: "american", expiration_date: "2026-11-20", shares_per_contract: 100, strike_price: strike, ticker: `O:SPY261120${right === "put" ? "P" : "C"}${String(strike * 1000).padStart(8, "0")}` },
	day: { volume }, greeks: { delta: right === "put" ? -0.4 : 0.4, gamma, theta: -0.5, vega: 0.3 }, implied_volatility: 0.2, open_interest: oi,
	last_quote: { bid: 2, ask: 2.2, last_updated: 1794858000000000000 }, underlying_asset: { price: 700, last_updated: 1794858000000000000, timeframe: "DELAYED" },
});
let calls: string[] = [];
const realFetch = globalThis.fetch;
const savedKey = process.env["POLYGON_API_KEY"];
beforeEach(() => {
	calls = [];
	process.env["POLYGON_API_KEY"] = "test-key";
	globalThis.fetch = (async (url: string) => {
		calls.push(String(url));
		return new Response(JSON.stringify({ status: "OK", results: [snap("put", 690, 5000, 0.01, 100), snap("put", 700, 3000, 0.02, 9000), snap("call", 700, 3000, 0.02, 50), snap("call", 710, 9000, 0.01, 100)] }), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	if (savedKey === undefined) delete process.env["POLYGON_API_KEY"];
	else process.env["POLYGON_API_KEY"] = savedKey;
});
const run = (input: Record<string, unknown>) => chain({ symbol: "SPY", expiry: "2026-11-20", now: NOW, ...input } as never) as Promise<Reply>;

test("chain 的四种结构 operation：取两边整条链（不按 right 过滤），回结构、正股价、说明和单位", async () => {
	for (const operation of ["oi", "gex", "max-pain", "unusual-volume"]) {
		const out = await run({ operation });
		assert.equal(out.status, "OK", operation);
		assert.equal(out.operation, operation);
		assert.equal(out.underlying.price, 700);
		assert.equal(out.rows, 4);
		assert.equal(typeof out.note, "string");
		assert.equal(out.truncated, false);
	}
	assert.deepEqual([...new Set(calls)], [`${BASE}/SPY?expiration_date=2026-11-20&limit=250`]);
	assert.deepEqual((await run({ operation: "gex" })).call_wall.strike, 710);
	assert.deepEqual((await run({ operation: "unusual-volume" })).contracts.map((c: Reply) => c.contract), ["O:SPY261120P00700000"]);
	assert.equal((await run({ operation: "max-pain" })).by_expiry[0].max_pain, 700);
});

test("chain：oi、gex、max-pain 填了 right 回 INVALID_INPUT，不发请求；unusual-volume 可以只看一边；快照多了 volume", async () => {
	for (const operation of ["oi", "gex", "max-pain"]) assert.equal((await run({ operation, right: "put" })).status, "INVALID_INPUT");
	assert.deepEqual(calls, []);
	assert.equal((await run({ operation: "unusual-volume", right: "put" })).status, "OK");
	const snapshot = await run({});
	assert.deepEqual(snapshot.contracts.map((c: Reply) => c.volume), [100, 50, 9000, 100]);
	assert.equal((await run({ operation: "nope" })).status, "INVALID_INPUT");
	assert.equal((await run({ operation: "" })).contracts.length, 4, "空串当 snapshot");
});

test("chain：oi、gex、max-pain 填了行权价范围回 INVALID_INPUT（截掉一段会把墙和最大痛点推到边上）；unusual-volume 可以填", async () => {
	for (const operation of ["oi", "gex", "max-pain"]) assert.equal((await run({ operation, strike_min: 690 })).status, "INVALID_INPUT", operation);
	assert.deepEqual(calls, []);
	assert.equal((await run({ operation: "unusual-volume", strike_min: 690, strike_max: 710 })).status, "OK");
});

test("chain：分页到上限还没取全时，oi、gex、max-pain 回 NO_DATA 不算；unusual-volume 照回并标 truncated", async () => {
	globalThis.fetch = (async (url: string) => {
		calls.push(String(url));
		return new Response(JSON.stringify({ status: "OK", results: [snap("put", 700, 3000, 0.02, 9000)], next_url: `${BASE}/SPY?cursor=next` }), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	for (const operation of ["oi", "gex", "max-pain"]) {
		const out = await run({ operation });
		assert.equal(out.status, "NO_DATA", operation);
		assert.match(out.reason, /分页上限/);
	}
	const unusual = await run({ operation: "unusual-volume" });
	assert.equal(unusual.status, "OK");
	assert.equal(unusual.truncated, true);
	assert.match(unusual.truncated_note, /分页上限/);
});
