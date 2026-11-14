import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { scanPackage } from "../src/modules/validate.ts";
import { newDay, watch, type Context, type DayState } from "../docs/modules/examples/stock-ta/feeds/quotes/watch.ts";
import { parseHoldings, stillIn, type HoldingRow } from "../docs/modules/examples/stock-ta/holdings.ts";
import type { Quote } from "../docs/modules/examples/stock-ta/massive.ts";
import { parseRuleLevels, type LevelRow } from "../docs/modules/examples/stock-ta/watch-rules.ts";

const PKG = join(import.meta.dirname, "../docs/modules/examples/stock-ta");
const DATE = "2026-11-12";
const ny = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00-05:00`)).toISOString();
type Extra = Partial<Pick<Quote, "volume" | "dayOpen" | "dayHigh" | "dayLow">>;
const q = (symbol: string, price: number, prevClose: number, hhmm: string, extra: Extra = {}, date = DATE): Quote => ({
	symbol, price, prevClose, changePct: Math.round((price / prevClose - 1) * 10_000) / 100, volume: null, at: ny(date, hhmm), dayClose: price, dayOpen: null, dayHigh: null, dayLow: null, ...extra,
});
const rows = (...fields: Record<string, unknown>[]): HoldingRow[] => fields.map((f, i) => ({ id: String(i + 1), fields: f }));
const held = (...fields: Record<string, unknown>[]) => parseHoldings(rows(...fields), ["NVDA", "AMD", "TSLA"]).holdings;
const ctx = (over: Partial<Context> = {}): Context => ({ levels: parseRuleLevels([]).levels, history: {}, past: {}, quiet: false, ...over });
const levels = (...fields: Record<string, unknown>[]) => parseRuleLevels(fields.map((f, i): LevelRow => ({ id: String(i + 1), fields: f }))).levels;
const run = (day: DayState, c: Context, ...beats: Quote[][]) => beats.map((quotes) => watch(day, quotes, c));

test("持仓集合：模块检查通过，holdings 是私密的 record 集合，字段是代码、成本、建仓日期、止损价、止损百分比、数量、原话和 removedAt", () => {
	const result = scanPackage(PKG);
	assert.ok(result.ok, JSON.stringify(!result.ok && result.problems));
	const data = result.scan.components.find((c) => c.kind === "data" && c.name === "holdings");
	assert.ok(data?.kind === "data");
	assert.equal(data.collection.kind, "record");
	assert.equal(data.collection.class, "private");
	assert.deepEqual(Object.entries(data.collection.fields).map(([name, f]) => [name, f.type]), [
		["symbol", "text"], ["cost", "number"], ["boughtAt", "date"], ["stopPrice", "number"], ["stopPct", "number"], ["quantity", "number"], ["note", "text"], ["removedAt", "date"],
	]);
});

test("持仓：一只票以最新的一行为准（代码不分大小写），最新一行写了 removedAt 就不再算", () => {
	const { holdings, bad } = parseHoldings(rows({ symbol: "nvda ", cost: 150 }, { symbol: "NVDA", cost: 152, boughtAt: "2026-10-01" }, { symbol: "AMD", cost: 140 }, { symbol: "AMD", removedAt: "2026-11-12" }), ["NVDA", "AMD"]);
	assert.deepEqual([...holdings.values()], [{ symbol: "NVDA", cost: 152, boughtAt: "2026-10-01" }]);
	assert.deepEqual(bad, []);
});

test("持仓：止损价和止损百分比都写了用止损价；百分比写正写负都按成本以下算；数量照记", () => {
	const holdings = held({ symbol: "NVDA", cost: 150, stopPrice: 138, stopPct: -10, quantity: 20 }, { symbol: "AMD", cost: 100, stopPct: 10 }, { symbol: "TSLA", cost: 200, stopPct: -7 });
	assert.deepEqual(holdings.get("NVDA"), { symbol: "NVDA", cost: 150, stop: { price: 138 }, quantity: 20 });
	assert.deepEqual(holdings.get("AMD")?.stop, { pct: 10 });
	assert.deepEqual(holdings.get("TSLA")?.stop, { pct: 7 });
});

test("持仓写坏了（没有成本或成本不是正数、止损价不是正数、止损百分比不在 0 到 100、建仓日期不对）：进 bad，这只票不算；被接替的旧行不算", () => {
	const { holdings, bad } = parseHoldings(rows(
		{ symbol: "NVDA", cost: 0 },
		{ symbol: "AMD", cost: 100, stopPrice: -1 },
		{ symbol: "TSLA", cost: 100, stopPct: 100 },
		{ symbol: "META", cost: 100, boughtAt: "10/01/2026" },
		{ symbol: "AAPL" },
		{ symbol: "MSFT", cost: "abc" },
		{ symbol: "NVDA", cost: 150 },
	), ["NVDA", "AMD", "TSLA", "META", "AAPL", "MSFT"]);
	assert.deepEqual(bad, ["2", "3", "4", "5", "6"]);
	assert.deepEqual([...holdings.keys()], ["NVDA"]);
});

test("持仓：只算自选股里的票；从自选股划掉的票持仓那一行留着，但不再盯，也不报写坏", () => {
	const { holdings, bad } = parseHoldings(rows({ symbol: "NVDA", cost: 150 }, { symbol: "AMD", cost: 0 }), ["TSLA"]);
	assert.deepEqual([holdings.size, bad], [0, []]);
	const [r] = run(newDay(DATE), ctx({ holdings }), [q("NVDA", 145, 151, "10:41", { dayLow: 129 })]);
	assert.deepEqual(r!.hits, []);
});

test("止损：没设止损线时按成本 -8%，当天最低价碰到就算；响铃一行写数字，另开一个任务问你，线程是这只票当天的持仓线程", () => {
	const holdings = held({ symbol: "NVDA", cost: 150 });
	const [r] = run(newDay(DATE), ctx({ holdings }), [q("NVDA", 139.1, 145.2, "10:41", { dayLow: 137.8 })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level, h.lean, h.fact]), [["stop-loss", 6, null, "触到止损线"]], "昨收已在成本下，跌破成本不再算");
	assert.deepEqual(r!.alerts.map((a) => [a.id, a.push ?? "ring"]), [[`stop-loss:NVDA:${DATE}`, "ring"]]);
	assert.equal(r!.alerts[0]!.text, "NVDA 触到你的止损线 138.00（没设止损线，按成本 150.00 的 -8%）。当天最低 137.80，现价 139.10，当天跌 -4.20%。报价时间 10:41 ET（延迟行情）。");
	assert.deepEqual(r!.notices.map((n) => [n.id, n.thread, n.threadScope, n.fields.rule, n.fields.level, n.fields.plan]), [[`stop-loss:NVDA:${DATE}`, `NVDA:${DATE}:holding`, "module", "stop-loss", "6", "holding-ask"]]);
	assert.equal(r!.notices[0]!.fields.line, "NVDA 触到你的止损线。现价 139.10，当天跌 -4.20%。报价时间 10:41 ET（延迟行情）。");
});

test("止损：设了止损价按止损价，设了百分比按成本的百分比；最低价没碰到不算", () => {
	const holdings = held({ symbol: "NVDA", cost: 150, stopPrice: 138 }, { symbol: "AMD", cost: 100, stopPct: -10 }, { symbol: "TSLA", cost: 100, stopPct: -10 });
	const [r] = run(newDay(DATE), ctx({ holdings }), [q("NVDA", 139.1, 145, "10:41", { dayLow: 138 }), q("AMD", 91, 95, "10:41", { dayLow: 90 }), q("TSLA", 91, 95, "10:41", { dayLow: 90.05 })]);
	assert.deepEqual(r!.hits.filter((h) => h.rule === "stop-loss").map((h) => h.symbol), ["NVDA", "AMD"]);
	assert.match(r!.alerts.find((a) => a.id.startsWith("stop-loss:NVDA"))!.text, /^NVDA 触到你的止损线 138\.00（你设的止损价）。/);
	assert.match(r!.alerts.find((a) => a.id.startsWith("stop-loss:AMD"))!.text, /^AMD 触到你的止损线 90\.00（你设的成本 100\.00 的 -10%）。/);
});

test("持仓规则的触发不带成本、止损价和高点：只有现价、当天涨跌和报价时间", () => {
	const holdings = held({ symbol: "NVDA", cost: 152.35, stopPrice: 141.65, boughtAt: "2026-10-01" });
	const raised = levels({ rule: "drawdown", level: 5 }, { rule: "below-cost", level: 5 }, { rule: "move-1", level: 0 }, { rule: "move-2", level: 0 });
	const [r] = run(newDay(DATE), ctx({ holdings, levels: raised, peaks: { NVDA: 197.45 } }), [q("NVDA", 141.9, 170, "10:41", { dayLow: 141.6, dayHigh: 170.5 })]);
	assert.deepEqual(r!.notices.map((n) => n.fields.rule), ["stop-loss"], "同一轮三条持仓规则并成一个任务");
	for (const n of r!.notices) for (const value of Object.values(n.fields)) assert.doesNotMatch(value, /152\.35|141\.65|197\.45/, `${n.id} 的触发没有持仓数字`);
	assert.ok(r!.alerts.some((a) => /152\.35/.test(a.text)), "直接给你的那一行照写成本");
});

test("回撤：从建仓日期以来的最高（日线库到昨天，盘中再和当天最高比）回撤 15% 响铃一行，不开任务；写明高点", () => {
	const holdings = held({ symbol: "NVDA", cost: 100, boughtAt: "2026-10-01" });
	const [r] = run(newDay(DATE), ctx({ holdings, peaks: { NVDA: 210 } }), [q("NVDA", 175.98, 180, "10:41", { dayHigh: 181 })]);
	assert.deepEqual(r!.hits.map((h) => [h.rule, h.level, h.lean, h.fact]), [["drawdown", 3, null, "从建仓以来高点回撤 16.2%"]]);
	assert.deepEqual(r!.alerts.map((a) => [a.push ?? "ring", a.text]), [["ring", "NVDA 从建仓以来的高点 210.00 回撤 16.20%，现价 175.98，当天跌 -2.23%。报价时间 10:41 ET（延迟行情）。"]]);
	assert.deepEqual(r!.notices, []);
});

test("回撤：没写建仓日期用 52 周最高；当天最高比日线库的高就按当天的算；没有高点（日线库里一根也没有）就不算", () => {
	const holdings = held({ symbol: "NVDA", cost: 100 }, { symbol: "AMD", cost: 50 });
	const [r] = run(newDay(DATE), ctx({ holdings, peaks: { NVDA: 200, AMD: null } }), [q("NVDA", 178, 185, "10:41", { dayHigh: 220 }), q("AMD", 60, 61, "10:41", { dayHigh: 100 })]);
	assert.deepEqual(r!.hits.filter((h) => h.rule === "drawdown").map((h) => [h.symbol, h.fact]), [["NVDA", "从 52 周高点回撤 19.1%"]]);
	assert.match(r!.alerts.find((a) => a.id.startsWith("drawdown:"))!.text, /^NVDA 从 52 周高点 220\.00 回撤 19\.09%，现价 178\.00，当天跌 -3\.78%。/);
});

test("跌破成本价：现价低于成本静音一行；正好等于成本不算", () => {
	const holdings = held({ symbol: "NVDA", cost: 150 }, { symbol: "AMD", cost: 100 });
	const [r] = run(newDay(DATE), ctx({ holdings }), [q("NVDA", 149.2, 151, "10:41"), q("AMD", 100, 101, "10:41")]);
	assert.deepEqual(r!.hits.map((h) => [h.symbol, h.rule, h.level]), [["NVDA", "below-cost", 2]]);
	assert.deepEqual(r!.alerts.map((a) => [a.push, a.text]), [["silent", "NVDA 跌破你的成本价 150.00，现价 149.20，当天跌 -1.19%。报价时间 10:41 ET（延迟行情）。"]]);
});

test("同一轮一只票进了几条持仓规则：并成一行，按最高的层级响铃，事实一起列；有 6 层的只开一个 holding-ask 任务；当天不再重复", () => {
	const holdings = held({ symbol: "NVDA", cost: 150, stopPrice: 138, boughtAt: "2026-10-01" });
	const day = newDay(DATE);
	const bandsOff = levels({ rule: "move-1", level: 0 }, { rule: "move-2", level: 0 });
	const [r, later] = run(day, ctx({ holdings, levels: bandsOff, peaks: { NVDA: 175 } }), [q("NVDA", 139, 152, "10:41", { dayLow: 137.5, dayHigh: 152.5 })], [q("NVDA", 135, 152, "10:42", { dayLow: 134, dayHigh: 152.5 })]);
	assert.deepEqual(r!.hits.filter((h) => !h.rule.startsWith("move-")).map((h) => [h.id, h.level]), [[`stop-loss:NVDA:${DATE}`, 6], [`drawdown:NVDA:${DATE}`, 3], [`below-cost:NVDA:${DATE}`, 2]], "每条规则各记一条命中");
	assert.deepEqual(r!.alerts.map((a) => [a.id, a.push ?? "ring", a.text]), [[`stop-loss:NVDA:${DATE}`, "ring", "NVDA 触到你的止损线 138.00（你设的止损价）。当天最低 137.50；同时从建仓以来的高点 175.00 回撤 20.57%、跌破你的成本价 150.00，现价 139.00，当天跌 -8.55%。报价时间 10:41 ET（延迟行情）。"]]);
	assert.deepEqual(r!.notices.map((n) => [n.id, n.thread, n.fields.rule, n.fields.level, n.fields.plan, n.fields.line]), [[`stop-loss:NVDA:${DATE}`, `NVDA:${DATE}:holding`, "stop-loss", "6", "holding-ask", "NVDA 触到你的止损线，同时从持仓高点回撤到你的回撤线、跌破你的成本价。现价 139.00，当天跌 -8.55%。报价时间 10:41 ET（延迟行情）。"]]);
	assert.deepEqual([later!.hits.filter((h) => !h.rule.startsWith("move-")), later!.alerts, later!.notices], [[], [], []]);
});

test("同一轮进了回撤和跌破成本（没有止损）：一行按回撤的响铃，不开任务", () => {
	const holdings = held({ symbol: "NVDA", cost: 150, boughtAt: "2026-10-01" });
	const [r] = run(newDay(DATE), ctx({ holdings, peaks: { NVDA: 180 } }), [q("NVDA", 149, 155, "10:41", { dayHigh: 155.5 })]);
	assert.deepEqual(r!.hits.map((h) => h.rule), ["drawdown", "below-cost"]);
	assert.deepEqual(r!.alerts.map((a) => [a.id, a.push ?? "ring", a.text]), [[`drawdown:NVDA:${DATE}`, "ring", "NVDA 从建仓以来的高点 180.00 回撤 17.22%；同时跌破你的成本价 150.00，现价 149.00，当天跌 -3.87%。报价时间 10:41 ET（延迟行情）。"]]);
	assert.deepEqual(r!.notices, []);
});

test("状态型只在进入那天算：昨收已经在线下不算；同一天第二轮不再算；第二天回到线上又跌破，再算一次", () => {
	const holdings = held({ symbol: "NVDA", cost: 150 });
	const already = run(newDay(DATE), ctx({ holdings }), [q("NVDA", 140, 145, "10:00", { dayLow: 137 })]);
	assert.deepEqual(already[0]!.hits.map((h) => h.rule), ["stop-loss"], "昨收 145 已在成本下，跌破成本不算；昨收在止损线 138 上，止损算");
	const day = newDay(DATE);
	const beats = run(day, ctx({ holdings }), [q("NVDA", 149, 151, "10:00")], [q("NVDA", 148, 151, "10:01")]);
	assert.deepEqual(beats.map((b) => b.hits.map((h) => h.rule)), [["below-cost"], []]);
	const next = run(newDay("2026-11-13"), ctx({ holdings }), [q("NVDA", 149.5, 150.5, "10:00", {}, "2026-11-13")]);
	assert.deepEqual(next[0]!.hits.map((h) => h.id), ["below-cost:NVDA:2026-11-13"]);
});

test("持仓的命中没有方向：不帮别的命中升级，自己也不被升；止损开了任务也不挡别的命中升级", () => {
	const holdings = held({ symbol: "NVDA", cost: 150 });
	const day = newDay(DATE);
	const [first, gap] = run(day, ctx({ holdings }), [q("NVDA", 149, 151, "09:40")], [q("NVDA", 148, 151, "09:45", { dayOpen: 146 })]);
	assert.deepEqual(first!.hits.map((h) => [h.rule, h.level, h.bumped]), [["below-cost", 2, undefined]]);
	assert.deepEqual(gap!.hits.map((h) => [h.rule, h.level, h.bumped]), [["gap", 1, undefined]], "跌破成本不算看空，跳空只有一条，不升");
	const stopped = newDay(DATE);
	const [, , rel] = run(stopped, ctx({ holdings: held({ symbol: "NVDA", cost: 150, stopPrice: 140 }) }),
		[q("NVDA", 145, 152, "09:40", { dayLow: 139.5 })],
		[q("NVDA", 145, 152, "09:45", { dayOpen: 146, dayLow: 139.5 })],
		[q("QQQ", 101, 100, "10:00"), q("NVDA", 145, 152, "10:00", { dayOpen: 146, dayLow: 139.5 })]);
	assert.ok(stopped.hits.some((h) => h.rule === "stop-loss" && h.level === 6));
	assert.deepEqual(rel!.hits.map((h) => [h.rule, h.level, h.bumped]), [["rel-strength", 2, true]], "跳空加逆大盘同向两条照升，止损的任务不算");
});

test("rule-levels 改持仓规则：回撤门槛改成 10%，跌破成本改成 3 层响铃", () => {
	const holdings = held({ symbol: "NVDA", cost: 150, boughtAt: "2026-10-01" }, { symbol: "AMD", cost: 100 });
	const changed = levels({ rule: "drawdown", threshold: 10 }, { rule: "below-cost", level: 3 });
	const quotes = [q("NVDA", 176, 181, "10:41"), q("AMD", 99, 101, "10:41")];
	const [plain] = run(newDay(DATE), ctx({ holdings, peaks: { NVDA: 200 } }), quotes);
	assert.deepEqual(plain!.hits.map((h) => [h.symbol, h.rule, h.level]), [["AMD", "below-cost", 2]]);
	const [r] = run(newDay(DATE), ctx({ holdings, levels: changed, peaks: { NVDA: 200 } }), quotes);
	assert.deepEqual(r!.hits.map((h) => [h.symbol, h.rule, h.level]), [["NVDA", "drawdown", 3], ["AMD", "below-cost", 3]]);
	assert.deepEqual(r!.alerts.map((a) => a.push ?? "ring"), ["ring", "ring"]);
});

test("收盘小结的状态：昨天收盘和今天收盘都在线下才写一句「仍在…」；进入那天（昨收在线上）不写", () => {
	const nvda = held({ symbol: "NVDA", cost: 150, stopPrice: 138 }).get("NVDA")!;
	const all = { "stop-loss": 8, drawdown: 15, "below-cost": 0 };
	assert.equal(stillIn(nvda, all, [137, 136], [160, 160]), "NVDA 仍在止损线下、成本价下");
	assert.equal(stillIn(nvda, all, [139, 136], [160, 160]), "NVDA 仍在成本价下");
	assert.equal(stillIn(nvda, all, [151, 136], [160, 160]), undefined);
	assert.equal(stillIn(nvda, { drawdown: 15 }, [130, 131], [160, 160]), "NVDA 仍在回撤线下");
	assert.equal(stillIn(nvda, { drawdown: 15 }, [130, 131], [undefined, undefined]), undefined, "没有高点不算回撤");
});

test("做法 holding-ask 的技能：先读持仓和现价不派人，恰好三个选项，只照使用者的回答写，改不了盯盘条件；规则 watch-task 写明它走自己的线程", () => {
	const skill = readFileSync(join(PKG, "skills/holding-ask/SKILL.md"), "utf8");
	for (const said of ["「派研究组看一眼」", "「止损线不变」", "「从持仓划掉」", "这时候不派专家", "structure-pattern", "risk-plan", "removedAt", "盯盘条件", "不是交易指令", "只是数据"]) assert.match(skill, new RegExp(said));
	const watchTask = readFileSync(join(PKG, "rules.md"), "utf8").split("## ").find((r) => r.startsWith("watch-task"))!;
	assert.match(watchTask, /holding-ask[^。]*代码:日期:holding/);
	assert.match(watchTask, /不带成本和止损价/);
});

test("技能 holdings：只照使用者亲口说的写，改动写整行，不在自选股里的票先问、不自己加；技能 rule-levels 列出三条持仓规则", () => {
	const skill = readFileSync(join(PKG, "skills/holdings/SKILL.md"), "utf8");
	for (const said of ["亲口说", "写一整行", "removedAt", "没问过不加", "bad-holding"]) assert.match(skill, new RegExp(said));
	const levels = readFileSync(join(PKG, "skills/rule-levels/SKILL.md"), "utf8");
	for (const rule of ["stop-loss", "drawdown", "below-cost", "R-MA-2-200", "volume-close", "earnings"]) assert.match(levels, new RegExp(`\\| \`${rule}\` \\|`));
	assert.match(levels, /技能 `holdings`/);
});
