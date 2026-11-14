import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfigError } from "../src/config-error.ts";
import { Modules, parseRules } from "../src/modules.ts";
import { moduleNameProblem } from "../src/modules/validate.ts";
import { servedAsHost } from "./helpers/fakes.ts";

const repoModules = fileURLToPath(new URL("../modules", import.meta.url));
const switches = (values: Record<string, boolean>) => ({ values, file: "/state/config.json" });
const legacyModules = fileURLToPath(new URL("./fixtures/legacy", import.meta.url));
const withToy = (...roots: string[]) => Modules.load([...roots, legacyModules], { switches: switches({ "toy-market": true }) });
const quote = (body: string) => ({ source: "toy-market", externalId: "x", threads: [], sender: "feed", body, occurredAt: 0 });

test("仓库里的模块和旧布局夹具都被发现，规则带模块前缀", () => {
	const modules = withToy(repoModules);
	assert.deepEqual(modules.found.map((m) => m.name), ["toy-market"]);
	assert.deepEqual(modules.packages.map((p) => p.name), ["module-builder", "pi-pi"]);
	assert.ok(modules.ruleAllows("toy-market/big-move", "toy-market"));
	assert.ok(!modules.ruleAllows("big-move", "toy-market"));
	assert.match(modules.rulesPrompt(), /### toy-market\/big-move/);
	assert.equal(modules.kitFor("toy-market")?.skillsDir, join(legacyModules, "toy-market/skills"));
});

test("程序层过滤：小于 1% 的波动在调用模型前被筛掉", () => {
	const { sourcePolicy } = withToy();
	assert.equal(sourcePolicy(quote("TOYX 价格 100.4，涨跌 +0.4%，成交量 500 股")), "ignore");
	assert.equal(sourcePolicy(quote("TOYX 价格 94.8，涨跌 -5.2%，成交量 12 股")), "candidate");
	assert.equal(sourcePolicy({ ...quote("anything"), source: "other" }), "candidate");
});

test("行情来源：模块里标了 market 的来源（玩具行情）是，其他来源不是", () => {
	const { isMarketSource } = withToy();
	assert.deepEqual(["toy-market", "mail", "conversation"].map(isMarketSource), [true, false, false]);
});

test("规则文件按二级标题切分，空规则不算", () => {
	assert.deepEqual(parseRules("rules.md", "user", "# 标题\n## a\n第一条\n\n## b\n\n## c\n第三条"), [
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

function moduleRoot(modules: Record<string, object>): string {
	const root = mkdtempSync(join(tmpdir(), "psa-mods-"));
	for (const [name, manifest] of Object.entries(modules)) {
		mkdirSync(join(root, name, "skills"), { recursive: true });
		writeFileSync(join(root, name, "module.json"), JSON.stringify({ name, ...manifest }));
		writeFileSync(join(root, name, "rules.md"), `## watch\n${name} 有动静就开任务\n`);
	}
	return root;
}

test("模块开关：关掉的模块不贡献来源、规则、技能和定时器，其他模块照常", () => {
	const root = moduleRoot({
		mail: { sources: [{ name: "mail", mode: "ignore" }], timers: [{ id: "t", everyMinutes: 5, thread: "t", body: "看信" }] },
		ci: { sources: [{ name: "ci" }] },
	});
	const modules = Modules.load([root], { switches: switches({ mail: false }) });
	assert.deepEqual(modules.modules.map((m) => m.name), ["ci"]);
	assert.deepEqual(modules.allRules().map((r) => r.id), ["ci/watch"]);
	assert.equal(modules.sourcePolicy({ ...quote("x"), source: "mail" }), "candidate");
	assert.deepEqual(modules.timers(), []);
	assert.equal(modules.kitFor("mail"), undefined);
	assert.ok(modules.kitFor("ci")?.skillsDir);
});

test("模块开关：found 列出全部模块和启用原因", () => {
	const root = moduleRoot({ a: {}, b: { defaultEnabled: false }, c: { defaultEnabled: false }, d: {} });
	const modules = Modules.load([root], { switches: switches({ c: true, d: false }) });
	assert.deepEqual(modules.found.map((m) => [m.name, m.state]), [
		["a", { enabled: true, by: "default" }],
		["b", { enabled: false, by: "manifest" }],
		["c", { enabled: true, by: "config" }],
		["d", { enabled: false, by: "config" }],
	]);
});

test("模块名和对象原型上的属性同名时（constructor），没写开关就按清单默认", () => {
	for (const [manifest, state] of [
		[{ defaultEnabled: false }, { enabled: false, by: "manifest" }],
		[{}, { enabled: true, by: "default" }],
	] as const) {
		const modules = Modules.load([moduleRoot({ constructor: manifest })], { switches: switches({}) });
		assert.deepEqual(modules.found.map((m) => [m.name, m.state]), [["constructor", state]]);
	}
});

test("旧布局夹具 toy-market 默认关闭，开关打开后它的规则和过滤才生效", () => {
	assert.deepEqual(Modules.load([repoModules, legacyModules]).modules.map((m) => m.name), []);
	const on = withToy();
	assert.ok(on.ruleAllows("toy-market/big-move", "toy-market"));
	assert.equal(on.sourcePolicy(quote("TOYX 价格 100.4，涨跌 +0.4%，成交量 500 股")), "ignore");
});

test("模块开关里写了没发现的模块名时报 ConfigError，指出 config.json 和已发现的模块", () => {
	const root = moduleRoot({ mail: {} });
	assert.throws(
		() => Modules.load([root], { switches: switches({ mial: true }) }),
		(e: Error) => e.name === "ConfigError" && /\/state\/config\.json.*modules\.mial.*mail/.test(e.message),
	);
});

test("module.json 的 defaultEnabled 不是 true 或 false 时报 ConfigError", () => {
	const root = moduleRoot({ m: { defaultEnabled: "no" } });
	assert.throws(() => Modules.load([root]), (e: Error) => e.name === "ConfigError" && /module\.json.*defaultEnabled/.test(e.message));
});

test("模块名只能用小写字母和数字，用单个 - 连接", () => {
	assert.equal(moduleNameProblem("us-market2"), undefined);
	for (const bad of ["", "-x", "../evil", "a/b", ".hidden", "中文", "a b", "us-market_2", "Us-market", "mail--x", "mail-"]) assert.ok(moduleNameProblem(bad), bad);
	const root = moduleRoot({ "a b": {} });
	assert.throws(() => Modules.load([root]), (e: Error) => e.name === "ConfigError" && /a b/.test(e.message));
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

test("仓库里的模块和旧布局夹具都有领域名和给幕僚长的说明，出现在领域名册里；旧布局夹具没有成员", () => {
	const modules = servedAsHost(withToy(repoModules));
	assert.equal(
		modules.rosterPrompt(),
		"- toy-market（玩具行情）：测试用的旧布局行情模块\n- module-builder（模块制作）：用聊天做一个新模块，或改一个已有模块：访谈、搭包、整理知识、出考题、检查\n- pi-pi（Pi 开发）：怎么写 Pi 的扩展、主题、技能、配置、提示模板和终端界面组件",
	);
	assert.deepEqual(Object.fromEntries([...modules.book].map(([name, { team, onRoster }]) => [name, { team, onRoster }])), { "module-builder": { team: "模块工坊", onRoster: true }, "pi-pi": { team: "Pi施工队", onRoster: true }, "toy-market": { team: null, onRoster: true } });
});

test("us-market 退役以后 config.json 的 modules 里还写着它：报错说删掉 modules.us-market", () => {
	assert.throws(() => Modules.load([repoModules], { switches: { values: { "us-market": false }, file: "/s/config.json" } }), (e: Error) => e instanceof ConfigError && e.message === "/s/config.json：us-market 已经退役，删掉 modules.us-market");
});
