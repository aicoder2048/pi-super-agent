import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startLiveModules } from "../../src/host/live-modules.ts";
import { moduleRows, openStore } from "../../src/kernel/store.ts";
import { Modules } from "../../src/modules.ts";
import { scanPackage } from "../../src/modules/validate.ts";
import { MEMBER_TOOLS, memberTools } from "../../src/worker/tools.ts";

const REPO_MODULES = fileURLToPath(new URL("../../modules", import.meta.url));
const BUILDER = join(REPO_MODULES, "module-builder");
const WRITERS = ["scaffolder", "knowledge-curator", "eval-writer", "checker"];

function scanned() {
	const result = scanPackage(BUILDER);
	assert.ok(result.ok, result.ok ? "" : result.problems.map((p) => `${p.where}: ${p.reason}`).join("\n"));
	return result.scan;
}

test("制作模块 module-builder 是新布局包，just module check 的同一段检查通过，带至少两道考题", () => {
	const scan = scanned();
	assert.equal(scan.manifest.name, "module-builder");
	assert.equal(scan.manifest.team, "模块工坊");
	assert.ok(scan.components.filter((c) => c.kind === "evals").length >= 2);
	assert.ok(scan.components.filter((c) => c.kind === "skills").length >= 3);
});

test("五位专家的 tools 都是成员能有的工具；动手写包的四位有 read、write、edit、bash；推断任务里谁都只剩只读工具", () => {
	const agents = scanned().components.flatMap((c) => (c.kind === "agents" ? [c.agent] : []));
	assert.deepEqual(agents.map((a) => a.name).sort(), ["checker", "eval-writer", "interviewer", "knowledge-curator", "scaffolder"]);
	for (const agent of agents) {
		for (const tool of agent.tools) assert.ok(MEMBER_TOOLS.includes(tool), `${agent.name} 的 ${tool} 是成员工具`);
		assert.deepEqual(agent.uses, [], `${agent.name} 不用模块能力，这个包没有知识、数据和工具`);
		for (const tool of ["write", "edit", "bash"]) assert.ok(!memberTools("inference", agent.tools).includes(tool), `${agent.name} 在推断任务里没有 ${tool}`);
	}
	assert.deepEqual(agents.find((a) => a.name === "interviewer")!.tools, ["read", "write", "edit", "ls"], "访谈只写说明书，不跑命令");
	for (const name of WRITERS) {
		const tools = agents.find((a) => a.name === name)!.tools;
		for (const tool of ["read", "write", "edit", "bash"]) assert.ok(tools.includes(tool), `${name} 有 ${tool}`);
	}
});

test("第一次启动：module-builder 随仓库发，默认打开，五位专家在队里，名册说明提到做模块", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-builder-"));
	const db = openStore(join(dir, "state.db"));
	const modules = startLiveModules({ db, stateDir: dir, roots: [REPO_MODULES], discovered: Modules.load([REPO_MODULES]), configSwitches: {}, log: () => {} });
	t.after(() => {
		modules.stop();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	assert.equal(Object.fromEntries(moduleRows(db).map((r) => [r.name, r.switch]))["module-builder"], true);
	assert.equal(modules.kitFor("module-builder", null)?.crew.length, 5);
	const line = modules.live.current().rosterPrompt().split("\n").find((l) => l.startsWith("- module-builder"));
	assert.match(line ?? "", /模块/);
});

const SKILL = (name: string) => readFileSync(join(BUILDER, "skills", name, "SKILL.md"), "utf8");
const QUOTE = "stock-ta/tools/quote";

/** Each fenced block whose info string carries `file=<package>/<path>` is one file of an example package, as the skill shows it. */
function examplePackages(markdown: string): Map<string, Map<string, string>> {
	const packages = new Map<string, Map<string, string>>();
	for (const [, path, body] of markdown.matchAll(/^```\w* file=(\S+)\n([\s\S]*?)^```$/gm)) {
		const [pkg, ...rest] = path!.split("/");
		if (!packages.has(pkg!)) packages.set(pkg!, new Map());
		packages.get(pkg!)!.set(rest.join("/"), body!);
	}
	return packages;
}

function writePackage(t: { after(fn: () => void): void }, name: string, files: Map<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "psa-example-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [path, body] of files) {
		mkdirSync(dirname(join(root, name, path)), { recursive: true });
		writeFileSync(join(root, name, path), body);
	}
	return join(root, name);
}

const problemsOf = (dir: string) => {
	const result = scanPackage(dir);
	return result.ok ? [] : result.problems.map((p) => `${p.where}: ${p.reason}`);
};

function checked(dir: string) {
	const result = scanPackage(dir);
	assert.ok(result.ok, result.ok ? "" : result.problems.map((p) => `${p.where}: ${p.reason}`).join("\n"));
	return result.scan;
}

function examples() {
	const packages = [...examplePackages(SKILL("package-layout"))];
	assert.equal(packages.length, 2, "技能 package-layout 给两个示例包");
	const team = packages.find(([, files]) => [...files.keys()].some((path) => path.startsWith("agents/")));
	const solo = packages.find(([, files]) => ![...files.keys()].some((path) => path.startsWith("agents/")));
	assert.ok(team && solo, "一个带专家，一个不带专家");
	return { team, solo };
}

test("技能 package-layout 原文里的两个示例包写进目录，just module check 的同一段检查都通过，都只用 stock-ta/tools/quote", (t) => {
	const { team, solo } = examples();
	const teamScan = checked(writePackage(t, ...team));
	assert.equal(teamScan.manifest.uses, undefined, "带专家的包不写模块级 uses");
	const agents = teamScan.components.flatMap((c) => (c.kind === "agents" ? [c.agent] : []));
	assert.ok(agents.length > 0);
	assert.deepEqual([...new Set(agents.flatMap((a) => a.uses))], [QUOTE], "外部工具写在专家的 uses 里");
	const soloScan = checked(writePackage(t, ...solo));
	assert.deepEqual(soloScan.manifest.uses, [QUOTE], "不带专家的包写在 module.json 的 uses 里");
	for (const scan of [teamScan, soloScan]) assert.ok(scan.notes.some((n) => n.includes(`uses "${QUOTE}", another module's tool`)), `${scan.manifest.name} 的检查认出外部工具，只给提醒`);
});

test("带专家的示例包把 uses 从专家文件挪到 module.json，检查报错", (t) => {
	const [name, files] = examples().team;
	const moved = new Map(files);
	for (const [path, body] of files) if (path.startsWith("agents/")) moved.set(path, body.replace(/^uses:.*\n/m, ""));
	const manifest = JSON.parse(files.get("module.json")!);
	moved.set("module.json", JSON.stringify({ ...manifest, uses: [QUOTE] }, null, 2));
	assert.ok(problemsOf(writePackage(t, name, moved)).some((line) => line.startsWith(`module.json: has "uses" but agents/ has members`)));
});

test("技能 build-module 原文写了「请对提供方说」的转述规则", () => {
	const text = SKILL("build-module");
	assert.ok(text.includes("请对 <提供方> 说"), "写明转述的句式");
	assert.ok(text.includes("请对 stock-ta 说"), "给出 stock-ta 的例句");
});
