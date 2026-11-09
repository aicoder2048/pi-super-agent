import assert from "node:assert/strict";
import test from "node:test";
import { workerArgs } from "../src/host/pi-worker.ts";

const base = { sessionDir: "/s", sessionId: "sid", extension: "/ext.ts", prompt: "p", skillsDirs: [] };
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const tools = (args: string[]) => flag(args, "--tools")?.split(",").sort();
const all = (args: string[], name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

test("推断任务的 Worker 只拿只读工具、网页读取和汇报类工具，并关掉 MCP", () => {
	const args = workerArgs({ ...base, basis: "inference" });
	assert.deepEqual(tools(args), ["find", "grep", "hand_back", "lookup", "ls", "read", "read_ticket", "report", "web_get"]);
	assert.ok(args.includes("--no-mcp"));
});

test("请求和规则任务的通用助手保留全部工具", () => {
	for (const basis of ["request", "rule"] as const) {
		const args = workerArgs({ ...base, basis });
		assert.equal(flag(args, "--tools"), undefined);
		assert.ok(!args.includes("--no-mcp"));
	}
});

test("角色只收窄：请求任务拿角色的工具加汇报类工具，关掉 MCP", () => {
	const args = workerArgs({ ...base, basis: "request", roleTools: ["read", "web_get", "bash"] });
	assert.deepEqual(tools(args), ["bash", "hand_back", "read", "read_ticket", "report", "web_get"]);
	assert.ok(args.includes("--no-mcp"));
});

test("推断任务派给写了 bash 的角色仍然只读：依据允许的和角色的取交集", () => {
	const args = workerArgs({ ...base, basis: "inference", roleTools: ["read", "bash", "write", "web_get"] });
	assert.deepEqual(tools(args), ["hand_back", "read", "read_ticket", "report", "web_get"]);
});

test("角色的提示词接在 Worker 提示词后面；角色技能和模块技能都加载", () => {
	const args = workerArgs({ ...base, basis: "request", rolePrompt: "你是新闻研究员。", skillsDirs: ["/roles/news-skills", "/modules/m/skills"] });
	assert.deepEqual(all(args, "--append-system-prompt"), ["p", "你是新闻研究员。"]);
	assert.deepEqual(all(args, "--skill"), ["/roles/news-skills", "/modules/m/skills"]);
	assert.deepEqual(all(workerArgs({ ...base, basis: "request" }), "--append-system-prompt"), ["p"]);
});
