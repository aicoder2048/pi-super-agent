import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { isInverted, marketRegime, parseCboeHistory, readVixSeries, vixLevel, type VixSeries } from "../../docs/modules/examples/option-ta/vix.ts";
import { classifyIvHvRatio, ivQuadrant } from "../../docs/modules/examples/option-ta/vol-regime.ts";
import { replay } from "../helpers/option-ta-feed-replay.ts";

const done = (output: { cursor?: string }) => JSON.parse(output.cursor!).done;

test("CBOE 历史文件：MM/DD/YYYY 转成 YYYY-MM-DD，坏行跳过；表头不对就抛错，不当成空文件", () => {
	const text = "﻿DATE,OPEN,HIGH,LOW,CLOSE\r\n11/16/2026,20.000000,24.520000,19.840000,22.910000\r\n11/17/2026,23.11,27.73,22.36,\r\nbad,1,2,3,4\r\n11/17/2026,23.11,27.73,22.36,25.46\r\n";
	assert.deepEqual(parseCboeHistory(text), [
		{ date: "2026-11-16", open: 20, high: 24.52, low: 19.84, close: 22.91 },
		{ date: "2026-11-17", open: 23.11, high: 27.73, low: 22.36, close: 25.46 },
	]);
	assert.throws(() => parseCboeHistory("<html>moved</html>"), /表头/);
});

test("VIX 档位：<15 平静、15—20 正常、20—25 偏高、25—35 开始紧张、35—50 恐慌、≥50 危机，下界算本档", () => {
	assert.deepEqual([14.99, 15, 19.99, 20, 25, 34.99, 35, 50].map(vixLevel), ["平静", "正常", "正常", "偏高", "开始紧张", "开始紧张", "恐慌", "危机"]);
});

test("期限结构：VIX ≥ VIX3M 算倒挂，VIX3M 高于 VIX 是正常", () => {
	assert.equal(isInverted(25.46, 24.98), true);
	assert.equal(isInverted(24.98, 24.98), true);
	assert.equal(isInverted(18, 21), false);
});

const series = (vix: [string, number][], vix9d: [string, number][] = [], vix3m: [string, number][] = []): VixSeries => ({ VIX: new Map(vix), VIX9D: new Map(vix9d), VIX3M: new Map(vix3m) });

test("市场环境：取 VIX 最新一天，同一天的 VIX3M 比期限结构，一年分位只看一年内的收盘", () => {
	const out = marketRegime(series([["2025-11-01", 40], ["2025-12-01", 20], ["2026-06-01", 15], ["2026-11-17", 25.46]], [["2026-11-17", 26.7]], [["2026-11-17", 24.98]]));
	assert.deepEqual(out, {
		status: "OK", date: "2026-11-17", vix: 25.46, level: "开始紧张", vix9d: 26.7, vix3m: 24.98, term: "倒挂", vix_over_vix3m: 1.0192,
		vix_percentile_1y: 0.6667, days: 3, source: "CBOE 每日收盘（VIX、VIX9D、VIX3M 历史文件）",
	});
});

test("市场环境：同一天没有 VIX3M 时期限结构为空并说明，不拿前一天的凑；没有 VIX 回 NO_DATA", () => {
	const out = marketRegime(series([["2026-11-16", 22], ["2026-11-17", 25]], [], [["2026-11-16", 23]]));
	assert.equal(out.status, "OK");
	assert.equal(out.status === "OK" && out.term, null);
	assert.match(out.status === "OK" ? out.note ?? "" : "", /VIX3M 还没有/);
	assert.equal(marketRegime(series([])).status, "NO_DATA");
});

test("IV/HV 分档照使用者笔记：<0.8 便宜、<0.95 略便宜、<1.2 合理、<2 偏贵、≥2 很贵", () => {
	assert.deepEqual([0.79, 0.8, 0.94, 0.95, 1.19, 1.2, 1.99, 2].map((r) => classifyIvHvRatio(r, 1)), ["cheap", "slightly_cheap", "slightly_cheap", "fair", "fair", "rich", "rich", "very_rich"]);
});

test("四象限：分位 ≥0.8 且 IV/HV ≥1.2 偏贵；分位 ≤0.2 且 IV/HV <0.8 偏便宜；一贵一便宜信号不一致；缺一项为空", () => {
	assert.equal(ivQuadrant(0.8, 1.2), "偏贵");
	assert.equal(ivQuadrant(0.79, 1.5), "中间");
	assert.equal(ivQuadrant(0.2, 0.79), "偏便宜");
	assert.equal(ivQuadrant(0.9, 0.7), "信号不一致");
	assert.equal(ivQuadrant(0.1, 1.3), "信号不一致");
	assert.equal(ivQuadrant(null, 1.3), null);
});

test("vix feed 第一次跑：三个指数都回填一年内的收盘，早于一年前那天的不要，cursor 记到最新交易日", async () => {
	const { output, fetched } = await replay("vix", "backfill");
	assert.equal(fetched.length, 3);
	const rows = output.records.map((r: Record<string, unknown>) => `${r.ticker} ${r.trade_date} ${r.close}`);
	assert.deepEqual(rows, ["VIX 2025-11-17 18.5", "VIX 2025-11-18 21", "VIX 2026-11-13 18.1", "VIX 2026-11-16 22", "VIX 2026-11-17 25.5", "VIX9D 2025-11-18 20", "VIX9D 2026-11-16 22.5", "VIX9D 2026-11-17 26.5", "VIX3M 2025-11-18 21.5", "VIX3M 2026-11-16 23", "VIX3M 2026-11-17 25"]);
	assert.deepEqual(output.records[0], { id: "VIX:2025-11-17", ticker: "VIX", trade_date: "2025-11-17", open: 18, high: 19.5, low: 17.5, close: 18.5, source: "CBOE", fetched_at: "2026-11-18T01:00:00.000Z" });
	assert.deepEqual(done(output), { VIX: "2026-11-17", VIX9D: "2026-11-17", VIX3M: "2026-11-17" });
	assert.equal(output.problem, undefined);
});

test("vix feed 日常：只存 cursor 之后的新一天；同一天再跑不取数", async () => {
	const { output } = await replay("vix", "daily");
	assert.deepEqual(output.records.map((r: Record<string, unknown>) => r.id), ["VIX:2026-11-17", "VIX9D:2026-11-17", "VIX3M:2026-11-17"]);
	const again = await replay("vix", "already-saved");
	assert.deepEqual(again.fetched, []);
	assert.deepEqual(again.output.records, []);
});

test("vix feed：CBOE 还没出当天收盘，不写行、cursor 不动、不报警；收盘 18 小时后还没有才报 not-ready", async () => {
	const early = await replay("vix", "not-published");
	assert.deepEqual(early.output.records, []);
	assert.deepEqual(done(early.output), { VIX: "2026-11-16", VIX9D: "2026-11-16", VIX3M: "2026-11-16" });
	assert.equal(early.output.problem, undefined);
	const late = await replay("vix", "not-published", { change: (input) => (input.now = "2026-11-18T16:00:00.000Z") });
	assert.equal(late.output.problem?.id, "not-ready");
	assert.match(late.output.problem.text, /2026-11-17/);
});

test("vix feed：周六晚上目标仍是周五；当天收盘后 15 分钟还不取，31 分钟开始取", async () => {
	const fridayDone = JSON.stringify({ done: { VIX: "2026-11-20", VIX9D: "2026-11-20", VIX3M: "2026-11-20" }, failures: 0 });
	const weekend = await replay("vix", "already-saved", { change: (input) => ((input.now = "2026-11-22T03:00:00.000Z"), (input.cursor = fridayDone)) });
	assert.deepEqual(weekend.fetched, [], "周六 22:00 美东");
	const early = await replay("vix", "already-saved", { change: (input) => ((input.now = "2026-11-17T21:15:00.000Z"), (input.cursor = JSON.stringify({ done: { VIX: "2026-11-16", VIX9D: "2026-11-16", VIX3M: "2026-11-16" }, failures: 0 }))) });
	assert.deepEqual(early.fetched, [], "收盘后 15 分钟");
	const after = await replay("vix", "daily", { change: (input) => (input.now = "2026-11-17T21:31:00.000Z") });
	assert.equal(after.fetched.length, 3, "收盘后 31 分钟");
	assert.deepEqual(after.output.records.map((r: Record<string, unknown>) => r.trade_date), ["2026-11-17", "2026-11-17", "2026-11-17"]);
});

test("vix feed：文件里休市日的行（CBOE 的 VIX 有盘后值）和目标日之后的行都不存", async () => {
	const { output } = await replay("vix", "holiday-row");
	assert.deepEqual(output.records.map((r: Record<string, unknown>) => r.id), ["VIX:2026-09-08", "VIX9D:2026-09-08", "VIX3M:2026-09-08"]);
	assert.deepEqual(done(output), { VIX: "2026-09-08", VIX9D: "2026-09-08", VIX3M: "2026-09-08" });
});

test("vix feed：一个指数取到、下一个失败时，取到的行照存、它的 cursor 前移，其余不动；成功一次失败次数清零", async () => {
	const { output } = await replay("vix", "partial-failure");
	assert.deepEqual(output.records.map((r: Record<string, unknown>) => r.id), ["VIX:2026-11-17"]);
	assert.deepEqual(done(output), { VIX: "2026-11-17", VIX9D: "2026-11-16", VIX3M: "2026-11-16" });
	assert.equal(JSON.parse(output.cursor).failures, 3);
	assert.equal(output.problem?.id, "data-down");
	const ok = await replay("vix", "daily", { change: (input) => (input.cursor = JSON.stringify({ done: { VIX: "2026-11-16", VIX9D: "2026-11-16", VIX3M: "2026-11-16" }, failures: 2 })) });
	assert.equal(JSON.parse(ok.output.cursor).failures, 0);
});

test("vix feed：缺的那天一直没补上，下一个交易日收盘后 not-ready 也不断，日期仍写缺的那天", async () => {
	const { output } = await replay("vix", "not-published", { change: (input) => (input.now = "2026-11-18T22:00:00.000Z") });
	assert.equal(output.problem?.id, "not-ready");
	assert.match(output.problem.text, /^2026-11-17 收盘/);
});

test("vix feed：HTTP 5xx 或文件不是 CSV 只记次数，连着第三次报 data-down；已存的不受影响", async () => {
	const third = await replay("vix", "http-5xx-third-beat");
	assert.equal(third.output.problem?.id, "data-down");
	assert.match(third.output.problem.text, /HTTP 503/);
	const html = await replay("vix", "not-csv");
	assert.equal(html.output.problem, undefined);
	assert.equal(JSON.parse(html.output.cursor).failures, 1);
	assert.deepEqual(html.output.records, []);
});

test("vol 读 vix-closes：PSA_MODULE_DATA 下的 data.db 有收盘就回 OK，没有表回 NO_DATA", () => {
	const dir = mkdtempSync(join(tmpdir(), "option-ta-vix-"));
	const saved = process.env["PSA_MODULE_DATA"];
	process.env["PSA_MODULE_DATA"] = dir;
	try {
		const db = new DatabaseSync(join(dir, "data.db"));
		db.exec(`CREATE TABLE "other" (x)`);
		assert.equal(marketRegime(readVixSeries()).status, "NO_DATA");
		db.exec(`CREATE TABLE "vix-closes" ("_id" INTEGER PRIMARY KEY, ticker TEXT, trade_date TEXT, close REAL)`);
		const insert = db.prepare(`INSERT INTO "vix-closes" (ticker, trade_date, close) VALUES (?, ?, ?)`);
		for (const [t, d, c] of [["VIX", "2026-11-16", 22.91], ["VIX", "2026-11-17", 25.46], ["VIX3M", "2026-11-17", 24.98], ["VIX9D", "2026-11-17", null], ["OTHER", "2026-11-17", 1]] as const) insert.run(t, d, c);
		db.close();
		const out = marketRegime(readVixSeries());
		assert.equal(out.status === "OK" && `${out.date} ${out.vix} ${out.term} ${out.vix9d}`, "2026-11-17 25.46 倒挂 null");
	} finally {
		if (saved === undefined) delete process.env["PSA_MODULE_DATA"];
		else process.env["PSA_MODULE_DATA"] = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});
