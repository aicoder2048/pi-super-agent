import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OUTPUT_KINDS, OutputRoot } from "../src/host/output.ts";

function outputRoot() {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-output-"));
	const root = join(stateDir, "output");
	return { stateDir, root, output: new OutputRoot({ root, stateDir }) };
}

test("分类表的目录互不相同，也不互相嵌套；只有 apps 用应用编号，分析报告在 docs/analysis", () => {
	const dirs = OUTPUT_KINDS.map((k) => k.dir);
	assert.equal(new Set(dirs).size, dirs.length);
	for (const a of dirs) for (const b of dirs) if (a !== b) assert.ok(!b.startsWith(`${a}/`), `${b} 嵌在 ${a} 下面`);
	assert.deepEqual(OUTPUT_KINDS.filter((k) => k.naming === "app").map((k) => k.dir), ["apps"]);
	assert.ok(dirs.includes("docs/analysis"));
});

test("助手和成员的规则里写着成品目录的绝对路径，分类表的每个目录都在里面", () => {
	const { root, output } = outputRoot();
	for (const role of ["helper", "member"] as const) {
		const rule = output.prompt(role);
		for (const kind of OUTPUT_KINDS) assert.ok(rule.includes(`${root}/${kind.dir}/`), `${role} 的规则里没有 ${kind.dir}`);
		assert.match(rule, /不要写进代码仓库/);
	}
});

test("只有助手的规则里有 new_app，也要求派活时写明目录、不让成员写进代码仓库；成员的规则里是请领队给目录", () => {
	const { output } = outputRoot();
	const helper = output.prompt("helper");
	const member = output.prompt("member");
	assert.match(helper, /new_app/);
	assert.match(helper, /派活给成员时.*绝对路径/);
	assert.doesNotMatch(member, /new_app/);
	assert.match(member, /请领队给/);
});

test("prepare 建好每一类的目录，README 列出每一类；重复调用不碰已有的成品", () => {
	const { root, output } = outputRoot();
	output.prepare();
	for (const kind of OUTPUT_KINDS) assert.ok(existsSync(join(root, kind.dir)), `没有建 ${kind.dir}`);
	const readme = readFileSync(join(root, "README.md"), "utf8");
	for (const kind of OUTPUT_KINDS) assert.ok(readme.includes(`${kind.dir}/`) && readme.includes(kind.label), `README 里没有 ${kind.dir}`);
	mkdirSync(join(root, "apps", "app-001-joke"));
	writeFileSync(join(root, "apps", "app-001-joke", "index.ts"), "kept");
	writeFileSync(join(root, "README.md"), "被手改过");
	output.prepare();
	assert.equal(readFileSync(join(root, "apps", "app-001-joke", "index.ts"), "utf8"), "kept");
	assert.equal(readFileSync(join(root, "README.md"), "utf8"), readme);
});
