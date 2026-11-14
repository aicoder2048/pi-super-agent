import assert from "node:assert/strict";
import test from "node:test";
import { parseCollected } from "../../src/modules/feed-runner.ts";
import { BADGE_TEXT_MAX } from "../../src/modules/protocol.ts";

const badge = (text: string) => {
	const collected = parseCollected({ alerts: [{ id: "a1", text, at: "2026-11-14T00:00:00Z", push: "badge" }] });
	assert.ok(typeof collected !== "string", String(collected));
	return collected.alerts![0].text;
};

test("太长的徽标文字截断时不把 emoji 的代理对切开，截完不超过上限", () => {
	const text = badge(`${"a".repeat(BADGE_TEXT_MAX - 2)}😀${"b".repeat(10)}`);
	assert.ok(text.length <= BADGE_TEXT_MAX);
	assert.equal(text, `${"a".repeat(BADGE_TEXT_MAX - 2)}…`);
	assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(text), "没有落单的高位代理");
});

test("emoji 整个放得下时照留", () => {
	assert.equal(badge(`${"a".repeat(BADGE_TEXT_MAX - 3)}😀${"b".repeat(10)}`), `${"a".repeat(BADGE_TEXT_MAX - 3)}😀…`);
});
