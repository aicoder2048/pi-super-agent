import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigError } from "../src/config-error.ts";
import { Modules, parseRules } from "../src/modules.ts";

const repoModules = fileURLToPath(new URL("../modules", import.meta.url));
const quote = (body: string) => ({ source: "toy-market", externalId: "x", threads: [], sender: "feed", body, occurredAt: 0 });

test("仓库里的模块都被发现，规则带模块前缀", () => {
	const modules = Modules.load([repoModules]);
	assert.deepEqual(modules.modules.map((m) => m.name), ["toy-market", "us-market"]);
	assert.ok(modules.ruleAllows("toy-market/big-move", "toy-market"));
	assert.ok(!modules.ruleAllows("big-move", "toy-market"));
	assert.match(modules.rulesPrompt(), /### toy-market\/big-move/);
	assert.equal(modules.kitFor("toy-market")?.skillsDir, join(repoModules, "toy-market/skills"));
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
	assert.deepEqual(parseRules("rules.md", "user", "# 标题\n## a\n第一条\n\n## b\n\n## c\n第三条"), [
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
	const modules = Modules.load([], { stateDir: dirname(file) });
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
	const modules = Modules.load([], { stateDir: dirname(file) });
	assert.ok(!modules.ruleAllows("user/empty", "mail"));
	assert.deepEqual(modules.skippedUserRules, ["user/empty"]);
	assert.equal(modules.rulesPrompt(), "");
});

test("规则里写了「团队：」行：加载时报一行错，以规则文件开头，写出规则 id 和改法；模块规则和使用者规则都一样", () => {
	for (const line of ["团队：新闻队", "团队: 新闻队", "团队："]) {
		const dir = mkdtempSync(join(tmpdir(), "psa-rules-"));
		const file = join(dir, "rules.md");
		writeFileSync(file, `## ci\n来源: ci\nCI 失败时开任务\n\n## news\n来源: rss\n${line}\n有听证会新闻就查一下\n`);
		assert.throws(() => Modules.load([], { stateDir: dirname(file) }), (e: Error) => {
			assert.ok(e instanceof ConfigError, String(e));
			assert.ok(e.message.startsWith(file), e.message);
			assert.ok(!e.message.includes("\n"), e.message);
			assert.match(e.message, /规则 user\/news 写了「团队：」/);
			assert.match(e.message, /删掉这一行/);
			assert.match(e.message, /agents\//);
			return true;
		}, line);
	}
	assert.throws(() => parseRules("/m/watch/rules.md", "watch", "## drop\n团队：看盘队\n跌多了开任务\n"), (e: Error) => e.message.startsWith("/m/watch/rules.md：规则 watch/drop 写了「团队：」"));
});

test("幕僚长看到的规则只有编号和正文", () => {
	const file = join(mkdtempSync(join(tmpdir(), "psa-rules-")), "rules.md");
	writeFileSync(file, "## news\n来源: rss\n有听证会新闻就查一下\n\n## ci\n来源: ci\nCI 失败时开任务\n");
	assert.equal(Modules.load([], { stateDir: dirname(file) }).rulesPrompt(), "### user/news\n有听证会新闻就查一下\n\n### user/ci\nCI 失败时开任务");
});

test("模块不能叫 user：这个名字留给使用者自己的规则，加载时报一行错，以 module.json 开头", () => {
	const root = mkdtempSync(join(tmpdir(), "psa-mods-"));
	mkdirSync(join(root, "user"));
	writeFileSync(join(root, "user", "module.json"), JSON.stringify({ name: "user" }));
	assert.throws(() => Modules.load([root]), (e: Error) => e instanceof ConfigError && e.message.startsWith(join(root, "user/module.json")) && /不能叫 user/.test(e.message) && !e.message.includes("\n"));
});

test("仓库里的两个行情模块都有领域名和给幕僚长的说明，出现在领域名册里；都还没有成员", () => {
	const modules = Modules.load([repoModules]);
	assert.equal(modules.rosterPrompt(), "- toy-market（玩具行情）：演示用的假行情，只管玩具代码（如 TOYX）的波动\n- us-market（美股行情）：美股个股和大盘的行情、涨跌和波动原因");
	assert.deepEqual([...modules.book], [["toy-market", { team: null, onRoster: true }], ["us-market", { team: null, onRoster: true }]]);
});
