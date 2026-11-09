import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Modules, parseRules } from "../src/modules.ts";

const repoModules = fileURLToPath(new URL("../modules", import.meta.url));
const quote = (body: string) => ({ source: "toy-market", externalId: "x", threads: [], sender: "feed", body, occurredAt: 0 });

test("仓库里的模块都被发现，规则带模块前缀", () => {
	const modules = Modules.load([repoModules]);
	assert.deepEqual(modules.modules.map((m) => m.name), ["toy-market", "us-market"]);
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

test("行情来源：模块里标了 market 的来源（玩具行情、美股行情）是，其他来源不是", () => {
	const { isMarketSource } = Modules.load([repoModules]);
	assert.deepEqual(["toy-market", "us-market", "mail", "conversation"].map(isMarketSource), [true, true, false, false]);
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

test("规则的适用来源：使用者规则必须写来源行才生效，写了就只适用于列出的来源", () => {
	const dir = mkdtempSync(join(tmpdir(), "psa-rules-"));
	const file = join(dir, "rules.md");
	writeFileSync(file, "## any\n有新邮件就看一下\n\n## ci-only\n来源: ci, github\nCI 失败时开任务\n");
	const modules = Modules.load([], file);
	assert.ok(!modules.ruleAllows("user/any", "mail"));
	assert.deepEqual(modules.rulesFor("mail"), []);
	assert.doesNotMatch(modules.rulesPrompt(), /user\/any/);
	assert.deepEqual(modules.skippedUserRules, ["user/any"]);
	assert.ok(modules.ruleAllows("user/ci-only", "github"));
	assert.ok(!modules.ruleAllows("user/ci-only", "mail"));
	assert.ok(!modules.ruleAllows("user/ci-only", "conversation"));
	assert.match(modules.rulesPrompt(), /### user\/ci-only/);
});

test("规则的适用来源：来源行里一个来源都没有的使用者规则同样不生效", () => {
	const file = join(mkdtempSync(join(tmpdir(), "psa-rules-")), "rules.md");
	writeFileSync(file, "## empty\n来源: ，\n有新邮件就看一下\n");
	const modules = Modules.load([], file);
	assert.ok(!modules.ruleAllows("user/empty", "mail"));
	assert.deepEqual(modules.skippedUserRules, ["user/empty"]);
	assert.equal(modules.rulesPrompt(), "");
});

test("规则的「团队：」行：从正文里取出来记在规则上；幕僚长看到的规则里写明团队；没写的规则没有团队", () => {
	assert.deepEqual(parseRules("user", "## news\n来源: rss\n团队：新闻队\n有听证会新闻就查一下\n\n## ci\n来源: ci\nCI 失败时开任务"), [
		{ id: "user/news", text: "有听证会新闻就查一下", sources: ["rss"], team: "新闻队" },
		{ id: "user/ci", text: "CI 失败时开任务", sources: ["ci"] },
	]);
	const file = join(mkdtempSync(join(tmpdir(), "psa-rules-")), "rules.md");
	writeFileSync(file, "## news\n来源: rss\n团队: 新闻队\n有听证会新闻就查一下\n\n## ci\n来源: ci\nCI 失败时开任务\n");
	const modules = Modules.load([], file);
	assert.deepEqual(modules.allRules().map((r) => [r.id, r.team]), [["user/news", "新闻队"], ["user/ci", undefined]]);
	assert.equal(modules.rulesPrompt(), "### user/news\n团队：新闻队\n有听证会新闻就查一下\n\n### user/ci\nCI 失败时开任务");
});
