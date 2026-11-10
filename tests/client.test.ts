import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import superAgentClient from "../extensions/super-agent.ts";
import { onJsonLines, writeJsonLine } from "../src/jsonl.ts";
import { openChoices, openQuestions, renderBoard, shortId } from "../src/client/board.ts";
import { HostConnection } from "../src/client/connection.ts";
import type { HostToClient, MemberCapBoard } from "../src/client/protocol.ts";
import { formatTranscriptMessage } from "../src/client/transcript.ts";
import { Host } from "../src/host/host.ts";
import type { DashboardRow } from "../src/kernel/types.ts";
import { defaultWorkerModels, FakeSpawner, fauxRouter, ofType, openOnConversation, startHost, tempStateDir, until, type Brain } from "./helpers/fakes.ts";

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

test("协议：开始查看时，紧跟历史的第一条实时消息若和历史最后一条相同只收到一次", async (t) => {
	const stateDir = tempStateDir();
	const { host, spawner } = await startHost(brain, () => {}, { stateDir });
	const c = client(host.socketPath);
	t.after(async () => { c.conn.close(); await host.stop(); });
	await until(() => c.conn.connected, "连接");
	host.say("读网页");
	await until(() => host.kernel.listTickets().length === 1 && spawner.workers.size === 1, "Worker 起来");
	const id = host.kernel.listTickets()[0].id;
	const last = { role: "assistant", content: [{ type: "text", text: "先看看" }] };
	const next = { role: "assistant", content: [{ type: "text", text: "找到了" }] };
	const dir = join(stateDir, "sessions", "workers");
	mkdirSync(dir, { recursive: true });
	const session = host.kernel.getTicket(id)!.workerSessionId;
	writeFileSync(join(dir, `2026-11-08T00-00-00_${session}.jsonl`), [{ type: "session", id: session }, { type: "message", message: last }].map((e) => JSON.stringify(e)).join("\n") + "\n");
	c.conn.watch(id);
	await until(() => c.of("transcript_history").length === 1, "过程历史");
	spawner.workers.get(id)!.transcript(last);
	spawner.workers.get(id)!.transcript(next);
	spawner.workers.get(id)!.transcript(last);
	await until(() => c.of("transcript").length >= 2, "实时过程");
	assert.deepEqual(c.of("transcript").map((m) => m.message), [next, last]);
});

test("协议：会话文件最后一行写到一半时，查看任务收到完整的行，宿主照常服务", async (t) => {
	const stateDir = tempStateDir();
	const { host, spawner } = await startHost(brain, () => {}, { stateDir });
	const c = client(host.socketPath);
	t.after(async () => { c.conn.close(); await host.stop(); });
	await until(() => c.conn.connected, "连接");
	host.say("读网页");
	await until(() => host.kernel.listTickets().length === 1 && spawner.workers.size === 1, "Worker 起来");
	const id = host.kernel.listTickets()[0].id;
	const good = { role: "assistant", content: [{ type: "text", text: "先看看" }] };
	const dir = join(stateDir, "sessions", "workers");
	mkdirSync(dir, { recursive: true });
	const session = host.kernel.getTicket(id)!.workerSessionId;
	const lines = [{ type: "session", id: session }, { type: "message", message: good }].map((e) => JSON.stringify(e)).join("\n");
	writeFileSync(join(dir, `2026-11-08T00-00-00_${session}.jsonl`), `${lines}\n{"type":"message","message":{"role":"assi`);
	c.conn.watch(id);
	await until(() => c.of("transcript_history").length === 1, "过程历史");
	assert.deepEqual(c.of("transcript_history")[0].messages, [good]);
	assert.ok(c.conn.say("还在吗"));
	await until(() => c.of("user").some((m) => m.text === "还在吗"), "宿主还活着");
});

test("协议：会话文件读不了时，查看任务收到空的过程历史并记一行日志，宿主照常服务", async (t) => {
	const stateDir = tempStateDir();
	const logs: string[] = [];
	const { host, spawner } = await startHost(brain, () => {}, { stateDir, log: (line) => logs.push(line) });
	const c = client(host.socketPath);
	t.after(async () => { c.conn.close(); await host.stop(); });
	await until(() => c.conn.connected, "连接");
	host.say("读网页");
	await until(() => host.kernel.listTickets().length === 1 && spawner.workers.size === 1, "Worker 起来");
	const id = host.kernel.listTickets()[0].id;
	const session = host.kernel.getTicket(id)!.workerSessionId;
	mkdirSync(join(stateDir, "sessions", "workers", `2026-11-08T00-00-00_${session}.jsonl`), { recursive: true });
	c.conn.watch(id);
	await until(() => c.of("transcript_history").length === 1, "过程历史");
	assert.deepEqual(c.of("transcript_history")[0], { type: "transcript_history", ticketId: id, messages: [] });
	assert.equal(logs.filter((l) => l.includes("watch") && l.includes("EISDIR")).length, 1);
	assert.ok(c.conn.say("还在吗"));
	await until(() => c.of("user").some((m) => m.text === "还在吗"), "宿主还活着");
	const fresh = client(host.socketPath);
	t.after(() => fresh.conn.close());
	await until(() => fresh.of("snapshot").length === 1, "新客户端拿到快照");
});

function rawLines(socketPath: string, lines: string[]): Promise<void> {
	return new Promise((resolve) => {
		const socket = connect(socketPath);
		socket.on("error", () => {});
		socket.resume();
		socket.on("close", () => resolve());
		socket.on("connect", () => socket.write(lines.map((l) => l + "\n").join("")));
	});
}

test("协议：客户端发来合法 JSON 但不是对象（null、数字、字符串、数组）时只断开它，宿主照常服务", async (t) => {
	const host = await hostAt(tempStateDir());
	t.after(() => host.stop());
	const hellos = { first: [], client: [JSON.stringify({ type: "hello", role: "client", token: readFileSync(join(dirname(host.socketPath), "client-token"), "utf8").trim() })], worker: ['{"type":"hello","role":"worker","ticketId":"x","token":"y"}'] };
	for (const [where, before] of Object.entries(hellos)) {
		for (const value of ["null", "42", '"x"', "[]"]) {
			await rawLines(host.socketPath, [...before, value]);
			const fresh = client(host.socketPath);
			await until(() => fresh.of("snapshot").length === 1, `${where} 之后发 ${value}，新客户端拿到快照`);
			fresh.conn.close();
		}
	}
});

test("协议：只有零宽字符的一句话不进对话", async (t) => {
	const host = await hostAt(tempStateDir());
	const c = client(host.socketPath);
	t.after(async () => { c.conn.close(); await host.stop(); });
	await until(() => c.conn.connected, "连接");
	c.conn.say("\u200b\ufeff");
	c.conn.say("真的一句");
	await until(() => c.of("user").length >= 1, "回显");
	assert.deepEqual(c.of("user").map((m) => m.text), ["真的一句"]);
});

function scriptedHost() {
	const path = join(tempStateDir(), "fake-host.sock");
	writeFileSync(join(dirname(path), "client-token"), "ab".repeat(32));
	const sockets: Socket[] = [];
	const fromClient: Record<string, any>[] = [];
	let onHello: (socket: Socket) => void = () => {};
	let onSay: (socket: Socket, record: Record<string, any>) => void = () => {};
	let onAnswer: (socket: Socket, record: Record<string, any>) => void = () => {};
	const server = createServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => {});
		onJsonLines(socket, (r) => {
			const record = r as Record<string, any>;
			fromClient.push(record);
			if (record.type === "hello") onHello(socket);
			if (record.type === "say") onSay(socket, record);
			if (record.type === "answer") onAnswer(socket, record);
		});
	});
	return {
		path,
		fromClient,
		hello(fn: typeof onHello) { onHello = fn; },
		onSay(fn: typeof onSay) { onSay = fn; },
		onAnswer(fn: typeof onAnswer) { onAnswer = fn; },
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
	const commands: Record<string, { handler: Function }> = {};
	const ui = { setWidget() {}, notify: (text: string, level: string) => { if (level === "warning") warnings.push(text); } };
	superAgentClient({
		sendMessage: (m: any) => shown.push(String(m.content)),
		registerMessageRenderer() {},
		registerCommand: (name: string, command: { handler: Function }) => (commands[name] = command),
		on: (name: string, fn: Function) => (handlers[name] = fn),
	} as any);
	await handlers.session_start({}, { ui });
	return {
		shown,
		warnings,
		input: (text: string) => handlers.input({ text, source: "interactive" }, { ui }),
		command: (name: string, args: string) => commands[name].handler(args, { ui }),
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

test("TUI：状态目录里没有 client-token 时提醒一次先启动宿主，不发 hello", async (t) => {
	const host = scriptedHost();
	rmSync(join(dirname(host.path), "client-token"));
	await host.listen();
	const ext = await runExtension(host.path);
	t.after(async () => { await ext.shutdown(); await host.close(); });
	await until(() => ext.warnings.length === 1, "提醒");
	assert.match(ext.warnings[0], /client-token.*just host/);
	assert.deepEqual(host.fromClient, []);
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
	fellBack: false, toolCalls: 12, tokensIn: 3200, tokensOut: 800, elapsedMs: 312_000, question: null, stall: null, lastProgressAt: null,
	helper: { name: "听松", role: "market", seq: 2 }, workerState: "running", startedAt: 0, endedAt: null, ...over,
});

const asking = (id: string, reportId: string, over: Partial<NonNullable<DashboardRow["question"]>> = {}) =>
	row({ id, title: `任务${id}`, stage: "awaiting_answer", question: { reportId, text: "要看哪部分？", options: ["只看营收", "营收和利润", "先不查"], askedAt: 0, click: null, spoke: false, ...over } });

test("看板：等回答的任务列出问题和编号选项，底部提示怎么作答；点过的按转交进度写明；久无进展的任务标出分钟数", () => {
	const click = (option: number, state: "sent" | "handed_over" | "dropped") => ({ click: { option, state, triggerId: "trg_1" } });
	const rows = [asking("tkt_ab12", "rpt_1"), asking("tkt_cd34", "rpt_2", click(1, "handed_over")), asking("tkt_gh78", "rpt_3", click(2, "sent")), asking("tkt_ij90", "rpt_4", click(0, "dropped")), row({ id: "tkt_ef56", stall: { since: 0, minutes: 42 } })];
	const text = renderBoard({ rows, receivedAt: 0, connected: true }, 120, 42 * 60_000).join("\n");
	assert.match(text, /问题：要看哪部分？\n\s+1\. 只看营收   2\. 营收和利润   3\. 先不查/);
	assert.match(text, /已回答：营收和利润/);
	assert.match(text, /已选「先不查」，等待幕僚长转交/);
	assert.match(text, /幕僚长没有转交上次的选择，可以重选/);
	assert.deepEqual(openChoices(rows).map((r) => r.id), ["tkt_ab12", "tkt_ij90"]);
	assert.deepEqual(openChoices([asking("tkt_kl12", "rpt_5", { spoke: true })]), [], "刚打过字的问题不接数字");
	assert.match(renderBoard({ rows: [asking("tkt_kl12", "rpt_5", { spoke: true })], receivedAt: 0, connected: true }, 120, 0).join("\n"), /你刚发了一句话，等幕僚长处理完再选/);
	assert.match(text, /久无进展 42 分钟/);
	assert.match(text, /回复数字作答；多个问题等回答时用 \/answer <编号> <序号>/);
});

async function answeringClient(rows: DashboardRow[], memberCap?: MemberCapBoard) {
	const host = scriptedHost();
	host.hello((s) => writeJsonLine(s, { type: "snapshot", conversation: [], board: rows, memberCap }));
	await host.listen();
	const ext = await runExtension(host.path);
	await until(() => host.fromClient.some((r) => r.type === "hello"), "连接");
	await new Promise((r) => setTimeout(r, 50));
	const sent = () => host.fromClient.filter((r) => r.type === "answer" || r.type === "say").map((r) => (r.type === "answer" ? [r.type, r.reportId, r.option] : [r.type, r.text]));
	return { host, ext, sent };
}

test("客户端：只有一个问题等回答时，回复一个数字就选那一项；数字超出选项数时提醒，不发出", async (t) => {
	const { host, ext, sent } = await answeringClient([asking("tkt_ab12", "rpt_1"), asking("tkt_cd34", "rpt_2", { click: { option: 0, state: "sent", triggerId: "trg_1" } })]);
	t.after(async () => { await ext.shutdown(); await host.close(); });
	await ext.input("2");
	await ext.input("4");
	await until(() => sent().length === 1, "发出回答");
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(sent(), [["answer", "rpt_1", 1]]);
	assert.match(ext.warnings.join("\n"), /只有 3 个选项/);
});

test("客户端：多个问题等回答时数字不猜，提示用 /answer <编号> <序号>；/answer 按编号作答；没有问题时数字照常当一句话发", async (t) => {
	const { host, ext, sent } = await answeringClient([asking("tkt_ab12", "rpt_1"), asking("tkt_cd34", "rpt_2")]);
	t.after(async () => { await ext.shutdown(); await host.close(); });
	await ext.input("1");
	assert.match(ext.warnings.at(-1)!, /\/answer <编号> <序号>/);
	await ext.command("answer", "cd34 3");
	await until(() => sent().length === 1, "按编号发出");
	assert.deepEqual(sent(), [["answer", "rpt_2", 2]]);
	const quiet = await answeringClient([row({})]);
	t.after(async () => { await quiet.ext.shutdown(); await quiet.host.close(); });
	await quiet.ext.input("1");
	await until(() => quiet.sent().length === 1, "当一句话发");
	assert.deepEqual(quiet.sent(), [["say", "1"]]);
});

test("客户端：/answer 和 /watch 的编号写几位都行，只要能唯一认出任务", async (t) => {
	const { host, ext, sent } = await answeringClient([asking("tkt_cd34ef56", "rpt_1"), asking("tkt_cd99aa00", "rpt_2")]);
	t.after(async () => { await ext.shutdown(); await host.close(); });
	await ext.command("answer", "cd34ef 2");
	await until(() => sent().length === 1, "六位编号作答");
	assert.deepEqual(sent(), [["answer", "rpt_1", 1]]);
	await ext.command("watch", "cd99aa0");
	await until(() => host.fromClient.some((r) => r.type === "watch"), "七位编号查看");
	assert.equal(host.fromClient.find((r) => r.type === "watch")!.ticketId, "tkt_cd99aa00");
	await ext.command("answer", "cd 1");
	assert.match(ext.warnings.at(-1)!, /对应多个问题/);
});

test("客户端：宿主拒绝回答（问题已回答或已过期）时提醒使用者原因", async (t) => {
	const { host, ext } = await answeringClient([asking("tkt_ab12", "rpt_1")]);
	t.after(async () => { await ext.shutdown(); await host.close(); });
	host.onAnswer((s, r) => writeJsonLine(s, { type: "refused", requestId: r.requestId, reason: "这个问题已经回答过，或已不在等待回答" }));
	await ext.input("1");
	await until(() => ext.warnings.some((w) => w.includes("已经回答过")), "提醒原因");
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

test("看板：团队任务的卡片写四字名和团队名，和页面同一种写法", () => {
	const lines = renderBoard({ rows: [row({ helper: { name: "高山流水", team: "看盘队", seq: 2 } })], receivedAt: 0, connected: true }, 120, 10_000).join("\n");
	assert.ok(lines.includes("高山流水 · 看盘队 #2 · gpt-6.1-sol"), lines);
});

test("看板：卡片带齐标题、阶段、依据、最近汇报、模型、工具次数、token 和时长", () => {
	const lines = renderBoard({ rows: [row({ fellBack: true })], receivedAt: 0, connected: true }, 120, 10_000).join("\n");
	for (const part of ["3f2a", "整理本周", "执行中", "请求", "已经读完", "听松 · 行情助手 #2", "gpt-6.1-sol（已回退）", "工具 12", "4.0k tok", "5分22秒"]) {
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

test("看板：宿主关于成员上限的问题列在最前面，编号是 cap，带编号选项；和任务的问题一起算等回答的问题", () => {
	const memberCap = { limit: 4, question: { reportId: "ask_cap_2026-11-09", text: "现在有 2 位成员在排队，同时运行的成员上限是 4。今天放宽到 10 吗？", options: ["今天放宽到 10", "保持 4"], askedAt: 0 } };
	const lines = renderBoard({ rows: [], memberCap, receivedAt: 0, connected: true }, 120, 0);
	assert.match(lines.join("\n"), /cap 成员上限\s+等你回答\n\s+问题：现在有 2 位成员在排队，同时运行的成员上限是 4。今天放宽到 10 吗？\n\s+1\. 今天放宽到 10   2\. 保持 4\n\s+回复数字作答/);
	assert.deepEqual(openQuestions({ rows: [], memberCap }), [{ id: "cap", title: "成员上限", reportId: "ask_cap_2026-11-09", options: ["今天放宽到 10", "保持 4"] }]);
	const both = openQuestions({ rows: [asking("tkt_ab12", "rpt_1")], memberCap });
	assert.deepEqual(both.map((q) => [q.id, q.reportId]), [["cap", "ask_cap_2026-11-09"], ["tkt_ab12", "rpt_1"]]);
	assert.deepEqual(openQuestions({ rows: [asking("tkt_ab12", "rpt_1")], memberCap: { limit: 10, question: null } }).map((q) => q.id), ["tkt_ab12"]);
	assert.deepEqual(openQuestions({ rows: [asking("tkt_ab12", "rpt_1")] }).map((q) => q.title), ["任务tkt_ab12"], "老宿主的帧没有成员上限");
	assert.doesNotMatch(renderBoard({ rows: [], memberCap: { limit: 10, question: null }, receivedAt: 0, connected: true }, 120, 0).join("\n"), /成员上限/);
	for (const width of [20, 40]) for (const line of renderBoard({ rows: [], memberCap, receivedAt: 0, connected: true }, width, 0)) assert.ok(visibleWidth(line) <= width, line);
});

const CAP_ASKING: MemberCapBoard = { limit: 4, question: { reportId: "ask_cap_2026-11-09", text: "现在有 2 位成员在排队，同时运行的成员上限是 4。今天放宽到 10 吗？", options: ["今天放宽到 10", "保持 4"], askedAt: 0 } };

test("客户端：只有成员上限的问题在等时，回复数字就答它；数字超出两项时提醒；看板帧里问题没了，数字又当一句话发", async (t) => {
	const { host, ext, sent } = await answeringClient([], CAP_ASKING);
	t.after(async () => { await ext.shutdown(); await host.close(); });
	await ext.input("3");
	assert.match(ext.warnings.at(-1)!, /「成员上限」只有 2 个选项/);
	await ext.input("1");
	await until(() => sent().length === 1, "发出回答");
	assert.deepEqual(sent(), [["answer", "ask_cap_2026-11-09", 0]]);
	host.dropClients();
	host.hello((s) => {
		writeJsonLine(s, { type: "snapshot", conversation: [], board: [], memberCap: CAP_ASKING });
		writeJsonLine(s, { type: "board", rows: [], memberCap: { limit: 10, question: null } });
	});
	await until(() => host.fromClient.filter((r) => r.type === "hello").length === 2, "重连", 5000);
	await new Promise((r) => setTimeout(r, 50));
	await ext.input("1");
	await until(() => sent().length === 2, "当一句话发");
	assert.deepEqual(sent()[1], ["say", "1"]);
});

test("客户端：成员上限的问题和任务的问题同时在等时数字不猜；/answer cap <序号> 答成员上限", async (t) => {
	const { host, ext, sent } = await answeringClient([asking("tkt_ab12", "rpt_1")], CAP_ASKING);
	t.after(async () => { await ext.shutdown(); await host.close(); });
	await ext.input("1");
	assert.match(ext.warnings.at(-1)!, /有 2 个问题在等回答，请用 \/answer <编号> <序号>，例如 \/answer cap 1/);
	await ext.command("answer", "cap 2");
	await ext.command("answer", "ab 1");
	await until(() => sent().length === 2, "两个都发出");
	assert.deepEqual(sent(), [["answer", "ask_cap_2026-11-09", 1], ["answer", "rpt_1", 0]]);
});
