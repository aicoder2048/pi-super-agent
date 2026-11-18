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
		id: "SPY:2026-11-19:option-ta-iv-close-v1", symbol: "SPY", trade_date: "2026-11-19", option_symbol: "O:SPY261210P00740000", strike: 740, expiry: "2026-12-10",
		contract_close: 12.3, underlying_close: 740, quote_midpoint: 12.35, quote_at: "2026-11-19T21:14:00.000Z", fetched_at: "2026-11-19T21:40:00.000Z",
		source: "Massive", methodology: "option-ta-iv-close-v1", data_status: "ok",
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
	assert.ok(fetched.length <= 15, `请求 ${fetched.length} 次，超过上限`);
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
