import assert from "node:assert/strict";
import test from "node:test";
import { workerArgs } from "../src/host/pi-worker.ts";
import { memberTools, toolAllowlist } from "../src/worker/tools.ts";

const base = { sessionDir: "/s", sessionId: "sid", extension: "/ext.ts", prompt: "p" };
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

test("推断任务的 Worker 只拿只读工具、网页读取和汇报类工具，并关掉 MCP", () => {
	const args = workerArgs({ ...base, basis: "inference" });
	assert.deepEqual(flag(args, "--tools")!.split(",").sort(), ["find", "grep", "hand_back", "lookup", "ls", "read", "read_ticket", "report", "web_get"]);
	assert.ok(args.includes("--no-mcp"));
});

test("请求和规则任务的 Worker 保留全部工具", () => {
	for (const basis of ["request", "rule"] as const) {
		const args = workerArgs({ ...base, basis });
		assert.equal(flag(args, "--tools"), undefined);
		assert.ok(!args.includes("--no-mcp"));
	}
});

test("能派活的助手：推断任务的工具清单多一个 dispatch_agent；请求任务本来就不限；不能派活的清单和原来一样", () => {
	assert.deepEqual(toolAllowlist("inference", true), [...toolAllowlist("inference")!, "dispatch_agent"]);
	assert.equal(toolAllowlist("request", true), undefined);
	assert.ok(!toolAllowlist("inference")!.includes("dispatch_agent"));
});

test("成员的工具 = 任务依据允许的工具 ∩ 成员自己的 tools；没有汇报、交回、读任务、后台命令和派活", () => {
	assert.deepEqual(memberTools("request", undefined), ["read", "bash", "edit", "write", "grep", "find", "ls", "web_get", "lookup"]);
	assert.deepEqual(memberTools("rule", ["bash", "read", "report", "hand_back", "read_ticket", "bg_start"]), ["read", "bash"]);
	assert.deepEqual(memberTools("inference", undefined), ["read", "grep", "find", "ls", "web_get", "lookup"]);
	assert.deepEqual(memberTools("inference", ["bash", "write", "web_get"]), ["web_get"], "推断任务里写了 bash 的成员仍只读");
	assert.deepEqual(memberTools("inference", ["bash"]), []);
	for (const basis of ["request", "rule", "inference"] as const) assert.ok(!memberTools(basis, undefined).includes("dispatch_agent"));
});
