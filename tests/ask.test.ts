import assert from "node:assert/strict";
import test from "node:test";
import { HostConnection } from "../src/client/connection.ts";
import type { HostToClient } from "../src/client/protocol.ts";
import { ids, ofType, openOnConversation, startHost, until, type Brain } from "./helpers/fakes.ts";

const openOnly: Brain = (cards) => cards.flatMap((card) => (card.startsWith("[对话]") ? openOnConversation(card) : []));

test("Worker 汇报的选项不合规时工具报错，说清规则，这份汇报不记录", async (t) => {
	const errors: string[] = [];
	const bad: Record<string, unknown>[] = [
		{ options: ["只有一个"] },
		{ options: ["一", "二", "三", "四", "五"] },
		{ options: ["好", "好"] },
		{ options: ["好", "这个选项写得太长了超过了二十个字的上限啊啊"] },
		{ options: ["好", " "] },
		{ options: ["好", 3] },
		{ options: "好,不好" },
	];
	const { host } = await startHost(openOnly, (w) => {
		for (const over of bad) {
			try {
				w.report({ status: "blocked", summary: "要你选", question: "选哪个？", ...over });
			} catch (error) {
				errors.push((error as Error).message);
			}
		}
		try {
			w.report({ status: "progress", summary: "没问题却给了选项", options: ["甲", "乙"] });
		} catch (error) {
			errors.push((error as Error).message);
		}
		w.report({ status: "blocked", summary: "要你选", question: "选哪个？", options: [" 甲 ", "乙"] });
		w.settle();
	});
	t.after(() => host.stop());
	host.say("帮我选");
	await until(() => host.kernel.listTickets()[0]?.stage === "awaiting_answer", "合规的提问被记下");
	assert.equal(errors.length, bad.length + 1, JSON.stringify(errors));
	for (const message of errors.slice(0, 2)) assert.match(message, /2 到 4 个/);
	assert.match(errors[2], /重复/);
	assert.match(errors[3], /20 个字/);
	assert.match(errors[4], /空/);
	assert.match(errors[5], /文字/);
	assert.match(errors[6], /列表/);
	assert.match(errors[7], /question/);
	const found = host.kernel.read(host.kernel.listTickets()[0].id);
	assert.ok(found?.type === "ticket");
	assert.deepEqual(found.recentReports.map((r) => r.options), [["甲", "乙"]], "只有合规的一份汇报，选项去掉首尾空白");
});

const OPTIONS = ["只看营收", "营收和利润", "先不查"];

// A Router that relays questions about the task and hands a clicked answer to the ticket named on its card.
const relayAndHandOver: Brain = (cards) =>
	cards.flatMap((card) => {
		const clicked = card.split("\n").find((l) => l.startsWith("点选回答："));
		if (card.startsWith("[对话]") && clicked) {
			return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: ids(card, "trg"), ticketId: ids(clicked, "tkt") }] } }];
		}
		if (card.startsWith("[对话]")) return openOnConversation(card);
		if (card.startsWith("[Worker 提问]")) return [{ name: "reply", args: { text: "要看财报的哪部分？", cause: ids(card, "tkt") } }];
		return [];
	});

async function askingHost() {
	const started = await startHost(relayAndHandOver, (w, input) => {
		if (input.includes("回答任务")) {
			w.report({ status: "ready", summary: `收到：${input.split("\n").at(-1)}` });
		} else {
			w.report({ status: "blocked", summary: "财报有两种口径", question: "要看哪部分？", options: OPTIONS });
		}
		w.settle();
	});
	started.host.say("查财报");
	await until(() => started.said().includes("要看财报的哪部分？"), "问题转达到对话");
	const row = started.host.kernel.listTickets()[0];
	return { ...started, row };
}

test("Router 收到的 [Worker 提问] 卡片列出编号选项", async (t) => {
	const { host, router } = await askingHost();
	t.after(() => host.stop());
	const card = router.batches.flat().find((c) => c.startsWith("[Worker 提问]"))!;
	assert.match(card, /问题：要看哪部分？\n选项：1\. 只看营收；2\. 营收和利润；3\. 先不查/);
});

test("点选回答的 [对话] 卡片多一行，写明回答的是哪个任务的哪个问题；Router 只凭卡片转交，Worker 收到这句使用者的话", async (t) => {
	const { host, router, spawner, row } = await askingHost();
	t.after(() => host.stop());
	const click = host.kernel.answerQuestion({ reportId: row.question!.reportId, option: 1, at: Date.now() });
	assert.ok(click.ok);
	host.dispatcher.kick();
	await until(() => host.kernel.listTickets()[0].stage === "closed", "任务收到回答后完成");
	const card = router.batches.flat().find((c) => c.startsWith("[对话]") && c.includes("回答任务"))!;
	assert.match(card, new RegExp(`^点选回答：${row.id}「查财报」的问题「要看哪部分？」`, "m"));
	assert.ok(spawner.workers.get(row.id)!.inputs.some((i) => i.includes("[使用者的话（经 Router 转交）]") && i.includes("回答任务「查财报」：营收和利润")));
	assert.equal(host.kernel.listTickets()[0].latestSummary, "收到：回答任务「查财报」：营收和利润");
});

test("客户端收到的幕僚长转述问题那一行带上 about 任务 id，和对话历史里一致", async (t) => {
	const started = await startHost(relayAndHandOver, (w) => {
		w.report({ status: "blocked", summary: "两种口径", question: "要看哪部分？", options: OPTIONS });
		w.settle();
	});
	const got: HostToClient[] = [];
	const conn = new HostConnection({ socketPath: started.host.socketPath, onMessage: (m) => got.push(m), retryMs: 30 });
	conn.open();
	t.after(async () => { conn.close(); await started.host.stop(); });
	await until(() => conn.connected, "连接");
	started.host.say("查财报");
	await until(() => ofType(got, "reply").some((m) => m.text === "要看财报的哪部分？"), "转述问题");
	const ticketId = started.host.kernel.listTickets()[0].id;
	const replies = ofType(got, "reply").map((m) => [m.text, m.about]);
	assert.deepEqual(replies, [["收到：查财报", undefined], ["要看财报的哪部分？", ticketId]]);
	assert.deepEqual(started.host.kernel.conversation().filter((l) => l.who === "router").map((l) => l.about), [undefined, ticketId]);
});

test("TUI 的连接：answer 消息回 ack 带触发 id，重复的回同一个；问题被新问题取代时回 refused 并说明原因", async (t) => {
	const { host, row } = await askingHost();
	const got: HostToClient[] = [];
	const conn = new HostConnection({ socketPath: host.socketPath, onMessage: (m) => got.push(m), retryMs: 30 });
	conn.open();
	t.after(async () => { conn.close(); await host.stop(); });
	await until(() => conn.connected, "连接");
	const first = conn.answer(row.question!.reportId, 0)!;
	const second = conn.answer(row.question!.reportId, 2)!;
	await until(() => ofType(got, "ack").length === 2, "两个 ack");
	const acks = ofType(got, "ack");
	assert.deepEqual(acks.map((a) => a.requestId), [first, second]);
	assert.equal(acks[0].triggerId, acks[1].triggerId);
	const replaced = host.kernel.workerReport(row.id, { status: "blocked", summary: "又要选", question: "发给谁？", options: ["甲", "乙"] }).reportId;
	host.kernel.workerReport(row.id, { status: "blocked", summary: "改问", question: "几点发？", options: ["现在", "明早"] });
	const stale = conn.answer(replaced, 1)!;
	await until(() => ofType(got, "refused").length === 1, "refused");
	const [refused] = ofType(got, "refused");
	assert.equal(refused.requestId, stale);
	assert.match(refused.reason, /已经回答过|不在等待回答/);
	assert.equal(ofType(got, "ack").length, 2);
});

test("任务久无进展时，即使 Watchdog 没在跑、也没有别的动静，宿主到点推一帧看板，行上标着久无进展", async (t) => {
	const { host } = await startHost(openOnly, () => {}, { config: { stuckMs: 300 } });
	const got: HostToClient[] = [];
	const conn = new HostConnection({ socketPath: host.socketPath, onMessage: (m) => got.push(m), retryMs: 30 });
	conn.open();
	t.after(async () => { conn.close(); await host.stop(); });
	await until(() => conn.connected, "连接");
	host.say("一直跑");
	await until(() => ofType(got, "board").some((m) => m.rows[0]?.stage === "running"), "执行中的看板帧");
	const runningFrames = ofType(got, "board").length;
	assert.equal(ofType(got, "board").at(-1)!.rows[0].stall, null);
	await until(() => ofType(got, "board").some((m) => m.rows[0]?.stall !== null && m.rows[0]?.stall !== undefined), "久无进展的看板帧", 2000);
	assert.ok(ofType(got, "board").length > runningFrames);
	assert.equal(ofType(got, "board").at(-1)!.rows[0].stall!.since, host.kernel.listTickets()[0].lastProgressAt);
});
