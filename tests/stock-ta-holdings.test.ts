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

test("收盘小结的状态：昨天收盘和今天收盘都在线下才写一句「仍在…」；进入那天（昨收在线上）不写", () => {
	const nvda = held({ symbol: "NVDA", cost: 150, stopPrice: 138 }).get("NVDA")!;
	const all = { "stop-loss": 8, drawdown: 15, "below-cost": 0 };
	assert.equal(stillIn(nvda, all, [137, 136], [160, 160]), "NVDA 仍在止损线下、成本价下");
	assert.equal(stillIn(nvda, all, [139, 136], [160, 160]), "NVDA 仍在成本价下");
	assert.equal(stillIn(nvda, all, [151, 136], [160, 160]), undefined);
	assert.equal(stillIn(nvda, { drawdown: 15 }, [130, 131], [160, 160]), "NVDA 仍在回撤线下");
	assert.equal(stillIn(nvda, { drawdown: 15 }, [130, 131], [undefined, undefined]), undefined, "没有高点不算回撤");
});
