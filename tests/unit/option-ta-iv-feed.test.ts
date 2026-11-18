import assert from "node:assert/strict";
import test from "node:test";
import { replay } from "../helpers/option-ta-feed-replay.ts";

const done = (output: { cursor?: string }) => (output.cursor === undefined ? undefined : JSON.parse(output.cursor).done);

test("空自选、当天已存、周末、节假日、收盘后还不到取数时刻：不取数，不写行", async () => {
	for (const name of ["empty-watchlist", "already-saved", "market-closed", "holiday", "before-close-wait"]) {
		const { output, fetched } = await replay("iv", name);
		assert.deepEqual(fetched, [], name);
		assert.deepEqual(output.records, [], name);
		assert.equal(output.problem, undefined, name);
	}
});

test("日常：收盘后存当天一行原始输入，带报价中间价，cursor 记到当天", async () => {
	const { output } = await replay("iv", "daily");
	assert.deepEqual(output.records, [{
		id: "SPY:2026-11-19:option-ta-iv-close-v2", symbol: "SPY", trade_date: "2026-11-19", option_symbol: "O:SPY261210P00740000", strike: 740, expiry: "2026-12-10",
		contract_close: 12.3, underlying_close: 740, quote_midpoint: 12.35, quote_at: "2026-11-19T21:14:00.000Z", fetched_at: "2026-11-19T21:40:00.000Z",
		source: "Massive", methodology: "option-ta-iv-close-v2", data_status: "ok",
	}]);
	assert.deepEqual(done(output), { SPY: "2026-11-19" });
});

test("同一交易日再跑一拍不重存", async () => {
	const first = await replay("iv", "daily");
	const again = await replay("iv", "daily", { change: (input) => ((input.cursor = first.output.cursor), (input.now = "2026-11-19T22:00:00.000Z")) });
	assert.deepEqual(again.fetched, []);
	assert.deepEqual(again.output.records, []);
});

test("当天正股日线还没出来：不写行，cursor 不前进，下一拍再试", async () => {
	const { output } = await replay("iv", "daily-not-ready");
	assert.deepEqual(output.records, []);
	assert.deepEqual(done(output), { SPY: "2026-11-18" });
});

test("回填：从一年前开始，每拍有请求上限，做到上限就停，下一拍接着做", async () => {
	const { output, fetched } = await replay("iv", "backfill-new-symbol");
	const rows = output.records.map((r: Record<string, unknown>) => [r.trade_date, r.data_status, r.option_symbol ?? null, r.contract_close ?? null, r.underlying_close]);
	assert.deepEqual(rows, [
		["2025-11-19", "ok", "O:SPY251210P00659000", 9.5, 660],
		["2025-11-20", "ok", "O:SPY251211P00655000", 10, 655],
		["2025-11-21", "no-data", null, null, 650],
		["2025-11-24", "no-data", "O:SPY251215P00680000", 9, 670],
	]);
	assert.ok(output.records.every((r: Record<string, unknown>) => r.quote_midpoint === undefined), "回填没有中间价");
	assert.ok(fetched.length <= 16, `请求 ${fetched.length} 次，超过上限`);
	assert.deepEqual(done(output), { SPY: "2025-11-24" });
});

test("回填选合约照 selectAtmContract：期限 21 到 45 天里最近的到期日，离正股最近、那天有成交的行权价，一样近取低的；滤掉二元期权", async () => {
	const { fetched } = await replay("iv", "backfill-new-symbol");
	const probed = fetched.filter((u) => u.includes("/O:") && u.includes("2025-11-19/2025-11-19"));
	assert.deepEqual(probed.map((u) => /O:[A-Z0-9]+/.exec(u)![0]), ["O:SPY251210P00660000", "O:SPY251210P00659000"]);
});

test("请求失败一拍只记次数，连着第三拍报警；失败前做完的行照样交回", async () => {
	const once = await replay("iv", "http-429");
	assert.equal(once.output.problem, undefined);
	assert.equal(JSON.parse(once.output.cursor).failures, 1);
	assert.deepEqual(done(once.output), { SPY: "2026-11-18" });
	const third = await replay("iv", "http-5xx-third-beat");
	assert.equal(third.output.problem?.id, "data-down");
});

test("缺 POLYGON_API_KEY 回 problem，写明补 key 的命令；自选为空就不报", async () => {
	const { output, fetched } = await replay("iv", "daily", { secrets: {} });
	assert.equal(output.problem?.id, "no-key");
	assert.match(output.problem.text, /just module secret option-ta POLYGON_API_KEY/);
	assert.deepEqual(fetched, []);
	assert.equal((await replay("iv", "empty-watchlist", { secrets: {} })).output.problem, undefined);
});

test("口径版本变了，按新口径从头回填", async () => {
	const { output } = await replay("iv", "already-saved", { change: (input) => ((input.cursor = JSON.stringify({ methodology: "old", done: { SPY: "2026-11-19" }, failures: 0 })), (input.settings = { requestsPerTick: 0 })) });
	assert.deepEqual(done(output), {});
});

test("从自选里划掉的标的不再采集", async () => {
	const { fetched } = await replay("iv", "daily", { change: (input) => input.rows.watchlist.push({ id: "2", from: "x", fields: { symbol: "SPY", removed_at: "2026-11-19T20:00:00.000Z" } }) });
	assert.deepEqual(fetched, []);
});

test("当天合约日线还没出来（探的合约都没有成交）：收盘 3 小时内不记无数据，cursor 不前进", async () => {
	const { output } = await replay("iv", "daily-option-bars-not-ready");
	assert.deepEqual(output.records, []);
	assert.deepEqual(done(output), { SPY: "2026-11-18" });
});

test("过了收盘 3 小时还没有成交，就记无数据并前进", async () => {
	const { output } = await replay("iv", "daily-option-bars-not-ready", { change: (input) => (input.now = "2026-11-20T00:30:00.000Z") });
	assert.deepEqual(output.records.map((r: Record<string, unknown>) => [r.trade_date, r.data_status]), [["2026-11-19", "no-data"]]);
	assert.deepEqual(done(output), { SPY: "2026-11-19" });
});

test("要存的日子里一根正股日线都没有：不写一整年的无数据，回 problem 提示代码可能写错", async () => {
	const { output } = await replay("iv", "backfill-no-bars");
	assert.deepEqual(output.records, []);
	assert.equal(output.problem?.id, "no-bars");
	assert.deepEqual(done(output), {});
});

test("回填只看那天已挂牌的合约：最近的到期日那天还没挂牌，就用挂牌了的最近到期日，不记无数据", async () => {
	const { output } = await replay("iv", "backfill-unlisted-expiration");
	assert.deepEqual(output.records.map((r: Record<string, unknown>) => [r.trade_date, r.data_status, r.option_symbol ?? null, r.contract_close ?? null]), [["2025-12-01", "ok", "O:QQQ251226P00610000", 6.4]]);
});

test("最近到期日离正股最近的合约都没成交：往后一个到期日再探，探完才记无数据", async () => {
	const strikes = (exp: string) => [740, 741].map((k) => `https://api.massive.com/v2/aggs/ticker/O:SPY${exp.slice(2).replaceAll("-", "")}P00${k}000/range/1/day/2026-11-19/2026-11-19?adjusted=false`);
	const empty = { ticker: "x", resultsCount: 0, status: "OK" };
	const listUrl = "https://api.massive.com/v3/reference/options/contracts?underlying_ticker=SPY&contract_type=put&expiration_date.gte=2026-12-10&expiration_date.lte=2027-01-03&strike_price.gte=703.00&strike_price.lte=777.00&as_of=2026-11-19&sort=expiration_date&order=asc&limit=250";
	const contract = (exp: string, k: number) => ({ ticker: `O:SPY${exp.slice(2).replaceAll("-", "")}P00${k}000`, underlying_ticker: "SPY", contract_type: "put", exercise_style: "american", expiration_date: exp, strike_price: k, shares_per_contract: 100 });
	const exps = ["2026-12-10", "2026-12-11", "2026-12-14", "2026-12-15"];
	const traded = await replay("iv", "daily", {
		change: (input) => (input.now = "2026-11-20T00:30:00.000Z"),
		respond: (r) => {
			r[listUrl] = { results: exps.flatMap((e) => [contract(e, 740), contract(e, 741), contract(e, 742)]), status: "OK" };
			for (const u of [...strikes("2026-12-10"), ...strikes("2026-12-11"), ...strikes("2026-12-14")]) r[u] = empty;
			r[strikes("2026-12-11")[1]!] = { ticker: "x", resultsCount: 1, results: [{ c: 12.8, t: 1795064400000 }], status: "OK" };
			r["https://api.massive.com/v3/snapshot/options/SPY/O:SPY261211P00741000"] = { results: {}, status: "OK" };
		},
	});
	assert.deepEqual(traded.output.records.map((r: Record<string, unknown>) => [r.data_status, r.option_symbol]), [["ok", "O:SPY261211P00741000"]]);
	const none = await replay("iv", "daily", {
		change: (input) => (input.now = "2026-11-20T00:30:00.000Z"),
		respond: (r) => {
			r[listUrl] = { results: exps.flatMap((e) => [contract(e, 740), contract(e, 741), contract(e, 742)]), status: "OK" };
			for (const u of [...strikes("2026-12-10"), ...strikes("2026-12-11"), ...strikes("2026-12-14")]) r[u] = empty;
		},
	});
	assert.deepEqual(none.output.records.map((r: Record<string, unknown>) => r.data_status), ["no-data"]);
	assert.equal(none.fetched.filter((u) => u.includes("/O:")).length, 6, "探最近 3 个到期日各 2 张");
});

test("上市不到一年（SPCX）：从上市日起回填，不碰代码以前那只 ETF 的日线；期权挂牌前的日子不记行、不报代码写错", async () => {
	const { output, fetched } = await replay("iv", "backfill-new-listing");
	assert.deepEqual(output.records.map((r: Record<string, unknown>) => [r.trade_date, r.data_status, r.option_symbol ?? null]), [["2026-06-16", "ok", "O:SPCX260717P00160000"]]);
	assert.equal(output.problem, undefined);
	assert.ok(fetched.every((u) => !u.includes("2025-")), "没有查上市前的日子");
	assert.deepEqual(done(output), { SPCX: "2026-06-16" });
});

test("期权挂牌前的日子跳过后记在 cursor 里，下一拍不重查", async () => {
	const first = await replay("iv", "backfill-new-listing", { change: (input) => (input.settings = { requestsPerTick: 10 }) });
	assert.deepEqual(first.output.records, []);
	const next = await replay("iv", "backfill-new-listing", {
		change: (input) => ((input.cursor = first.output.cursor), (input.settings = { requestsPerTick: 10 })),
		respond: (r) => (r["https://api.massive.com/v2/aggs/ticker/SPCX/range/1/day/2026-06-15/2026-11-19?adjusted=false&sort=asc&limit=50000"] = r["https://api.massive.com/v2/aggs/ticker/SPCX/range/1/day/2026-06-12/2026-11-19?adjusted=false&sort=asc&limit=50000"]),
	});
	assert.ok(!next.fetched.some((u) => u.includes("/v3/reference/tickers/") || u.includes("as_of=2026-06-12")), "没有重查上市日和已跳过的日子");
	assert.deepEqual(next.output.records.map((r: Record<string, unknown>) => r.trade_date), ["2026-06-16"]);
});

test("行情服务不认识这个代码：不写行，回 problem 提示代码可能写错", async () => {
	const { output, fetched } = await replay("iv", "backfill-unknown-symbol");
	assert.deepEqual(output.records, []);
	assert.equal(output.problem?.id, "unknown-symbol");
	assert.match(output.problem.text, /ZZZZ.*代码可能写错/);
	assert.equal(fetched.length, 1);
	assert.equal(JSON.parse(output.cursor).failures, 0, "不算行情服务出错");
});
