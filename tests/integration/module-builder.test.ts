import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
