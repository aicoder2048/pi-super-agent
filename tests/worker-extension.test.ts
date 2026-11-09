import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { onJsonLines, writeJsonLine } from "../src/jsonl.ts";
import { until } from "./helpers/fakes.ts";

async function load(basis: string, roleTools?: string, extra: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "psa-wext-"));
	const socketPath = join(dir, "host.sock");
	const requests: any[] = [];
	const sockets = new Set<import("node:net").Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		onJsonLines(socket, (r: any) => {
			if (r.type !== "request") return;
			requests.push(r);
			const result = r.method === "worker.consult" ? { text: "行情分析师：放量下跌", details: { kind: "consult", experts: [{ title: "行情分析师" }] } } : { recorded: true };
			writeJsonLine(socket, { id: r.id, ok: true, result });
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	Object.assign(process.env, { PSA_SOCKET: socketPath, PSA_TICKET: "tkt_1", PSA_TOKEN: "tok", PSA_BASIS: basis });
	if (roleTools !== undefined) process.env.PSA_ROLE_TOOLS = roleTools;
	Object.assign(process.env, extra);
	const { default: workerExtension } = await import(`../src/worker/extension.ts?basis=${basis}&role=${roleTools}&extra=${Object.keys(extra)}`);
	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	const sent: any[] = [];
	workerExtension({
		registerTool: (def: any) => tools.set(def.name, def),
		on: (event: string, fn: any) => handlers.set(event, fn),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	});
	const run = (name: string, params: any) => tools.get(name).execute("call", params, undefined, undefined, { cwd: dir });
	return { tools, handlers, sent, requests, run, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}

test("后台命令启动后立即返回，结束时结果作为新输入送回", async (t) => {
	const w = await load("request");
	t.after(w.close);
	const started = Date.now();
	const result = await w.run("bg_start", { command: "sleep 0.3; echo 跑完了" });
	assert.ok(Date.now() - started < 250, "没有等命令结束");
	assert.match(result.content[0].text, /已启动 bg1/);
	assert.equal(w.sent.length, 0);
	await until(() => w.sent.length === 1, "结果送回");
	assert.match(w.sent[0].message.content, /跑完了/);
	assert.equal(w.sent[0].options.triggerTurn, true);
	await until(() => w.requests.some((r) => r.method === "worker.bg" && r.params.running === 0), "告知宿主后台命令已结束");
});

test("汇报经宿主连接提交", async (t) => {
	const w = await load("request");
	t.after(w.close);
	const result = await w.run("report", { status: "ready", summary: "好了" });
	assert.match(result.content[0].text, /recorded/);
	assert.deepEqual(w.requests.at(-1).params, { status: "ready", summary: "好了" });
	assert.equal(w.requests.at(-1).method, "worker.report");
});

test("推断任务的 Worker 只能调用只读工具和汇报类工具，其余一律拦截；请求任务不拦", async (t) => {
	const inference = await load("inference");
	const request = await load("request");
	t.after(() => { inference.close(); request.close(); });
	const call = (toolName: string) => ({ toolName, input: { command: "git -C . push", path: "x" } });
	for (const tool of ["bash", "write", "edit", "bg_start", "mcp__mail__send"]) {
		assert.equal((await inference.handlers.get("tool_call")(call(tool)))?.block, true, tool);
		assert.equal(await request.handlers.get("tool_call")(call(tool)), undefined, tool);
	}
	for (const tool of ["read", "grep", "report", "read_ticket", "web_get"]) assert.equal(await inference.handlers.get("tool_call")(call(tool)), undefined, tool);
});

test("角色写了工具：只放行角色的工具和汇报类工具，没写 bg_start 就不注册后台命令；推断任务派给带 bash 的角色仍拦 bash", async (t) => {
	const news = await load("request", "read,web_get");
	const inference = await load("inference", "read,bash");
	t.after(() => { news.close(); inference.close(); });
	const call = (toolName: string) => ({ toolName, input: {} });
	for (const tool of ["bash", "write", "grep", "mcp__mail__send"]) assert.equal((await news.handlers.get("tool_call")(call(tool)))?.block, true, tool);
	for (const tool of ["read", "web_get", "report", "hand_back", "read_ticket"]) assert.equal(await news.handlers.get("tool_call")(call(tool)), undefined, tool);
	assert.equal(news.tools.has("bg_start"), false);
	assert.equal((await inference.handlers.get("tool_call")(call("bash")))?.block, true);
	assert.equal(await inference.handlers.get("tool_call")(call("read")), undefined);
	assert.equal(process.env.PSA_ROLE_TOOLS, undefined);
});

test("角色写了 bg_start：请求任务注册后台命令；推断任务即使角色写了也不注册", async (t) => {
	const request = await load("request", "read,bg_start,bg_status");
	const inference = await load("inference", "read,bg_start");
	t.after(() => { request.close(); inference.close(); });
	assert.equal(request.tools.has("bg_start"), true);
	assert.equal(inference.tools.has("bg_start"), false);
});

test("每种依据的 Worker 都有 web_get，它只收一个网址并拒绝非公网地址", async (t) => {
	const inference = await load("inference");
	const request = await load("request");
	t.after(() => { inference.close(); request.close(); });
	for (const w of [inference, request]) {
		const tool = w.tools.get("web_get");
		assert.deepEqual(Object.keys(tool.parameters.properties), ["url"]);
		assert.match(tool.description, /数据/);
		await assert.rejects(w.run("web_get", { url: "http://127.0.0.1:9/" }), /公网/);
	}
});

test("扩展读完宿主连接信息后从环境变量里删掉，命令子进程继承不到", async (t) => {
	const w = await load("request");
	t.after(w.close);
	for (const name of ["PSA_SOCKET", "PSA_TOKEN", "PSA_TICKET", "PSA_BASIS"]) assert.equal(process.env[name], undefined, name);
});

test("每种依据（包括推断）都有 lookup：描述里列出宿主给的可查来源，调用经宿主连接发出", async (t) => {
	process.env.PSA_LOOKUPS = "us-market（美股行情）：quote { symbols }";
	const w = await load("inference");
	t.after(w.close);
	assert.match(w.tools.get("lookup").description, /us-market（美股行情）：quote/);
	assert.equal(process.env.PSA_LOOKUPS, undefined);
	await w.run("lookup", { source: "us-market", op: "quote", args: { symbols: ["NVDA"] } });
	assert.deepEqual([w.requests.at(-1).method, w.requests.at(-1).params], ["worker.lookup", { source: "us-market", op: "quote", args: { symbols: ["NVDA"] } }]);
	assert.equal(await w.handlers.get("tool_call")({ toolName: "lookup" }), undefined);
});

test("汇报工具接受问题的 2 到 4 个选项，经宿主连接原样提交", async (t) => {
	const w = await load("inference");
	t.after(w.close);
	const options = w.tools.get("report").parameters.properties.options;
	assert.deepEqual([options.minItems, options.maxItems, options.items.maxLength], [2, 4, 20]);
	await w.run("report", { status: "blocked", summary: "要你选", question: "选哪个？", options: ["甲", "乙"] });
	assert.deepEqual(w.requests.at(-1).params.options, ["甲", "乙"]);
});

test("牵头人的 Worker 有 consult：专家只能从名册里选，一次 1 到 4 个问题，经宿主连接提交，结果带给页面的明细", async (t) => {
	const lead = await load("inference", undefined, { PSA_EXPERTS: "market-analyst,news-researcher" });
	const plain = await load("request");
	t.after(() => { lead.close(); plain.close(); });
	assert.equal(plain.tools.has("consult"), false);
	const questions = lead.tools.get("consult").parameters.properties.questions;
	assert.deepEqual([questions.minItems, questions.maxItems], [1, 4]);
	assert.deepEqual(questions.items.properties.expert.enum, ["market-analyst", "news-researcher"]);
	assert.equal(await lead.handlers.get("tool_call")({ toolName: "consult" }), undefined, "推断任务也能会诊");
	const params = { questions: [{ expert: "market-analyst", question: "盘面？" }] };
	const result = await lead.run("consult", params);
	assert.deepEqual([lead.requests.at(-1).method, lead.requests.at(-1).params], ["worker.consult", params]);
	assert.equal(result.content[0].text, "行情分析师：放量下跌");
	assert.equal(result.details.kind, "consult");
	assert.equal(process.env.PSA_EXPERTS, undefined);
});

test("被会诊的专家只有只读工具：不注册汇报、交回、会诊和后台命令，其余工具一律拦截", async (t) => {
	const expert = await load("request", "read,web_get,lookup", { PSA_EXPERT: "1" });
	t.after(expert.close);
	for (const tool of ["report", "hand_back", "read_ticket", "consult", "bg_start"]) assert.equal(expert.tools.has(tool), false, tool);
	const call = (toolName: string) => expert.handlers.get("tool_call")({ toolName, input: {} });
	for (const tool of ["bash", "write", "edit", "report", "consult", "grep"]) assert.equal((await call(tool))?.block, true, tool);
	for (const tool of ["read", "web_get", "lookup"]) assert.equal(await call(tool), undefined, tool);
	assert.equal(process.env.PSA_EXPERT, undefined);
});
