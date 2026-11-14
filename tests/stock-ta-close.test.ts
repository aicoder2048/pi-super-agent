import assert from "node:assert/strict";
import test from "node:test";
import { close, type CloseInput, type DailyBar, type TaSignal } from "../docs/modules/examples/stock-ta/feeds/scan/close.ts";
import type { Hit } from "../docs/modules/examples/stock-ta/hits.ts";
import { parseRuleLevels, type LevelRow } from "../docs/modules/examples/stock-ta/watch-rules.ts";

const DATE = "2026-11-12";
const AT = "2026-11-12T21:00:00.000Z";
/** 21 sessions of 1,000,000 shares closing at 100, then the session itself. */
const bars = (close: number, volume: number): DailyBar[] => [
	...Array.from({ length: 21 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, close: 100, volume: 1_000_000 })),
	{ date: DATE, close, volume },
];
const ma = (period: number, direction: "bullish" | "bearish", attention = "normal", extra: Partial<TaSignal> = {}): TaSignal => ({
	symbol: "NVDA", rule_id: `R-MA-2-${period}`, kind: `${direction === "bullish" ? "站上" : "跌破"} MA${period}`, direction, price: 97,
	attention, values: { left: 97, right: 98.5 }, ...extra,
});
const ta = (rule: string, direction: string, attention = "key", kind = "三重顶跌破颈线（空）"): TaSignal => ({ symbol: "NVDA", rule_id: rule, kind, direction, price: 97, attention, values: {} });
const input = (over: Partial<CloseInput> = {}): CloseInput => ({
	date: DATE, at: AT, symbols: ["NVDA"], signals: [], bars: { NVDA: bars(97, 1_000_000) }, earlier: [], levels: parseRuleLevels([]).levels, quiet: false, ...over,
});
const levels = (...rows: Record<string, unknown>[]) => parseRuleLevels(rows.map((fields, i): LevelRow => ({ id: String(i + 1), fields }))).levels;
const quoteHit = (rule: string, lean: Hit["lean"], level: Hit["level"], extra: Partial<Hit> = {}): Hit => ({
	id: `${rule}:NVDA:${DATE}`, rule, symbol: "NVDA", date: DATE, at: "2026-11-12T16:00:00.000Z", lean, fact: rule, level, text: "", ...extra,
});

test("收盘跌破 200 日线：5 层开任务，派结构和动量（structure-trend），不发那一行；线程挂在模块下的 代码:日期", () => {
	const r = close(input({ signals: [ma(200, "bearish")] }));
	assert.deepEqual(r.hits.map((h) => [h.id, h.rule, h.level, h.lean]), [[`R-MA-2-200:NVDA:${DATE}`, "R-MA-2-200", 5, "bear"]]);
	assert.deepEqual(r.alerts, []);
	assert.deepEqual(r.notices.map((n) => [n.id, n.thread, n.threadScope, n.fields.rule, n.fields.level, n.fields.plan]), [[`R-MA-2-200:NVDA:${DATE}`, `NVDA:${DATE}`, "module", "R-MA-2-200", "5", "structure-trend"]]);
	assert.match(r.notices[0]!.fields.line, /^NVDA 收盘跌破 200 日线（收盘 97\.00，200 日均线 98\.50）。当天跌 -3\.00%。收盘日线 11-12（美东）。$/);
});

test("200 日线加同日收盘放量（看同一边）：任务正文写「放量确认」和放量倍数；放量自己只记录", () => {
	const r = close(input({ signals: [ma(200, "bearish")], bars: { NVDA: bars(97, 2_400_000) } }));
	assert.deepEqual(r.hits.map((h) => [h.rule, h.level]), [["volume-close", 0], ["R-MA-2-200", 5]]);
	assert.match(r.notices[0]!.fields.line, /。放量确认（收盘成交量是 20 日均量的 2\.4 倍）。/);
	const up = close(input({ signals: [ma(200, "bearish")], bars: { NVDA: bars(103, 2_400_000) } }));
	assert.doesNotMatch(up.notices[0]!.fields.line, /放量确认/, "放量上涨不确认跌破");
});

test("收盘跌破 50 日线：2 层静音一行，不开任务（使用者 2026-11-13 定）", () => {
	const r = close(input({ signals: [ma(50, "bearish")] }));
	assert.deepEqual(r.hits.map((h) => [h.rule, h.level]), [["R-MA-2-50:down", 2]]);
	assert.deepEqual(r.alerts.map((a) => [a.id, a.push]), [[`R-MA-2-50:down:NVDA:${DATE}`, "silent"]]);
	assert.match(r.alerts[0]!.text, /^NVDA 收盘跌破 50 日线（收盘 97\.00，50 日均线 98\.50）。/);
	assert.deepEqual(r.notices, []);
});

test("组合：放量加跌破 50 日线开 5 层任务（structure-trend），只发组合那一行", () => {
	const r = close(input({ signals: [ma(50, "bearish")], bars: { NVDA: bars(97, 1_600_000) } }));
	assert.deepEqual(r.hits.map((h) => [h.rule, h.level, h.combo]), [["volume-close", 0, "volume-close+R-MA-2-50:down"], ["R-MA-2-50:down", 2, "volume-close+R-MA-2-50:down"], ["volume-close+R-MA-2-50:down", 5, undefined]]);
	assert.deepEqual(r.alerts.map((a) => a.id), [`volume-close+R-MA-2-50:down:NVDA:${DATE}`]);
	assert.match(r.alerts[0]!.text, /^NVDA 放量跌破 50 日线：收盘跌破 50 日线（收盘 97\.00，50 日均线 98\.50），收盘成交量是 20 日均量的 1\.6 倍。/);
	assert.deepEqual(r.notices.map((n) => [n.fields.rule, n.fields.plan, n.threadScope]), [["volume-close+R-MA-2-50:down", "structure-trend", "module"]]);
});

test("站上 50 日线只记录（0 层）；ta 的其余信号 0 层；重点形态 1 层，都不发", () => {
	const r = close(input({ signals: [ma(50, "bullish"), ta("R-SR-4", "bearish", "normal", "跌破整数关口 100"), ta("R-PAT-1-T", "bearish")] }));
	assert.deepEqual(r.hits.map((h) => [h.id, h.rule, h.level]).sort(), [
		[`R-MA-2-50:up:NVDA:${DATE}`, "R-MA-2-50:up", 0],
		[`R-PAT-1-T:down:NVDA:${DATE}`, "ta-key", 1],
		[`R-SR-4:down:NVDA:${DATE}`, "ta-other", 0],
	]);
	assert.deepEqual([r.alerts, r.notices], [[], []]);
	assert.equal(r.hits.find((h) => h.rule === "ta-key")!.signal, "R-PAT-1-T");
});

test("ta 判为噪音的信号降到 0 层：200 日线也不开任务，写明 ta 判它来回翻", () => {
	const r = close(input({ signals: [ma(200, "bearish", "noise", { values: { left: 97, right: 98.5, whipsaw: { flips: 3, start_ms: 0 } } })] }));
	assert.deepEqual(r.hits.map((h) => [h.rule, h.level, h.whipsaw]), [["R-MA-2-200", 0, 3]]);
	assert.deepEqual([r.alerts, r.notices], [[], []]);
	assert.match(r.hits[0]!.text, /近 12 根日线反复翻转 3 次/);
});

test("同向升一层跨 feed：盘中 52 周新高（看多）加收盘重点形态（看多、ta 判重点），形态从 1 层升到 2 层静音一行", () => {
	const earlier = [quoteHit("high-52w", "bull", 2)];
	const r = close(input({ earlier, signals: [ta("R-PAT-1-B", "bullish", "key", "三重底突破颈线（多）")] }));
	assert.deepEqual(r.hits.map((h) => [h.rule, h.level, h.bumped]), [["ta-key", 2, true]]);
	assert.match(r.alerts[0]!.text, /。同向升一层（看多 2 条，看空 0 条）。/);
	assert.equal(r.alerts[0]!.push, "silent");
});

test("ta 不判重点的信号不升层：key 是升一层的条件之一", () => {
	const earlier = [quoteHit("high-52w", "bull", 2)];
	const r = close(input({ earlier, signals: [ta("R-PAT-1-B", "bullish", "normal", "三重底突破颈线（多）")] }));
	assert.deepEqual(r.hits.map((h) => [h.rule, h.level, h.bumped]), [["ta-key", 1, undefined]]);
	assert.deepEqual(r.alerts, []);
});

test("多空分歧跨 feed：盘中 52 周新高（看多）以后收盘跌破 50 日线（看空），不升层，那一行写分歧", () => {
	const r = close(input({ earlier: [quoteHit("high-52w", "bull", 2)], signals: [ma(50, "bearish")] }));
	assert.deepEqual(r.hits.map((h) => [h.rule, h.level]), [["R-MA-2-50:down", 2]]);
	assert.match(r.alerts[0]!.text, /。同日：high-52w。多空分歧（看多 1 条，看空 1 条）。/);
});

test("这只票今天盘中已经开了任务就不升层；200 日线照开任务，进同一个线程", () => {
	const earlier = [quoteHit("high-52w", "bull", 2), quoteHit("move-1", "bull", 5, { id: `move-1:NVDA:${DATE}:up` })];
	const r = close(input({ earlier, signals: [ta("R-PAT-1-B", "bullish", "key", "三重底突破颈线（多）"), ma(200, "bullish", "key", { values: { left: 103, right: 101 } })], bars: { NVDA: bars(103, 1_000_000) } }));
	assert.deepEqual(r.hits.map((h) => [h.rule, h.level]), [["ta-key", 1], ["R-MA-2-200", 5]]);
	assert.deepEqual(r.notices.map((n) => n.thread), [`NVDA:${DATE}`]);
});

test("到档一个方向只算一条：两档同一拍到（层级被改成 2，没开任务），收盘跌破 50 日线写「看多 1 条，看空 1 条」", () => {
	const earlier = [quoteHit("move-1", "bull", 2, { id: `move-1:NVDA:${DATE}:up` }), quoteHit("move-2", "bull", 2, { id: `move-2:NVDA:${DATE}:up` })];
	const r = close(input({ earlier, signals: [ma(50, "bearish")] }));
	assert.match(r.alerts[0]!.text, /多空分歧（看多 1 条，看空 1 条）/);
});

test("rule-levels 改了收盘规则：跌破 50 日线改成 0 层就只记录；改成 5 层就开任务", () => {
	const silent = close(input({ signals: [ma(50, "bearish")], levels: levels({ rule: "R-MA-2-50:down", level: 0 }) }));
	assert.deepEqual([silent.hits[0]!.level, silent.alerts, silent.notices], [0, [], []]);
	const task = close(input({ signals: [ma(50, "bearish")], levels: levels({ rule: "R-MA-2-50:down", level: 5 }) }));
	assert.deepEqual(task.notices.map((n) => n.fields.plan), ["structure-trend"]);
});

test("只看自选股里的个股：不在名单里的信号、SPY 和 QQQ 的信号不记", () => {
	const r = close(input({ symbols: ["NVDA", "SPY"], signals: [{ ...ma(200, "bearish"), symbol: "AMD" }, { ...ma(200, "bearish"), symbol: "SPY" }] }));
	assert.deepEqual(r.hits, []);
});

test("已经记下的命中不重算：同一天再扫一次（加了自选股），之前的命中原样留着，不再发", () => {
	const first = close(input({ signals: [ma(200, "bearish")] }));
	const again = close(input({ signals: [ma(200, "bearish")], earlier: first.hits }));
	assert.deepEqual([again.hits, again.alerts, again.notices], [[], [], []]);
});

test("免打扰时段：静音一行和任务都先留着，命中标成 held", () => {
	const r = close(input({ quiet: true, signals: [ma(200, "bearish"), { ...ma(50, "bearish"), symbol: "NVDA", rule_id: "R-MA-2-50" }] }));
	assert.deepEqual([r.alerts, r.notices], [[], []]);
	assert.deepEqual(r.hits.map((h) => [h.rule, h.held]), [["R-MA-2-50:down", true], ["R-MA-2-200", true]]);
});

test("理由写成事实：不出现分数、评分、胜率", () => {
	const r = close(input({ earlier: [quoteHit("high-52w", "bull", 2)], signals: [ma(50, "bearish"), ta("R-PAT-1-B", "bullish")], bars: { NVDA: bars(97, 1_600_000) } }));
	for (const h of r.hits) assert.doesNotMatch(h.text, /分数|评分|胜率|score/);
});
