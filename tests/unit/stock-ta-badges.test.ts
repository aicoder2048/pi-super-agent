import assert from "node:assert/strict";
import test from "node:test";
import { badgeAlerts } from "../../docs/modules/examples/stock-ta/badges.ts";

const hit = (fact: string) => ({ symbol: "NVDA", date: "2026-11-12", at: "2026-11-12T15:00:00Z", fact, level: 1 });

test("标记太长时按字符截断：不把表情符号劈成半个，截完不超过宿主的 300 个 UTF-16 单位", () => {
	const facts = [hit(`${"涨".repeat(291)}📈${"涨".repeat(20)}`)];
	const [badge] = badgeAlerts(facts, facts);
	const text = badge!.text;
	assert.ok(text.endsWith("…"));
	assert.ok(text.length <= 300, `长度 ${text.length}`);
	assert.equal(text.isWellFormed(), true, "没有落单的代理项");
});
