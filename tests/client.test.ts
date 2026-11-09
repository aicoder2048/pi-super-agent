import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import superAgentClient from "../extensions/super-agent.ts";
import { onJsonLines, writeJsonLine } from "../src/jsonl.ts";
import { renderBoard, shortId } from "../src/client/board.ts";
import { HostConnection } from "../src/client/connection.ts";
import type { HostToClient } from "../src/client/protocol.ts";
import { formatTranscriptMessage } from "../src/client/transcript.ts";
import { Host } from "../src/host/host.ts";
import type { DashboardRow } from "../src/kernel/types.ts";
import { defaultWorkerModels, FakeSpawner, fauxRouter, ofType, openOnConversation, tempStateDir, until, type Brain } from "./helpers/fakes.ts";

const brain: Brain = (cards) => cards.flatMap((c) => (c.startsWith("[对话]") ? openOnConversation(c) : []));

async function hostAt(stateDir: string) {
	const spawner = new FakeSpawner((w) => {
		w.report({ status: "progress", summary: "处理中" });
		w.settle();
	});
	const host = await Host.start({ stateDir, createRouter: fauxRouter(brain).createRouter, createSpawner: () => spawner, log: () => {}, workerModels: defaultWorkerModels() });
	spawner.request = (...a) => host.workers.handleRequest(...a);
	return host;
}

function client(socketPath: string) {
	const got: HostToClient[] = [];
	const conn = new HostConnection({ socketPath, onMessage: (m) => got.push(m), retryMs: 30 });
	conn.open();
	return { conn, got, of: <T extends HostToClient["type"]>(type: T) => ofType(got, type) };
}

test("协议：连上即收到快照；说一句话后收到回显、回复和看板", async (t) => {
	const host = await hostAt(tempStateDir());
	const c = client(host.socketPath);
	t.after(async () => { c.conn.close(); await host.stop(); });
	await until(() => c.of("snapshot").length === 1, "快照");
	assert.deepEqual(c.of("snapshot")[0].conversation, []);
	assert.ok(c.conn.say("查天气"));
	await until(() => c.of("reply").length === 1 && c.of("board").some((b) => b.rows.length === 1), "回复和看板");
	assert.equal(c.of("user")[0].text, "查天气");
	assert.equal(c.of("reply")[0].text, "收到：查天气");
	const row = c.of("board").at(-1)!.rows[0];
	for (const key of ["title", "stage", "basis", "latestSummary", "model", "fellBack", "toolCalls", "tokensIn", "tokensOut", "elapsedMs"]) assert.ok(key in row, key);
	assert.doesNotMatch(JSON.stringify(c.got), /\x1b\[/);
});

test("协议：宿主重启后客户端自动重连，快照里有之前的对话和任务", async (t) => {
	const stateDir = tempStateDir();
	let host = await hostAt(stateDir);
	const c = client(host.socketPath);
	t.after(async () => { c.conn.close(); await host.stop(); });
	await until(() => c.conn.connected, "首次连接");
	c.conn.say("写周报");
	await until(() => c.of("reply").length === 1, "回复");
	await host.stop();
	await until(() => !c.conn.connected, "断开");
	host = await hostAt(stateDir);
	await until(() => c.of("snapshot").length === 2, "重连快照");
	const snap = c.of("snapshot")[1];
	assert.deepEqual(snap.conversation.map((l) => l.text), ["写周报", "收到：写周报"]);
	assert.equal(snap.board[0].title, "写周报");
});

test("协议：只读查看某个任务时收到它的过程，看不到别的任务", async (t) => {
	const host = await hostAt(tempStateDir());
	const c = client(host.socketPath);
	t.after(async () => { c.conn.close(); await host.stop(); });
	await until(() => c.conn.connected, "连接");
	c.conn.say("任务一");
	await until(() => host.kernel.listTickets().length === 1, "任务");
	const id = host.kernel.listTickets()[0].id;
	c.conn.watch(id);
	await until(() => c.of("transcript_history").length === 1, "过程历史");
	(host as any).server.sendTranscript(id, { role: "assistant", content: [{ type: "text", text: "看过了" }] });
	(host as any).server.sendTranscript("tkt_other", { role: "assistant", content: [{ type: "text", text: "别人的" }] });
	await until(() => c.of("transcript").length === 1, "实时过程");
	assert.equal(c.of("transcript")[0].ticketId, id);
});

function scriptedHost() {
	const path = join(tempStateDir(), "fake-host.sock");
	const sockets: Socket[] = [];
	const fromClient: Record<string, any>[] = [];
	let onHello: (socket: Socket) => void = () => {};
	let onSay: (socket: Socket, record: Record<string, any>) => void = () => {};
	const server = createServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => {});
		onJsonLines(socket, (r) => {
			const record = r as Record<string, any>;
			fromClient.push(record);
			if (record.type === "hello") onHello(socket);
			if (record.type === "say") onSay(socket, record);
		});
	});
	return {
		path,
		fromClient,
		hello(fn: typeof onHello) { onHello = fn; },
		onSay(fn: typeof onSay) { onSay = fn; },
		listen: () => new Promise<void>((resolve) => server.listen(path, resolve)),
		dropClients() { for (const s of sockets.splice(0)) s.destroy(); },
		close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
	};
}

async function runExtension(socketPath: string) {
	process.env.PSA_SOCKET = socketPath;
	const shown: string[] = [];
	const warnings: string[] = [];
	const handlers: Record<string, Function> = {};
	const ui = { setWidget() {}, notify: (text: string, level: string) => { if (level === "warning") warnings.push(text); } };
	superAgentClient({
		sendMessage: (m: any) => shown.push(String(m.content)),
		registerMessageRenderer() {},
		registerCommand() {},
		on: (name: string, fn: Function) => (handlers[name] = fn),
	} as any);
	await handlers.session_start({}, { ui });
	return {
		shown,
		warnings,
		input: (text: string) => handlers.input({ text, source: "interactive" }, { ui }),
		shutdown: () => handlers.session_shutdown(),
	};
}

test("客户端：同一毫秒到达的多条对话都显示，同一个 id 只显示一次，重连快照只补没见过的行", async (t) => {
	const host = scriptedHost();
	host.hello((s) => {
		writeJsonLine(s, { type: "snapshot", conversation: [], board: [] });
		writeJsonLine(s, { type: "user", id: "trg_1", text: "问", at: 5 });
		writeJsonLine(s, { type: "reply", replyId: "rpl_1", text: "答一", at: 5 });
		writeJsonLine(s, { type: "reply", replyId: "rpl_2", text: "答二", at: 5 });
		writeJsonLine(s, { type: "reply", replyId: "rpl_1", text: "答一", at: 5 });
	});
	await host.listen();
	const ext = await runExtension(host.path);
	t.after(async () => { await ext.shutdown(); await host.close(); });
	await until(() => ext.shown.length >= 3, "三行对话");
	host.hello((s) => writeJsonLine(s, { type: "snapshot", board: [], conversation: [
		{ id: "trg_1", who: "user", text: "问", at: 5 },
		{ id: "rpl_1", who: "router", text: "答一", at: 5 },
		{ id: "rpl_2", who: "router", text: "答二", at: 5 },
		{ id: "rpl_3", who: "router", text: "答三", at: 5 },
	] }));
	host.dropClients();
	await until(() => ext.shown.some((l) => l.includes("答三")), "重连后补上答三", 5000);
	await new Promise((r) => setTimeout(r, 100));
	assert.deepEqual(ext.shown, ["你> 问", "Router> 答一", "Router> 答二", "Router> 答三"]);
});

test("客户端：说的话带请求 id，宿主回 ack 并附上触发 id，和回显的用户行 id 一致", async (t) => {
	const host = await hostAt(tempStateDir());
	const c = client(host.socketPath);
	t.after(async () => { c.conn.close(); await host.stop(); });
	await until(() => c.conn.connected, "连接");
	const requestId = c.conn.say("查快递");
	assert.equal(typeof requestId, "string");
	await until(() => c.of("ack").length === 1 && c.of("user").length === 1, "ack 和回显");
	const [ack] = c.of("ack");
	assert.equal(ack.requestId, requestId);
	assert.match(ack.triggerId, /^trg_/);
	assert.equal(c.of("user")[0].id, ack.triggerId);
});

test("客户端：宿主收下但不回 ack（卡住了）时提醒使用者这句话可能没送达；回了 ack 就不提醒", async (t) => {
	process.env.PSA_ACK_TIMEOUT_MS = "200";
	const host = scriptedHost();
	host.hello((s) => writeJsonLine(s, { type: "snapshot", conversation: [], board: [] }));
	await host.listen();
	const ext = await runExtension(host.path);
	t.after(async () => { delete process.env.PSA_ACK_TIMEOUT_MS; await ext.shutdown(); await host.close(); });
	await until(() => host.fromClient.some((r) => r.type === "hello"), "连接");
	await ext.input("明早九点前整理报税材料");
	await until(() => ext.warnings.length === 1, "没收到 ack 的提醒");
	assert.match(ext.warnings[0], /明早九点前整理报税材料/);
	const say = host.fromClient.find((r) => r.type === "say")!;
	assert.equal(typeof say.requestId, "string");
	host.onSay((s, r) => writeJsonLine(s, { type: "ack", requestId: r.requestId, triggerId: "trg_2" }));
	await ext.input("第二句");
	await until(() => host.fromClient.filter((r) => r.type === "say").length === 2, "第二句送到");
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(ext.warnings.length, 1);
});

const row = (over: Partial<DashboardRow>): DashboardRow => ({
	id: "tkt_3f2a9c", title: "整理本周的会议纪要并发给团队", stage: "running", basis: "request",
	latestSummary: "已经读完五份纪要，正在合并重复的行动项，预计还要两分钟", model: "openai-codex/gpt-6.1-sol",
	fellBack: false, toolCalls: 12, tokensIn: 3200, tokensOut: 800, elapsedMs: 312_000, ...over,
});

test("看板：任意终端宽度下每行都不超宽（含中文双宽字符）", () => {
	const view = {
		rows: [row({}), row({ id: "tkt_b1", stage: "awaiting_answer", basis: "inference", fellBack: true, model: "deepseek/deepseek-flash" }),
			row({ id: "tkt_c1", stage: "closed" }), row({ id: "tkt_d1", stage: "closed" }), row({ id: "tkt_e1", stage: "closed" })],
		receivedAt: 0, connected: true,
	};
	for (const width of [1, 10, 20, 30, 40, 60, 80, 100, 160]) {
		for (const line of renderBoard(view, width, 5000)) assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
	}
});

test("看板：卡片带齐标题、阶段、依据、最近汇报、模型、工具次数、token 和时长", () => {
	const lines = renderBoard({ rows: [row({ fellBack: true })], receivedAt: 0, connected: true }, 120, 10_000).join("\n");
	for (const part of ["3f2a", "整理本周", "执行中", "请求", "已经读完", "gpt-6.1-sol（已回退）", "工具 12", "4.0k tok", "5分22秒"]) {
		assert.ok(lines.includes(part), part);
	}
	assert.equal(shortId("tkt_3f2a9c"), "3f2a");
});

test("看板：已结束的任务只显示最近两个，其余折叠成一行", () => {
	const rows = ["a", "b", "c", "d"].map((id) => row({ id: `tkt_${id}`, stage: "closed" }));
	const text = renderBoard({ rows, receivedAt: 0, connected: false }, 100, 0).join("\n");
	assert.match(text, /另有 2 个已结束的任务/);
	assert.match(text, /未连接/);
});

test("看板：按创建先后排列的行里，显示最后创建的两个已结束任务", () => {
	const rows = ["一号旧任务", "二号旧任务", "三号新任务", "四号新任务"].map((title, i) => row({ id: `tkt_${i}`, title, stage: "closed" }));
	const text = renderBoard({ rows, receivedAt: 0, connected: true }, 100, 0).join("\n");
	assert.match(text, /三号新任务/);
	assert.match(text, /四号新任务/);
	assert.doesNotMatch(text, /一号旧任务|二号旧任务/);
});

test("过程格式：Worker 文字、工具调用和截断的工具结果", () => {
	assert.deepEqual(formatTranscriptMessage({ role: "assistant", content: [{ type: "text", text: "先看目录" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] }),
		["【Worker】先看目录", '【工具】bash {"command":"ls"}']);
	const [result] = formatTranscriptMessage({ role: "toolResult", content: [{ type: "text", text: "x".repeat(1000) }] });
	assert.ok([...result].length < 450);
	assert.deepEqual(formatTranscriptMessage({ role: "system", content: "s" }), []);
});
