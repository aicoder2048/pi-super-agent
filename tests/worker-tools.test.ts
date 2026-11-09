import assert from "node:assert/strict";
import test from "node:test";
import { workerArgs } from "../src/host/pi-worker.ts";

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
