import assert from "node:assert/strict";
import test from "node:test";
import { effective, parseRuleLevels, ruleOf, scopeOf, type LevelRow } from "../../docs/modules/examples/stock-ta/watch-rules.ts";

const parse = (...fields: Record<string, unknown>[]) => parseRuleLevels(fields.map((f, i): LevelRow => ({ id: String(i + 1), fields: f })));
const at = (levels: ReturnType<typeof parse>["levels"], rule: "move-1" | "move-2", symbol: string) => effective(ruleOf(rule), symbol, scopeOf(symbol), levels);

test("rule-levels：去掉一行对全部票的改动后，已经核对过的票重新核对，第一档不低于第二档的那一行也报出来", () => {
	const { levels, bad } = parse({ rule: "move-2", symbol: "AAA", threshold: 4.5 }, { rule: "move-2", symbol: "BBB", threshold: 3.5 }, { rule: "move-1", threshold: 4 });
	assert.deepEqual(bad, ["1", "2", "3"]);
	for (const symbol of ["AAA", "BBB", "NVDA"]) assert.ok(at(levels, "move-1", symbol).threshold! < at(levels, "move-2", symbol).threshold!, `${symbol} 第一档低于第二档`);
});

test("rule-levels：最新一行写坏了，报出这一行，沿用上一行写对的改动", () => {
	const { levels, bad } = parse({ rule: "move-1", symbol: "NVDA", level: 6 }, { rule: "move-1", symbol: "NVDA", level: 200 });
	assert.deepEqual(bad, ["2"]);
	assert.equal(at(levels, "move-1", "NVDA").level, 6);
});

test("rule-levels：最新一行让第一档不低于第二档，报出这一行，沿用上一行的门槛", () => {
	const { levels, bad } = parse({ rule: "move-1", symbol: "TSLA", threshold: 6 }, { rule: "move-1", symbol: "TSLA", threshold: 9 });
	assert.deepEqual(bad, ["2"]);
	assert.equal(at(levels, "move-1", "TSLA").threshold, 6);
});

test("rule-levels：撤回以后写坏的一行回到表里的默认，不沿用撤回以前的改动", () => {
	const { levels, bad } = parse({ rule: "move-1", symbol: "NVDA", level: 6 }, { rule: "move-1", symbol: "NVDA", removedAt: "2026-11-14" }, { rule: "move-1", symbol: "NVDA", level: 9 });
	assert.deepEqual(bad, ["3"]);
	assert.equal(at(levels, "move-1", "NVDA").level, 5);
});

test("rule-levels：被接替的写坏的旧行不再报", () => {
	const { levels, bad } = parse({ rule: "move-1", symbol: "NVDA", level: 9 }, { rule: "move-1", symbol: "NVDA", level: 3 });
	assert.deepEqual(bad, []);
	assert.equal(at(levels, "move-1", "NVDA").level, 3);
});
