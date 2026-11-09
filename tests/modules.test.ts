import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Modules, moduleNameProblem, parseRules } from "../src/modules.ts";

const repoModules = fileURLToPath(new URL("../modules", import.meta.url));
const withToy = () => Modules.load([repoModules], undefined, { values: { "toy-market": true }, file: "config.json" });
const quote = (body: string) => ({ source: "toy-market", externalId: "x", threads: [], sender: "feed", body, occurredAt: 0 });

test("仓库里的模块都被发现，规则带模块前缀", () => {
	const modules = withToy();
	assert.deepEqual(modules.found.map((m) => m.name), ["toy-market", "us-market"]);
	assert.ok(modules.ruleAllows("toy-market/big-move", "toy-market"));
	assert.ok(!modules.ruleAllows("big-move", "toy-market"));
	assert.match(modules.rulesPrompt(), /### toy-market\/big-move/);
	assert.ok(modules.moduleForRule("toy-market/big-move")?.skillsDir);
});

test("程序层过滤：小于 1% 的波动在调用模型前被筛掉", () => {
	const { sourcePolicy } = withToy();
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
	const modules = withToy();
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

function moduleRoot(modules: Record<string, object>): string {
	const root = mkdtempSync(join(tmpdir(), "psa-mods-"));
	for (const [name, manifest] of Object.entries(modules)) {
		mkdirSync(join(root, name, "skills"), { recursive: true });
		writeFileSync(join(root, name, "module.json"), JSON.stringify({ name, ...manifest }));
		writeFileSync(join(root, name, "rules.md"), `## watch\n${name} 有动静就开任务\n`);
	}
	return root;
}

const switches = (values: Record<string, boolean>) => ({ values, file: "/state/config.json" });

test("模块开关：关掉的模块不贡献来源、规则、技能和定时器，其他模块照常", () => {
	const root = moduleRoot({
		mail: { sources: [{ name: "mail", mode: "ignore" }], timers: [{ id: "t", everyMinutes: 5, thread: "t", body: "看信" }] },
		ci: { sources: [{ name: "ci" }] },
	});
	const modules = Modules.load([root], undefined, switches({ mail: false }));
	assert.deepEqual(modules.modules.map((m) => m.name), ["ci"]);
	assert.deepEqual(modules.allRules().map((r) => r.id), ["ci/watch"]);
	assert.equal(modules.sourcePolicy({ ...quote("x"), source: "mail" }), "candidate");
	assert.deepEqual(modules.timers(), []);
	assert.equal(modules.moduleForRule("mail/watch"), undefined);
	assert.ok(modules.moduleForRule("ci/watch")?.skillsDir);
});

test("模块开关：found 列出全部模块和启用原因", () => {
	const root = moduleRoot({ a: {}, b: { defaultEnabled: false }, c: { defaultEnabled: false }, d: {} });
	const modules = Modules.load([root], undefined, switches({ c: true, d: false }));
	assert.deepEqual(modules.found.map((m) => [m.name, m.state]), [
		["a", { enabled: true, by: "default" }],
		["b", { enabled: false, by: "manifest" }],
		["c", { enabled: true, by: "config" }],
		["d", { enabled: false, by: "config" }],
	]);
});

test("模块名和对象原型上的属性同名时（constructor、toString），没写开关就按清单默认", () => {
	const root = moduleRoot({ constructor: { defaultEnabled: false }, toString: {} });
	const modules = Modules.load([root], undefined, switches({}));
	assert.deepEqual(modules.found.map((m) => [m.name, m.state]), [
		["constructor", { enabled: false, by: "manifest" }],
		["toString", { enabled: true, by: "default" }],
	]);
});

test("toy-market 默认关闭，开关打开后它的规则和过滤才生效", () => {
	assert.deepEqual(Modules.load([repoModules]).modules.map((m) => m.name), ["us-market"]);
	const on = Modules.load([repoModules], undefined, switches({ "toy-market": true }));
	assert.ok(on.ruleAllows("toy-market/big-move", "toy-market"));
	assert.equal(on.sourcePolicy(quote("TOYX 价格 100.4，涨跌 +0.4%，成交量 500 股")), "ignore");
});

test("模块开关里写了没发现的模块名时报 ConfigError，指出 config.json 和已发现的模块", () => {
	const root = moduleRoot({ mail: {} });
	assert.throws(
		() => Modules.load([root], undefined, switches({ mial: true })),
		(e: Error) => e.name === "ConfigError" && /\/state\/config\.json.*modules\.mial.*mail/.test(e.message),
	);
});

test("module.json 的 defaultEnabled 不是 true 或 false 时报 ConfigError", () => {
	const root = moduleRoot({ m: { defaultEnabled: "no" } });
	assert.throws(() => Modules.load([root]), (e: Error) => e.name === "ConfigError" && /module\.json.*defaultEnabled/.test(e.message));
});

test("模块名只能用字母、数字、- 和 _，并以字母或数字开头", () => {
	assert.equal(moduleNameProblem("us-market_2"), undefined);
	for (const bad of ["", "-x", "../evil", "a/b", ".hidden", "中文", "a b"]) assert.ok(moduleNameProblem(bad), bad);
	const root = moduleRoot({ "a b": {} });
	assert.throws(() => Modules.load([root]), (e: Error) => e.name === "ConfigError" && /a b/.test(e.message));
});
