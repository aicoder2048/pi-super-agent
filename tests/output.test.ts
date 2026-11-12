import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Kernel } from "../src/kernel/kernel.ts";
import { openStore } from "../src/kernel/store.ts";
import { OUTPUT_KINDS, OutputRoot } from "../src/host/output.ts";

function outputRoot(stateDir = mkdtempSync(join(tmpdir(), "psa-output-"))) {
	const kernel = new Kernel({ db: openStore(":memory:"), clock: { now: () => Date.now() }, sourcePolicy: () => "candidate" });
	const ticket = () => {
		const { triggerId } = kernel.userSaid({ text: "做个扩展", at: Date.now() });
		const [opened] = kernel.route([{ kind: "open_ticket", basis: "request", triggerId, title: "做个扩展", brief: "做个扩展" }]);
		assert.ok(opened.ok);
		return opened.ticketId!;
	};
	const root = join(stateDir, "output");
	return { stateDir, root, ticket, output: new OutputRoot({ root, stateDir, ledger: kernel }) };
}

test("分类表的目录互不相同，也不互相嵌套；只有 apps 用应用编号，分析报告在 docs/analysis", () => {
	const dirs = OUTPUT_KINDS.map((k) => k.dir);
	assert.equal(new Set(dirs).size, dirs.length);
	for (const a of dirs) for (const b of dirs) if (a !== b) assert.ok(!b.startsWith(`${a}/`), `${b} 嵌在 ${a} 下面`);
	assert.deepEqual(OUTPUT_KINDS.filter((k) => k.naming === "app").map((k) => k.dir), ["apps"]);
	assert.ok(dirs.includes("docs/analysis"));
});

test("助手和成员的规则里写着成品目录的绝对路径，分类表的每个目录都在里面，也写着模块包放在状态目录的 modules/", () => {
	const { root, stateDir, output } = outputRoot();
	for (const role of ["helper", "member"] as const) {
		const rule = output.prompt(role);
		for (const kind of OUTPUT_KINDS) assert.ok(rule.includes(`${root}/${kind.dir}/`), `${role} 的规则里没有 ${kind.dir}`);
		assert.match(rule, /不要写进代码仓库/);
		assert.ok(rule.includes(`模块包写进 ${join(stateDir, "modules")}/<名字>/`), `${role} 的规则写明模块包的位置`);
		const check = rule.split("\n").find((l) => l.includes("宿主会检查")) ?? "";
		assert.match(check, /模块目录/, `${role} 的规则里，宿主的写入检查也把模块目录算在里面`);
		const dataRow = rule.split("\n").find((l) => l.startsWith(`| ${root}/data/ |`)) ?? "";
		assert.doesNotMatch(dataRow, /\.md/, "数据那一行的起名例子不该带 .md");
	}
});

test("只有助手的规则里有 new_app，也要求派活时写明目录、不让成员写进代码仓库；成员的规则里是请领队给目录", () => {
	const { output } = outputRoot();
	const helper = output.prompt("helper");
	const member = output.prompt("member");
	assert.match(helper, /new_app/);
	assert.match(helper, /派活给成员时.*绝对路径/);
	const dispatch = helper.split("\n").find((l) => l.includes("派活给成员时")) ?? "";
	assert.match(dispatch, /模块目录/, "派活时可以把模块目录下的模块包路径写进任务");
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

test("new_app 拒绝不合法的短名，错误信息是中文", () => {
	const { output, ticket } = outputRoot();
	const id = ticket();
	for (const short of ["Joke", "../x", "a b", "", "x".repeat(25), "-x", "x-", "a--b", 7, undefined]) {
		assert.throws(() => output.newApp(id, short), /短名/, JSON.stringify(short));
	}
});

test("new_app 建好 apps/app-NNN-<短名>/，编号至少三位", () => {
	const { output, ticket, root } = outputRoot();
	const app = output.newApp(ticket(), "stock-alert");
	assert.deepEqual(app, { app: "app-001-stock-alert", dir: join(root, "apps", "app-001-stock-alert"), isNew: true });
	assert.ok(existsSync(app.dir));
});

test("new_app 的编号不比 apps/ 下已有的最大编号小，state.db 是新的也一样", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-output-"));
	mkdirSync(join(stateDir, "output", "apps", "app-041-old"), { recursive: true });
	mkdirSync(join(stateDir, "output", "apps", "notes"), { recursive: true });
	const { output, ticket } = outputRoot(stateDir);
	assert.equal(output.newApp(ticket(), "joke").app, "app-042-joke");
});

test("同一任务用同一短名再要，拿回同一个目录；不同任务用同一短名，拿到新编号", () => {
	const { output, ticket } = outputRoot();
	const [a, b] = [ticket(), ticket()];
	const first = output.newApp(a, "joke");
	assert.deepEqual(output.newApp(a, "joke"), { ...first, isNew: false });
	assert.equal(output.newApp(b, "joke").app, "app-002-joke");
});
