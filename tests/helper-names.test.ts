import assert from "node:assert/strict";
import test from "node:test";
import { SOLO_NAMES, TEAM_NAMES, helperName, msUntilNextNewYorkDay, newYorkDate } from "../src/kernel/helper-names.ts";

const length = (name: string) => [...name].length;

test("名字池分两个：单个助手的池全是两字名，团队的池全是四字名，不少于 24 个，两个池里都没有重名", () => {
	assert.deepEqual([...new Set(SOLO_NAMES.map(length))], [2]);
	assert.deepEqual([...new Set(TEAM_NAMES.map(length))], [4]);
	assert.ok(TEAM_NAMES.length >= 24, `四字名只有 ${TEAM_NAMES.length} 个`);
	const all = [...SOLO_NAMES, ...TEAM_NAMES];
	assert.equal(new Set(all).size, all.length);
});

test("名字池里没有「边牧」和「弈境」：别的产品在用这两个名字", () => {
	const all: readonly string[] = [...SOLO_NAMES, ...TEAM_NAMES];
	assert.deepEqual(["边牧", "弈境"].filter((name) => all.includes(name)), []);
});

test("取名只在给定的池里轮转：从序号的位置往后找第一个没人在用的，整池都在用时加「·二」，再满加「·三」", () => {
	assert.equal(helperName(TEAM_NAMES, 0, new Set()), TEAM_NAMES[0]);
	assert.equal(helperName(TEAM_NAMES, TEAM_NAMES.length + 1, new Set()), TEAM_NAMES[1]);
	assert.equal(helperName(TEAM_NAMES, 0, new Set([TEAM_NAMES[0], SOLO_NAMES[1]])), TEAM_NAMES[1]);
	assert.equal(helperName(SOLO_NAMES, 3, new Set(SOLO_NAMES)), `${SOLO_NAMES[3]}·二`);
	assert.equal(helperName(SOLO_NAMES, 0, new Set([...SOLO_NAMES, ...SOLO_NAMES.map((n) => `${n}·二`)])), `${SOLO_NAMES[0]}·三`);
});

test("离下一个纽约日还有多久：按纽约的钟算到零点，换夏令时冬令时那天也正好落在零点", () => {
	assert.equal(msUntilNextNewYorkDay(Date.UTC(2026, 10, 10, 4, 30)), 30 * 60_000, "纽约 23:30");
	assert.equal(msUntilNextNewYorkDay(Date.UTC(2026, 10, 10, 5, 0)), 24 * 3_600_000, "纽约零点整");
	assert.equal(msUntilNextNewYorkDay(Date.UTC(2026, 6, 1, 3, 59, 59, 500)), 500, "夏令时，纽约 23:59:59.5");
	assert.equal(msUntilNextNewYorkDay(Date.UTC(2026, 2, 8, 5, 30)), 22.5 * 3_600_000, "3 月 8 日只有 23 小时");
	assert.equal(msUntilNextNewYorkDay(Date.UTC(2026, 10, 1, 4, 30)), 24.5 * 3_600_000, "11 月 1 日有 25 小时");
	for (const start of [Date.UTC(2026, 2, 8, 5, 30), Date.UTC(2026, 10, 1, 4, 30)]) {
		const at = start + msUntilNextNewYorkDay(start);
		assert.deepEqual([newYorkDate(at - 1) === newYorkDate(start), newYorkDate(at) === newYorkDate(start)], [true, false]);
	}
});
