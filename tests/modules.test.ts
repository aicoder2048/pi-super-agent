import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Modules, parseRules } from "../src/modules.ts";

const repoModules = fileURLToPath(new URL("../modules", import.meta.url));
const quote = (body: string) => ({ source: "toy-market", externalId: "x", threads: [], sender: "feed", body, occurredAt: 0 });

test("玩具模块被发现，规则带模块前缀", () => {
	const modules = Modules.load([repoModules]);
	assert.deepEqual(modules.modules.map((m) => m.name), ["toy-market"]);
	assert.ok(modules.ruleAllows("toy-market/big-move", "toy-market"));
	assert.ok(!modules.ruleAllows("big-move", "toy-market"));
	assert.match(modules.rulesPrompt(), /### toy-market\/big-move/);
	assert.ok(modules.moduleForRule("toy-market/big-move")?.skillsDir);
});

test("程序层过滤：小于 1% 的波动在调用模型前被筛掉", () => {
	const { sourcePolicy } = Modules.load([repoModules]);
	assert.equal(sourcePolicy(quote("TOYX 价格 100.4，涨跌 +0.4%，成交量 500 股")), "ignore");
	assert.equal(sourcePolicy(quote("TOYX 价格 94.8，涨跌 -5.2%，成交量 12 股")), "candidate");
	assert.equal(sourcePolicy({ ...quote("anything"), source: "other" }), "candidate");
});

test("规则文件按二级标题切分，空规则不算", () => {
	assert.deepEqual(parseRules("user", "# 标题\n## a\n第一条\n\n## b\n\n## c\n第三条"), [
		{ id: "user/a", text: "第一条" },
		{ id: "user/c", text: "第三条" },
	]);
});

test("规则的适用来源：模块规则只适用于模块声明的来源", () => {
	const modules = Modules.load([repoModules]);
	assert.ok(modules.ruleAllows("toy-market/big-move", "toy-market"));
	assert.ok(!modules.ruleAllows("toy-market/big-move", "mail"));
	assert.deepEqual(modules.rulesFor("toy-market"), ["toy-market/big-move"]);
	assert.deepEqual(modules.rulesFor("mail"), []);
});

test("规则的适用来源：使用者规则不写来源行时适用于所有非对话来源，写了就只适用于列出的来源", () => {
	const dir = mkdtempSync(join(tmpdir(), "psa-rules-"));
	const file = join(dir, "rules.md");
	writeFileSync(file, "## any\n有新邮件就看一下\n\n## ci-only\n来源: ci, github\nCI 失败时开任务\n");
	const modules = Modules.load([], file);
	assert.ok(modules.ruleAllows("user/any", "mail"));
	assert.ok(!modules.ruleAllows("user/any", "conversation"));
	assert.ok(modules.ruleAllows("user/ci-only", "github"));
	assert.ok(!modules.ruleAllows("user/ci-only", "mail"));
});
