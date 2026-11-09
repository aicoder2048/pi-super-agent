import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { onJsonLines, writeJsonLine } from "../src/jsonl.ts";
import { until } from "./helpers/fakes.ts";

async function load(basis: string) {
	const dir = mkdtempSync(join(tmpdir(), "psa-wext-"));
	const socketPath = join(dir, "host.sock");
	const requests: any[] = [];
	const sockets = new Set<import("node:net").Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		onJsonLines(socket, (r: any) => {
			if (r.type !== "request") return;
			requests.push(r);
			writeJsonLine(socket, { id: r.id, ok: true, result: { recorded: true } });
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	Object.assign(process.env, { PSA_SOCKET: socketPath, PSA_TICKET: "tkt_1", PSA_TOKEN: "tok", PSA_BASIS: basis });
	const { default: workerExtension } = await import(`../src/worker/extension.ts?basis=${basis}`);
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
	for (const tool of ["read", "grep", "report", "read_ticket"]) assert.equal(await inference.handlers.get("tool_call")(call(tool)), undefined, tool);
});

test("扩展读完宿主连接信息后从环境变量里删掉，命令子进程继承不到", async (t) => {
	const w = await load("request");
	t.after(w.close);
	for (const name of ["PSA_SOCKET", "PSA_TOKEN", "PSA_TICKET", "PSA_BASIS"]) assert.equal(process.env[name], undefined, name);
});
