import assert from "node:assert/strict";
import test from "node:test";
import { newDay, watch, type Context, type DayState } from "../docs/modules/examples/stock-ta/feeds/quotes/watch.ts";
import { badgeAlerts } from "../docs/modules/examples/stock-ta/badges.ts";
import type { Hit } from "../docs/modules/examples/stock-ta/hits.ts";
import type { Quote } from "../docs/modules/examples/stock-ta/massive.ts";
import { parseRuleLevels, quietAt, type LevelRow } from "../docs/modules/examples/stock-ta/watch-rules.ts";

const DATE = "2026-11-12";
const ny = (hhmm: string) => new Date(Date.parse(`${DATE}T${hhmm}:00-05:00`)).toISOString();
type Extra = Partial<Pick<Quote, "volume" | "dayOpen" | "dayHigh" | "dayLow">>;
const q = (symbol: string, price: number, prevClose: number, hhmm: string, extra: Extra = {}): Quote => ({
	symbol, price, prevClose, changePct: Math.round((price / prevClose - 1) * 10_000) / 100, volume: null, at: ny(hhmm), dayClose: price, dayOpen: null, dayHigh: null, dayLow: null, ...extra,
});
const HISTORY = { high52: 110, low52: 90, avgVolume20: 1_000_000 };
const ctx = (over: Partial<Context> = {}): Context => ({ levels: parseRuleLevels([]).levels, history: { NVDA: HISTORY, AMD: HISTORY }, past: {}, quiet: false, ...over });
/** Volume that is exactly `x` times the 20-day average scaled to the elapsed regular session at `hhmm`. */
const paced = (x: number, hhmm: string) => {
	const [h, m] = hhmm.split(":").map(Number) as [number, number];
	return Math.ceil(x * HISTORY.avgVolume20 * ((h * 60 + m - 570) / 390));
};
const run = (day: DayState, c: Context, ...beats: Quote[][]) => beats.map((quotes) => watch(day, quotes, c));
const lines = (r: ReturnType<typeof watch>) => r.alerts.map((a) => `${a.push ?? "ring"} ${a.text}`);

test("放量：美东 10:30 以前不算；之后累计成交量到 3.5 倍的折算均量，静音一行，方向跟当天涨跌", () => {
	const day = newDay(DATE);
	const [early, late] = run(day, ctx(), [q("NVDA", 102, 100, "10:29", { volume: paced(9, "10:29") })], [q("NVDA", 102, 100, "11:00", { volume: paced(3.5, "11:00") })]);
	assert.deepEqual(early!.hits, []);
	assert.equal(late!.hits.length, 1);
	const hit = late!.hits[0]!;
	assert.deepEqual([hit.rule, hit.level, hit.lean], ["volume", 2, "bull"]);
	assert.equal(late!.alerts.length, 1);
	assert.equal(late!.alerts[0]!.push, "silent");
	assert.match(late!.alerts[0]!.text, /^NVDA 放量 3\.5 倍（按已过的交易时段折算）。当天涨 \+2\.00%。/);
	assert.deepEqual(late!.notices, []);
});

test("放量不到门槛不报；没有 20 日均量（日线库里还没有这只票）也不报", () => {
	const r = run(newDay(DATE), ctx({ history: { NVDA: null } }), [q("NVDA", 102, 100, "11:00", { volume: paced(10, "11:00") })], [q("AMD", 102, 100, "11:00", { volume: paced(3.4, "11:00") })]);
	assert.deepEqual(r.flatMap((x) => x.hits), []);
});

test("52 周新高静音一行，52 周新低响铃一行，都写出此前的最高最低", () => {
	const [r] = run(newDay(DATE), ctx(), [q("NVDA", 109, 105, "10:00", { dayHigh: 111.5 }), q("AMD", 92, 95, "10:00", { dayLow: 89.2 })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.symbol, h.level, h.lean]), [["high-52w", "NVDA", 2, "bull"], ["low-52w", "AMD", 3, "bear"]]);
	assert.deepEqual(lines(r!).map((l) => l.split("。")[0]), ["silent NVDA 创 52 周新高 111.50（此前最高 110.00）", "ring AMD 创 52 周新低 89.20（此前最低 90.00）"]);
});

test("开盘跳空 3% 是 1 层页面标记：一行 push: badge 的提醒，key 是代码，写的是事实；不响、不开任务", () => {
	const [r] = run(newDay(DATE), ctx(), [q("NVDA", 103.5, 100, "09:45", { dayOpen: 103.4 })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level, h.lean, h.fact]), [["gap", 1, "bull", "开盘跳空 +3.40%"]]);
	assert.deepEqual(r!.alerts, [{ id: `badge:NVDA:${DATE}:1`, text: "NVDA · 开盘跳空 +3.40%", at: ny("09:45"), push: "badge", key: "NVDA" }]);
	assert.deepEqual(r!.notices, []);
});

test("页面标记一只票一个：同一天后来的 1 层命中换掉前一个，列出当天全部 1 层的事实；别的票各自一个", () => {
	const day = newDay(DATE);
	const [gap, rest] = run(day, ctx(), [q("NVDA", 103.5, 100, "09:45", { dayOpen: 103.4 })], [q("QQQ", 101.2, 100, "13:00"), q("NVDA", 99.6, 100, "13:00", { dayOpen: 103.4, dayHigh: 103.6 }), q("AMD", 101.5, 100, "13:00", { dayLow: 96.4 })]);
	assert.deepEqual(gap!.alerts.map((a) => [a.id, a.key, a.text]), [[`badge:NVDA:${DATE}:1`, "NVDA", "NVDA · 开盘跳空 +3.40%"]]);
	const badges = rest!.alerts.filter((a) => a.push === "badge");
	assert.deepEqual(badges.map((a) => [a.id, a.key]), [[`badge:NVDA:${DATE}:2`, "NVDA"], [`badge:AMD:${DATE}:1`, "AMD"]]);
	assert.match(badges[0]!.text, /^NVDA · 开盘跳空 \+3\.40% · 盘中曾涨 \+3\.60%，现在跌 -0\.40%/);
});

test("升了层的不做标记：跳空 1 层是标记，同一拍的新高升到 3 层响铃；标记只列 1 层的", () => {
	const [r] = run(newDay(DATE), ctx(), [q("NVDA", 104, 100, "11:00", { dayOpen: 103.4, dayHigh: 111.5 })]);
	assert.deepEqual(r!.alerts.map((a) => [a.push ?? "ring", a.text.split("。")[0]]), [["ring", "NVDA 创 52 周新高 111.50（此前最高 110.00）"], ["badge", "NVDA · 开盘跳空 +3.40%"]]);
});

test("rule-levels 把一条规则改成 1 层就做标记：52 周新高改成 1 层，不发静音一行，卡片上标出来", () => {
	const rows: LevelRow[] = [{ id: "1", fields: { rule: "high-52w", level: 1 } }];
	const [r] = run(newDay(DATE), ctx({ levels: parseRuleLevels(rows).levels }), [q("NVDA", 104, 100, "10:00", { dayHigh: 111 })]);
	assert.deepEqual(r!.alerts.map((a) => [a.push, a.text]), [["badge", "NVDA · 创 52 周新高 111.00（此前最高 110.00）"]]);
});

test("免打扰不管页面标记：标记不打扰你，照样上卡片，命中不标 held", () => {
	const [r] = run(newDay(DATE), ctx({ quiet: true }), [q("NVDA", 103.5, 100, "15:59", { dayOpen: 103.4 })]);
	assert.deepEqual(r!.alerts.map((a) => a.push), ["badge"]);
	assert.equal(r!.hits[0]!.held, undefined);
});

test("盘中反转：曾涨 3% 以上、现在翻成跌，记一条看空；曾跌 3% 以上翻成涨，记一条看多", () => {
	const [r] = run(newDay(DATE), ctx(), [q("NVDA", 99.6, 100, "13:00", { dayHigh: 103.6 }), q("AMD", 100.4, 100, "13:00", { dayLow: 96.5 })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.symbol, h.lean, h.fact]), [["reversal", "NVDA", "bear", "盘中曾涨 +3.60%，现在跌 -0.40%"], ["reversal", "AMD", "bull", "盘中曾跌 -3.50%，现在涨 +0.40%"]]);
});

test("逆大盘：个股和 QQQ 当天方向相反、相差 3 个百分点以上，记一条；SPY、QQQ 自己不算", () => {
	const [r] = run(newDay(DATE), ctx(), [q("QQQ", 98.8, 100, "11:00"), q("NVDA", 102.1, 100, "11:00"), q("AMD", 101, 100, "11:00")]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.symbol, h.lean, h.fact]), [["rel-strength", "NVDA", "bull", "逆大盘：NVDA +2.10%，QQQ -1.20%"]]);
});

test("VIXY 涨 10% 静音一行；涨 20% 开盘面任务（market-desk），同一拍两档都到只发一行", () => {
	const day = newDay(DATE);
	const [one] = run(day, ctx(), [q("VIXY", 11, 10, "10:00")]);
	assert.deepEqual(one!.hits.map((h) => [h.rule, h.level, h.lean]), [["vixy-1", 2, "bear"]]);
	assert.equal(one!.alerts[0]!.push, "silent");
	const [both] = run(newDay(DATE), ctx(), [q("VIXY", 12.1, 10, "10:00")]);
	assert.deepEqual(both!.hits.map((h) => h.rule), ["vixy-1", "vixy-2"]);
	assert.equal(both!.alerts.length, 1, "两档同一拍只发一行");
	assert.equal(both!.alerts[0]!.push, "silent");
	assert.deepEqual(both!.notices.map((n) => [n.thread, n.fields.rule, n.fields.level, n.fields.plan]), [[`VIXY:${DATE}`, "vixy-2", "5", "market-desk"]]);
});

test("组合：放量（看多）加 52 周新高开 5 层任务，静音一行，理由写成事实，不写分数", () => {
	const day = newDay(DATE);
	const [, r] = run(day, ctx(), [q("NVDA", 103, 100, "11:00", { volume: paced(3.8, "11:00") })], [q("NVDA", 104, 100, "11:30", { dayHigh: 112.3, volume: paced(4, "11:30") })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level]), [["high-52w", 2], ["volume+high-52w", 5]]);
	assert.equal(r!.alerts.length, 1, "新高自己那一行并进组合，不另发");
	assert.equal(r!.alerts[0]!.push, "silent");
	assert.equal(r!.alerts[0]!.text.split("。")[0], "NVDA 放量创 52 周新高：创 52 周新高 112.30（此前最高 110.00），放量 3.8 倍（按已过的交易时段折算）");
	assert.doesNotMatch(r!.alerts[0]!.text, /分|评|胜率|score/);
	assert.doesNotMatch(r!.alerts[0]!.text, /同日：[^。]*(放量|52 周新高)/, "组合那一行已经写了两条的事实，同日里不再重复");
	assert.deepEqual(r!.notices.map((n) => [n.id, n.thread, n.fields.rule, n.fields.level, n.fields.plan]), [[`volume+high-52w:NVDA:${DATE}`, `NVDA:${DATE}`, "volume+high-52w", "5", "band-move"]]);
});

test("组合：放量（看空）加 52 周新低开任务，那一行响铃", () => {
	const [r] = run(newDay(DATE), ctx(), [q("AMD", 92, 95, "11:00", { dayLow: 88.5, volume: paced(3.6, "11:00") })]);
	assert.deepEqual(r!.hits.map((h) => h.rule), ["volume", "low-52w", "volume+low-52w"]);
	assert.deepEqual(lines(r!).map((l) => l.split("：")[0]), ["ring AMD 放量创 52 周新低"]);
	assert.equal(r!.notices[0]!.fields.plan, "band-move");
});

test("方向相反不升级：先 52 周新高（看多），后放量下跌（看空），不成组合也不升层，那一行写「多空分歧」", () => {
	const day = newDay(DATE);
	const [first, r] = run(day, ctx(), [q("NVDA", 109, 108, "10:00", { dayHigh: 111 })], [q("NVDA", 106, 108, "12:00", { dayHigh: 111, volume: paced(3.6, "12:00") })]);
	assert.equal(first!.alerts[0]!.push, "silent");
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level, h.lean]), [["volume", 2, "bear"]]);
	assert.deepEqual(r!.notices, []);
	assert.equal(r!.alerts[0]!.push, "silent", "没有升到响铃");
	assert.match(r!.alerts[0]!.text, /。多空分歧（看多 1 条，看空 1 条）。/);
});

test("同向共振：同一只票同一天同向的命中到 2 条、多过反向的，1、2 层那条升一层，一行写明看多看空各几条；一天只升一次", () => {
	const day = newDay(DATE);
	const [gap, high, rel] = run(day, ctx(), [q("NVDA", 103.5, 100, "09:45", { dayOpen: 103.4 })], [q("NVDA", 104, 100, "10:00", { dayOpen: 103.4, dayHigh: 111 })], [q("QQQ", 98.5, 100, "11:00"), q("NVDA", 104, 100, "11:00", { dayOpen: 103.4, dayHigh: 111 })]);
	assert.deepEqual(gap!.alerts.map((a) => a.push), ["badge"]);
	assert.deepEqual(high!.hits.map((h) => [h.rule, h.level]), [["high-52w", 3]]);
	assert.equal(high!.alerts[0]!.push, undefined, "2 层升到 3 层，响铃");
	assert.match(high!.alerts[0]!.text, /。同向升一层（看多 2 条，看空 0 条）。/);
	assert.deepEqual(rel!.hits.map((h) => [h.rule, h.level]), [["rel-strength", 1]], "这只票今天已经升过一次");
});

test("同一拍里两条同向命中：先判层级低的，升的是层级高的那条（跳空 1 层在前，新高 2 层升成响铃）", () => {
	const [r] = run(newDay(DATE), ctx(), [q("NVDA", 104, 100, "11:00", { dayOpen: 103.4, dayHigh: 111.5 })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level]), [["gap", 1], ["high-52w", 3]]);
	assert.deepEqual(r!.alerts.map((a) => a.push ?? "ring"), ["ring", "badge"]);
});

test("只升 1、2 层：同一拍跳空（1 层看空）加 52 周新低（3 层看空），新低照 3 层响铃，不升到没有那一行的 4 层", () => {
	const [r] = run(newDay(DATE), ctx(), [q("AMD", 96.5, 100, "10:30", { dayOpen: 96.9, dayLow: 89.5, dayHigh: 97 })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level, h.bumped ?? false]), [["gap", 1, false], ["low-52w", 3, false]]);
	assert.deepEqual(r!.alerts.map((a) => [a.id.split(":")[0], a.push ?? "ring"]), [["low-52w", "ring"], ["badge", "badge"]]);
});

test("3 层的命中只计数：先 52 周新低（3 层看空），后盘中反转看空，反转升到 2 层", () => {
	const day = newDay(DATE);
	const [, r] = run(day, ctx(), [q("AMD", 89.5, 92, "10:30", { dayLow: 89.5 })], [q("AMD", 91, 92, "13:00", { dayLow: 89.5, dayHigh: 95 })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level, h.bumped ?? false]), [["reversal", 2, true]]);
	assert.equal(r!.alerts[0]!.push, "silent");
	assert.match(r!.alerts[0]!.text, /。同向升一层（看多 0 条，看空 2 条）。/);
});

test("同向多过反向才升：先跳空看空，再反转看多（分歧，一比一），再 52 周新高看多，看多 2 条多过看空 1 条，新高升到 3 层", () => {
	const day = newDay(DATE);
	const [gap, rev, high] = run(day, ctx(), [q("NVDA", 96.5, 100, "09:45", { dayOpen: 96.6 })], [q("NVDA", 100.5, 100, "12:00", { dayOpen: 96.6, dayLow: 96.5 })], [q("NVDA", 104, 100, "13:00", { dayOpen: 96.6, dayLow: 96.5, dayHigh: 111 })]);
	assert.deepEqual(gap!.hits.map((h) => [h.rule, h.level]), [["gap", 1]]);
	assert.deepEqual(rev!.hits.map((h) => [h.rule, h.level]), [["reversal", 1]]);
	assert.match(rev!.hits[0]!.text, /。多空分歧（看多 1 条，看空 1 条）。/);
	assert.deepEqual(high!.hits.map((h) => [h.rule, h.level, h.bumped ?? false]), [["high-52w", 3, true]]);
	assert.equal(high!.alerts[0]!.push, undefined, "升到 3 层，响铃");
	assert.match(high!.alerts[0]!.text, /。同向升一层（看多 2 条，看空 1 条）。/);
});

test("计数时组合那一行不重复算，组合的两条照方向算：放量加新高（看多）以后的反转看空写「看多 2 条，看空 1 条」", () => {
	const day = newDay(DATE);
	const [, r] = run(day, ctx(), [q("NVDA", 104, 100, "11:00", { dayHigh: 111, volume: paced(4, "11:00") })], [q("NVDA", 99.5, 100, "13:00", { dayHigh: 111, volume: paced(4, "13:00") })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level]), [["reversal", 1]]);
	assert.match(r!.hits[0]!.text, /。多空分歧（看多 2 条，看空 1 条）。/);
});

test("到档的命中照方向计数：先跌到 -5% 档，后反转看多，写多空分歧；来回翻降到 0 层的不算", () => {
	const day = newDay(DATE);
	const [, r] = run(day, ctx(), [q("NVDA", 94.8, 100, "10:30")], [q("NVDA", 100.5, 100, "12:00", { dayLow: 94.8 })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level]), [["reversal", 1]]);
	assert.match(r!.hits[0]!.text, /。多空分歧（看多 1 条，看空 1 条）。/);
	const past = { "gap:NVDA": ["bull", "bear", "bull"] as const };
	const [demoted, high] = run(newDay(DATE), ctx({ past }), [q("NVDA", 96.5, 100, "09:45", { dayOpen: 96.6 })], [q("NVDA", 101, 100, "13:00", { dayOpen: 96.6, dayHigh: 111 })]);
	assert.equal(demoted!.hits[0]!.level, 0);
	assert.doesNotMatch(high!.hits[0]!.text, /多空分歧/);
});

test("这只票今天已经开了任务就不升：先到第一档开任务，后来的新高照自己的 2 层", () => {
	const day = newDay(DATE);
	const [, r] = run(day, ctx(), [q("NVDA", 105.3, 100, "10:00", { dayOpen: 103.4 })], [q("NVDA", 106, 100, "10:30", { dayOpen: 103.4, dayHigh: 111 })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level]), [["high-52w", 2]]);
	assert.equal(r!.alerts[0]!.push, "silent");
});

test("没有方向的命中不算：平盘时的放量既不和新高成组合，也不让新高升层", () => {
	const [r] = run(newDay(DATE), ctx(), [q("NVDA", 100, 100, "11:00", { dayHigh: 111, volume: paced(4, "11:00") })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level, h.lean ?? "-"]), [["volume", 2, "-"], ["high-52w", 2, "bull"]]);
	assert.deepEqual(r!.notices, []);
	assert.ok(r!.alerts.every((a) => a.push === "silent"));
});

test("来回翻：同一只票同一条规则 10 个交易日里方向翻了 3 次，这一条降到 0 层，写明反复几次", () => {
	const past = { "gap:NVDA": ["bull", "bear", "bull"] as const };
	const [r] = run(newDay(DATE), ctx({ past }), [q("NVDA", 96.5, 100, "09:45", { dayOpen: 96.6 })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level, h.lean]), [["gap", 0, "bear"]]);
	assert.match(r!.hits[0]!.text, /NVDA 开盘跳空近 10 个交易日反复 3 次/);
	const [two] = run(newDay(DATE), ctx({ past: { "gap:NVDA": ["bear", "bull"] } }), [q("NVDA", 96.5, 100, "09:45", { dayOpen: 96.6 })]);
	assert.equal(two!.hits[0]!.level, 1, "只翻了 2 次照常");
});

test("免打扰：2、3 层不发那一行，5 层的触发先留着，命中标成 held，照样记下", () => {
	const [r] = run(newDay(DATE), ctx({ quiet: true }), [q("NVDA", 104, 100, "15:59", { dayHigh: 111 }), q("AMD", 105.5, 100, "15:59")]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.symbol, h.held ?? false]), [["move-1", "AMD", true], ["high-52w", "NVDA", true]]);
	assert.deepEqual(r!.alerts, []);
	assert.deepEqual(r!.notices, []);
});

test("免打扰时段按宿主本地时间 22:00 到 07:00，美股常规时段内不生效", () => {
	const at = (iso: string) => Date.parse(iso);
	assert.equal(quietAt(at("2026-11-12T23:30:00+08:00"), false, "Asia/Shanghai"), true);
	assert.equal(quietAt(at("2026-11-12T23:30:00+08:00"), true, "Asia/Shanghai"), false, "常规时段照常提醒");
	assert.equal(quietAt(at("2026-11-12T21:59:00+08:00"), false, "Asia/Shanghai"), false);
	assert.equal(quietAt(at("2026-11-13T07:00:00+08:00"), false, "Asia/Shanghai"), false);
	assert.equal(quietAt(at("2026-11-13T06:59:00+08:00"), false, "Asia/Shanghai"), true);
});

test("大盘日：SPY 当天已到档，之后个股到档的触发进 SPY 的任务，正文写明并进来；提醒行不变", () => {
	const day = newDay(DATE);
	const [spy, stocks] = run(day, ctx(), [q("SPY", 489.5, 500, "10:00")], [q("SPY", 489, 500, "10:30"), q("NVDA", 94.8, 100, "10:30"), q("AMD", 94.9, 100, "10:30")]);
	assert.deepEqual(spy!.notices.map((n) => n.thread), [`SPY:${DATE}`]);
	assert.deepEqual(stocks!.notices.map((n) => [n.id, n.thread]), [[`band:NVDA:${DATE}:down5`, `SPY:${DATE}`], [`band:AMD:${DATE}:down5`, `SPY:${DATE}`]]);
	assert.ok(stocks!.notices.every((n) => n.fields.line.endsWith("（大盘日：SPY 今天已到 -2% 档，这只票并进指数的任务，汇报里逐只列出）")));
	assert.ok(stocks!.alerts.every((a) => !a.text.includes("大盘日")));
	const [own] = run(newDay(DATE), ctx(), [q("NVDA", 94.8, 100, "10:30")]);
	assert.equal(own!.notices[0]!.thread, `NVDA:${DATE}`, "指数没到档时个股照开自己的任务");
});

test("大盘日只并同方向的：SPY 跌到 -2% 档以后，个股涨到 +5% 档照开自己的任务", () => {
	const day = newDay(DATE);
	const [, r] = run(day, ctx(), [q("SPY", 489.5, 500, "10:00")], [q("SPY", 489, 500, "10:30"), q("NVDA", 105.5, 100, "10:30")]);
	assert.deepEqual(r!.notices.map((n) => n.thread), [`NVDA:${DATE}`]);
	assert.ok(!r!.notices[0]!.fields.line.includes("大盘日"));
});

test("同一拍里 SPY 和个股一起到档，也并进指数的任务", () => {
	const [r] = run(newDay(DATE), ctx(), [q("NVDA", 94.8, 100, "10:30"), q("SPY", 489.5, 500, "10:30")]);
	assert.deepEqual(r!.notices.map((n) => n.thread), [`SPY:${DATE}`, `SPY:${DATE}`]);
});

const BEATS: Quote[][] = [
	[q("NVDA", 103.5, 100, "09:45", { dayOpen: 103.4 }), q("QQQ", 100.2, 100, "09:45")],
	[q("NVDA", 104, 100, "10:00", { dayOpen: 103.4, dayHigh: 111 }), q("SPY", 489.5, 500, "10:00")],
	[q("NVDA", 105.4, 100, "11:00", { dayOpen: 103.4, dayHigh: 111, volume: paced(4, "11:00") }), q("AMD", 89, 95, "11:00", { dayLow: 88.5 })],
	[q("NVDA", 99.5, 100, "13:00", { dayOpen: 103.4, dayHigh: 111, volume: paced(4, "13:00") }), q("QQQ", 97, 100, "13:00"), q("VIXY", 11.2, 10, "13:00")],
];

test("只用命中那一刻已有的信息：去掉后面的报价，前面的命中一条不变；已经记下的命中以后不改写", () => {
	const full = newDay(DATE);
	const snapshots: Hit[][] = [];
	for (const beat of BEATS) {
		watch(full, beat, ctx());
		snapshots.push(structuredClone(full.hits));
	}
	assert.ok(full.hits.length >= 6, `够多的命中才说明问题，实际 ${full.hits.length}`);
	for (let k = 1; k <= BEATS.length; k++) {
		const prefix = newDay(DATE);
		for (const beat of BEATS.slice(0, k)) watch(prefix, beat, ctx());
		assert.deepEqual(prefix.hits, full.hits.slice(0, prefix.hits.length), `前 ${k} 拍的命中和完整回放的开头一样`);
		assert.deepEqual(snapshots[k - 1], full.hits.slice(0, snapshots[k - 1]!.length), `第 ${k} 拍以后，之前记下的命中原样留着`);
	}
});

test("同一条规则同一只票一天只记一次（id 是 规则:代码:日期），到档每个方向各算", () => {
	const day = newDay(DATE);
	run(day, ctx(), [q("NVDA", 104, 100, "10:00", { dayHigh: 111 })], [q("NVDA", 105, 100, "10:05", { dayHigh: 112 })], [q("NVDA", 105.2, 100, "10:10")], [q("NVDA", 94.9, 100, "14:00")]);
	assert.deepEqual(day.hits.map((h) => h.id), [`high-52w:NVDA:${DATE}`, `move-1:NVDA:${DATE}:up`, `move-1:NVDA:${DATE}:down`]);
});

test("rule-levels 改了新规则的层级：52 周新高改成 0 层就只记录", () => {
	const rows: LevelRow[] = [{ id: "1", fields: { rule: "high-52w", level: 0 } }];
	const [r] = run(newDay(DATE), ctx({ levels: parseRuleLevels(rows).levels }), [q("NVDA", 104, 100, "10:00", { dayHigh: 111 })]);
	assert.deepEqual(r!.hits.map((h) => h.level), [0]);
	assert.deepEqual(r!.alerts, []);
});

test("rule-levels：VIXY 第一档改得不低于第二档时这一行不生效", () => {
	const { bad } = parseRuleLevels([{ id: "4", fields: { rule: "vixy-1", threshold: 25 } }]);
	assert.deepEqual(bad, ["4"]);
});

test("到档一个方向只算一条：两档同一拍到（层级改成 2，没开任务），后来的放量写「看空 2 条」，不是 3 条", () => {
	const c = ctx({ levels: parseRuleLevels([{ id: "1", fields: { rule: "move-1", level: 2 } }, { id: "2", fields: { rule: "move-2", level: 2 } }]).levels });
	const [, r] = run(newDay(DATE), c, [q("NVDA", 91.5, 100, "10:00")], [q("NVDA", 91.5, 100, "11:00", { volume: paced(4, "11:00") })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level]), [["volume", 3]]);
	assert.match(r!.hits[0]!.text, /同向升一层（看多 0 条，看空 2 条）/);
});

test("页面标记一只票当天 1 层的事实再多，也截在 300 字以内，末尾写「…」", () => {
	const hits = Array.from({ length: 40 }, (_, i) => ({ symbol: "NVDA", date: "2026-11-12", at: "2026-11-12T15:05:00.000Z", fact: `ta 重点形态第 ${i} 条（ta R-PAT-${i}）`, level: 1 }));
	const [badge] = badgeAlerts(hits, hits.slice(-1));
	assert.ok(badge!.text.length <= 300 && badge!.text.endsWith("…"), badge!.text);
	assert.ok(badge!.text.startsWith("NVDA · "));
});
