import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createGateway } from "../../src/modules/gateway.ts";
import { instanceData, type ToolCalls } from "../../src/modules/instance-data.ts";
import { ModuleStore } from "../../src/modules/live.ts";
import { moduleDataDir } from "../../src/modules/knowledge.ts";
import type { ComponentName, Digest, ModuleName } from "../../src/modules/manifest.ts";
import type { Json, Request, WorkerCaller } from "../../src/modules/protocol.ts";
import { scanPackage } from "../../src/modules/validate.ts";

function files(root: string, tree: Record<string, string>): void {
	for (const [path, content] of Object.entries(tree)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

const readTool = (title: string) => JSON.stringify({ title, description: `${title}的说明`, effect: "read", input: { code: { type: "text", title: "代码" } }, output: { level: { type: "number", title: "价位" } } });

const PACKAGES: Record<string, Record<string, string>> = {
	alpha: {
		"module.json": JSON.stringify({ schema: 1, name: "alpha", version: "0.1.0", exports: ["tools/level", "tools/boom"] }),
		"tools/level/tool.json": readTool("价位"),
		"tools/level/index.ts": "export default () => ({ level: 42 });",
		"tools/boom/tool.json": readTool("出错"),
		"tools/boom/index.ts": 'export default () => { throw new Error("行情接口超时"); };',
	},
	beta: {
		"module.json": JSON.stringify({ schema: 1, name: "beta", version: "0.1.0", team: "乙队" }),
		"tools/own/tool.json": readTool("本模块"),
		"tools/own/index.ts": "export default () => ({ level: 7 });",
		"agents/analyst.md": "---\nname: analyst\ntitle: 分析员\ndescription: 看价位\ntools: read\nuses: tools/own, alpha/tools/level, alpha/tools/boom, delta/tools/quote\n---\n你是分析员。",
	},
};

type Row = { at: string; caller: string; ticket: string | null; member: string | null; basis: string; tool: string; outcome: string; ms: number };

function setup(t: TestContext, toolCalls?: (real: ToolCalls) => ToolCalls) {
	const root = mkdtempSync(join(tmpdir(), "psa-toolcalls-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = new ModuleStore(join(root, "store"));
	const serving = new Map<string, Digest>();
	for (const [name, tree] of Object.entries(PACKAGES)) {
		const pkg = join(root, "src", name);
		files(pkg, tree);
		const scan = scanPackage(pkg, { runCases: false });
		assert.ok(scan.ok, JSON.stringify(scan));
		assert.ok(store.keep(name as ModuleName, scan.scan.digest, pkg));
		serving.set(name, scan.scan.digest);
	}
	const stateDir = join(root, "state");
	const data = instanceData(stateDir);
	const logs: string[] = [];
	const gateway = createGateway({
		copyDir: (module, digest) => store.dirOf(module, digest),
		serving: (module) => serving.get(module),
		dataDir: (module) => moduleDataDir(stateDir, module),
		rows: data,
		toolCalls: toolCalls ? toolCalls(data) : data,
		secret: () => undefined,
		log: (line) => logs.push(line),
	});
	const caller = (over: Partial<WorkerCaller> = {}): WorkerCaller => ({ who: "worker", ticket: "tkt_1", pin: { module: "beta" as ModuleName, digest: serving.get("beta")! }, basis: "request", member: "analyst", heardOthers: false, ...over });
	const rows = (module: string): Row[] => {
		const path = join(moduleDataDir(stateDir, module as ModuleName), "data.db");
		if (!existsSync(path)) return [];
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			return db.prepare("SELECT * FROM _tool_calls ORDER BY rowid").all() as Row[];
		} finally {
			db.close();
		}
	};
	return { gateway, caller, rows, logs, stateDir };
}

const call = (name: string, input: Json = { code: "NVDA" }): Request => ({ kind: "tool", name: name as ComponentName, input });
const facts = ({ at, ms, ...rest }: Row) => (assert.ok(!Number.isNaN(Date.parse(at)) && ms >= 0, `${at} ${ms}`), rest);

test("_tool_calls：外部调用记在提供方的 data.db，写着调用方模块、任务、成员、依据、工具、结果", async (t) => {
	const { gateway, caller, rows } = setup(t);
	assert.equal((await gateway.call(caller({ basis: "inference" }), call("alpha/tools/level"))).ok, true);
	assert.deepEqual(rows("alpha").map(facts), [{ caller: "beta", ticket: "tkt_1", member: "analyst", basis: "inference", tool: "tools/level", outcome: "ok" }]);
});

test("_tool_calls：本模块的工具调用也记，调用方是本模块；助手的成员是空的", async (t) => {
	const { gateway, caller, rows } = setup(t);
	assert.equal((await gateway.call(caller({ member: null }), call("own"))).ok, true);
	assert.deepEqual(rows("beta").map(facts), [{ caller: "beta", ticket: "tkt_1", member: null, basis: "request", tool: "tools/own", outcome: "ok" }]);
	assert.deepEqual(rows("alpha"), []);
});

test("_tool_calls：工具跑了但出错，结果记拒绝码", async (t) => {
	const { gateway, caller, rows } = setup(t);
	assert.equal((await gateway.call(caller(), call("alpha/tools/boom"))).ok, false);
	assert.deepEqual(rows("alpha").map((r) => r.outcome), ["provider-failed"]);
});

test("_tool_calls：没跑起来的调用不记，不给没装的提供方建数据目录", async (t) => {
	const { gateway, caller, rows, stateDir } = setup(t);
	assert.equal((await gateway.call(caller({ member: "nobody" }), call("alpha/tools/level"))).ok, false);
	assert.equal((await gateway.call(caller(), call("delta/tools/quote"))).ok, false);
	assert.deepEqual(rows("alpha"), []);
	assert.equal(existsSync(moduleDataDir(stateDir, "delta" as ModuleName)), false);
});

test("_tool_calls 写不进去：工具调用照常成功，宿主日志记一行", async (t) => {
	const { gateway, caller, logs } = setup(t, () => ({
		recordToolCall: () => {
			throw new Error("database is locked");
		},
	}));
	assert.deepEqual(await gateway.call(caller(), call("alpha/tools/level")), { ok: true, output: { level: 42 } });
	assert.ok(logs.some((l) => l.includes("_tool_calls") && l.includes("database is locked")), logs.join("\n"));
});
