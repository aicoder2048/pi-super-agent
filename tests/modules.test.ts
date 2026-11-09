import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Modules, parseRules } from "../src/modules.ts";

const repoModules = fileURLToPath(new URL("../modules", import.meta.url));
const quote = (body: string) => ({ source: "toy-market", externalId: "x", threads: [], sender: "feed", body, occurredAt: 0 });

test("玩具模块被发现，规则带模块前缀", () => {
	const modules = Modules.load([repoModules]);
	assert.deepEqual(modules.modules.map((m) => m.name), ["toy-market"]);
	assert.ok(modules.isKnownRule("toy-market/big-move"));
	assert.ok(!modules.isKnownRule("big-move"));
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
