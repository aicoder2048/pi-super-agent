import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { afterEach, beforeEach } from "node:test";
import vol from "../../docs/modules/examples/option-ta/tools/vol/index.ts";
import { CLOSES, historyRows, KNOWN_IV, NO_DATA_INDEX, writeHistory } from "../helpers/option-ta-iv-history.ts";

type Reply = Record<string, any>;

const sample = (name: string) => JSON.parse(readFileSync(new URL(`../../docs/modules/option-ta-p1/samples/${name}.json`, import.meta.url), "utf8")).body;
const BASE = "https://api.massive.com";
const NOW = "2026-10-21T14:00:00Z";
const PREV = `${BASE}/v2/aggs/ticker/SPY/prev`;
const TERM = `${BASE}/v3/snapshot/options/SPY?contract_type=put&expiration_date.gte=2026-10-21&expiration_date.lte=2027-01-29&strike_price.gte=725&strike_price.lte=755&limit=250`;
const SKEW = `${BASE}/v3/snapshot/options/SPY?expiration_date=2026-11-20&strike_price.gte=591&strike_price.lte=888&limit=250`;

let calls: string[] = [];
let dataDir = "";
const realFetch = globalThis.fetch;
const saved = { key: process.env["POLYGON_API_KEY"], data: process.env["PSA_MODULE_DATA"] };

function serve(replies: Record<string, unknown>) {
	globalThis.fetch = (async (url: string) => {
		calls.push(String(url));
		if (!Object.hasOwn(replies, String(url))) throw new Error(`unexpected fetch ${url}`);
		const reply = replies[String(url)] as Record<string, unknown>;
		const replay = typeof reply?.["status"] === "number";
		return new Response(JSON.stringify(replay ? reply["body"] ?? {} : reply), { status: replay ? (reply["status"] as number) : 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}
const normal = () => serve({ [PREV]: sample("aggs-prev-underlying"), [TERM]: sample("chain-spy-puts-filtered"), [SKEW]: sample("chain-spy-puts-filtered") });

beforeEach(() => {
	calls = [];
	dataDir = mkdtempSync(join(tmpdir(), "option-ta-vol-"));
	process.env["POLYGON_API_KEY"] = "test-key";
	process.env["PSA_MODULE_DATA"] = dataDir;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	rmSync(dataDir, { recursive: true, force: true });
	for (const [name, value] of [["POLYGON_API_KEY", saved.key], ["PSA_MODULE_DATA", saved.data]] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

const run = (input: Record<string, unknown>) => vol(input as never) as Promise<Reply>;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

test("平值 IV、期限结构、偏斜：平值取 21 到 45 天内最近的到期、离正股价最近的 put；偏斜缺 call 时差值为空，不当 0", async () => {
	normal();
	const out = await run({ symbol: "spy", now: NOW });
	assert.equal(out.status, "OK");
	assert.deepEqual(calls, [PREV, TERM, SKEW]);
	assert.equal(out.market, "休市");
	assert.equal(out.underlying.price, 736.172);
	assert.equal(out.atm.contract, "O:SPY261120P00735000");
	assert.equal(out.atm.iv, 0.1936);
	assert.equal(out.atm.iv_source, "供应方");
	assert.deepEqual(out.term.map((t: Reply) => [t.expiry, t.contract, t.iv]), [["2026-11-20", "O:SPY261120P00735000", 0.1936]]);
	assert.equal(out.skew.expiry, "2026-11-20");
	assert.equal(out.skew.put.contract, "O:SPY261120P00725000");
	assert.equal(out.skew.put.iv, 0.2318);
	assert.equal(out.skew.call, null);
	assert.equal(out.skew.put_minus_call, null);
});

test("iv-snapshots 是空的：history 回 NO_HISTORY，IV/HV 为空，其余照常", async () => {
	normal();
	const out = await run({ symbol: "SPY", now: NOW });
	assert.equal(out.status, "OK");
	assert.equal(out.history.status, "NO_HISTORY");
	assert.match(out.history.reason, /iv feed/);
	assert.equal(out.iv_hv.hv20, null);
	assert.equal(out.iv_hv.ratio, null);
});

test("有历史：用收盘价反解的序列算 rank、百分位，HV20 用正股收盘；不同口径、无数据的行、别的标的不进序列", async () => {
	writeHistory(dataDir);
	normal();
	const out = await run({ symbol: "SPY", now: NOW });
	const series = KNOWN_IV.filter((_, i) => i !== NO_DATA_INDEX);
	const latest = series.at(-1)!;
	const lo = Math.min(...series), hi = Math.max(...series);
	assert.equal(out.history.status, "OK");
	assert.equal(out.history.days, series.length);
	assert.equal(out.history.to, "2026-11-16");
	assert.equal(out.history.latest_iv, latest);
	assert.equal(out.history.iv_rank, round4((latest - lo) / (hi - lo)));
	assert.equal(out.history.iv_percentile, round4(series.filter((v) => v < latest).length / series.length));
	const returns = CLOSES.slice(1).map((c, i) => Math.log(c / CLOSES[i]!)).slice(-20);
	const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
	const hv = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1)) * Math.sqrt(252);
	assert.equal(out.iv_hv.hv20, round4(hv));
	assert.equal(out.iv_hv.ratio, round4(0.1936 / round4(hv)), "the ratio of the IV and HV20 the reply shows");
	assert.equal(typeof out.iv_hv.class, "string");
});

test("市场环境：vix-closes 有收盘时回 VIX 档位和期限结构；VIX ≥35 和倒挂写进 regime 的提示，个股 IV 一档照常判", async () => {
	writeHistory(dataDir);
	const db = new DatabaseSync(join(dataDir, "data.db"));
	db.exec(`CREATE TABLE "vix-closes" ("_id" INTEGER PRIMARY KEY, "_from" TEXT, "ticker" TEXT, "trade_date" TEXT, "close" REAL)`);
	const insert = db.prepare(`INSERT INTO "vix-closes" ("_from", "ticker", "trade_date", "close") VALUES ('feed:vix', ?, ?, ?)`);
	for (const [t, d, c] of [["VIX", "2026-11-16", 30], ["VIX", "2026-11-17", 36.2], ["VIX9D", "2026-11-17", 40.1], ["VIX3M", "2026-11-17", 31.5]] as const) insert.run(t, d, c);
	db.close();
	normal();
	const out = await run({ symbol: "SPY", now: NOW });
	assert.equal(out.vix.status, "OK");
	assert.deepEqual([out.vix.date, out.vix.vix, out.vix.level, out.vix.term, out.vix.vix_percentile_1y], ["2026-11-17", 36.2, "恐慌", "倒挂", 0.5]);
	assert.equal(out.regime.vix_level, "恐慌");
	assert.equal(out.regime.iv, "中间", "百分位 0.79 不到 0.8，IV/HV 1.8 在偏贵，合起来不算偏贵");
	assert.ok(out.regime.notes.some((n: string) => /卖方风控线 35/.test(n)), JSON.stringify(out.regime.notes));
	assert.ok(out.regime.notes.some((n: string) => /倒挂/.test(n)));
});

test("没设 PSA_MODULE_DATA：history 回 NO_HISTORY，不去读当前目录下的 data.db", async () => {
	writeHistory(dataDir);
	delete process.env["PSA_MODULE_DATA"];
	const cwd = process.cwd();
	process.chdir(dataDir);
	try {
		normal();
		assert.equal((await run({ symbol: "SPY", now: NOW })).history.status, "NO_HISTORY");
	} finally {
		process.chdir(cwd);
	}
});

test("仓库里 vol 用例的 iv-snapshots 夹具和生成脚本一致", () => {
	const db = new DatabaseSync(new URL("../../docs/modules/examples/option-ta/tools/vol/fixtures/history/data.db", import.meta.url).pathname, { readOnly: true });
	try {
		const rows = db.prepare(`SELECT symbol, trade_date, strike, expiry, contract_close, underlying_close, methodology, data_status FROM "iv-snapshots" ORDER BY "_id"`).all();
		assert.deepEqual(rows.map((r) => ({ ...r })), historyRows().map(({ option_symbol: _, ...r }) => r));
	} finally {
		db.close();
	}
});

test("21 到 45 天内没有到期日：平值和偏斜为空并说明，不另取一个到期日凑数", async () => {
	const now = "2026-11-17T09:30:00Z";
	const term = `${BASE}/v3/snapshot/options/SPY?contract_type=put&expiration_date.gte=2026-11-17&expiration_date.lte=2027-02-25&strike_price.gte=725&strike_price.lte=755&limit=250`;
	serve({ [PREV]: sample("aggs-prev-underlying"), [term]: sample("chain-spy-puts-filtered") });
	const out = await run({ symbol: "SPY", now });
	assert.equal(out.status, "OK");
	assert.equal(out.atm, null);
	assert.match(out.atm_note, /21 到 45 天/);
	assert.equal(out.skew, null);
	assert.equal(out.term.length, 1);
	assert.deepEqual(calls, [PREV, term]);
});

test("HTTP 429、5xx、应答体 ERROR：回固定状态和原因，不抛错", async () => {
	serve({ [PREV]: { status: 429, body: {} } });
	assert.equal((await run({ symbol: "SPY", now: NOW })).status, "RATE_LIMITED");
	serve({ [PREV]: { status: 502, body: {} } });
	assert.equal((await run({ symbol: "SPY", now: NOW })).status, "UPSTREAM_ERROR");
	serve({ [PREV]: sample("aggs-prev-underlying"), [TERM]: { status: "ERROR", error: "bad request" } });
	const out = await run({ symbol: "SPY", now: NOW });
	assert.equal(out.status, "UPSTREAM_ERROR");
	assert.match(out.reason, /bad request/);
});

test("缺 key：不发请求，回 NO_KEY 和补 key 的命令", async () => {
	delete process.env["POLYGON_API_KEY"];
	serve({});
	const out = await run({ symbol: "SPY", now: NOW });
	assert.equal(out.status, "NO_KEY");
	assert.match(out.reason, /just module secret option-ta POLYGON_API_KEY/);
	assert.equal(calls.length, 0);
});

const stripped = (zeroQuote: string) => {
	const body = sample("chain-spy-puts-filtered");
	for (const row of body.results) {
		delete row.implied_volatility;
		if (row.greeks) row.greeks = {};
		if (row.details.ticker === zeroQuote) Object.assign(row.last_quote, { bid: 0, ask: 0 });
	}
	return body;
};

test("缺字段：供应方没给 IV 和希腊值时平值、偏斜用自算的值并标「自算」，没有报价的合约不参加挑选", async () => {
	serve({ [PREV]: sample("aggs-prev-underlying"), [TERM]: stripped("O:SPY261120P00725000"), [SKEW]: stripped("O:SPY261120P00725000") });
	const out = await run({ symbol: "SPY", now: NOW });
	assert.equal(out.status, "OK");
	assert.equal(out.atm.iv_source, "自算");
	assert.equal(out.skew.put.greeks_source, "自算");
	assert.notEqual(out.skew.put.contract, "O:SPY261120P00725000");
});

const asCall = (row: Reply, delta: number, iv: number) => ({
	...row,
	details: { ...row.details, contract_type: "call", ticker: row.details.ticker.replace("P00", "C00") },
	greeks: { ...row.greeks, delta },
	implied_volatility: iv,
});

test("偏斜：两边都有、来源相同时回 put 减 call 的 IV 差；一边自算一边供应方时不相减", async () => {
	const body = sample("chain-spy-puts-filtered");
	const call = asCall(body.results[3], 0.24, 0.15);
	serve({ [PREV]: sample("aggs-prev-underlying"), [TERM]: sample("chain-spy-puts-filtered"), [SKEW]: { ...body, results: [...body.results, call] } });
	const out = await run({ symbol: "SPY", now: NOW });
	assert.equal(out.skew.call.contract, "O:SPY261120C00735000");
	assert.equal(out.skew.put_minus_call, round4(0.2318 - 0.15));

	const own = { ...call, greeks: {}, implied_volatility: undefined };
	serve({ [PREV]: sample("aggs-prev-underlying"), [TERM]: sample("chain-spy-puts-filtered"), [SKEW]: { ...body, results: [...body.results, own] } });
	const mixed = await run({ symbol: "SPY", now: NOW });
	assert.equal(mixed.skew.call.iv_source, "自算");
	assert.equal(mixed.skew.put_minus_call, null);
	assert.match(mixed.skew.note, /不相减/);
});

test("正股价跳空、取回的行权价离平值太远：平值为空并说明，不把边上的合约当平值", async () => {
	const body = sample("chain-spy-puts-filtered");
	for (const row of body.results) row.underlying_asset.price = 780;
	serve({ [PREV]: sample("aggs-prev-underlying"), [TERM]: body });
	const out = await run({ symbol: "SPY", now: NOW });
	assert.equal(out.atm, null);
	assert.match(out.atm_note, /太远/);
	assert.equal(out.skew, null);
});
