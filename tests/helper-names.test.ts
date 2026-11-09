import assert from "node:assert/strict";
import test from "node:test";
import { SOLO_NAMES, TEAM_NAMES, helperName } from "../src/kernel/helper-names.ts";

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
