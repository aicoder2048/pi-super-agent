import assert from "node:assert/strict";
import test from "node:test";
import { REPLY_MAX } from "../src/host/dispatch.ts";
import { MEMBER_PROMPT, workerArgs } from "../src/host/pi-worker.ts";
import { canCode, memberTools, toolAllowlist } from "../src/worker/tools.ts";

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

test("没有成员可派的助手：启动参数和单个助手一模一样，提示词只有那一段", () => {
	assert.deepEqual(workerArgs({ ...base, basis: "request", crew: [] }), ["--session-dir", "/s", "--session-id", "sid", "--no-extensions", "-e", "/ext.ts", "--no-skills", "--append-system-prompt", "p"]);
	assert.deepEqual(workerArgs({ ...base, basis: "request", crew: [] }), workerArgs({ ...base, basis: "request" }));
	assert.deepEqual(workerArgs({ ...base, basis: "inference", crew: [] }), workerArgs({ ...base, basis: "inference" }));
});

test("本队有成员的助手：提示词末尾多一段本队名册（名字、职称、说明），写明简单的事自己做、需要专门判断或可以并行时才派；推断任务的工具清单多一个 dispatch_agent", () => {
	const crew = [{ name: "market-analyst", title: "行情分析师", description: "看盘面和大盘" }, { name: "news-researcher", title: "新闻研究员", description: "查新闻、核对来源" }];
	const args = workerArgs({ ...base, basis: "inference", crew });
	const roster = args.at(-1)!;
	assert.deepEqual(args.slice(-4, -1), ["--append-system-prompt", "p", "--append-system-prompt"]);
	assert.match(roster, /market-analyst · 行情分析师：看盘面和大盘\n- news-researcher · 新闻研究员：查新闻、核对来源$/);
	assert.match(roster, /简单的事自己做/);
	assert.match(roster, /专门判断/);
	assert.match(roster, /并行/);
	assert.match(roster, /dispatch_agent/);
	assert.ok(flag(args, "--tools")!.split(",").includes("dispatch_agent"));
	assert.equal(flag(workerArgs({ ...base, basis: "request", crew }), "--tools"), undefined, "请求任务的助手保留全部工具");
});

test("能写文件、改文件或执行命令的成员算写代码的：按这次任务里实际能用的工具判断", () => {
	assert.equal(canCode(memberTools("request", undefined)), true);
	for (const tool of ["write", "edit", "bash"]) assert.equal(canCode(memberTools("request", ["read", tool])), true, tool);
	assert.equal(canCode(memberTools("request", ["read", "grep", "web_get", "lookup"])), false);
	assert.equal(canCode(memberTools("inference", ["read", "bash", "write"])), false, "推断任务里它只读");
	assert.equal(canCode([]), false);
});

test("成员的提示词：同一任务里读过的文件还在上文，再派给它时不重读；长文件先 grep 定位，再只读需要的那一段", () => {
	assert.match(MEMBER_PROMPT, /读过的文件还在上文里.*不要重读/);
	assert.match(MEMBER_PROMPT, /先用 grep 找到位置/);
});

test("成员的提示词：回复超过 2000 字时宿主把全文存成文件，助手直接看到的只有前 2000 字，所以结论摘要写在开头", () => {
	assert.match(MEMBER_PROMPT, new RegExp(`超过 ${REPLY_MAX} 字.*宿主把全文存成任务目录里的文件`));
	assert.match(MEMBER_PROMPT, /开头先写结论摘要/);
});
