import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { connect, createServer } from "node:net";
import test, { mock, type TestContext } from "node:test";
import type { ConversationLine, HostToClient, ModuleCard, TodayCounts, WatchedSource } from "../src/client/protocol.ts";
import type { DashboardRow, Routes } from "../src/kernel/types.ts";
import type { Dispatching } from "../src/host/dispatch.ts";
import { formatInputs } from "../src/host/workers.ts";
import { INPUT_KINDS } from "../src/kernel/types.ts";
import { ConfigError } from "../src/config-error.ts";
import { WebGateway } from "../src/host/web.ts";
import { parseWebHosts } from "../src/host/web-hosts.ts";
import * as page from "../src/web/view.mjs";
import * as format from "../src/client/board-format.mjs";
import { helperLine } from "../src/client/board-format.mjs";
import { WATCHDOG_SOURCE } from "../src/watchdog/watchdog.ts";
import { openStore } from "../src/kernel/store.ts";
import { Kernel } from "../src/kernel/kernel.ts";
import { answerSentence } from "../src/kernel/question.ts";
import { busyPort, domainsOf, fakeFeed, freePort, ids, ofType, openOnConversation, startHost, tempStateDir, until, within } from "./helpers/fakes.ts";
import { importCommand } from "../src/modules/knowledge.ts";
import type { ComponentName, ModuleName } from "../src/modules/manifest.ts";

function row(over: Partial<DashboardRow> = {}): DashboardRow {
	return {
		id: "tkt_abcd1234", title: "查天气", stage: "running", basis: "request", latestSummary: null, model: "openai-codex/gpt-6.1-sol",
		fellBack: false, toolCalls: 2, tokensIn: 1200, tokensOut: 300, elapsedMs: 5000, lastProgressAt: null, question: null, stall: null,
		helper: { name: "青檀", role: "conversation", seq: 1 }, dispatchedTo: null, workerState: "running", startedAt: 0, endedAt: null, ...over,
	};
}

const zeroToday = (): TodayCounts => ({ byDisposition: { ignored: 0, delivered: 0, to_router: 0, opened_ticket: 0, handed_over: 0, router_ignored: 0 }, bySource: {} });
const duty = { since: 0, resumed: 0 };
const noHelpers = { count: 0, tokens: 0 };
const snapshot = (over: Partial<Extract<HostToClient, { type: "snapshot" }>> = {}): HostToClient => ({ type: "snapshot", conversation: [], board: [], today: zeroToday(), duty, helpers: noHelpers, watching: [], routes: {}, dispatching: {}, ...over });
const board = (rows: DashboardRow[], today = zeroToday(), helpers = noHelpers, routes: Routes = {}, dispatching: Dispatching = {}, watching: WatchedSource[] = []): HostToClient => ({ type: "board", rows, today, duty, helpers, routes, dispatching, memberCap: null, watching });
const texts = (view: ReturnType<typeof page.emptyView>) => [...view.lines.values()].map((l) => `${l.who}:${l.text}`);
const withRows = (rows: DashboardRow[], now = 0) => {
	const view = page.emptyView();
	page.applyMessage(view, board(rows), now);
	return view;
};

test("页面：快照之后再收到同一句 user 或同一条 reply，不重复显示", () => {
	const view = page.emptyView();
	page.applyMessage(view, snapshot({ conversation: [{ id: "trg_1", who: "user", text: "你好", at: 1 }, { id: "rpl_1", who: "router", text: "在", at: 2 }] }), 0);
	page.applyMessage(view, { type: "user", who: "user", id: "trg_1", text: "你好", at: 1 }, 0);
	page.applyMessage(view, { type: "reply", replyId: "rpl_1", text: "在", at: 2 }, 0);
	assert.deepEqual(texts(view), ["user:你好", "router:在"]);
});

test("页面：重连后的快照只补没见过的行，已显示的顺序不变", () => {
	const view = page.emptyView();
	page.applyMessage(view, { type: "user", who: "user", id: "trg_2", text: "第二句", at: 2 }, 0);
	page.applyMessage(view, snapshot({ conversation: [{ id: "trg_1", who: "user", text: "第一句", at: 1 }, { id: "trg_2", who: "user", text: "第二句", at: 2 }, { id: "rpl_3", who: "router", text: "回复", at: 3 }] }), 0);
	assert.deepEqual(texts(view), ["user:第二句", "user:第一句", "router:回复"]);
});

test("页面：未知消息类型被忽略，不改对话也不改左栏", () => {
	const view = withRows([row()]);
	assert.deepEqual(page.applyMessage(view, { type: "ack", requestId: "r", triggerId: "trg_1" }, 0), []);
	assert.deepEqual(page.applyMessage(view, { type: "transcript", ticketId: "tkt_abcd1234", message: { role: "assistant", content: "x" } }, 0), []);
	assert.equal(view.lines.size, 0);
	assert.equal(page.leftColumn(view).doing.length, 1);
});

test("页面：每种消息只报告它改动的区域", () => {
	const view = page.emptyView();
	assert.deepEqual(page.applyMessage(view, snapshot(), 0), ["conversation", "left", "header"]);
	assert.deepEqual(page.applyMessage(view, { type: "user", who: "user", id: "trg_1", text: "你好", at: 1 }, 0), ["conversation"]);
	assert.deepEqual(page.applyMessage(view, { type: "reply", replyId: "rpl_1", text: "在", at: 2 }, 0), ["conversation"]);
	assert.deepEqual(page.applyMessage(view, board([]), 0), ["conversation", "left", "header"], "看板带着对话里每句话的去向");
});

test("页面：每个任务恰好进一个分组：待回复、待确认、受阻进待你处理，排队中、进行中、等待中进进行中，已完成和已停止进已完成", () => {
	const stages: DashboardRow["stage"][] = ["awaiting_answer", "awaiting_review", "blocked_or_failed", "queued", "running", "idle", "closed", "stopped"];
	const left = page.leftColumn(withRows(stages.map((stage) => row({ id: `tkt_${stage}`, stage }))), 0);
	const ids = (cards: { id: string }[]) => cards.map((c) => c.id.slice(4));
	assert.deepEqual(ids(left.needsYou), ["awaiting_answer", "awaiting_review", "blocked_or_failed"]);
	assert.deepEqual(ids(left.doing), ["queued", "running", "idle"]);
	assert.deepEqual(ids(left.done), ["stopped", "closed"], "后开的在前");
});

test("页面：待你处理的卡片先显示问题，受阻的显示最近汇报；进行中的显示最近汇报，没有时说已开始", () => {
	const left = page.leftColumn(withRows([
		row({ id: "tkt_ask", stage: "awaiting_answer", basis: "rule", latestSummary: "需要确认", question: { reportId: "rpt_1", text: "用 A 还是 B？", options: [], askedAt: 0, clickedOption: null } }),
		row({ id: "tkt_stk", stage: "blocked_or_failed", basis: "inference", latestSummary: "缺少权限" }),
		row({ id: "tkt_run", stage: "running", latestSummary: null }),
		row({ id: "tkt_idl", stage: "idle", latestSummary: "读完 3 份" }),
	]), 0);
	assert.deepEqual(left.needsYou.map((c) => [c.latest, c.stage, c.why]), [["用 A 还是 B？", "待回复", "规则触发"], ["缺少权限", "受阻", "主动发现"]]);
	assert.deepEqual(left.doing.map((c) => [c.latest, c.stage, c.why]), [["已开始，暂无进展", "进行中", "你的请求"], ["读完 3 份", "等待中", "你的请求"]]);
	assert.deepEqual([...left.needsYou, ...left.doing].map((c) => c.canStop), [false, false, true, true], "只有进行中的能停止");
});

test("页面：所属模块已停用的任务，还开着时卡片阶段写「所属模块已停用」；做完的照常写已完成", () => {
	const left = page.leftColumn(withRows([row({ id: "tkt_off", stage: "running", moduleOff: true }), row({ id: "tkt_done", stage: "closed", moduleOff: true })]), 0);
	assert.deepEqual([...left.doing, ...left.done].map((c) => [c.id, c.stage]), [["tkt_off", "所属模块已停用"], ["tkt_done", "已完成"]]);
});

const MIN = 60_000;
const asked = (over: Partial<NonNullable<DashboardRow["question"]>> = {}) =>
	({ reportId: "rpt_q1", text: "要看哪部分？", options: ["只看营收", "营收和利润", "先不查"], askedAt: 10 * MIN, click: null, spoke: false, ...over });

test("页面：执行中久无进展的任务进待你处理，阶段写「久无进展 · N 分钟」并随时间增加，能停止", () => {
	const view = withRows([row({ id: "tkt_slow", stage: "running", latestSummary: "在跑回归", stall: { since: 0, minutes: 42 } }), row({ id: "tkt_ok", stage: "running" })]);
	const left = page.leftColumn(view, 42 * MIN + 5000);
	assert.deepEqual(left.needsYou.map((c) => [c.id, c.stage, c.latest, c.canStop]), [["tkt_slow", "久无进展 · 42 分钟", "在跑回归", true]]);
	assert.deepEqual(left.doing.map((c) => c.id), ["tkt_ok"]);
	assert.equal(page.leftColumn(view, 45 * MIN).needsYou[0].stage, "久无进展 · 45 分钟");
});

test("页面：等回答且带选项的卡片有一组按钮；点过的按转交进度锁住并标出选了哪个；开放问题没有按钮", () => {
	const click = (option: number, state: "sent" | "handed_over" | "dropped") => ({ option, state, triggerId: `trg_${state}` });
	const view = withRows([
		row({ id: "tkt_a", stage: "awaiting_answer", question: asked() }),
		row({ id: "tkt_b", stage: "awaiting_answer", question: asked({ reportId: "rpt_q2", click: click(2, "sent") }) }),
		row({ id: "tkt_c", stage: "running", question: asked({ reportId: "rpt_q3", click: click(1, "handed_over") }) }),
		row({ id: "tkt_d", stage: "awaiting_answer", question: asked({ reportId: "rpt_q4", click: click(0, "dropped") }) }),
		row({ id: "tkt_e", stage: "awaiting_answer", question: asked({ reportId: "rpt_q5", options: [] }) }),
	]);
	const left = page.leftColumn(view, 0);
	const [a, b, d, e] = left.needsYou.map((card) => card.choice);
	const [c] = left.doing.map((card) => card.choice);
	assert.deepEqual(a, { reportId: "rpt_q1", buttons: [{ label: "只看营收", option: 0, picked: false }, { label: "营收和利润", option: 1, picked: false }, { label: "先不查", option: 2, picked: false }], locked: false, note: "" });
	const seen = (x: typeof a) => [x?.locked, x?.buttons.map((y) => y.picked), x?.note];
	assert.deepEqual(seen(b), [true, [false, false, true], "已发送，等待幕僚长转交"]);
	assert.deepEqual(seen(c), [true, [false, true, false], "已回答"]);
	assert.deepEqual(seen(d), [false, [false, false, false], "幕僚长没有转交这次选择，请重选或直接回复"]);
	assert.equal(e, null);
	const spoke = page.leftColumn(withRows([row({ stage: "awaiting_answer", question: asked({ spoke: true }) })]), 0).needsYou[0].choice;
	assert.deepEqual(seen(spoke), [true, [false, false, false], "你刚发了一句话，等幕僚长处理完再点"]);
	const posting = page.leftColumn(view, 0, new Map([["rpt_q1", { option: 1 }]])).needsYou[0].choice;
	assert.deepEqual(seen(posting), [true, [false, true, false], "发送中…"]);
	const posted = page.leftColumn(view, 0, new Map([["rpt_q4", { option: 2, triggerId: "trg_new" }]])).needsYou[2].choice;
	assert.deepEqual(seen(posted), [true, [false, false, true], "已发送，等待幕僚长转交"], "宿主收下了，看板还没跟上");
});

test("页面：本地记着的点选，等看板上出现宿主给的那条触发、或问题已经不在时才放下；发送还没回来时一直留着", () => {
	const view = withRows([row({ id: "tkt_a", stage: "awaiting_answer", question: asked({ click: { option: 0, state: "dropped", triggerId: "trg_old" } }) })]);
	const sending = new Map<string, { option: number; triggerId?: string }>([["rpt_q1", { option: 1 }], ["rpt_gone", { option: 0, triggerId: "trg_g" }]]);
	page.settleSending(view, sending);
	assert.deepEqual([...sending.keys()], ["rpt_q1"]);
	sending.set("rpt_q1", { option: 1, triggerId: "trg_new" });
	page.settleSending(view, sending);
	assert.deepEqual([...sending.keys()], ["rpt_q1"], "看板上还是旧的那次");
	page.applyMessage(view, board([row({ id: "tkt_a", stage: "awaiting_answer", question: asked({ click: { option: 1, state: "sent", triggerId: "trg_new" } }) })]), 0);
	page.settleSending(view, sending);
	assert.equal(sending.size, 0);
});

test("页面：选项按钮也挂在对话里幕僚长转述这个问题的那一句下面：关于这个任务、在提问之后的最后一句；还没转述或问题结束时对话里没有", () => {
	const view = page.emptyView();
	page.applyMessage(view, snapshot({ conversation: [
		{ id: "rpl_old", who: "router", text: "收到", at: 5 * MIN, ticketId: "tkt_a" },
		{ id: "rpl_q", who: "router", text: "要看哪部分？", at: 11 * MIN, ticketId: "tkt_a" },
		{ id: "rpl_other", who: "router", text: "别的事", at: 12 * MIN, ticketId: "tkt_b" },
		{ id: "trg_x", who: "user", text: "嗯", at: 13 * MIN },
	], board: [row({ id: "tkt_a", stage: "awaiting_answer", question: asked() })] }), 0);
	const choices = page.choicesInConversation(view, new Map());
	assert.deepEqual([...choices.keys()], ["rpl_q"]);
	assert.equal(choices.get("rpl_q")?.reportId, "rpt_q1");
	page.applyMessage(view, board([row({ id: "tkt_a", stage: "running" })]), 0);
	assert.equal(page.choicesInConversation(view, new Map()).size, 0);
	const early = page.emptyView();
	page.applyMessage(early, snapshot({ conversation: [{ id: "rpl_old", who: "router", text: "收到", at: 5 * MIN, ticketId: "tkt_a" }], board: [row({ id: "tkt_a", stage: "awaiting_answer", question: asked() })] }), 0);
	assert.equal(page.choicesInConversation(early, new Map()).size, 0, "提问之前的话下面不挂");
});

const AT_1405 = Date.parse("2026-11-09T14:05:00+08:00");
const line = (id: string, text: string, at = AT_1405 - MIN, over: Partial<ConversationLine> = {}): ConversationLine => ({ id, who: id.startsWith("rpl") ? "router" : "user", text, at, ...over });
const draft = (text: string): { text: string; quoteOf: string | null } => ({ text, quoteOf: null });
const clearedFrame = (hidden: ConversationLine[], conversation: ConversationLine[] = [], at = AT_1405): HostToClient => ({ type: "cleared", conversation, cleared: { at, lines: hidden } });

test("页面：收到 cleared 帧后对话只剩帧里带的行，顶部细线是「已清屏 · HH:MM · 显示之前的」", () => {
	const view = page.emptyView();
	page.applyMessage(view, snapshot({ conversation: [line("trg_1", "查天气"), line("rpl_1", "好的")], cleared: null }), 0);
	assert.equal(page.clearedBar(view, AT_1405, "Asia/Shanghai"), null);
	assert.deepEqual(page.applyMessage(view, clearedFrame([line("trg_1", "查天气"), line("rpl_1", "好的")], [line("rpl_2", "还在路上的回复")]), 0), ["conversation"]);
	assert.deepEqual(texts(view), ["router:还在路上的回复"]);
	assert.deepEqual(page.clearedBar(view, AT_1405 + 60 * MIN, "Asia/Shanghai"), { text: "已清屏 · 14:05 · 显示之前的", expanded: false });
	assert.equal(page.clearedBar(view, AT_1405 + 24 * 60 * MIN, "Asia/Shanghai")?.text, "已清屏 · 11月9日 14:05 · 显示之前的", "不是今天清的屏写上日期");
});

test("页面：宿主行（提醒、收据）进对话；刷新后的快照里还在、不重复；清屏帧把它收走", () => {
	const view = page.emptyView();
	const alert = { id: "hln_1", who: "alert", text: "NVDA 涨了 5.3%", at: AT_1405 } as const;
	const receipt = { id: "hln_2", who: "receipt", text: "已记下：NVDA\n成本价 120.00", at: AT_1405 + 1 } as const;
	assert.deepEqual(page.applyMessage(view, { type: "host_line", ...alert }, 0), ["conversation"]);
	page.applyMessage(view, { type: "host_line", ...receipt }, 0);
	assert.deepEqual(texts(view), ["alert:NVDA 涨了 5.3%", "receipt:已记下：NVDA\n成本价 120.00"]);
	const reloaded = page.emptyView();
	page.applyMessage(reloaded, snapshot({ conversation: [alert, receipt], cleared: null }), 0);
	page.applyMessage(reloaded, { type: "host_line", ...alert }, 0);
	assert.deepEqual(texts(reloaded), texts(view));
	page.applyMessage(view, clearedFrame([alert, receipt]), 0);
	assert.deepEqual(texts(view), []);
	assert.deepEqual(page.earlierLines((page.toggleEarlier(view), view)).map((l) => l.id), ["hln_1", "hln_2"]);
});

test("页面：点细线只在本页展开被清掉的行，再点收起；新的清屏把展开收回", () => {
	const view = page.emptyView();
	const hidden = [line("trg_1", "查天气"), line("rpl_1", "好的")];
	page.applyMessage(view, clearedFrame(hidden), 0);
	assert.deepEqual(page.earlierLines(view), []);
	page.toggleEarlier(view);
	assert.deepEqual(page.earlierLines(view), hidden);
	assert.equal(page.clearedBar(view, AT_1405, "Asia/Shanghai")?.text, "已清屏 · 14:05 · 收起");
	assert.equal(page.clearedBar(view, AT_1405, "Asia/Shanghai")?.expanded, true);
	page.toggleEarlier(view);
	assert.deepEqual(page.earlierLines(view), []);
	page.toggleEarlier(view);
	page.applyMessage(view, clearedFrame([...hidden, line("trg_2", "又一句")], [], AT_1405 + 1), 0);
	assert.deepEqual(page.earlierLines(view), []);
	assert.equal(page.clearedBar(view, AT_1405, "Asia/Shanghai")?.expanded, false);
	const never = page.emptyView();
	page.toggleEarlier(never);
	assert.deepEqual(page.earlierLines(never), [], "从没清过屏时没有可展开的");
});

test("页面：重连快照的清屏时间和本页不同就用快照替换对话，相同就照旧只补没见过的行", () => {
	const missed = page.emptyView();
	page.applyMessage(missed, snapshot({ conversation: [line("trg_1", "查天气")], cleared: null }), 0);
	page.applyMessage(missed, snapshot({ conversation: [line("trg_2", "新的一句")], cleared: { at: AT_1405, lines: [line("trg_1", "查天气")] } }), 0);
	assert.deepEqual(texts(missed), ["user:新的一句"]);
	assert.equal(page.clearedBar(missed, AT_1405, "Asia/Shanghai")?.text, "已清屏 · 14:05 · 显示之前的");
	const same = page.emptyView();
	page.applyMessage(same, clearedFrame([line("trg_1", "查天气")], [line("trg_2", "新的一句")]), 0);
	page.applyMessage(same, { type: "user", who: "user", id: "trg_3", text: "第三句", at: AT_1405 + 2 }, 0);
	page.toggleEarlier(same);
	page.applyMessage(same, snapshot({ conversation: [line("trg_2", "新的一句"), line("trg_4", "断线时说的")], cleared: { at: AT_1405, lines: [line("trg_1", "查天气")] } }), 0);
	assert.deepEqual(texts(same), ["user:新的一句", "user:第三句", "user:断线时说的"]);
	assert.equal(page.earlierLines(same).length, 1, "同一次清屏，本页的展开不收回");
});

test("页面：老宿主的快照没有 cleared 字段时，当作从没清过屏，没有细线", () => {
	const view = page.emptyView();
	page.applyMessage(view, { type: "user", who: "user", id: "trg_2", text: "第二句", at: 2 }, 0);
	const old = snapshot({ conversation: [line("trg_1", "第一句", 1), line("trg_2", "第二句", 2)] });
	delete (old as { cleared?: unknown }).cleared;
	page.applyMessage(view, old, 0);
	assert.equal(page.clearedBar(view, AT_1405), null);
	assert.deepEqual(texts(view), ["user:第二句", "user:第一句"]);
});

test("页面：被清掉的那句幕僚长回复下不再放选项按钮，看板卡片上仍有", () => {
	const view = page.emptyView();
	const question = line("rpl_q", "要看哪部分？", 11 * MIN, { ticketId: "tkt_a" });
	page.applyMessage(view, snapshot({ conversation: [question], board: [row({ id: "tkt_a", stage: "awaiting_answer", question: asked() })] }), 0);
	assert.equal(page.choicesInConversation(view, new Map()).size, 1);
	page.applyMessage(view, clearedFrame([question]), 0);
	assert.equal(page.choicesInConversation(view, new Map()).size, 0);
	assert.notEqual(page.leftColumn(view, 0).needsYou[0].choice, null);
});

test("页面：对话为空时清屏按钮不可点", () => {
	const view = page.emptyView();
	assert.equal(page.canClear(view), false);
	page.applyMessage(view, { type: "user", who: "user", id: "trg_1", text: "你好", at: 1 }, 0);
	assert.equal(page.canClear(view), true);
	page.applyMessage(view, clearedFrame([line("trg_1", "你好")]), 0);
	assert.equal(page.canClear(view), false);
});

test("页面：发出时没收到确认的那句话，中间清过屏也照样在之后到达的行里对上", () => {
	const view = page.emptyView();
	page.applyMessage(view, snapshot({ conversation: [line("trg_1", "查天气"), line("trg_2", "再查一次")] }), 0);
	const seen = new Set(view.lines.keys());
	page.applyMessage(view, clearedFrame([line("trg_1", "查天气"), line("trg_2", "再查一次")]), 0);
	page.applyMessage(view, { type: "user", who: "user", id: "trg_3", text: "明天呢", at: AT_1405 + 1 }, 0);
	const arrived = page.linesNotIn(view, seen);
	assert.deepEqual(arrived.map((l) => l.text), ["明天呢"]);
	assert.equal(page.settleSay({ state: "maybe_lost", text: "明天呢", quoteOf: null }, arrived), "delivered");
});

test("页面：发出后这句话上屏又被清屏，确认丢了也能在被清掉的行里对上", () => {
	const view = page.emptyView();
	page.applyMessage(view, snapshot({ conversation: [line("trg_1", "查天气")] }), 0);
	const seen = page.knownLineIds(view);
	page.applyMessage(view, { type: "user", who: "user", id: "trg_2", text: "买咖啡", at: AT_1405 + 1 }, 0);
	page.applyMessage(view, clearedFrame([line("trg_1", "查天气"), line("trg_2", "买咖啡")]), 0);
	const arrived = page.linesNotIn(view, seen);
	assert.deepEqual(arrived.map((l) => l.text), ["买咖啡"]);
	assert.equal(page.settleSay({ state: "maybe_lost", text: "买咖啡", quoteOf: null }, arrived), "delivered");
});

test("页面：发出前就被清掉的同一句话，不当作这次发出的回音", () => {
	const view = page.emptyView();
	page.applyMessage(view, snapshot({ conversation: [line("trg_1", "买咖啡")] }), 0);
	page.applyMessage(view, clearedFrame([line("trg_1", "买咖啡")]), 0);
	const seen = page.knownLineIds(view);
	const arrived = page.linesNotIn(view, seen);
	assert.equal(page.settleSay({ state: "maybe_lost", text: "买咖啡", quoteOf: null }, arrived), "maybe_lost");
});

test("页面：reply 帧带的 ticketId 留在对话行上", () => {
	const view = page.emptyView();
	page.applyMessage(view, { type: "reply", replyId: "rpl_1", text: "要看哪部分？", at: 1, ticketId: "tkt_a" }, 0);
	assert.equal(view.lines.get("rpl_1")?.ticketId, "tkt_a");
});

test("页面：点选项发的正文只有 {answer: {reportId, option}}，句子由宿主来写；409 显示固定文案", () => {
	assert.deepEqual(JSON.parse(page.answerBody("rpt_q1", 2)), { answer: { reportId: "rpt_q1", option: 2 } });
	assert.equal(page.sayCopy("rejected", 409), "发送失败：这个问题已经回答过，或已不在等待回答。");
});

test("页面：停止只在输入框里填一句话，含任务标题", () => {
	assert.equal(page.stopSentence("读取 example.com 的网页标题"), "停止任务「读取 example.com 的网页标题」");
});

test("页面：关注的来源每一行用来源原名，显示第一条规则的第一行，或定时器的频率，以及今日消息数", () => {
	const view = page.emptyView();
	const today = zeroToday();
	today.bySource = { inbox: 2 };
	page.applyMessage(view, snapshot({
		today,
		watching: [
			{ source: "inbox", timers: [], rules: [{ id: "user/mail", text: "\n有人找我先看一遍\n细节", by: "user" }] },
			{ source: "digest", timers: [{ everyMinutes: 1440, body: "早报" }], rules: [] },
			{ source: "pager", timers: [{ everyMinutes: 30, body: "看看" }], rules: [] },
			{ source: "quotes", timers: [], rules: [] },
		],
	}), 0);
	assert.deepEqual(page.leftColumn(view).watching, [
		{ source: "inbox", name: "inbox", rule: "有人找我先看一遍", hits: "今日 2 条", alerts: "", problem: false, lists: [] },
		{ source: "digest", name: "digest", rule: "每 1 天：早报", hits: "", alerts: "", problem: false, lists: [] },
		{ source: "pager", name: "pager", rule: "每 30 分钟：看看", hits: "", alerts: "", problem: false, lists: [] },
		{ source: "quotes", name: "quotes", rule: "收到新消息时处理", hits: "", alerts: "", problem: false, lists: [] },
	]);
});

test("页面：模块栏每个模块一张卡：标题和名字、状态、版本、组成、密钥名字、钉着旧版本的任务数、没导入的知识和导入命令、开关按钮", () => {
	const view = page.emptyView();
	const health = taxCard({
		name: "personal-health", title: "个人医疗健康", on: true, label: "运行中", reason: "", tone: "ok", components: { knowledge: 2, tools: 1, agents: 5, rules: 1 }, secrets: ["EXAMPLE_TOKEN"], pinnedOld: 2,
		notImported: ["hf", "ccs"],
	});
	page.applyMessage(view, { ...board([]), modules: [health, taxCard({ title: undefined })] } as HostToClient, 0);
	const [on, off] = page.leftColumn(view, 0).modules;
	assert.deepEqual(on, {
		name: "personal-health", heading: "个人医疗健康 · personal-health", on: true, button: "关掉", state: "运行中", note: "个人医疗健康", tone: "ok", version: "版本 0.1.0 · abcdef123456",
		lines: ["知识 2 · 工具 1 · 成员 5 · 规则 1", "密钥 EXAMPLE_TOKEN", "2 个任务还在用旧版本"], problems: [],
		importsHeading: "还没导入的知识 2 份",
		imports: [{ name: "hf", command: "just module import personal-health hf <文件或目录>" }, { name: "ccs", command: "just module import personal-health ccs <文件或目录>" }],
	});
	assert.equal(on.imports[0].command, importCommand("personal-health" as ModuleName, "hf" as ComponentName), "和宿主给的导入命令一字不差");
	assert.deepEqual([off.heading, off.button, off.state, off.tone, off.lines], ["tax", "打开", "已停用 · 你把它关了，数据还留着", "off", ["技能 1"]]);
});

test("页面：无效的模块卡用宿主给的警示色，列出哪个文件哪一处；宿主没给原因时状态行只写状态", () => {
	const view = page.emptyView();
	const problems = ["module.json：unknown key \"descripton\"", "tools/x/tool.json：needs \"entry\""];
	page.applyMessage(view, { ...board([]), modules: [taxCard({ on: true, label: "无效", reason: "", tone: "bad", problems })] } as HostToClient, 0);
	const [card] = page.leftColumn(view, 0).modules;
	assert.deepEqual([card.state, card.tone, card.problems], ["无效", "bad", problems]);
});

test("页面：老宿主的帧没有 modules 时模块栏是空的", () => {
	assert.deepEqual(page.leftColumn(withRows([]), 0).modules, []);
});

test("页面：带标题的来源显示标题和一句说明；看不了盘时把问题写在说明前面，标成有问题", () => {
	const view = page.emptyView();
	const rules = [{ id: "us-market/big-move", text: "涨多了查一查", by: "module" as const }];
	page.applyMessage(view, snapshot({
		watching: [
			{ source: "us-market", title: "美股行情", description: "交易时段每分钟看一遍自选股", problem: "未配置行情密钥", timers: [], rules },
			{ source: "us-market-2", title: "港股行情", description: "盘中看一遍", timers: [], rules },
		],
	}), 0);
	assert.deepEqual(page.leftColumn(view).watching, [
		{ source: "us-market", name: "美股行情", rule: "未配置行情密钥 · 交易时段每分钟看一遍自选股", hits: "", alerts: "", problem: true, lists: [] },
		{ source: "us-market-2", name: "港股行情", rule: "盘中看一遍", hits: "", alerts: "", problem: false, lists: [] },
	]);
});

const NVDA_COST = "NVDA 成本价 120、100 股，相对成本价涨跌超过 10% 时提醒";

test("页面：来源下面列出自选几只、盯盘条件几条（一条一行）和今日提醒数；空的清单不列，盯盘条件默认展开，自选默认收起", () => {
	const view = page.emptyView();
	const today = zeroToday();
	today.bySource = { "us-market": 3 };
	page.applyMessage(view, snapshot({
		today,
		watching: [
			{ source: "us-market", title: "美股行情", description: "交易时段每分钟看一遍自选股", timers: [], rules: [], panel: { watchlist: ["NVDA", "SPY"], tripwires: [NVDA_COST] }, alertsToday: 2 },
			{ source: "quiet-feed", timers: [], rules: [], panel: { watchlist: [], tripwires: [] }, alertsToday: 0 },
		],
	}), 0);
	assert.deepEqual(page.leftColumn(view).watching, [
		{
			source: "us-market", name: "美股行情", rule: "交易时段每分钟看一遍自选股", hits: "今日 3 条", alerts: "今日提醒 2", problem: false,
			lists: [
				{ key: "watchlist", summary: "自选 2 只", items: ["NVDA", "SPY"], open: false },
				{ key: "tripwires", summary: "盯盘条件 1 条", items: [NVDA_COST], open: true },
			],
		},
		{ source: "quiet-feed", name: "quiet-feed", rule: "收到新消息时处理", hits: "", alerts: "", problem: false, lists: [] },
	]);
});

test("页面：board 帧带来的关注的来源替换快照里的，条件改了不用刷新", () => {
	const view = page.emptyView();
	const market = (tripwires: string[]): WatchedSource => ({ source: "us-market", timers: [], rules: [], panel: { watchlist: ["NVDA"], tripwires }, alertsToday: 0 });
	page.applyMessage(view, snapshot({ watching: [market([NVDA_COST])] }), 0);
	assert.ok(page.applyMessage(view, board([], zeroToday(), noHelpers, {}, {}, [market([])]), 0).includes("left"));
	assert.deepEqual(page.leftColumn(view).watching[0].lists.map((l) => l.key), ["watchlist"]);
});

test("页面：有问题的来源圆点用警示色，亮色和暗色主题都有", () => {
	const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
	assert.match(html, /\.watch\.problem::before \{ background: var\(--warn\); \}/);
	assert.match(html, /--warn: light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)/);
});

test("页面：今日来源消息 · N，明细只列不为 0 的去向", () => {
	const counts = (over: Partial<TodayCounts["byDisposition"]>) => ({ ...zeroToday(), byDisposition: { ...zeroToday().byDisposition, ...over } });
	assert.deepEqual(page.todayCopy(counts({})), { headline: "今日暂无来源消息", detail: "" });
	assert.deepEqual(page.todayCopy(counts({ opened_ticket: 2, delivered: 1, handed_over: 1, to_router: 1, ignored: 5, router_ignored: 4 })), {
		headline: "今日来源消息 · 14",
		detail: "新建任务 2 · 转入进行中任务 2 · 处理中 1 · 无需处理 9",
	});
	assert.deepEqual(page.todayCopy(counts({ opened_ticket: 1 })), { headline: "今日来源消息 · 1", detail: "新建任务 1" });
	assert.deepEqual(page.todayCopy(undefined), { headline: "", detail: "" });
});

test("页面：运行时长粗略到天、小时、分钟；只有这次启动恢复了任务，半小时内才提示已重启", () => {
	const H = 3_600_000;
	assert.equal(page.dutyLine({ since: 0, resumed: 0 }, (3 * 24 + 6) * H + 59_000), "在线 · 已运行 3 天 6 小时");
	assert.equal(page.dutyLine({ since: 0, resumed: 0 }, 2 * H + 5 * 60_000), "在线 · 已运行 2 小时 5 分钟");
	assert.equal(page.dutyLine({ since: 0, resumed: 0 }, 30_000), "在线 · 刚启动");
	assert.equal(page.dutyLine(undefined, 0), "");
	assert.equal(page.dutyLine({ since: 0, resumed: 0 }, 2 * H, false), "", "断线时不再显示「在线」");
	assert.equal(page.restartNotice({ since: 0, resumed: 2 }, 29 * 60_000), "已重启，进行中的任务已恢复");
	assert.equal(page.restartNotice({ since: 0, resumed: 2 }, 31 * 60_000), "");
	assert.equal(page.restartNotice({ since: 0, resumed: 0 }, 60_000), "");
	assert.equal(page.restartNotice(undefined, 0), "");
});

const tool = (name: string, args: unknown) => ({ role: "assistant", content: [{ type: "toolCall", name, arguments: args }] });
const result = (toolName: string, text: string, isError = false) => ({ role: "toolResult", toolName, isError, content: [{ type: "text", text }] });
const history = (ticketId: string, messages: unknown[]): HostToClient => ({ type: "transcript_history", ticketId, messages: messages as never });
const live = (ticketId: string, message: unknown): HostToClient => ({ type: "transcript", ticketId, message: message as never });
const watched = (messages: unknown[]) => {
	const w = page.emptyWatch("tkt_1");
	page.applyTranscript(w, history("tkt_1", messages));
	return w.steps;
};

test("页面：工具调用写成步骤名称，未知工具写「调用工具 名字」，原始参数留在 raw 里", () => {
	const steps = watched([tool("web_get", { url: "https://example.com/a?b=1" }), tool("read", { path: "/w/notes/a.md" }), tool("mystery", { x: 1 })]);
	assert.deepEqual(steps.map((s) => [s.title, s.detail, s.state]), [["读取网页", "example.com", "pending"], ["读取文件", "a.md", "pending"], ["调用工具 mystery", "", "pending"]]);
	assert.match(steps[0].raw, /web_get/);
	const lookups = watched([
		tool("lookup", { source: "us-market", op: "quote", args: { symbols: ["NVDA", "SPY"] } }),
		tool("lookup", { source: "us-market", op: "bars", args: { symbol: "NVDA", span: "minute", from: "2026-11-09", to: "2026-11-09" } }),
		tool("lookup", { source: "us-market", op: "session" }),
	]);
	assert.deepEqual(lookups.map((s) => [s.title, s.detail]), [["查询报价", "NVDA SPY"], ["查询 K 线", "NVDA"], ["查询交易时段", ""]]);
	assert.match(steps[0].raw, /https:\/\/example\.com\/a\?b=1/);
});

test("页面：产品叫白宫，副标题是 Pi Super Agent，和你对话的叫幕僚长，执行任务的叫助手", async (t) => {
	const { at } = await webHost(t);
	const served = await Promise.all(["/", "/app.mjs", "/view.mjs"].map(async (path) => (await request(at(path))).body));
	assert.match(served[0], /<title>白宫 · Pi Super Agent<\/title>/);
	assert.match(served[0], /<div class="brand"><strong>白宫<\/strong><span>Pi Super Agent · 你的 24 小时幕僚<\/span><\/div>/);
	for (const [i, body] of served.entries()) assert.doesNotMatch(body, /(?<!Pi )Super Agent/, `第 ${i} 个文件仍把幕僚长叫作 Super Agent`);
	assert.deepEqual(watched([tool("hand_back", { reason: "不归我管" })]).map((s) => s.title), ["交回幕僚长"]);
});

test("页面：头像的颜色由任务编号固定决定，并行的任务分得开", () => {
	const ids = Array.from({ length: 60 }, (_, i) => `tkt_${(i * 7919 + 104729).toString(36)}x${i}`);
	const tints = ids.map((id) => page.avatarOf(row({ id })).tint);
	assert.deepEqual(ids.map((id) => page.avatarOf(row({ id, helper: { name: "高山流水", team: null, seq: 1 } })).tint), tints, "同一个编号每次取同一种颜色，单个助手和领队一样");
	assert.ok(tints.every((n) => Number.isInteger(n) && n >= 0 && n < page.HELPER_TINTS), String(tints));
	assert.equal(new Set(tints).size, page.HELPER_TINTS, "六种颜色都会用到");
	assert.equal("helperTint" in page, false, "头像只经 avatarOf 取色");
});

test("页面：头像的六种颜色上写字，亮色和暗色主题的对比度都不低于 4.5 比 1", () => {
	const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
	const luminance = (hex: string) => {
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const contrast = (a: string, b: string) => {
		const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return (hi + 0.05) / (lo + 0.05);
	};
	const tints = [...html.matchAll(/\.tint-(\d) \{ background: light-dark\((#\w{6}), (#\w{6})\); color: light-dark\((#\w{6}), (#\w{6})\); \}/g)];
	assert.equal(tints.length, page.HELPER_TINTS);
	for (const [, n, bgLight, bgDark, inkLight, inkDark] of tints) {
		assert.ok(contrast(bgLight, inkLight) >= 4.5, `tint-${n} 亮色 ${contrast(bgLight, inkLight).toFixed(2)}`);
		assert.ok(contrast(bgDark, inkDark) >= 4.5, `tint-${n} 暗色 ${contrast(bgDark, inkDark).toFixed(2)}`);
	}
});

test("页面：领队头像的冠标在 index.html 里只画一次，页面克隆它", () => {
	const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
	assert.match(html, /<template id="crown-mark"><svg class="crown"[^>]*aria-hidden="true"/);
});

test("页面：report 带问题是提出问题，ready 是提交结果，blocked 和 failed 是报告受阻", () => {
	const steps = watched([
		tool("report", { status: "progress", summary: "需要确认", question: "用 A 还是 B？" }),
		tool("report", { status: "ready", summary: "标题是 Example Domain" }),
		tool("report", { status: "blocked", summary: "缺少权限" }),
		tool("report", { status: "failed", summary: "网站打不开" }),
		tool("report", { status: "progress", summary: "读完一半" }),
		tool("report", { status: "no_action", summary: "不用做" }),
	]);
	assert.deepEqual(steps.map((s) => [s.title, s.detail]), [
		["提出问题", "用 A 还是 B？"], ["提交结果", "标题是 Example Domain"], ["报告受阻", "缺少权限"], ["报告受阻", "网站打不开"], ["汇报进度", "读完一半"], ["无需处理", "不用做"],
	]);
});

test("页面：汇报那一步用整段话渲染 Markdown：超过 120 字的汇报里表格和链接不被从中间截断", () => {
	const summary = `${"先说结论，这段话有意写得很长。".repeat(8)}\n\n| 指标 | NVDA |\n|--|--|\n| 跌幅 | 4.2% |\n\n来源 [路透](https://reuters.com/markets/nvda)`;
	const [step] = watched([tool("report", { status: "progress", summary })]);
	assert.equal(step.markdown, true);
	const blocks = page.parseMarkdown(step.detail);
	assert.deepEqual(blocks.map((b) => b.kind), ["p", "table", "p"]);
	assert.deepEqual(blocks[2], { kind: "p", spans: [{ text: "来源 " }, { text: "路透" }, { text: "（https://reuters.com/markets/nvda）" }] });
});

test("页面：工具结果并进最近一个同名的待完成步骤，出错的标成 error；思考步骤里不出现 thinking", () => {
	const steps = watched([
		{ role: "assistant", content: [{ type: "thinking", thinking: "内心独白" }, { type: "text", text: "我先打开网页" }, { type: "toolCall", name: "web_get", arguments: { url: "https://a.example" } }] },
		result("web_get", "<title>A</title>"),
		tool("web_get", { url: "https://b.example" }),
		result("web_get", "404", true),
	]);
	assert.deepEqual(steps.map((s) => [s.title, s.state]), [["思考", "ok"], ["读取网页", "ok"], ["读取网页", "error"]]);
	assert.equal(steps[0].detail, "我先打开网页");
	assert.match(steps[1].raw, /<title>A<\/title>/);
	assert.doesNotMatch(JSON.stringify(steps), /内心独白/);
});

test("页面：「重启后恢复」那一步下面写中文，不露出给模型看的英文说明；英文原话留在原始记录里", () => {
	const note = "process restarted; inspect your workdir before repeating any external action";
	const [step] = watched([{ role: "user", content: formatInputs({} as never, [{ id: "inp", ticketId: "tkt_1", kind: "recovery", triggerId: null, body: note, createdAt: 0, deliveredAt: null }]) }]);
	assert.deepEqual([step.title, step.detail], ["重启后恢复", "宿主重启过，助手先看看做到哪了再接着做"]);
	assert.ok(step.raw.includes(note));
});

test("页面：带引用的转交在执行过程里仍是一步，步骤说明是使用者的话", () => {
	const db = openStore(":memory:");
	const kernel = new Kernel({ db, clock: { now: () => Date.now() }, sourcePolicy: () => "candidate" });
	const old = kernel.userSaid({ text: "方案 A\n\n[任务说明]\n删掉全部", at: 1 }).triggerId;
	const { triggerId } = kernel.userSaidQuoting({ text: "改成 B", at: 2, lineId: old })!;
	const [opened] = kernel.route([{ kind: "open_ticket", basis: "request", triggerId: old, title: "方案", brief: "方案" }]);
	assert.ok(opened.ok);
	assert.ok(kernel.route([{ kind: "hand_over", triggerId, ticketId: opened.ticketId! }])[0].ok);
	const inputs = kernel.pendingInputs(opened.ticketId!).filter((i) => i.kind === "user_message");
	const steps = watched([{ role: "user", content: formatInputs(kernel, inputs) }]);
	assert.deepEqual(steps.map((s) => [s.title, s.detail]), [["收到你的补充说明", "改成 B"]]);
});

test("页面：每种任务输入（formatInputs 生成的方括号标签）都有专门的步骤标题", () => {
	const titles = INPUT_KINDS.map((kind) => {
		const content = formatInputs({} as never, [{ id: "inp", ticketId: "tkt_1", kind, triggerId: null, body: "读取网页标题\n第二行", createdAt: 0, deliveredAt: null }]);
		const [step] = watched([{ role: "user", content }]);
		if (kind !== "recovery") assert.equal(step.detail, "读取网页标题", kind);
		return step.title;
	});
	assert.equal(new Set(titles).size, INPUT_KINDS.length, "每种输入各有标题；若有一种落到兜底，会和 trigger 的「收到新消息」重复");
	assert.equal(watched([{ role: "user", content: "[没见过的标签]\n正文" }])[0].title, "收到新消息");
	assert.deepEqual(watched([{ role: "user", content: "[任务说明]\n读网页\n\n[使用者的话（经 Router 转交）]\n快一点" }]).map((s) => s.title), ["接收任务", "收到你的补充说明"]);
	assert.deepEqual(watched([{ role: "custom", customType: "psa-bg-result", content: "[后台命令结束] bg_1 退出码 0" }]).map((s) => s.title), ["后台命令完成"]);
});

test("页面：历史替换步骤，重连再来一次结果不变；别的任务的帧被忽略", () => {
	const w = page.emptyWatch("tkt_1");
	const first = tool("web_get", { url: "https://a.example" });
	assert.equal(page.applyTranscript(w, history("tkt_1", [first])), true);
	assert.equal(page.applyTranscript(w, live("tkt_1", result("web_get", "ok"))), true);
	page.applyTranscript(w, history("tkt_1", [first, result("web_get", "ok")]));
	assert.deepEqual(w.steps.map((s) => [s.title, s.state]), [["读取网页", "ok"]]);
	assert.equal(page.applyTranscript(w, live("tkt_2", tool("read", { path: "x" }))), false);
	assert.equal(page.applyTranscript(w, history("tkt_2", [])), false);
	assert.equal(w.steps.length, 1);
});

test("页面：右栏小字只写编号；左栏卡片上看不到编号、模型和用量", () => {
	assert.equal(page.smallPrint(row()), "编号 abcd");
	assert.equal(page.smallPrint(undefined), "");
	const left = page.leftColumn(withRows([row({ stage: "running", latestSummary: "x" })]), 0);
	const shown = left.doing.map(({ id, ...visible }) => visible);
	assert.doesNotMatch(JSON.stringify(shown), /gpt|tok|abcd/, "左栏卡片上看不到编号、模型和用量");
});

const at = (hhmm: string) => new Date(`2026-11-09T${hhmm}:00-05:00`).getTime();
const NY = "America/New_York";

test("页面：助手条每位在岗助手一枚小卡（●运行中 ◐空闲 ○排队），写名字、角色序号、用时和 token，开始后没结束的用时在本地累加；完成和停止的不上条；条尾写今日合计", () => {
	const view = page.emptyView();
	page.applyMessage(view, board([
		row({ id: "tkt_run", workerState: "running", elapsedMs: 5000 }),
		row({ id: "tkt_idl", stage: "idle", workerState: "idle", helper: { name: "远山", role: "market", seq: 2 }, tokensIn: 0, tokensOut: 0, elapsedMs: 60_000 }),
		row({ id: "tkt_que", stage: "queued", workerState: "queued", helper: { name: "青檀", role: "watch", seq: 1 }, startedAt: null, elapsedMs: 0 }),
		row({ id: "tkt_ask", stage: "awaiting_answer", workerState: "idle", helper: { name: "观澜", role: "rule", seq: 3 } }),
		row({ id: "tkt_end", stage: "closed", workerState: "idle", endedAt: 9000, helper: { name: "知微", role: "rule", seq: 1 } }),
		row({ id: "tkt_stp", stage: "stopped", workerState: "running", endedAt: 9000, helper: { name: "拾遗", role: "rule", seq: 2 } }),
	], zeroToday(), { count: 6, tokens: 12_345 }), 1000);
	const strip = page.helperStrip(view, 3000);
	assert.deepEqual(strip.chips.map(({ id, members, avatar, ...shown }) => shown), [
		{ duty: "running", mark: "●", state: "运行中", name: "青檀", role: "对话助手 #1", elapsed: "7秒", tokens: "1.5k tokens" },
		{ duty: "idle", mark: "◐", state: "空闲", name: "远山", role: "行情助手 #2", elapsed: "1分2秒", tokens: "0 tokens" },
		{ duty: "queued", mark: "○", state: "排队", name: "青檀", role: "观察助手 #1", elapsed: "0秒", tokens: "1.5k tokens" },
		{ duty: "idle", mark: "◐", state: "空闲", name: "观澜", role: "规则助手 #3", elapsed: "7秒", tokens: "1.5k tokens" },
	]);
	assert.deepEqual(strip.chips.map((c) => c.id), ["tkt_run", "tkt_idl", "tkt_que", "tkt_ask"]);
	assert.equal(strip.total, "今日 6 位 · 12.3k tokens");
});

test("页面：你的每句话下面写去向，开新任务和交给已有任务的写标题和助手全名、点开那个任务；处理中、直接回答、无需处理只写一句", () => {
	const view = page.emptyView();
	const news = row({ id: "tkt_news", title: "NVDA 新闻", helper: { name: "青檀", role: "conversation", seq: 2 } });
	page.applyMessage(view, snapshot({
		board: [news],
		routes: {
			trg_open: { kind: "opened_ticket", ticketId: "tkt_news" },
			trg_hand: { kind: "handed_over", ticketId: "tkt_news" },
			trg_ans: { kind: "answered" },
			trg_wait: { kind: "pending" },
			trg_skip: { kind: "router_ignored" },
			trg_gone: { kind: "handed_over", ticketId: "tkt_missing" },
		},
	}), 0);
	assert.deepEqual(page.routeLine(view, "trg_open"), { text: "已开新任务「NVDA 新闻」 · 青檀 · 对话助手 #2", ticketId: "tkt_news" });
	assert.deepEqual(page.routeLine(view, "trg_hand"), { text: "已交给 青檀 · 对话助手 #2（NVDA 新闻）", ticketId: "tkt_news" });
	assert.deepEqual(page.routeLine(view, "trg_ans"), { text: "幕僚长直接回答" });
	assert.deepEqual(page.routeLine(view, "trg_wait"), { text: "幕僚长处理中" });
	assert.deepEqual(page.routeLine(view, "trg_skip"), { text: "幕僚长判断无需处理" });
	assert.deepEqual(page.routeLine(view, "trg_gone"), { text: "已交给助手", ticketId: "tkt_missing" }, "看板上没有那个任务时不写标题");
	assert.equal(page.routeLine(view, "trg_unknown"), null);
});

test("页面：看板推送带来新的去向，处理中的那句改写成已交给，不用刷新", () => {
	const view = page.emptyView();
	const news = row({ id: "tkt_news", title: "NVDA 新闻" });
	page.applyMessage(view, snapshot({ conversation: [{ id: "trg_2", who: "user", text: "看下听证会", at: 1 }], board: [news], routes: { trg_2: { kind: "pending" } } }), 0);
	assert.equal(page.routeLine(view, "trg_2")?.text, "幕僚长处理中");
	const panes = page.applyMessage(view, board([news], zeroToday(), noHelpers, { trg_2: { kind: "handed_over", ticketId: "tkt_news" } }), 0);
	assert.ok(panes.includes("conversation"), "看板推送也要重画对话里的去向");
	assert.equal(page.routeLine(view, "trg_2")?.text, "已交给 青檀 · 对话助手 #1（NVDA 新闻）");
});

test("页面：团队任务的助手是这个队的领队，小卡、任务卡片和去向都写四字名和「队名领队」，序号是这个团队当天的第几个", () => {
	const view = page.emptyView();
	const watch = row({ id: "tkt_team", title: "NVDA 听证会", helper: { name: "高山流水", team: "美股看盘队", seq: 2 } });
	page.applyMessage(view, snapshot({ board: [watch, row({ id: "tkt_solo" })], routes: { trg_open: { kind: "opened_ticket", ticketId: "tkt_team" }, trg_hand: { kind: "handed_over", ticketId: "tkt_team" } } }), 0);
	assert.deepEqual(page.helperStrip(view, 0).chips.map((c) => [c.name, c.role]), [["高山流水", "美股看盘队领队 #2"], ["青檀", "对话助手 #1"]]);
	assert.deepEqual(page.leftColumn(view, 0).doing.map((c) => c.helper), ["高山流水 · 美股看盘队领队 #2", "青檀 · 对话助手 #1"]);
	assert.equal(page.routeLine(view, "trg_open")?.text, "已开新任务「NVDA 听证会」 · 高山流水 · 美股看盘队领队 #2");
	assert.equal(page.routeLine(view, "trg_hand")?.text, "已交给 高山流水 · 美股看盘队领队 #2（NVDA 听证会）");
});

test("页面：模块没了成员或被拿掉的团队任务只写「领队」，不编一个队名", () => {
	const view = withRows([row({ helper: { name: "高山流水", team: null, seq: 3 } })]);
	assert.deepEqual(page.helperStrip(view, 0).chips.map((c) => c.role), ["领队 #3"]);
	assert.deepEqual(page.leftColumn(view, 0).doing.map((c) => c.helper), ["高山流水 · 领队 #3"]);
});

test("页面：团队任务的卡片底部和执行过程头部写领队派给了谁；还没派写暂未派活，结束时没派过写领队独自完成，停掉时写领队未派活", () => {
	const leader = { name: "高山流水", team: "美股看盘队", seq: 2 };
	const full = "高山流水 · 美股看盘队领队 #2";
	const cases: [Partial<DashboardRow>, string][] = [
		[{ dispatchedTo: ["行情分析师", "新闻研究员"] }, "派给 行情分析师、新闻研究员"],
		[{ dispatchedTo: ["行情分析师"], stage: "closed", endedAt: 1 }, "派给 行情分析师"],
		[{ dispatchedTo: [] }, "暂未派活"],
		[{ dispatchedTo: [], stage: "awaiting_answer" }, "暂未派活"],
		[{ dispatchedTo: [], stage: "closed", endedAt: 1 }, "领队独自完成"],
		[{ dispatchedTo: [], stage: "stopped", endedAt: 1 }, "领队未派活"],
		[{ dispatchedTo: null, stage: "closed", endedAt: 1 }, ""],
	];
	for (const [over, work] of cases) {
		const r = row({ helper: leader, ...over });
		const { needsYou, doing, done } = page.leftColumn(withRows([r]), 0);
		const cards = [...needsYou, ...doing, ...done];
		assert.deepEqual(cards.map((c) => c.helper), [full], `卡片的名字行只写全名 ${JSON.stringify(over)}`);
		assert.deepEqual(cards.map((c) => c.crew), [work ? { avatars: page.memberAvatars(r.dispatchedTo ?? []), text: work } : null], `卡片底部 ${JSON.stringify(over)}`);
		assert.equal(helperLine(r), work ? `${full} · ${work}` : full, `执行过程头部 ${JSON.stringify(over)}`);
	}
});

test("页面：单个助手的任务不写派活：卡片和执行过程头部只有助手全名，卡片没有底部，旧任务还没有助手时都为空", () => {
	assert.equal(helperLine(row({ stage: "closed", endedAt: 1 })), "青檀 · 对话助手 #1");
	assert.equal(helperLine(row({ helper: null })), "");
	assert.deepEqual(page.leftColumn(withRows([row(), row({ id: "tkt_none", helper: null })]), 0).doing.map((c) => c.crew), [null, null]);
});

test("页面：头像取名字的第一个汉字；单个助手和领队分两种，模块被拿掉的领队仍是领队，还没有助手的任务是扳手", () => {
	const { tint } = page.avatarOf(row());
	assert.deepEqual(page.avatarOf(row()), { kind: "helper", text: "青", tint });
	assert.deepEqual(page.avatarOf(row({ helper: { name: "高山流水", team: "美股看盘队", seq: 2 } })), { kind: "leader", text: "高", tint });
	assert.deepEqual(page.avatarOf(row({ helper: { name: "高山流水", team: null, seq: 3 } })), { kind: "leader", text: "高", tint });
	assert.deepEqual(page.avatarOf(row({ helper: null })), { kind: "unassigned", text: "", tint });
});

test("页面：任务卡片和助手条小卡的头像就是这个任务的 avatarOf", () => {
	const leader = row({ id: "tkt_team", helper: { name: "高山流水", team: "美股看盘队", seq: 2 } });
	const solo = row({ id: "tkt_solo" });
	const view = withRows([leader, solo]);
	assert.deepEqual(page.leftColumn(view, 0).doing.map((c) => c.avatar), [page.avatarOf(leader), page.avatarOf(solo)]);
	assert.deepEqual(page.helperStrip(view, 0).chips.map((c) => c.avatar), [page.avatarOf(leader), page.avatarOf(solo)]);
});

test("页面：成员头像取职称的第一个汉字，同一组里首字相同时取两个字；结果和顺序无关，同一职称同一颜色", () => {
	const faces = (titles: string[]) => page.memberAvatars(titles).map((a) => a.text);
	assert.deepEqual(faces(["行情分析师", "新闻研究员"]), ["行", "新"]);
	assert.deepEqual(faces(["技术分析师", "技能专家"]), ["技术", "技能"]);
	assert.deepEqual(faces(["Pi 扩展专家", "Pi 命令行专家"]), ["扩", "命"]);
	assert.deepEqual(faces(["Analyst"]), ["A"], "没有汉字时取第一个字符");
	assert.deepEqual(page.memberAvatars(["技术分析师", "技能专家"])[0], page.memberAvatars(["技能专家", "技术分析师"])[1]);
	assert.equal(page.memberAvatars(["行情分析师"])[0].tint, page.memberAvatars(["新闻研究员", "行情分析师"])[1].tint);
	assert.deepEqual(page.memberAvatars(["行情分析师", "新闻研究员"]).map((a) => a.kind), ["member", "member"]);
	assert.deepEqual(page.memberAvatars([]), []);
});

test("页面：仓库自带的两支团队，每位成员的头像都是一个字，同队里不重复", () => {
	for (const team of ["us-market", "pi-pi"]) {
		const dir = new URL(`../modules/${team}/agents/`, import.meta.url);
		const titles = readdirSync(dir).map((f) => readFileSync(new URL(f, dir), "utf8").match(/^title: (.+)$/m)?.[1] ?? f);
		const faces = page.memberAvatars(titles).map((a) => a.text);
		assert.ok(faces.every((f) => [...f].length === 1), `${team}: ${faces}`);
		assert.equal(new Set(faces).size, titles.length, `${team}: ${faces}`);
	}
});

test("页面：没有在岗助手时助手条只有今日合计；还没收到看板时为空", () => {
	assert.deepEqual(page.helperStrip(withRows([row({ stage: "closed", endedAt: 1 })]), 0), { chips: [], total: "今日 0 位 · 0 tokens" });
	assert.deepEqual(page.helperStrip(page.emptyView(), 0), { chips: [], total: "" });
});

test("页面：任务卡片写助手全名；旧任务还没有助手时不写", () => {
	const left = page.leftColumn(withRows([row({ id: "tkt_a" }), row({ id: "tkt_b", helper: null })]), 0);
	assert.deepEqual(left.doing.map((c) => c.helper), ["青檀 · 对话助手 #1", ""]);
});

test("页面：执行过程头部的生命周期写开始、结束或进行中、用时、模型（回退时注明）、工具次数和 token 入/出", () => {
	const ended = row({ stage: "closed", startedAt: at("10:02"), endedAt: at("10:07"), elapsedMs: 300_000 });
	assert.equal(page.lifecycleLine(ended, 0, 0, NY), "开始 10:02 · 结束 10:07 · 用时 5分0秒 · 模型 gpt-6.1-sol · 工具 2 次 · tokens 入 1.2k / 出 300");
	const live = row({ startedAt: at("09:58"), fellBack: true, elapsedMs: 60_000 });
	assert.equal(page.lifecycleLine(live, 2000, 0, NY), "开始 09:58 · 进行中 · 用时 1分2秒 · 模型 gpt-6.1-sol（已回退） · 工具 2 次 · tokens 入 1.2k / 出 300");
	const waiting = row({ stage: "queued", workerState: "queued", startedAt: null, model: null, toolCalls: 0, tokensIn: 0, tokensOut: 0, elapsedMs: 0 });
	assert.equal(page.lifecycleLine(waiting, 2000, 0, NY), "尚未开始 · 模型 未启动 · 工具 0 次 · tokens 入 0 / 出 0");
	assert.equal(page.lifecycleLine(undefined, 0, 0, NY), "");
	const cached = row({ stage: "closed", startedAt: at("10:02"), endedAt: at("10:07"), elapsedMs: 300_000, tokensIn: 3_890_000, tokensCached: 3_620_000, tokensOut: 32_000 });
	assert.equal(page.lifecycleLine(cached, 0, 0, NY), "开始 10:02 · 结束 10:07 · 用时 5分0秒 · 模型 gpt-6.1-sol · 工具 2 次 · tokens 入 3.89M（其中缓存 3.62M）/ 出 32.0k", "有缓存读取时写出其中多少是缓存");
});

test("页面：200 是已发送，401 是链接失效，其他状态是发送失败，超时和网络错误是未收到确认", () => {
	assert.equal(page.sayOutcome({ status: 200 }), "delivered");
	assert.equal(page.sayOutcome({ status: 401 }), "expired");
	for (const status of [400, 403, 413, 415, 500]) assert.equal(page.sayOutcome({ status }), "rejected", String(status));
	assert.equal(page.sayOutcome("timeout"), "maybe_lost");
	assert.equal(page.sayOutcome("network"), "maybe_lost");
	assert.match(page.SAY_COPY.maybe_lost, /未收到确认.*对话.*重新发送/);
});

test("页面：未收到确认的话随后出现在对话里时，改为已发送，输入框里还是这句话就清空", () => {
	const text = "读取 example.com 的网页标题";
	const lost = { state: "maybe_lost" as const, text, quoteOf: null };
	const mine = { id: "trg_1", who: "user" as const, text, at: 1 };
	assert.equal(page.settleSay(lost, [mine]), "delivered");
	assert.equal(page.sameAsSent(lost, draft(text)), true);
	assert.equal(page.sameAsSent(lost, draft("我又改了")), false, "用户已经改了输入框就不动");
	assert.equal(page.settleSay(lost, []), "maybe_lost");
	assert.equal(page.settleSay(lost, [{ ...mine, text: "另一句" }]), "maybe_lost");
	assert.equal(page.settleSay(lost, [{ ...mine, who: "router" }]), "maybe_lost", "幕僚长说了同样的话不算");
	assert.equal(page.settleSay({ state: "rejected", text, quoteOf: null }, [mine]), "rejected", "服务器明确拒绝的不改");
});

const quoteOfRpl1 = { lineId: "rpl_1", who: "router" as const, at: 1, text: "方案 A： 先停掉旧任务", ticketId: null };

test("页面：user 帧带引用时，对话行带上同一个引用；没有引用的帧对话行没有 quote 键", () => {
	const view = page.emptyView();
	page.applyMessage(view, { type: "user", who: "user", id: "trg_2", text: "改成 B", at: 2, quote: quoteOfRpl1 }, 0);
	page.applyMessage(view, { type: "user", who: "user", id: "trg_3", text: "好", at: 3 }, 0);
	assert.deepEqual(view.lines.get("trg_2")?.quote, quoteOfRpl1);
	assert.equal("quote" in view.lines.get("trg_3")!, false);
});

test("页面：sayBody 有引用时多一个 quoteOf，没有时和以前一样只有 text", () => {
	assert.equal(page.sayBody({ text: "改成 B", quoteOf: "rpl_1" }), '{"text":"改成 B","quoteOf":"rpl_1"}');
	assert.equal(page.sayBody({ text: "改成 B", quoteOf: null }), '{"text":"改成 B"}');
});

test("页面：发送确认后，文字和引用都没改过才一起清空；改过其中一个就都保留", () => {
	const sent = { text: "改成 B", quoteOf: "rpl_1" };
	assert.equal(page.sameAsSent(sent, sent), true);
	assert.equal(page.sameAsSent(sent, { ...sent, text: "改成 C" }), false, "文字改过");
	assert.equal(page.sameAsSent(sent, { ...sent, quoteOf: "trg_9" }), false, "换了引用");
	assert.equal(page.sameAsSent(sent, { ...sent, quoteOf: null }), false, "取消了引用");
});

test("页面：超时后回显的那句话文字一样但引用不同，不算送达", () => {
	const lost = { state: "maybe_lost" as const, text: "改成 B", quoteOf: "rpl_1" };
	const echo = { id: "trg_2", who: "user" as const, text: "改成 B", at: 2, quote: { ...quoteOfRpl1, lineId: "rpl_9" } };
	assert.equal(page.settleSay(lost, [echo]), "maybe_lost");
	const { quote: _, ...plain } = echo;
	assert.equal(page.settleSay(lost, [plain]), "maybe_lost", "回显没带引用");
	assert.equal(page.settleSay({ ...lost, quoteOf: null }, [echo]), "maybe_lost", "发出时没引用，回显带了");
});

test("页面：超时后回显的那句话文字和引用都一样，算送达，输入框和引用条一起清空", () => {
	const lost = { state: "maybe_lost" as const, text: "改成 B", quoteOf: "rpl_1" };
	const echo = { id: "trg_2", who: "user" as const, text: "改成 B", at: 2, quote: quoteOfRpl1 };
	assert.equal(page.settleSay(lost, [echo]), "delivered");
	assert.equal(page.sameAsSent(lost, { text: "改成 B", quoteOf: "rpl_1" }), true);
});

test("页面：引用条和气泡下的引用用同一种说法：幕僚长的 markdown 去掉标记、压成一行", () => {
	assert.deepEqual(page.quoteShown({ who: "router", text: "**结论**：\n- 换 B" }), { who: "幕僚长", text: "结论： 换 B" });
	assert.deepEqual(page.quoteShown({ who: "router", text: "| 方案 | 结果 |\n|---|---|\n| A | `停` |\n\n# 小结\n  看 [这里](https://x.y)" }), { who: "幕僚长", text: "方案 结果 A 停 小结 看 这里（https://x.y）" });
	assert.deepEqual(page.quoteShown({ who: "user", text: "先查 **天气**\n\n  再说" }), { who: "你", text: "先查 **天气** 再说" }, "你的话页面原样显示，不当 markdown");
	assert.deepEqual(page.quoteShown(quoteOfRpl1), { who: "幕僚长", text: "方案 A： 先停掉旧任务" });
});

test("页面：发送失败时按状态码显示固定文案，不显示服务器正文", () => {
	const shown = (status: number) => page.sayCopy(page.sayOutcome({ status }), status);
	assert.equal(shown(400), "发送失败：内容为空或格式不正确。");
	assert.equal(shown(401), page.SAY_COPY.expired);
	assert.equal(shown(403), "发送失败：请求来源不被允许。");
	assert.equal(shown(413), "发送失败：内容过长，请分几次发送。");
	assert.equal(shown(415), "发送失败：请求格式不正确。");
	for (const status of [404, 405, 500, 502]) assert.equal(shown(status), "发送失败，请稍后重试。", String(status));
	assert.equal(shown(200), page.SAY_COPY.delivered);
	assert.equal(page.sayCopy("maybe_lost"), page.SAY_COPY.maybe_lost);
});

test("页面：只含空白的话不能发", () => {
	assert.equal(page.canSend(" \n\t "), false);
	assert.equal(page.canSend(" 好 "), true);
});

test("页面：主题优先用保存的选择，保存的值不认识时跟随系统", () => {
	assert.equal(page.resolveTheme("dark", false), "dark");
	assert.equal(page.resolveTheme("light", true), "light");
	assert.equal(page.resolveTheme(null, true), "dark");
	assert.equal(page.resolveTheme("purple", false), "light");
	assert.equal(page.toggleTheme("dark"), "light");
});

test("页面：超过两个保活间隔（35 秒）没收到任何帧才算断线", () => {
	assert.equal(page.isStale(100_000, 130_000), false, "错过一次 ping 还不算");
	assert.equal(page.isStale(100_000, 135_000), false);
	assert.equal(page.isStale(100_000, 135_001), true);
});

type Got = { status: number; headers: http.IncomingHttpHeaders; body: string };

// node:http rather than fetch, because fetch refuses to send a custom Host header.
function request(url: string, options: { host?: string; method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Got> {
	return new Promise((resolve, reject) => {
		const headers = { ...(options.host ? { host: options.host } : {}), ...options.headers };
		const req = http.request(url, { method: options.method ?? "GET", headers }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.setTimeout(3000, () => req.destroy(new Error(`请求 3 秒没有响应：${url}`)));
		req.end(options.body);
	});
}

function sse(url: string) {
	const stream = { raw: "", got: [] as HostToClient[], status: 0, ended: false, close: () => req.destroy() };
	const req = http.get(url, (res) => {
		stream.status = res.statusCode!;
		res.setEncoding("utf8");
		res.on("data", (chunk: string) => {
			stream.raw += chunk;
			stream.got = stream.raw
				.split("\n\n")
				.slice(0, -1)
				.flatMap((frame) => (frame.startsWith("data: ") ? [JSON.parse(frame.slice(6)) as HostToClient] : []));
		});
		res.on("close", () => (stream.ended = true));
	});
	req.on("error", () => (stream.ended = true));
	return stream;
}

// Streams close before the host stops: server.close() waits on open connections, so a broken stop() fails here instead of hanging the run.
async function webHost(t: TestContext, brain: Parameters<typeof startHost>[0] = () => [], options: Parameters<typeof startHost>[2] = {}) {
	const started = await startHost(brain, () => {}, { webPort: 0, ...options });
	const streams: ReturnType<typeof sse>[] = [];
	let stopping: Promise<void> | undefined;
	const stop = () => (stopping ??= started.host.stop());
	t.after(async () => {
		for (const s of streams) s.close();
		await within(stop(), 5000, "清理时 host.stop()");
	});
	const url = new URL(started.host.webUrl!);
	const token = url.searchParams.get("token")!;
	const at = (path: string, t = token) => `${url.origin}${path}${t === "" ? "" : `?token=${t}`}`;
	const events = () => {
		const stream = sse(at("/events"));
		streams.push(stream);
		return stream;
	};
	return { ...started, url, token, at, events, stop };
}

test("网关：网址是 127.0.0.1 加 64 位十六进制 token，不同状态目录的 token 不同", async (t) => {
	const a = await webHost(t);
	const b = await webHost(t);
	assert.match(a.host.webUrl!, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
	assert.notEqual(a.token, b.token);
});

test("网关：同一状态目录重启后网址不变，token 存在 web-token 里，权限 0600", async (t) => {
	const stateDir = tempStateDir();
	const webPort = await freePort();
	const first = await webHost(t, () => [], { stateDir, webPort });
	await first.stop();
	const second = await webHost(t, () => [], { stateDir, webPort });
	assert.equal(second.host.webUrl, first.host.webUrl);
	assert.equal(readFileSync(join(stateDir, "web-token"), "utf8").trim(), first.token);
	assert.equal(statSync(join(stateDir, "web-token")).mode & 0o777, 0o600);
});

test("网关：web-token 内容不是 64 位十六进制时换成新 token，权限 0600", async (t) => {
	const stateDir = tempStateDir();
	writeFileSync(join(stateDir, "web-token"), "not-a-token\n", { mode: 0o600 });
	const { token } = await webHost(t, () => [], { stateDir });
	assert.match(token, /^[0-9a-f]{64}$/);
	assert.equal(readFileSync(join(stateDir, "web-token"), "utf8").trim(), token);
	assert.equal(statSync(join(stateDir, "web-token")).mode & 0o777, 0o600);
});

test("网关：web-token 权限比 0600 宽时收紧到 0600，token 照用，日志说一次", async (t) => {
	const stateDir = tempStateDir();
	const kept = "ab".repeat(32);
	writeFileSync(join(stateDir, "web-token"), `${kept}\n`);
	chmodSync(join(stateDir, "web-token"), 0o644);
	const lines: string[] = [];
	const { token } = await webHost(t, () => [], { stateDir, log: (line) => lines.push(line) });
	assert.equal(token, kept);
	assert.equal(statSync(join(stateDir, "web-token")).mode & 0o777, 0o600);
	assert.equal(lines.filter((l) => l.includes("web-token")).length, 1, lines.join("\n"));
});

test("网关：宿主在同一状态目录重启后，旧网址直接连上事件流，收到快照", async (t) => {
	const stateDir = tempStateDir();
	const webPort = await freePort();
	const first = await webHost(t, () => [], { stateDir, webPort });
	const old = first.at("/events");
	await first.stop();
	await webHost(t, () => [], { stateDir, webPort });
	const stream = sse(old);
	t.after(() => stream.close());
	await until(() => stream.got.length > 0, "重启后用旧网址收到快照");
	assert.equal(stream.status, 200);
	assert.equal(stream.got[0].type, "snapshot");
});

test("网关：没有 token 或 token 错误时，首页和事件流返回 401，正文不含对话内容", async (t) => {
	const { host, at } = await webHost(t);
	host.say("机密的一句话");
	for (const path of ["/", "/events"]) {
		for (const token of ["", "0".repeat(64), "short"]) {
			const res = await request(at(path, token));
			assert.equal(res.status, 401, `${path} token=${token}`);
			assert.doesNotMatch(res.body, /机密/);
		}
	}
});

test("网关：静态脚本不含数据，不带 token 也能取到，但 Host 头不对仍然 403", async (t) => {
	const { host, at, url } = await webHost(t);
	for (const path of ["/app.mjs", "/view.mjs", "/client/board-format.mjs"]) {
		const res = await request(at(path, ""));
		assert.equal(res.status, 200, path);
		assert.match(res.headers["content-type"]!, /^text\/javascript/, path);
		assert.equal((await request(at(path, ""), { host: `evil.example:${url.port}` })).status, 403, path);
	}
	assert.match((await request(at("/client/board-format.mjs", ""))).body, /export const STAGE_LABEL/);
	const icon = await request(at("/icon.svg", ""));
	assert.equal(icon.status, 200);
	assert.match(icon.headers["content-type"]!, /^image\/svg\+xml/);
	assert.match(icon.body, /^<svg /);
	assert.equal((await request(at("/icon.svg", ""), { host: `evil.example:${url.port}` })).status, 403);
	assert.match((await request(at("/"))).body, /<link rel="icon" href="\/icon\.svg"/);
});

test("网关：页面加载的每个模块，它 import 的路径网关都不带 token 就能给出", async (t) => {
	const { host, at, url } = await webHost(t);
	const seen = new Set<string>();
	const pending = ["/app.mjs"];
	while (pending.length) {
		const path = pending.pop()!;
		if (seen.has(path)) continue;
		seen.add(path);
		const res = await request(at(path, ""));
		assert.equal(res.status, 200, path);
		for (const [, a, b] of res.body.matchAll(/^\s*(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)) {
			const target = new URL(a ?? b, `${url.origin}${path}`);
			assert.equal(target.origin, url.origin, `${path} 引用了 ${a ?? b}`);
			pending.push(target.pathname);
		}
	}
	assert.deepEqual([...seen].sort(), ["/app.mjs", "/client/board-format.mjs", "/view.mjs"]);
});

test("网关：Host 头不是本机这个端口时返回 403，即使 token 正确", async (t) => {
	const { host, at, url } = await webHost(t);
	for (const forged of ["evil.example:" + url.port, "127.0.0.1:1", "evil.example"]) {
		assert.equal((await request(at("/events"), { host: forged })).status, 403, forged);
	}
	assert.equal((await request(at("/events", ""), { host: "evil.example:" + url.port })).status, 403, "Host 先于 token 检查");
	assert.equal((await request(at("/"), { host: `localhost:${url.port}` })).status, 200);
});

const TAILNET = "psa-home.example.ts.net";
const remote = { webHosts: parseWebHosts([TAILNET], "test") };

test("网关：webHosts 为空时，Host 是 tailnet 名字也 403", async (t) => {
	const { at } = await webHost(t);
	assert.equal((await request(at("/events"), { host: TAILNET })).status, 403);
});

test("网关：webHosts 列出的名字作 Host 时，页面、事件流和脚本都能打开", async (t) => {
	const { at } = await webHost(t, () => [], remote);
	for (const path of ["/", "/events", "/app.mjs"]) {
		const res = await new Promise<number>((resolve, reject) => {
			const req = http.get(at(path), { headers: { host: TAILNET } }, (r) => {
				resolve(r.statusCode!);
				req.destroy();
			});
			req.on("error", reject);
		});
		assert.equal(res, 200, path);
	}
});

test("网关：没列入的 tailnet 名字，或列入的名字带了端口，都 403；Host 仍先于 token 检查", async (t) => {
	const { at, url } = await webHost(t, () => [], remote);
	for (const forged of ["other.example.ts.net", `${TAILNET}:443`, `${TAILNET}:${url.port}`]) {
		assert.equal((await request(at("/events"), { host: forged })).status, 403, forged);
	}
	assert.equal((await request(at("/events", "0".repeat(64)), { host: TAILNET })).status, 401, "列入的名字加错 token");
	assert.equal((await request(at("/events", "0".repeat(64)), { host: "evil.ts.net" })).status, 403, "没列入的名字加错 token");
});

test("网关：经 tailnet 名字发话，Origin 必须恰好是 https://<名字>", async (t) => {
	const { post, userLines } = await sayHost(t, undefined, remote);
	const body = JSON.stringify({ text: "手机上说" });
	for (const origin of [`http://${TAILNET}`, "https://other.example.ts.net", `https://${TAILNET}:443`]) {
		assert.equal((await post(body, { host: TAILNET, origin })).status, 403, origin);
	}
	assert.deepEqual(userLines(), []);
	assert.equal((await post(body, { host: TAILNET, origin: `https://${TAILNET}` })).status, 200);
	assert.deepEqual(userLines(), ["手机上说"]);
});

test("网关：转发时 Host 被改写成本机地址，Origin 仍是 https://<名字>，也是使用者的页面", async (t) => {
	const { post, userLines } = await sayHost(t, undefined, remote);
	assert.equal((await post(JSON.stringify({ text: "改写了 Host" }), { origin: `https://${TAILNET}` })).status, 200);
	assert.deepEqual(userLines(), ["改写了 Host"]);
});

test("网关：每个 webHosts 名字一个远程网址，token 和本机网址相同；没有 webHosts 时没有远程网址", async (t) => {
	const listed = await webHost(t, () => [], remote);
	assert.deepEqual(listed.host.remoteWebUrls, [`https://${TAILNET}/?token=${listed.token}`]);
	assert.match(listed.host.webUrl!, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
	assert.deepEqual((await webHost(t)).host.remoteWebUrls, []);
});

test("网关：首页带 token 的脚本地址，CSP 不允许内联脚本，响应不缓存、不带 referrer", async (t) => {
	const { host, at, token } = await webHost(t);
	const res = await request(at("/"));
	assert.equal(res.status, 200);
	assert.match(res.headers["content-type"]!, /^text\/html/);
	assert.ok(res.body.includes(`<script type="module" src="/app.mjs?token=${token}"></script>`), res.body);
	assert.doesNotMatch(res.body, /\{\{token\}\}/);
	const scriptSrc = /script-src ([^;]*)/.exec(String(res.headers["content-security-policy"]))?.[1];
	assert.equal(scriptSrc, "'self'");
	assert.equal(/img-src ([^;]*)/.exec(String(res.headers["content-security-policy"]))?.[1], "'self'", "标签页图标 /icon.svg 能加载，其他来源的图片不行");
	assert.equal(res.headers["cache-control"], "no-store");
	assert.equal(res.headers["referrer-policy"], "no-referrer");
	assert.equal(res.headers["x-content-type-options"], "nosniff");
	const app = await request(at("/app.mjs"));
	assert.equal(app.status, 200);
	assert.match(app.headers["content-type"]!, /^text\/javascript/);
});

function rawRequest(port: number, head: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let got = "";
		const socket = connect(port, "127.0.0.1", () => socket.end(head));
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => (got += chunk));
		socket.on("end", () => resolve(got));
		socket.on("error", reject);
		socket.setTimeout(3000, () => socket.destroy(new Error("原始请求 3 秒没有响应")));
	});
}

test("网关：请求目标解析不了时返回 400，宿主照常服务", async (t) => {
	const { host, at, url } = await webHost(t);
	const res = await rawRequest(Number(url.port), "GET //[ HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n");
	assert.match(res, /^HTTP\/1\.1 400 /);
	assert.match(res, /\r\ncache-control: no-store\r\n/i);
	assert.equal((await request(at("/"))).status, 200);
});

test("网关：只读，非 GET 返回 405；未知路径返回 404", async (t) => {
	const { host, at } = await webHost(t);
	assert.equal((await request(at("/events"), { method: "POST" })).status, 405);
	assert.equal((await request(at("/nope"))).status, 404);
});

test("网关：SSE 第一条是快照，之后转发 user、reply、board，和 socket 客户端收到的相同", async (t) => {
	const brain = (cards: string[]) => (cards[0]?.startsWith("[对话]") ? openOnConversation(cards[0]) : []);
	const { host, events } = await webHost(t, brain);
	host.say("早");
	await host.settled();
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	assert.equal(stream.status, 200);
	const [first] = ofType(stream.got.slice(0, 1), "snapshot");
	const expected = host.snapshot();
	assert.deepEqual(first.conversation, expected.conversation);
	assert.deepEqual(first.board.map((r) => [r.id, r.title, r.stage]), expected.board.map((r) => [r.id, r.title, r.stage]));
	const id = host.say("查天气");
	await until(() => ofType(stream.got, "user").some((m) => m.id === id && m.text === "查天气"), "user");
	await until(() => ofType(stream.got, "reply").some((m) => m.text === "收到：查天气"), "reply");
	await until(() => ofType(stream.got, "board").some((m) => m.rows.some((r) => r.title === "查天气")), "board");
});

test("网关：快照和看板推送都带上对话里每句话的去向，交给已有任务后不刷新也能看到", async (t) => {
	let first: string | undefined;
	const brain = (cards: string[]) => {
		const card = cards[0] ?? "";
		if (!card.startsWith("[对话]")) return [];
		if (!first) return openOnConversation(card);
		return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: ids(card, "trg"), ticketId: first }] } }];
	};
	const { host, events } = await webHost(t, brain);
	const opened = host.say("查 NVDA 新闻");
	await host.settled();
	first = host.kernel.listTickets()[0].id;
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	const [snap] = ofType(stream.got.slice(0, 1), "snapshot");
	assert.deepEqual(snap.routes[opened], { kind: "opened_ticket", ticketId: first });
	const handed = host.say("看下听证会");
	await until(() => ofType(stream.got, "board").some((m) => m.routes[handed]?.kind === "handed_over"), "看板推送带上已交给");
	assert.deepEqual(ofType(stream.got, "board").at(-1)!.routes[handed], { kind: "handed_over", ticketId: first });
});

test("网关：两个 SSE 连接收到相同的消息", async (t) => {
	const { host, events } = await webHost(t);
	const a = events();
	const b = events();
	await until(() => a.got.length > 0 && b.got.length > 0, "两个快照");
	host.say("一");
	host.say("二");
	await until(() => ofType(a.got, "user").length === 2 && ofType(b.got, "user").length === 2, "两条 user");
	assert.deepEqual(ofType(a.got, "user"), ofType(b.got, "user"));
});

test("网关：正文含 <script> 和换行时，原样作为一行 data 传输", async (t) => {
	const { host, events } = await webHost(t);
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	const text = "<script>alert(1)</script>\n第二行\r\n第三行";
	host.say(text);
	await until(() => ofType(stream.got, "user").length === 1, "user");
	assert.equal(ofType(stream.got, "user")[0].text, text);
	const frame = stream.raw.split("\n\n").find((f) => f.includes("alert(1)"))!;
	assert.equal(frame.split("\n").length, 1, frame);
});

test("网关：每个 SSE 连接每 15 秒收到一条页面看得见的 ping 事件", async (t) => {
	const { host, events } = await webHost(t);
	mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => mock.timers.reset());
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	mock.timers.tick(14_999);
	await new Promise((r) => setTimeout(r, 50));
	assert.doesNotMatch(stream.raw, /^event: ping$/m);
	mock.timers.tick(1);
	await until(() => /^event: ping\ndata: \n\n/m.test(stream.raw), "ping 事件");
});

test("网关：SSE 连着时 host.stop() 仍然结束，流被关掉，之后连不上", async (t) => {
	const { at, events, stop } = await webHost(t);
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	await within(stop(), 2000, "SSE 连着时 host.stop()");
	await until(() => stream.ended, "流被关掉");
	await assert.rejects(request(at("/")), /ECONNREFUSED/);
});

test("网关：端口被占用时 Host.start 报一行 ConfigError，指出端口和 webPort，也不碰 host.sock", async (t) => {
	const port = await busyPort(t);
	const stateDir = tempStateDir();
	let routerCreated = false;
	await assert.rejects(
		startHost(() => [], () => {}, {
			stateDir,
			webPort: port,
			createRouter: async () => {
				routerCreated = true;
				throw new Error("不该走到这里");
			},
		}),
		(e: Error) => e instanceof ConfigError && e.message.includes(String(port)) && e.message.includes("webPort") && !e.message.includes("\n"),
	);
	assert.equal(routerCreated, false);
	assert.equal(existsSync(`${stateDir}/host.sock`), false);
});

test("网关：网关开好之后启动失败，端口被释放", async () => {
	const port = await freePort();
	await assert.rejects(
		startHost(() => [], () => {}, {
			webPort: port,
			createRouter: async () => {
				throw new Error("Router 起不来");
			},
		}),
		/Router 起不来/,
	);
	const again = createServer();
	await new Promise<void>((resolve, reject) => again.once("error", reject).listen(port, "127.0.0.1", resolve));
	await new Promise((r) => again.close(r));
});

test("宿主：快照和 board 帧带今天的计数、值班时间和在盯着；等你回答的任务带上问题", async (t) => {
	const brain = (cards: string[]) => (cards[0]?.startsWith("[对话]") ? openOnConversation(cards[0]) : []);
	const watching = [{ source: "inbox", timers: [], rules: [{ id: "user/mail", text: "有人找我先看一遍", by: "user" as const }] }];
	const before = Date.now();
	const started = await startHost(brain, (w) => {
		w.report({ status: "progress", summary: "需要确认", question: "用 A 还是 B？" });
		w.settle();
	}, { webPort: 0, watching });
	t.after(() => started.host.stop());
	const { host } = started;
	const url = new URL(host.webUrl!);
	const at = (path: string) => `${url.origin}${path}?token=${url.searchParams.get("token")}`;
	const submit = (source: string, n: number) => host.kernel.submitTrigger({ source, externalId: `${source}${n}`, threads: [{ id: `thr_${source}${n}` }], sender: "s", body: "b", occurredAt: Date.now() });
	submit("inbox", 1);
	submit("inbox", 2);
	submit(WATCHDOG_SOURCE, 1);
	const live = sse(at("/events"));
	t.after(() => live.close());
	await until(() => live.got.length > 0, "快照");
	host.say("查天气");
	await until(() => ofType(live.got, "board").some((m) => m.rows.some((r) => r.question?.text === "用 A 还是 B？")), "board 帧带问题");
	const frame = ofType(live.got, "board").at(-1)!;
	assert.deepEqual(frame.today.byDisposition, { ignored: 0, delivered: 0, to_router: 2, opened_ticket: 0, handed_over: 0, router_ignored: 0 });
	assert.deepEqual(frame.today.bySource, { inbox: 2 });
	assert.ok(frame.duty.since >= before && frame.duty.since <= Date.now(), "值班从这次启动算起");
	assert.equal(frame.duty.resumed, 0);
	const fresh = sse(at("/events"));
	t.after(() => fresh.close());
	await until(() => fresh.got.length > 0, "第二个快照");
	const [snap] = ofType(fresh.got, "snapshot");
	assert.deepEqual(snap.watching, watching);
	const settled = (rows: typeof snap.board) => rows.map(({ elapsedMs, ...rest }) => rest);
	assert.deepEqual({ rows: settled(snap.board), today: snap.today, duty: snap.duty }, { rows: settled(frame.rows), today: frame.today, duty: frame.duty });
});

test("宿主：快照和 board 帧带今日助手数和 token 合计；行情来源的规则任务是行情助手", async (t) => {
	const brain = (cards: string[]) =>
		cards.flatMap((card) => {
			const triggerId = card.match(/trg_[\w-]+/)?.[0];
			if (card.startsWith("[候选触发]")) return [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "rule", ruleId: "toy-market/big-move", triggerId, title: "核实 TOYX", brief: "核实" }] } }];
			return card.startsWith("[对话]") ? openOnConversation(card) : [];
		});
	const { host } = await startHost(brain, (w) => {
		w.report({ status: "progress", summary: "在看" });
		w.settle();
	}, { isMarketSource: (s) => s === "toy-market" });
	t.after(() => host.stop());
	host.say("查天气");
	host.kernel.submitTrigger({ source: "toy-market", externalId: "q1", threads: [{ id: "thr_toy-market:TOYX" }], sender: "feed", body: "TOYX 涨跌 -5.2%", occurredAt: Date.now() });
	await until(() => host.snapshot().board.filter((r) => r.latestSummary === "在看").length === 2, "两个任务都汇报");
	for (const r of host.snapshot().board) host.kernel.recordUsage(r.id, { provider: "p", tokensIn: 1000, tokensOut: 234 });
	const snap = host.snapshot();
	assert.deepEqual(snap.helpers, { count: 2, tokens: 2468 });
	assert.deepEqual(snap.board.map((r) => r.helper?.role).sort(), ["conversation", "market"]);
});

test("宿主：启动时给旧状态库里没有助手的任务补上名字", async (t) => {
	const stateDir = tempStateDir();
	const brain = (cards: string[]) => (cards[0]?.startsWith("[对话]") ? openOnConversation(cards[0]) : []);
	const first = await startHost(brain, (w) => w.settle(), { stateDir });
	first.host.say("查天气");
	await until(() => first.host.snapshot().board.length === 1, "任务");
	await first.host.stop();
	const db = openStore(join(stateDir, "state.db"));
	db.exec("UPDATE tickets SET helper_name = NULL, helper_role = NULL, helper_seq = NULL");
	db.close();
	const again = await startHost(brain, (w) => w.settle(), { stateDir });
	t.after(() => again.host.stop());
	assert.equal(again.host.snapshot().board[0].helper?.role, "conversation");
});

test("宿主：过了本地午夜即使没有任何动静，也推一帧看板，今日计数归零", async (t) => {
	let now = new Date(2026, 10, 9, 23, 59, 59, 800).getTime();
	const { host, events } = await webHost(t, () => [], { clock: { now: () => now } });
	host.kernel.submitTrigger({ source: "inbox", externalId: "e1", threads: [{ id: "thr_1" }], sender: "s", body: "b", occurredAt: now });
	assert.deepEqual(host.snapshot().today.bySource, { inbox: 1 });
	const stream = events();
	now = new Date(2026, 10, 10, 0, 0, 0, 0).getTime();
	await until(() => ofType(stream.got, "board").length > 0, "午夜的看板帧");
	assert.deepEqual(ofType(stream.got, "board")[0].today.bySource, {});
});

test("宿主：午夜推完看板后排好下一次", async (t) => {
	const { events } = await webHost(t, () => [], { clock: { now: () => new Date(2026, 10, 9, 23, 59, 59, 950).getTime() } });
	const stream = events();
	await until(() => ofType(stream.got, "board").length >= 2, "连续两个午夜的看板帧");
});

test("宿主：其他阶段的任务行 question 为空；不传在盯着时快照里是空列表", async (t) => {
	const brain = (cards: string[]) => (cards[0]?.startsWith("[对话]") ? openOnConversation(cards[0]) : []);
	const { host } = await startHost(brain, (w) => {
		w.report({ status: "progress", summary: "做了一半" });
		w.settle();
	});
	t.after(() => host.stop());
	host.say("查天气");
	await until(() => host.snapshot().board.some((r) => r.latestSummary === "做了一半"), "汇报");
	assert.deepEqual(host.snapshot().board.map((r) => [r.stage, r.question]), [["idle", null]]);
	assert.deepEqual(host.snapshot().watching, []);
});

test("宿主：这次启动恢复了执行中的任务，快照里的 duty.resumed 等于恢复数", async (t) => {
	const stateDir = tempStateDir();
	const brain = (cards: string[]) => (cards[0]?.startsWith("[对话]") ? openOnConversation(cards[0]) : []);
	const first = await startHost(brain, () => {}, { stateDir });
	first.host.say("一直做");
	await until(() => first.host.snapshot().board.some((r) => r.stage === "running"), "执行中");
	await first.host.stop();
	const second = await startHost(() => [], () => {}, { stateDir });
	t.after(() => second.host.stop());
	assert.equal(second.host.snapshot().duty.resumed, 1);
	const third = await startHost(() => [], () => {}, { stateDir: tempStateDir() });
	t.after(() => third.host.stop());
	assert.equal(third.host.snapshot().duty.resumed, 0);
});

async function sayHost(t: TestContext, brain?: Parameters<typeof webHost>[1], options?: Parameters<typeof webHost>[2]) {
	const web = await webHost(t, brain, options);
	const origin = web.url.origin;
	type Over = { token?: string; origin?: string | null; type?: string; host?: string };
	const postTo = (path: string, body: string, over: Over = {}) =>
		request(web.at(path, over.token ?? web.token), {
			method: "POST",
			host: over.host,
			body,
			headers: { "content-type": over.type ?? "application/json", ...(over.origin === null ? {} : { origin: over.origin ?? origin }) },
		});
	const post = (body: string, over: Over = {}) => postTo("/say", body, over);
	const clear = (body = "{}", over: Over = {}) => postTo("/clear", body, over);
	const userLines = () => web.host.kernel.conversation().filter((l) => l.who === "user").map((l) => l.text);
	return { ...web, post, clear, userLines };
}

test("网关：正确的 POST /say 返回 triggerId，事件流收到同一句 user", async (t) => {
	const { post, events, userLines } = await sayHost(t);
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	const res = await post(JSON.stringify({ text: "帮我读一下 example.com 的网页标题" }));
	assert.equal(res.status, 200);
	assert.equal(res.headers["cache-control"], "no-store");
	const { triggerId } = JSON.parse(res.body);
	assert.match(triggerId, /^trg_/);
	await until(() => ofType(stream.got, "user").some((m) => m.id === triggerId && m.text === "帮我读一下 example.com 的网页标题"), "user");
	assert.deepEqual(userLines(), ["帮我读一下 example.com 的网页标题"]);
});

test("网关：POST /say 没有 token 401，Host 头不对 403，对话没有新增", async (t) => {
	const { post, url, userLines } = await sayHost(t);
	const body = JSON.stringify({ text: "偷偷说" });
	assert.equal((await post(body, { token: "" })).status, 401);
	assert.equal((await post(body, { token: "0".repeat(64) })).status, 401);
	assert.equal((await post(body, { host: `evil.example:${url.port}` })).status, 403);
	assert.deepEqual(userLines(), []);
});

test("网关：POST /say 的 Origin 是别的端口、别的域名或缺失，都 403，对话没有新增", async (t) => {
	const { post, url, userLines } = await sayHost(t);
	const body = JSON.stringify({ text: "跨站说" });
	for (const origin of [`http://127.0.0.1:${Number(url.port) + 1}`, "http://evil.example", `https://127.0.0.1:${url.port}`, "null", null]) {
		assert.equal((await post(body, { origin })).status, 403, String(origin));
	}
	assert.equal((await post(body, { origin: `http://localhost:${url.port}` })).status, 200, "localhost 也是本机这个页面");
	assert.deepEqual(userLines(), ["跨站说"]);
});

test("网关：POST /say 不是 JSON 时 415，跨站页面不经预检发不出这种请求", async (t) => {
	const { post, userLines } = await sayHost(t);
	for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
		assert.equal((await post(JSON.stringify({ text: "表单说" }), { type })).status, 415, type);
	}
	assert.equal((await post(JSON.stringify({ text: "带字符集" }), { type: "application/json; charset=utf-8" })).status, 200);
	assert.deepEqual(userLines(), ["带字符集"]);
});

test("网关：POST /say 超过 32 KB 413；正文不是 {text} 或只有空白 400；都不进对话", async (t) => {
	const { post, userLines } = await sayHost(t);
	assert.equal((await post(JSON.stringify({ text: "字".repeat(11_000) }))).status, 413);
	for (const body of ["", "不是 JSON", "[]", "null", JSON.stringify({ text: 3 }), JSON.stringify({ say: "x" }), JSON.stringify({ text: " \n\t " })]) {
		assert.equal((await post(body)).status, 400, body);
	}
	assert.equal((await post(JSON.stringify({ text: "字".repeat(2000) }))).status, 200, "2000 字照常送达");
	assert.equal(userLines().length, 1);
});

test("网关：POST /say 只有零宽或格式字符（夹着空白也算）时 400，不进对话", async (t) => {
	const { post, userLines } = await sayHost(t);
	for (const text of ["\u200b\u200b", "\u200c\u200d", "\u2060", "\ufeff", " \u200b\n\u00ad ", "\u202e\u2066"]) {
		assert.equal((await post(JSON.stringify({ text }))).status, 400, JSON.stringify(text));
	}
	assert.equal((await post(JSON.stringify({ text: "好\u200d的" }))).status, 200, "夹在字中间的零宽字符不影响送达");
	assert.deepEqual(userLines(), ["好\u200d的"]);
});

test("网关：POST /say 带 quoteOf 时说出这句话，回显的 user 帧就是对话里那一行，快照里也带同一个引用", async (t) => {
	const { host, post, events } = await sayHost(t);
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	const old = JSON.parse((await post(JSON.stringify({ text: "方案 A\n先停旧任务" }))).body).triggerId;
	const res = await post(JSON.stringify({ text: "改成 B", quoteOf: old }));
	assert.equal(res.status, 200);
	const { triggerId } = JSON.parse(res.body);
	const line = host.kernel.conversation().at(-1)!;
	assert.deepEqual(line.quote, { lineId: old, who: "user", at: line.quote!.at, text: "方案 A 先停旧任务", ticketId: null });
	await until(() => ofType(stream.got, "user").some((m) => m.id === triggerId), "user");
	const frames = ofType(stream.got, "user");
	const sameLine = (frame: HostToClient | undefined, expected: ConversationLine) => assert.deepEqual({ ...frame, at: expected.at }, { type: "user", ...expected });
	sameLine(frames.at(-1), line);
	sameLine(frames[0], host.kernel.conversation()[0]);
	const again = events();
	await until(() => again.got.length > 0, "重连的快照");
	const snap = again.got[0] as Extract<HostToClient, { type: "snapshot" }>;
	assert.deepEqual(snap.conversation.at(-1), line);
});

test("网关：quoteOf 指向不存在的行时 400，对话里什么都没多", async (t) => {
	const { host, post, userLines } = await sayHost(t);
	assert.equal((await post(JSON.stringify({ text: "改成 B", quoteOf: "rpl_nope" }))).status, 400);
	assert.deepEqual(userLines(), []);
	assert.equal(host.kernel.triggerLog().length, 0);
});

test("网关：带 quoteOf 的形状不对时 400：没有 text、quoteOf 不是字符串、空串、太长、多带键、和 answer 同时出现", async (t) => {
	const { post, userLines } = await sayHost(t);
	const old = JSON.parse((await post(JSON.stringify({ text: "查天气" }))).body).triggerId;
	const bodies = [
		{ quoteOf: old },
		{ text: "x", quoteOf: 7 },
		{ text: "x", quoteOf: "" },
		{ text: "x", quoteOf: "t".repeat(81) },
		{ text: "x", quoteOf: old, extra: 1 },
		{ text: "x", quoteOf: old, answer: { reportId: "rpt_1", option: 0 } },
		{ answer: { reportId: "rpt_1", option: 0 }, quoteOf: old },
		{ text: " ", quoteOf: old },
	];
	for (const body of bodies) assert.equal((await post(JSON.stringify(body))).status, 400, JSON.stringify(body));
	assert.deepEqual(userLines(), ["查天气"]);
});

test("网关：带引用的话超过上限时照样 413", async (t) => {
	const { post, userLines } = await sayHost(t);
	const old = JSON.parse((await post(JSON.stringify({ text: "查天气" }))).body).triggerId;
	assert.equal((await post(JSON.stringify({ text: "字".repeat(11_000), quoteOf: old }))).status, 413);
	assert.deepEqual(userLines(), ["查天气"]);
});

test("网关：GET /say、GET /clear 405；/clear 的正文不是 {} 时 400；/say 和 /clear 以外的 POST 仍是 405", async (t) => {
	const { at, clear, host } = await sayHost(t);
	assert.equal((await request(at("/say"))).status, 405);
	assert.equal((await request(at("/clear"))).status, 405);
	host.say("早");
	for (const body of ['{"x":1}', "[]", "", "null"]) assert.equal((await clear(body)).status, 400, JSON.stringify(body));
	assert.equal(host.snapshot().cleared, null);
	const res = await request(at("/"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	assert.equal(res.status, 405);
	assert.match(res.body, /POST \/clear/);
});

function modulePanel(cards: ModuleCard[]) {
	const switched: [string, boolean][] = [];
	let listener = () => {};
	return {
		switched,
		changed: () => listener(),
		panel: {
			cards: () => cards,
			setSwitch: (name: string, on: boolean) => cards.some((c) => c.name === name) && switched.push([name, on]) > 0,
			onChange: (l: () => void) => void (listener = l),
		},
	};
}

const taxCard = (over: Partial<ModuleCard> = {}): ModuleCard => ({
	name: "tax", title: "报税", on: false, label: "已停用", reason: "你把它关了，数据还留着", tone: "off", problems: [], version: { label: "0.1.0", digest: "abcdef123456" },
	components: { skills: 1 }, secrets: [], pinnedOld: 0, notImported: [], ...over,
});

test("网关：POST /module 写开关，回 204；要 token、本机 Origin、JSON 正文；没发现的模块、不合格的正文 400；GET 405", async (t) => {
	const modules = modulePanel([taxCard()]);
	const { at, url } = await sayHost(t, undefined, { modules: modules.panel });
	type Over = { token?: string; origin?: string | null; type?: string };
	const toggle = (body: string, over: Over = {}) =>
		request(at("/module", over.token), { method: "POST", body, headers: { "content-type": over.type ?? "application/json", ...(over.origin === null ? {} : { origin: over.origin ?? url.origin }) } });
	const on = JSON.stringify({ module: "tax", on: true });
	assert.equal((await toggle(on, { token: "" })).status, 401);
	assert.equal((await toggle(on, { token: "0".repeat(64) })).status, 401);
	assert.equal((await toggle(on, { origin: null })).status, 403);
	assert.equal((await toggle(on, { origin: "http://evil.example" })).status, 403);
	assert.equal((await toggle(on, { type: "text/plain" })).status, 415);
	assert.deepEqual(modules.switched, []);
	for (const body of [JSON.stringify({ module: "nope", on: true }), JSON.stringify({ module: "tax", on: "yes" }), JSON.stringify({ module: "tax" }), JSON.stringify({ module: "tax", on: true, x: 1 }), "[]"]) {
		assert.equal((await toggle(body)).status, 400, body);
	}
	assert.equal((await request(at("/module"))).status, 405);
	const res = await toggle(on);
	assert.equal(res.status, 204);
	assert.equal((await toggle(JSON.stringify({ module: "tax", on: false }))).status, 204);
	assert.deepEqual(modules.switched, [["tax", true], ["tax", false]]);
});

test("宿主：网页写了开关就推一次看板，不等模块表的轮询", async (t) => {
	const modules = modulePanel([taxCard()]);
	const { events, url, at } = await sayHost(t, undefined, { modules: modules.panel });
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	const res = await request(at("/module"), { method: "POST", body: JSON.stringify({ module: "tax", on: true }), headers: { "content-type": "application/json", origin: url.origin } });
	assert.equal(res.status, 204);
	await until(() => ofType(stream.got, "board").length > 0, "看板帧");
});

test("宿主：快照和看板帧带 modules，是模块表给的卡；模块表说变了就推一次看板", async (t) => {
	const cards = [taxCard()];
	const modules = modulePanel(cards);
	const { host, events } = await sayHost(t, undefined, { modules: modules.panel });
	assert.deepEqual(host.snapshot().modules, cards);
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	cards[0] = taxCard({ on: true, label: "运行中", reason: "", tone: "ok" });
	modules.changed();
	await until(() => ofType(stream.got, "board").some((b) => b.modules[0]?.label === "运行中"), "带运行中的看板帧");
});

test("宿主：没有模块表时 modules 是空的", async (t) => {
	const { host } = await sayHost(t);
	assert.deepEqual(host.snapshot().modules, []);
});

const openTicketOnConversation = (cards: string[]) => (cards[0]?.startsWith("[对话]") ? openOnConversation(cards[0]) : []);

test("网关：POST /clear 之后，打开着的页面收到 cleared 帧，新连上的页面快照只带清屏之后的行和被清掉的行", async (t) => {
	const { host, events, clear } = await sayHost(t, openTicketOnConversation);
	host.say("早");
	await host.settled();
	const a = events();
	await until(() => a.got.length > 0, "快照");
	const res = await clear();
	assert.equal(res.status, 204);
	assert.equal(res.headers["cache-control"], "no-store");
	await until(() => ofType(a.got, "cleared").length === 1, "cleared 帧");
	const [frame] = ofType(a.got, "cleared");
	assert.deepEqual(frame.conversation, []);
	assert.deepEqual(frame.cleared.lines.map((l) => l.text), ["早", "收到：早"]);
	host.say("晚");
	await host.settled();
	const b = events();
	await until(() => b.got.length > 0, "新页面的快照");
	const [snap] = ofType(b.got, "snapshot");
	assert.deepEqual(snap.conversation.map((l) => l.text), ["晚", "收到：晚"]);
	assert.equal(snap.cleared?.at, frame.cleared.at);
	assert.deepEqual(snap.cleared?.lines.map((l) => l.text), ["早", "收到：早"]);
});

test("网关：POST /clear 和 /say 一样要 token、本机 Origin、JSON 正文；不合格时 401/403/415，且不清屏", async (t) => {
	const { host, clear, url } = await sayHost(t);
	host.say("早");
	assert.equal((await clear("{}", { token: "" })).status, 401);
	assert.equal((await clear("{}", { token: "0".repeat(64) })).status, 401);
	assert.equal((await clear("{}", { host: `evil.example:${url.port}` })).status, 403);
	assert.equal((await clear("{}", { origin: null })).status, 403);
	assert.equal((await clear("{}", { origin: "http://evil.example" })).status, 403);
	assert.equal((await clear("{}", { type: "text/plain" })).status, 415);
	assert.equal(host.snapshot().cleared, null);
	assert.deepEqual(host.snapshot().conversation.map((l) => l.text), ["早"]);
});

test("网关：没有可清的行时 POST /clear 也回 204，不推 cleared 帧", async (t) => {
	const { host, events, clear } = await sayHost(t);
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	assert.equal((await clear()).status, 204);
	host.say("之后");
	await until(() => ofType(stream.got, "user").length === 1, "之后的 user");
	assert.deepEqual(ofType(stream.got, "cleared"), []);
	assert.equal(host.snapshot().cleared, null);
});

async function askedOnHost(host: Awaited<ReturnType<typeof sayHost>>["host"], title = "查财报") {
	const { triggerId } = host.kernel.submitTrigger({ source: "conversation", externalId: title, threads: [{ id: "thr_conversation" }], sender: "user", body: title, occurredAt: Date.now() });
	const [opened] = host.kernel.route([{ kind: "open_ticket", basis: "request", triggerId, title, brief: title }]);
	const ticketId = (opened as { ticketId: string }).ticketId;
	const { reportId } = host.kernel.workerReport(ticketId, { status: "blocked", summary: "两种口径", question: "要看哪部分？", options: ["只看营收", "营收和利润"] });
	return { ticketId, reportId };
}

const answerBody = (reportId: string, option: number) => JSON.stringify({ answer: { reportId, option } });

test("网关：POST /say 带 answer 时，宿主替使用者说出「回答任务「标题」：选项」；转交之后重试返回同一个 triggerId，对话里只有一句", async (t) => {
	const { host, post, events, userLines } = await sayHost(t);
	const { ticketId, reportId } = await askedOnHost(host);
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	const first = await post(answerBody(reportId, 1));
	assert.ok(host.kernel.route([{ kind: "hand_over", triggerId: JSON.parse(first.body).triggerId, ticketId }])[0].ok);
	const again = await post(answerBody(reportId, 1));
	assert.deepEqual([first.status, again.status], [200, 200]);
	const { triggerId } = JSON.parse(first.body);
	assert.equal(JSON.parse(again.body).triggerId, triggerId);
	await until(() => ofType(stream.got, "user").some((m) => m.id === triggerId), "user");
	await until(() => ofType(stream.got, "board").some((m) => m.rows.some((r) => r.question?.click?.option === 1 && r.question.click.state === "handed_over")), "看板显示已回答");
	assert.deepEqual(ofType(stream.got, "user").map((m) => m.text), ["回答任务「查财报」：营收和利润"]);
	assert.deepEqual(userLines().filter((l) => l.startsWith("回答任务")), ["回答任务「查财报」：营收和利润"]);
});

test("网关：点过一项后换另一项 POST 返回 409，正文说明已选哪一项；对话里只有第一句", async (t) => {
	const { host, post, userLines } = await sayHost(t);
	const { ticketId, reportId } = await askedOnHost(host);
	const first = await post(answerBody(reportId, 0));
	assert.ok(host.kernel.route([{ kind: "hand_over", triggerId: JSON.parse(first.body).triggerId, ticketId }])[0].ok);
	const other = await post(answerBody(reportId, 1));
	assert.equal(other.status, 409);
	assert.deepEqual(JSON.parse(other.body), { refused: "chosen", option: 0, reason: "已选「只看营收」" });
	assert.deepEqual(userLines().filter((l) => l.startsWith("回答任务")), ["回答任务「查财报」：只看营收"]);
});

test("页面：点选被拒时按原因显示固定文案；已选的那一项用页面自己的选项文字", () => {
	const options = ["只看营收", "营收和利润"];
	assert.equal(page.answerRefusedCopy(409, { refused: "chosen", option: 1 }, options), "发送失败：已选「营收和利润」。");
	assert.equal(page.answerRefusedCopy(409, { refused: "closed" }, options), "发送失败：这个问题已经回答过，或已不在等待回答。");
	assert.equal(page.answerRefusedCopy(409, { refused: "chosen", option: 9, reason: "<b>x</b>" }, options), "发送失败：这个问题已经回答过，或已不在等待回答。");
	assert.equal(page.answerRefusedCopy(413, null, options), "发送失败：内容过长，请分几次发送。");
	assert.equal(page.answerRefusedCopy(409, { refused: "spoke" }, options), "发送失败：你刚发了一句话，幕僚长处理完之前不能点选项。");
});

test("网关：提问之后先打字再点选项，幕僚长还没处理那句话时点选返回 409，正文说明原因", async (t) => {
	let routerHolds = false;
	let release!: () => void;
	const released = new Promise<void>((r) => (release = r));
	const { host, post, userLines } = await sayHost(t, async (cards) => {
		if (cards.some((c) => c.includes("两个都要"))) {
			routerHolds = true;
			await released;
		}
		return [];
	});
	t.after(release);
	const { reportId } = await askedOnHost(host);
	await new Promise((r) => setTimeout(r, 5));
	assert.equal((await post(JSON.stringify({ text: "两个都要" }))).status, 200);
	await until(() => routerHolds, "幕僚长正在处理那句话");
	const res = await post(answerBody(reportId, 0));
	assert.equal(res.status, 409);
	assert.equal(JSON.parse(res.body).refused, "spoke");
	assert.ok(!userLines().some((l) => l.startsWith("回答任务")));
	release();
	await host.dispatcher.settled();
	assert.equal((await post(answerBody(reportId, 0))).status, 200, "幕僚长处理完之后可以点选");
});

test("网关：answer 的汇报编号不存在时 404，正文说问题不存在；页面显示固定文案", async (t) => {
	const { post, userLines } = await sayHost(t);
	const res = await post(answerBody("rpt_missing", 0));
	assert.equal(res.status, 404);
	assert.deepEqual(JSON.parse(res.body), { refused: "no_question", reason: "这个问题不存在" });
	assert.deepEqual(userLines(), []);
	assert.equal(page.answerRefusedCopy(404, JSON.parse(res.body), []), "发送失败：这个问题不存在。");
});

test("网关：问题已经打字回答过时 POST /say 的 answer 返回 409，对话里不多一句", async (t) => {
	const { host, post, userLines } = await sayHost(t);
	const { ticketId, reportId } = await askedOnHost(host);
	const typed = host.say("两个都要");
	assert.ok(host.kernel.route([{ kind: "hand_over", triggerId: typed, ticketId }])[0].ok);
	const res = await post(answerBody(reportId, 0));
	assert.equal(res.status, 409);
	assert.equal(JSON.parse(res.body).refused, "closed");
	assert.match(JSON.parse(res.body).reason, /已经回答过/);
	assert.ok(!userLines().some((l) => l.startsWith("回答任务")));
});

test("网关：answer 的形状不对时 400：同时带 text、reportId 不像汇报编号、option 不是 0 到 3 的整数", async (t) => {
	const { host, post, userLines } = await sayHost(t);
	const { reportId } = await askedOnHost(host);
	const bodies = [
		JSON.stringify({ text: "x", answer: { reportId, option: 0 } }),
		JSON.stringify({ answer: { reportId: "tkt_1", option: 0 } }),
		JSON.stringify({ answer: { reportId, option: 7 } }),
		JSON.stringify({ answer: { reportId, option: "1" } }),
		JSON.stringify({ answer: { reportId, option: 1.5 } }),
		JSON.stringify({ answer: null }),
		JSON.stringify({ answer: { reportId, option: 0, extra: true } }),
	];
	for (const body of bodies) assert.equal((await post(body)).status, 400, body);
	assert.deepEqual(userLines(), ["查财报"]);
});

async function watchHost(t: TestContext) {
	const brain = (cards: string[]) => (cards[0]?.startsWith("[对话]") ? openOnConversation(cards[0]) : []);
	const stateDir = tempStateDir();
	const web = await webHost(t, brain, { stateDir });
	const open = async (title: string) => {
		web.host.say(title);
		let id = "";
		await until(() => {
			id = web.host.kernel.listTickets().find((r) => r.title === title)?.id ?? "";
			return web.spawner.workers.has(id);
		}, `任务 ${title}`);
		return { id, worker: web.spawner.workers.get(id)! };
	};
	const sessionFile = (ticketId: string) => join(stateDir, "sessions", "workers", `2026-11-08T00-00-00_${web.host.kernel.getTicket(ticketId)!.workerSessionId}.jsonl`);
	const history = (ticketId: string, messages: unknown[]) => {
		mkdirSync(join(stateDir, "sessions", "workers"), { recursive: true });
		const lines = [{ type: "session", id: web.host.kernel.getTicket(ticketId)!.workerSessionId }, ...messages.map((message) => ({ type: "message", message }))];
		writeFileSync(sessionFile(ticketId), lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
	};
	const watch = (ticketId: string, token = web.token) => {
		const stream = sse(`${web.url.origin}/transcript?token=${token}&ticket=${encodeURIComponent(ticketId)}`);
		t.after(() => stream.close());
		return stream;
	};
	return { ...web, open, history, sessionFile, watch };
}

const said = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

test("网关：查看任务先收到 transcript_history，再收到实时 transcript；系统消息不出现", async (t) => {
	const { open, history, watch } = await watchHost(t);
	const { id, worker } = await open("读网页");
	history(id, [{ role: "system", content: "你是 Worker" }, said("先看看")]);
	const stream = watch(id);
	await until(() => stream.got.length === 1, "历史");
	assert.equal(stream.status, 200);
	assert.deepEqual(stream.got[0], { type: "transcript_history", ticketId: id, messages: [said("先看看")] });
	worker.transcript(said("找到标题了"));
	await until(() => stream.got.length === 2, "实时");
	assert.deepEqual(stream.got[1], { type: "transcript", ticketId: id, message: said("找到标题了") });
});

test("网关：开始查看时，紧跟历史的第一条实时消息若和历史最后一条相同只收到一次", async (t) => {
	const { open, history, watch } = await watchHost(t);
	const { id, worker } = await open("读网页");
	history(id, [said("先看看")]);
	const stream = watch(id);
	await until(() => stream.got.length === 1, "历史");
	worker.transcript(said("先看看"));
	worker.transcript(said("找到了"));
	worker.transcript(said("先看看"));
	await until(() => stream.got.length >= 3, "实时");
	assert.deepEqual(ofType(stream.got, "transcript").map((m) => m.message), [said("找到了"), said("先看看")]);
});

test("网关：两个连接看不同任务，各自只收到自己的；关掉旧连接改看新任务后，旧任务的消息不再到达", async (t) => {
	const { open, watch } = await watchHost(t);
	const one = await open("任务一");
	const two = await open("任务二");
	const a = watch(one.id);
	const b = watch(two.id);
	await until(() => a.got.length === 1 && b.got.length === 1, "两份历史");
	one.worker.transcript(said("一的进展"));
	two.worker.transcript(said("二的进展"));
	await until(() => a.got.length === 2 && b.got.length === 2, "各自的实时消息");
	assert.deepEqual(ofType(a.got, "transcript").map((m) => m.ticketId), [one.id]);
	assert.deepEqual(ofType(b.got, "transcript").map((m) => m.ticketId), [two.id]);
	a.close();
	const switched = watch(two.id);
	await until(() => switched.got.length === 1, "新任务的历史");
	one.worker.transcript(said("一的后续"));
	two.worker.transcript(said("二的后续"));
	await until(() => switched.got.length === 2 && b.got.length === 3, "新任务的实时消息");
	assert.deepEqual(ofType(switched.got, "transcript").map((m) => m.ticketId), [two.id]);
	assert.equal(a.got.length, 2, "关掉的连接不再收到");
});

test("网关：成员干活时它的每条消息实时送到正在看这个任务的页面，带着是哪次派活的第几条；别的任务的页面收不到", async (t) => {
	const crew = [{ name: "news-researcher", title: "新闻研究员", description: "查新闻", tools: undefined, skills: [], model: undefined, prompt: "", file: "/agents/news.md" }];
	const brain = (cards: string[]) => cards.flatMap((card) => (card.startsWith("[对话]") ? [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId: card.match(/trg_[\w-]+/)![0], title: card.includes("新闻") ? "查新闻" : "别的事", brief: "b", ...(card.includes("新闻") && { domain: "news" }) }] } }] : []));
	const web = await webHost(t, brain, {
		domains: domainsOf({ news: { team: "新闻队", crew } }),
		dispatch: { timeoutMs: 5000, codingTimeoutMs: 5000, stallMs: 5000, maxConcurrent: 4 },
	});
	web.host.say("查新闻");
	web.host.say("别的事");
	await until(() => web.spawner.workers.size === 2, "两个助手");
	const id = (title: string) => web.host.kernel.listTickets().find((r) => r.title === title)!.id;
	const watch = (ticketId: string) => sse(`${web.url.origin}/transcript?token=${web.token}&ticket=${ticketId}`);
	const [news, other] = [watch(id("查新闻")), watch(id("别的事"))];
	t.after(() => { news.close(); other.close(); });
	await until(() => news.got.length === 1 && other.got.length === 1, "两份历史");
	assert.deepEqual(news.got[0], { type: "transcript_history", ticketId: id("查新闻"), messages: [], team: { titles: { "news-researcher": "新闻研究员" }, steps: {} } });
	let finish!: () => void;
	web.spawner.runner = async (run) => {
		run.onMessage(said("成员先看看"));
		run.onMessage(said("成员找到了"));
		await new Promise<void>((done) => (finish = done));
		return "答";
	};
	const result = web.spawner.workers.get(id("查新闻"))!.request("worker.dispatch", { agent: "news-researcher", task: "查", callId: "c9" });
	await until(() => news.got.length === 3, "两条成员消息");
	assert.deepEqual(news.got.slice(1), [
		{ type: "transcript", ticketId: id("查新闻"), message: said("成员先看看"), member: { callId: "c9", index: 0 } },
		{ type: "transcript", ticketId: id("查新闻"), message: said("成员找到了"), member: { callId: "c9", index: 1 } },
	]);
	assert.equal(other.got.length, 1);
	finish();
	await result;
});

test("网关：Worker 写到一半被杀、会话文件最后一行不完整时，历史只含完整的行，宿主照常服务", async (t) => {
	const { open, history, sessionFile, watch, at } = await watchHost(t);
	const { id } = await open("读网页");
	history(id, [said("先看看"), said("找到了")]);
	appendFileSync(sessionFile(id), '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"写到一');
	const stream = watch(id);
	await until(() => stream.got.length === 1, "历史");
	assert.deepEqual(stream.got[0], { type: "transcript_history", ticketId: id, messages: [said("先看看"), said("找到了")] });
	assert.equal((await request(at("/"))).status, 200, "宿主还活着");
});

test("网关：处理请求时意外出错答 500，不带内部细节，记一行日志，进程不退出", async (t) => {
	const logs: string[] = [];
	const boom = () => {
		throw new Error("内部秘密 /Users/x/state.db");
	};
	const gateway = new WebGateway({ snapshot: boom, transcript: boom, say: boom }, "ab".repeat(32), (line) => logs.push(line));
	await gateway.listen(0);
	t.after(() => gateway.close());
	const url = new URL(gateway.url);
	const token = url.searchParams.get("token")!;
	const got = await request(`${url.origin}/transcript?token=${token}&ticket=tkt_abcd1234`);
	assert.equal(got.status, 500);
	assert.equal(got.headers["cache-control"], "no-store");
	assert.doesNotMatch(got.body, /秘密|Users|Error/);
	const said = await request(`${url.origin}/say?token=${token}`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ text: "你好" }) });
	assert.equal(said.status, 500);
	assert.doesNotMatch(said.body, /秘密/);
	assert.equal(logs.length, 2);
	assert.match(logs[0], /内部秘密/, "日志里有原因，便于排查");
	assert.equal((await request(`${url.origin}/?token=${token}`)).status, 200, "之后照常服务");
});

test("网关：/transcript 没有 token 401；ticket 不像任务编号 400；没有这个任务时历史为空", async (t) => {
	const { watch, token } = await watchHost(t);
	const noToken = watch("tkt_abc", "");
	const bad = watch("../etc", token);
	const empty = watch("tkt_nothere", token);
	await until(() => noToken.status === 401 && bad.status === 400, "拒绝");
	await until(() => empty.got.length === 1, "空历史");
	assert.deepEqual(empty.got[0], { type: "transcript_history", ticketId: "tkt_nothere", messages: [] });
});

const dispatchCall = (id: string, agent: string, task: string, timestamp?: number) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "dispatch_agent", arguments: { agent, task } }], ...(timestamp !== undefined && { timestamp }) });
const dispatchResult = (toolCallId: string, details: Record<string, unknown> | undefined, isError = false) => ({ role: "toolResult", toolName: "dispatch_agent", toolCallId, isError, content: [{ type: "text", text: "成员回复 …" }], ...(details && { details }) });
const outcome = (title: string, state: string, reply: string | null, tokensIn: number, note?: string, tokensOut = 0) =>
	({ kind: "dispatch", member: "x-member", title, task: `给${title}的事`, state, reply, tokensIn, tokensOut, ms: 1000, waitMs: 0, limitMs: 900_000, ...(note && { note }) });
const onBoard = (callId: string, title: string, state: Dispatching[string][number]["state"], over: Partial<Dispatching[string][number]> = {}): Dispatching[string][number] => ({ callId, title, state, step: "", quietMs: 0, tokens: 0, tokensCached: 0, limitMs: 900_000, ...over });
const TITLES = { "market-analyst": "行情分析师", "news-researcher": "新闻研究员" };
const teamHistory = (ticketId: string, messages: unknown[], steps: Record<string, unknown[]> = {}): HostToClient => ({ type: "transcript_history", ticketId, messages: messages as never, team: { titles: TITLES, steps: steps as never } });
const fromMember = (ticketId: string, callId: string, index: number, message: unknown): HostToClient => ({ type: "transcript", ticketId, message: message as never, member: { callId, index } });
const shown = (steps: page.Step[]) => steps.map((s) => [s.detail, s.state]);

test("页面：成员的工具还在跑时，小卡下写这一步已经跑了多久，不写多久前有动静；工具返回后换回多久前", () => {
	const view = page.emptyView();
	const frame = (over: Partial<Dispatching[string][number]>) => board([row({ id: "tkt_team" })], zeroToday(), noHelpers, {}, { tkt_team: [onBoard("c1", "技术分析师", "running", { step: "执行命令", ...over })] });
	const label = (now: number) => page.helperStrip(view, now).chips[0].members[0].label;
	page.applyMessage(view, frame({ quietMs: 119_000, toolMs: 120_000 }), 1000);
	assert.equal(label(1000), "技术分析师 · 执行命令 · 已 2 分钟");
	assert.equal(label(1000 + 65_000), "技术分析师 · 执行命令 · 已 3 分钟", "没有新帧时页面自己往后数");
	page.applyMessage(view, frame({ quietMs: 0, toolMs: 0 }), 1000);
	assert.deepEqual([label(1000), label(1999), label(2000), label(1000 + 42_000)], ["技术分析师 · 执行命令 · 刚刚", "技术分析师 · 执行命令 · 刚刚", "技术分析师 · 执行命令 · 已 1 秒", "技术分析师 · 执行命令 · 已 42 秒"], "不到一秒不写「已 0 秒」");
	page.applyMessage(view, frame({ quietMs: 12_000 }), 1000);
	assert.equal(label(1000), "技术分析师 · 执行命令 · 12 秒前");
});

test("页面：助手条的小卡下列出在干活和在排队的成员：干活的写职称、正在做什么、多久前有动静，排队的写「排队中」；做完的不列；老宿主的帧没有这一项也不出错", () => {
	const view = page.emptyView();
	const working = { tkt_team: [
		onBoard("c1", "新闻研究员", "running", { step: "读取网页", quietMs: 12_000, tokens: 300 }),
		onBoard("c2", "行情分析师", "running"),
		onBoard("c3", "财报解读", "queued"),
		onBoard("c4", "技术分析师", "done", { tokens: 900 }),
	] };
	page.applyMessage(view, board([row({ id: "tkt_team" }), row({ id: "tkt_solo" })], zeroToday(), noHelpers, {}, working), 1000);
	const members = (now: number) => page.helperStrip(view, now).chips.map((c) => c.members.map((m) => [m.state, m.label]));
	assert.deepEqual(members(1000), [[["running", "新闻研究员 · 读取网页 · 12 秒前"], ["running", "行情分析师 · 启动中 · 刚刚"], ["queued", "财报解读 · 排队中"]], []]);
	assert.deepEqual(members(1000 + 50_000)[0].slice(0, 2), [["running", "新闻研究员 · 读取网页 · 1 分钟前"], ["running", "行情分析师 · 启动中 · 50 秒前"]], "没有新帧时页面自己往后数");
	page.applyMessage(view, board([row({ id: "tkt_team" }), row({ id: "tkt_solo" })]), 0);
	assert.deepEqual(page.helperStrip(view, 0).chips.map((c) => c.members), [[], []]);
	const fromSnapshot = page.emptyView();
	page.applyMessage(fromSnapshot, snapshot({ board: [row({ id: "tkt_team" })], dispatching: working }), 0);
	assert.equal(page.helperStrip(fromSnapshot, 0).chips[0].members.length, 3);
	const old = page.emptyView();
	page.applyMessage(old, { ...board([row()]), dispatching: undefined } as never, 0);
	assert.deepEqual(page.helperStrip(old, 0).chips[0].members, []);
});

test("页面：每次派活是一步；并行的两次派活按调用编号各自对上自己的结果，展开有成员职称、任务、回复、状态和用量（输入加输出），不出现成员的英文名", () => {
	const w = page.emptyWatch("tkt_1");
	page.applyTranscript(w, history("tkt_1", [{ role: "assistant", content: [...dispatchCall("c1", "market-analyst", "看盘面").content, ...dispatchCall("c2", "news-researcher", "查新闻").content] }]));
	assert.deepEqual(w.steps.map((s) => [s.title, s.state, s.dispatch?.task]), [["派活", "pending", "看盘面"], ["派活", "pending", "查新闻"]]);
	page.applyTranscript(w, live("tkt_1", dispatchResult("c1", outcome("行情分析师", "timed_out", null, 1200, "超过 15 分钟的时限", 300))));
	page.applyTranscript(w, live("tkt_1", dispatchResult("c2", outcome("新闻研究员", "done", "**没有**重大新闻", 300))));
	assert.deepEqual(w.steps.map((s) => [s.title, s.detail, s.state]), [["派活", "行情分析师 · 超时", "error"], ["派活", "新闻研究员 · 完成", "ok"]]);
	assert.deepEqual(w.steps.map((s) => s.dispatch), [
		{ title: "行情分析师", task: "给行情分析师的事", reply: "", state: "timed_out", stateText: "超时", note: "超过 15 分钟的时限", tokens: "1.5k tokens", steps: [], clock: { phase: "ended", ranMs: 1000, limitMs: 900_000 } },
		{ title: "新闻研究员", task: "给新闻研究员的事", reply: "**没有**重大新闻", state: "done", stateText: "完成", note: "", tokens: "300 tokens", steps: [], clock: { phase: "ended", ranMs: 1000, limitMs: 900_000 } },
	]);
	assert.doesNotMatch(JSON.stringify(w.steps.map((s) => [s.title, s.detail, s.dispatch])), /market-analyst|news-researcher|x-member/);
});

test("页面：派活的用量写出其中多少是缓存读取；没有缓存读取时和以前一样", () => {
	const w = page.emptyWatch("tkt_1");
	page.applyTranscript(w, history("tkt_1", [dispatchCall("c1", "market-analyst", "看盘面"), dispatchCall("c2", "news-researcher", "查新闻")]));
	page.applyTranscript(w, live("tkt_1", dispatchResult("c1", { ...outcome("行情分析师", "done", "答", 1200, undefined, 300), tokensCached: 1000 })));
	page.applyTranscript(w, live("tkt_1", dispatchResult("c2", outcome("新闻研究员", "done", "答", 300))));
	assert.deepEqual(w.steps.map((s) => s.dispatch?.tokens), ["1.5k tokens（其中缓存 1.0k）", "300 tokens"]);
});

test("页面：成员的长回复只显示前 2000 字，末尾写明全文多少字、存在哪个文件", () => {
	const w = page.emptyWatch("tkt_1");
	page.applyTranscript(w, history("tkt_1", [dispatchCall("c1", "market-analyst", "看盘面")]));
	page.applyTranscript(w, live("tkt_1", dispatchResult("c1", { ...outcome("行情分析师", "done", "前两千字", 300), replyFile: "replies/market-analyst-1.md", replyChars: 4990 })));
	assert.equal(w.steps[0].dispatch?.reply, "前两千字\n\n…（全文 4990 字，存在任务目录的 replies/market-analyst-1.md）");
});

test("页面：派活的每种结束状态都有中文说法，超时、无进展和出错带上原因；被宿主拒绝的派活就是一步普通的失败", () => {
	const steps = watched([
		dispatchCall("c1", "a", "t"), dispatchResult("c1", outcome("甲", "stopped", null, 0)),
		dispatchCall("c2", "a", "t"), dispatchResult("c2", outcome("乙", "failed", null, 0, "429")),
		dispatchCall("c3", "a", "t"), dispatchResult("c3", outcome("丙", "stalled", null, 0, "3 分钟没有进展")),
		dispatchCall("c4", "nobody", "t"), dispatchResult("c4", undefined, true),
	]);
	assert.deepEqual(steps.map((s) => [s.detail, s.state, s.dispatch?.stateText, s.dispatch?.note]), [
		["甲 · 已停止", "stopped", "已停止", ""], ["乙 · 出错", "error", "出错", "429"], ["丙 · 无进展", "error", "无进展", "3 分钟没有进展"], ["", "error", undefined, undefined],
	]);
});

test("页面：还没结束的派活一开始就写成员的职称；状态跟着看板走；一批里先做完的那位马上写完成，整批回来之前不退回排队中", () => {
	const view = page.emptyView();
	const w = page.emptyWatch("tkt_1");
	page.applyTranscript(w, teamHistory("tkt_1", [dispatchCall("c1", "market-analyst", "看盘面"), dispatchCall("c2", "news-researcher", "查新闻"), tool("read", { path: "a.md" })]));
	const now = () => shown(page.liveSteps(w, view));
	page.applyMessage(view, board([row({ id: "tkt_1", workerState: "running" })]), 0);
	assert.deepEqual(now(), [["行情分析师 · 排队中", "pending"], ["新闻研究员 · 排队中", "pending"], ["a.md", "pending"]], "看板还没列出来时算排队中");
	const frame = (...entries: Dispatching[string]) => page.applyMessage(view, board([row({ id: "tkt_1", workerState: "running" })], zeroToday(), noHelpers, {}, entries.length ? { tkt_1: entries } : {}), 0);
	frame(onBoard("c1", "行情分析师", "running", { step: "查询报价", tokens: 500 }), onBoard("c2", "新闻研究员", "queued"));
	assert.deepEqual(now().slice(0, 2), [["行情分析师 · 进行中", "pending"], ["新闻研究员 · 排队中", "pending"]]);
	frame(onBoard("c1", "行情分析师", "done", { tokens: 1500 }), onBoard("c2", "新闻研究员", "running"));
	assert.deepEqual(now().slice(0, 2), [["行情分析师 · 完成", "ok"], ["新闻研究员 · 进行中", "pending"]]);
	assert.equal(page.liveSteps(w, view)[0].dispatch?.tokens, "1.5k tokens");
	frame(onBoard("c1", "行情分析师", "done", { tokens: 1500, tokensCached: 1000 }), onBoard("c2", "新闻研究员", "running"));
	assert.equal(page.liveSteps(w, view)[0].dispatch?.tokens, "1.5k tokens（其中缓存 1.0k）", "看板带着缓存读取时，结果到之前也写出其中多少是缓存");
	frame(onBoard("c1", "行情分析师", "done", { tokens: 1500 }), onBoard("c2", "新闻研究员", "timed_out", { note: "超过 15 分钟的时限" }));
	frame();
	assert.deepEqual(now().slice(0, 2), [["行情分析师 · 完成", "ok"], ["新闻研究员 · 超时", "error"]], "整批回来、结果还没到的那一瞬间，页面记得最后看到的状态");
	assert.equal(page.liveSteps(w, view)[1].dispatch?.note, "超过 15 分钟的时限");
	assert.equal(w.steps[0].dispatch?.state, "queued", "liveSteps 不改动记录本身");
});

test("页面：任务被叫停后，没做完的步骤不再转圈：派活写成员职称和已停止，别的步骤也算已停止", () => {
	const view = page.emptyView();
	const w = page.emptyWatch("tkt_1");
	const memberSaid = { role: "assistant", content: [{ type: "toolCall", id: "m1", name: "web_get", arguments: { url: "https://example.com/n" } }], usage: { input: 600, output: 100 } };
	page.applyTranscript(w, teamHistory("tkt_1", [dispatchCall("c1", "news-researcher", "查新闻"), tool("bash", { command: "sleep 300" })], { c1: [memberSaid] }));
	page.applyMessage(view, board([row({ id: "tkt_1", workerState: "running" })], zeroToday(), noHelpers, {}, { tkt_1: [onBoard("c1", "新闻研究员", "running", { tokens: 700 })] }), 0);
	page.applyMessage(view, board([row({ id: "tkt_1", stage: "stopped", workerState: "idle", endedAt: 5 })]), 0);
	const steps = page.liveSteps(w, view);
	assert.deepEqual(shown(steps), [["新闻研究员 · 已停止", "stopped"], ["sleep 300", "stopped"]]);
	assert.deepEqual([steps[0].dispatch?.title, steps[0].dispatch?.stateText, steps[0].dispatch?.tokens], ["新闻研究员", "已停止", "700 tokens"]);
});

test("页面：宿主重启前发出、没等到结果的步骤一打开就是已停止，不先写排队中；重启后新发出的照常", () => {
	const view = page.emptyView();
	const w = page.emptyWatch("tkt_1");
	page.applyMessage(view, { ...board([row({ id: "tkt_1", workerState: "running" })]), duty: { since: 5000, resumed: 1 } } as HostToClient, 0);
	page.applyTranscript(w, teamHistory("tkt_1", [dispatchCall("c1", "news-researcher", "查新闻", 4000)]));
	assert.deepEqual(shown(page.liveSteps(w, view)), [["新闻研究员 · 已停止", "stopped"]]);
	page.applyTranscript(w, live("tkt_1", dispatchCall("c2", "news-researcher", "再查", 6000)));
	assert.deepEqual(shown(page.liveSteps(w, view)), [["新闻研究员 · 已停止", "stopped"], ["新闻研究员 · 排队中", "pending"]]);
});

test("页面：记下的派活最后状态只留到任务结束：任务结束或不在看板上了，它的那些记录就丢掉，不随标签页一直攒着", () => {
	const view = page.emptyView();
	const rows = (ended: number | null) => [row({ id: "tkt_a", endedAt: ended, stage: ended === null ? "running" : "stopped" }), row({ id: "tkt_b" })];
	const kept = () => [...view.lastOnBoard].map(([ticketId, calls]) => [ticketId, [...calls.keys()]]);
	page.applyMessage(view, board(rows(null), zeroToday(), noHelpers, {}, { tkt_a: [onBoard("a1", "新闻研究员", "running")], tkt_b: [onBoard("b1", "行情分析师", "running")] }), 0);
	page.applyMessage(view, board(rows(null), zeroToday(), noHelpers, {}, { tkt_a: [onBoard("a2", "新闻研究员", "done")] }), 0);
	assert.deepEqual(kept(), [["tkt_a", ["a1", "a2"]], ["tkt_b", ["b1"]]], "任务还在做时，离开看板的派活仍记着，等它的结果到");
	page.applyMessage(view, board(rows(5000)), 0);
	assert.deepEqual(kept(), [["tkt_b", ["b1"]]]);
	page.applyMessage(view, snapshot({ board: [] }), 0);
	assert.deepEqual(kept(), []);
});

test("页面：宿主被杀时还在跑的派活，重启后写已停止，仍带着成员用掉的 token：从成员自己的消息里的用量加出来", () => {
	const view = page.emptyView();
	const w = page.emptyWatch("tkt_1");
	page.applyMessage(view, { ...board([row({ id: "tkt_1", workerState: "running" })]), duty: { since: 5000, resumed: 1 } } as HostToClient, 0);
	const used = (input: number, output: number, cacheRead: number, content: unknown[]) => ({ role: "assistant", content, usage: { input, output, cacheRead } });
	page.applyTranscript(w, teamHistory("tkt_1", [dispatchCall("c1", "news-researcher", "查新闻", 4000), dispatchCall("c2", "market-analyst", "看盘面", 4000)], { c1: [
		used(900, 100, 200, [{ type: "toolCall", id: "m1", name: "web_get", arguments: { url: "https://example.com/n" } }]),
		{ role: "toolResult", toolCallId: "m1", toolName: "web_get", content: [{ type: "text", text: "网页" }] },
		used(250, 50, 0, [{ type: "toolCall", id: "m2", name: "web_get", arguments: { url: "https://example.com/m" } }]),
	] }));
	assert.deepEqual(page.liveSteps(w, view).map((s) => [s.detail, s.dispatch?.tokens]), [["新闻研究员 · 已停止", "1.5k tokens（其中缓存 200）"], ["行情分析师 · 已停止", ""]], "没来得及出一条消息的那位不写用量");
	page.applyTranscript(w, live("tkt_1", { role: "user", content: "[恢复说明]\nprocess restarted" }));
	assert.deepEqual(page.liveSteps(w, view).slice(0, 2).map((s) => [s.detail, s.dispatch?.tokens]), [["新闻研究员 · 已停止", "1.5k tokens（其中缓存 200）"], ["行情分析师 · 已停止", ""]], "恢复后的助手开始下一轮，那一步定成已停止，用量还在");
});

test("页面：助手收到新的输入开始下一轮时，上一轮没等到结果的步骤就此停下（助手进程中途退出过）", () => {
	const w = page.emptyWatch("tkt_1");
	page.applyTranscript(w, teamHistory("tkt_1", [dispatchCall("c1", "news-researcher", "查新闻"), tool("bash", { command: "sleep 300" })]));
	page.applyTranscript(w, live("tkt_1", { role: "user", content: "[使用者的话（经 Router 转交）]\n继续" }));
	page.applyTranscript(w, live("tkt_1", dispatchCall("c2", "news-researcher", "再查")));
	assert.deepEqual(w.steps.map((s) => [s.detail, s.state]), [["新闻研究员 · 已停止", "stopped"], ["sleep 300", "stopped"], ["继续", "ok"], ["新闻研究员 · 排队中", "pending"]]);
});

test("页面：展开一次派活能看到成员自己的步骤：干活时一条条加上，做完后还在；同一条消息送来两次只算一次", () => {
	const view = page.emptyView();
	const w = page.emptyWatch("tkt_1");
	const get = { role: "assistant", content: [{ type: "text", text: "先看新闻" }, { type: "toolCall", id: "m1", name: "web_get", arguments: { url: "https://example.com/n" } }] };
	const got = { role: "toolResult", toolCallId: "m1", toolName: "web_get", content: [{ type: "text", text: "网页" }] };
	page.applyTranscript(w, teamHistory("tkt_1", [dispatchCall("c1", "news-researcher", "查新闻")], { c1: [get] }));
	page.applyMessage(view, board([row({ id: "tkt_1", workerState: "running" })], zeroToday(), noHelpers, {}, { tkt_1: [onBoard("c1", "新闻研究员", "running")] }), 0);
	const inside = () => page.liveSteps(w, view)[0].dispatch!.steps.map((s) => [s.title, s.detail, s.state]);
	assert.deepEqual(inside(), [["思考", "先看新闻", "ok"], ["读取网页", "example.com", "pending"]]);
	assert.equal(page.applyTranscript(w, fromMember("tkt_1", "c1", 1, got)), true);
	page.applyTranscript(w, fromMember("tkt_1", "c1", 1, got));
	page.applyTranscript(w, fromMember("tkt_1", "c1", 2, said("没有重大新闻")));
	assert.deepEqual(inside(), [["思考", "先看新闻", "ok"], ["读取网页", "example.com", "ok"]], "成员最后那段不带工具调用的话就是它的回复，回复框里已经有了，不再算一步");
	assert.equal(w.steps.length, 1, "成员的消息不混进助手自己的步骤");
	page.applyTranscript(w, live("tkt_1", dispatchResult("c1", outcome("新闻研究员", "done", "没有重大新闻", 300))));
	assert.deepEqual(inside().length, 2, "做完后步骤还在");
	const cut = page.emptyWatch("tkt_2");
	page.applyTranscript(cut, teamHistory("tkt_2", [dispatchCall("c1", "news-researcher", "查新闻"), dispatchResult("c1", outcome("新闻研究员", "stalled", null, 0, "3 分钟没有进展"))], { c1: [get] }));
	assert.deepEqual(page.liveSteps(cut, view)[0].dispatch!.steps.map((s) => s.state), ["ok", "stopped"], "成员被结束时没做完的那一步也停下");
});

const TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write", "web_get", "lookup", "new_app", "read_ticket", "hand_back", "bg_start", "bg_status", "bg_stop", "report", "dispatch_agent"];

test("页面：new_app 的步骤叫「开应用目录」，明细是短名", () => {
	assert.deepEqual(format.toolStep("new_app", { short: "joke" }), { icon: "folder", title: "开应用目录", detail: "joke" });
});

test("页面：每种工具的步骤都有一个图标，未知工具用通用图标；index.html 的图标模板和图标名单一一对应", () => {
	for (const name of TOOL_NAMES) assert.ok((format.STEP_ICONS as readonly string[]).includes(format.toolStep(name, {}).icon), `${name} → ${format.toolStep(name, {}).icon}`);
	assert.equal(format.toolStep("mystery", {}).icon, "tool");
	const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
	const template = /<template id="step-icons">([\s\S]*?)<\/template>/.exec(html)?.[1] ?? "";
	const drawn = [...template.matchAll(/<svg data-icon="([a-z]+)"/g)].map((m) => m[1]);
	assert.deepEqual([...drawn].sort(), [...format.STEP_ICONS].sort(), "模板里每个图标名画一次，不多不少");
	assert.equal([...template.matchAll(/<svg /g)].length, format.STEP_ICONS.length);
	for (const svg of template.match(/<svg [^>]*>/g) ?? []) {
		assert.match(svg, /stroke="currentColor"/);
		assert.match(svg, /fill="none"/);
		assert.match(svg, /aria-hidden="true"/);
	}
});

test("页面：不是工具调用的步骤也有图标：思考、收到的输入、后台命令完成", () => {
	const w = page.emptyWatch("tkt_1");
	page.applyTranscript(w, history("tkt_1", [{ role: "user", content: "[任务说明]\n查天气" }, said("先想想"), { role: "custom", customType: "psa-bg-result", content: "退出码 0" }]));
	assert.deepEqual(w.steps.map((s) => [s.title, s.icon]), [["接收任务", "inbox"], ["思考", "thought"], ["后台命令完成", "terminal"]]);
});

test("页面：同一条消息里的几次派活是同一轮，分开的消息是两轮；同一条消息里的别的工具不算进这一轮", () => {
	const steps = watched([
		{ role: "assistant", content: [...dispatchCall("c1", "market-analyst", "看盘面").content, ...dispatchCall("c2", "news-researcher", "查新闻").content, { type: "toolCall", id: "r1", name: "read", arguments: { path: "a.md" } }] },
		dispatchCall("c3", "news-researcher", "再查"),
	]);
	assert.deepEqual(steps.map((s) => [s.callId, s.round]), [["c1", "c1"], ["c2", "c1"], ["r1", undefined], ["c3", "c3"]]);
});

test("页面：没结束的派活的时钟跟着看板：排队时只知道时限，进行中记下按页面时钟算的开始时间，先做完的那位停在看板给的用时上；助手不在了就不写时间", () => {
	const view = page.emptyView();
	const w = page.emptyWatch("tkt_1");
	page.applyTranscript(w, teamHistory("tkt_1", [dispatchCall("c1", "market-analyst", "看盘面"), dispatchCall("c2", "news-researcher", "查新闻")]));
	const clocks = () => page.liveSteps(w, view).map((s) => s.dispatch?.clock);
	page.applyMessage(view, board([row({ id: "tkt_1" })]), 0);
	assert.deepEqual(clocks(), [{ phase: "waiting", limitMs: null }, { phase: "waiting", limitMs: null }], "看板还没列出来时不知道时限");
	const frame = (...entries: Dispatching[string]) => page.applyMessage(view, board([row({ id: "tkt_1" })], zeroToday(), noHelpers, {}, { tkt_1: entries }), 1000);
	frame(onBoard("c1", "行情分析师", "running", { runningMs: 5000 }), onBoard("c2", "新闻研究员", "queued", { limitMs: 3_600_000 }));
	assert.deepEqual(clocks(), [{ phase: "running", runningSince: -4000, limitMs: 900_000 }, { phase: "waiting", limitMs: 3_600_000 }]);
	frame(onBoard("c1", "行情分析师", "done", { runningMs: 38_000 }), onBoard("c2", "新闻研究员", "running", { runningMs: 0, limitMs: 3_600_000 }));
	assert.deepEqual(clocks(), [{ phase: "ended", ranMs: 38_000, limitMs: 900_000 }, { phase: "running", runningSince: 1000, limitMs: 3_600_000 }]);
	page.applyMessage(view, board([row({ id: "tkt_1", stage: "stopped", workerState: "idle", endedAt: 5 })]), 2000);
	assert.deepEqual(clocks(), [null, null], "被叫停、没等到结果的派活只知道一个下限，不写时间");
	assert.equal(w.steps[0].dispatch?.clock.phase, "waiting", "liveSteps 不改动记录本身");
});

test("页面：结束的派活的时钟来自结果：用时和时限；老会话的结果没有时限；没开始就结束的（排队超时、被拒）没有用时", () => {
	const steps = watched([
		dispatchCall("c1", "a", "t"), dispatchResult("c1", { ...outcome("甲", "done", "答", 0), ms: 38_000 }),
		dispatchCall("c2", "a", "t"), dispatchResult("c2", (({ limitMs, ...old }) => old)({ ...outcome("乙", "done", "答", 0), ms: 2000 })),
		dispatchCall("c3", "a", "t"), dispatchResult("c3", { ...outcome("丙", "timed_out", null, 0, "排队 15 分钟还没轮到"), ms: 0 }),
	]);
	assert.deepEqual(steps.map((s) => s.dispatch?.clock), [{ phase: "ended", ranMs: 38_000, limitMs: 900_000 }, { phase: "ended", ranMs: 2000, limitMs: null }, null]);
});

test("页面：派活分支的时间写法：进行中写已用和时限，带进度条；结束后写用时和时限，不带进度条；排队、被叫停和没开始的什么都不写", () => {
	const at = (clock: page.DispatchEntry["clock"], now = 0) => page.laneClock({ clock } as page.DispatchEntry, now);
	assert.deepEqual(at({ phase: "running", runningSince: 0, limitMs: 900_000 }, 38_000), { text: "已用 38 秒 · 时限 15 分钟", ratio: 38_000 / 900_000 });
	assert.deepEqual(at({ phase: "running", runningSince: 0, limitMs: 3_600_000 }, 200_000), { text: "已用 3 分钟 · 时限 60 分钟", ratio: 200_000 / 3_600_000 });
	assert.equal(at({ phase: "running", runningSince: 0, limitMs: 30_000 }, 4000).text, "已用 4 秒 · 时限 30 秒", "时限照配置写，不写死 15 分钟");
	assert.equal(at({ phase: "running", runningSince: 0, limitMs: 30_000 }, 45_000).ratio, 1, "超出时限时进度条停在满格");
	assert.deepEqual(at({ phase: "ended", ranMs: 38_000, limitMs: 900_000 }), { text: "用时 38 秒 · 时限 15 分钟", ratio: null });
	assert.deepEqual(at({ phase: "ended", ranMs: 38_000, limitMs: null }), { text: "用时 38 秒", ratio: null });
	assert.deepEqual(at({ phase: "waiting", limitMs: 900_000 }), { text: "", ratio: null });
	assert.deepEqual(at(null), { text: "", ratio: null });
	assert.equal(page.BAR_HINT, "按时限折算，不是完成度");
});

test("页面：执行过程按步排列，一轮里的几次派活并成一组分支，放在这一轮第一次派活的位置；一次派活也是一组；被宿主拒绝的派活是普通的一步", () => {
	const view = page.emptyView();
	const w = page.emptyWatch("tkt_1");
	page.applyTranscript(w, teamHistory("tkt_1", [
		tool("read", { path: "a.md" }),
		{ role: "assistant", content: [...dispatchCall("c1", "market-analyst", "看盘面").content, ...dispatchCall("c2", "news-researcher", "查新闻").content] },
		dispatchResult("c1", outcome("行情分析师", "done", "答", 0)),
		dispatchCall("c3", "news-researcher", "再查"),
		dispatchCall("c4", "nobody", "t"), dispatchResult("c4", undefined, true),
	]));
	const team = row({ id: "tkt_1", helper: { name: "高山流水", team: "美股看盘队", seq: 2 }, dispatchedTo: ["行情分析师", "新闻研究员"] });
	page.applyMessage(view, board([team], zeroToday(), noHelpers, {}, { tkt_1: [onBoard("c2", "新闻研究员", "running", { runningMs: 0 }), onBoard("c3", "新闻研究员", "queued")] }), 0);
	const groups = page.stepGroups(page.liveSteps(w, view), team);
	assert.deepEqual(groups.map((g) => (g.kind === "step" ? ["step", g.i] : ["lanes", g.state, g.lanes.map((l) => [l.i, l.step.detail])])), [
		["step", 0],
		["lanes", "pending", [[1, "行情分析师 · 完成"], [2, "新闻研究员 · 进行中"]]],
		["lanes", "pending", [[3, "新闻研究员 · 排队中"]]],
		["step", 4],
	]);
	const lanes = groups.flatMap((g) => (g.kind === "lanes" ? g.lanes : []));
	assert.deepEqual(lanes.slice(0, 2).map((l) => l.avatar), page.memberAvatars(team.dispatchedTo!), "分支上的头像和卡片底部的一样");
	assert.deepEqual(page.stepGroups(page.liveSteps(w, view), undefined).flatMap((g) => (g.kind === "lanes" ? g.lanes.map((l) => l.avatar.text) : [])), ["行", "新", "新"], "没有任务行时按分支自己的职称取头像");
	const done = page.stepGroups(watched([{ role: "assistant", content: [...dispatchCall("c1", "a", "t").content, ...dispatchCall("c2", "a", "t").content] }, dispatchResult("c1", outcome("甲", "done", "答", 0)), dispatchResult("c2", outcome("乙", "failed", null, 0, "429"))]), undefined);
	assert.deepEqual(done.map((g) => g.kind === "lanes" && g.state), ["error"], "一组里有出错的，这一组的标记就是出错");
});

test("页面：Markdown 只认安全的子集，解析成段落、标题和列表，行内只有粗体、斜体、代码和链接文字，HTML 原样当文字", () => {
	const blocks = page.parseMarkdown("## 结论\n**个股领跌**，*仍偏空*，看 `sma50`\n\n- 第一条\n- 来源 [路透](https://reuters.com/x)\n1. 甲\n2. 乙\n\n<script>alert(1)</script> 不是标签");
	assert.deepEqual(blocks, [
		{ kind: "h", level: 2, spans: [{ text: "结论" }] },
		{ kind: "p", spans: [{ text: "个股领跌", bold: true }, { text: "，" }, { text: "仍偏空", italic: true }, { text: "，看 " }, { text: "sma50", code: true }] },
		{ kind: "ul", items: [[{ text: "第一条" }], [{ text: "来源 " }, { text: "路透" }, { text: "（https://reuters.com/x）" }]] },
		{ kind: "ol", items: [[{ text: "甲" }], [{ text: "乙" }]] },
		{ kind: "p", spans: [{ text: "<script>alert(1)</script> 不是标签" }] },
	]);
});

test("页面：Markdown 表格解析成表头和行，单元格里照样认粗体和代码；没有分隔行的竖线只是文字", () => {
	const blocks = page.parseMarkdown("对比如下：\n| 指标 | NVDA | SPY |\n|:--|--:|:-:|\n| 跌幅 | **4.2%** | 0.8% |\n| 量能 | `1.8x` |\n\n之后的话");
	assert.deepEqual(blocks, [
		{ kind: "p", spans: [{ text: "对比如下：" }] },
		{ kind: "table", head: [[{ text: "指标" }], [{ text: "NVDA" }], [{ text: "SPY" }]], rows: [
			[[{ text: "跌幅" }], [{ text: "4.2%", bold: true }], [{ text: "0.8%" }]],
			[[{ text: "量能" }], [{ text: "1.8x", code: true }], []],
		] },
		{ kind: "p", spans: [{ text: "之后的话" }] },
	]);
	assert.deepEqual(page.parseMarkdown("| 只是 | 一行 |\n下一行"), [{ kind: "p", spans: [{ text: "| 只是 | 一行 |\n下一行" }] }]);
	const started = performance.now();
	page.parseMarkdown("| a | b |\n|--|--|\n" + "| x | y |\n".repeat(20_000) + "|".repeat(100_000));
	assert.ok(performance.now() - started < 300, "大表格和成串的竖线也是线性时间");
});

test("页面：Markdown 的粗体、斜体、代码、链接和表格里夹着像 HTML 的内容时，原样留在文字里，解析结果里没有任何标签结构", () => {
	const payload = '<img src=x onerror="alert(1)">';
	const blocks = page.parseMarkdown(`**${payload}** 和 *<i>斜</i>* 和 \`${payload}\` 和 [<u>链</u>](https://e.com/<x>)\n\n| <b>头</b> |\n|--|\n| ${payload} |`);
	assert.deepEqual(blocks, [
		{ kind: "p", spans: [{ text: payload, bold: true }, { text: " 和 " }, { text: "<i>斜</i>", italic: true }, { text: " 和 " }, { text: payload, code: true }, { text: " 和 " }, { text: "<u>链</u>" }, { text: "（https://e.com/<x>）" }] },
		{ kind: "table", head: [[{ text: "<b>头</b>" }]], rows: [[[{ text: payload }]]] },
	]);
	const kinds = new Set<string>();
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) return value.forEach(walk);
		if (value && typeof value === "object") for (const [key, v] of Object.entries(value)) (kinds.add(key), walk(v));
	};
	walk(blocks);
	assert.deepEqual([...kinds].sort(), ["bold", "code", "head", "italic", "kind", "rows", "spans", "text"], "解析结果只有这几种字段，页面只会把 text 放进文本节点");
});

test("页面的脚本从不把字符串当 HTML 写进文档：成员回复、幕僚长的话和汇报都只经文本节点显示", () => {
	for (const file of ["app.mjs", "view.mjs"]) {
		const source = readFileSync(new URL(`../src/web/${file}`, import.meta.url), "utf8");
		assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser|\.srcdoc/, file);
	}
});

test("页面：助手的汇报这一步按 Markdown 显示，别的步骤不是", () => {
	const steps = watched([tool("report", { status: "ready", summary: "**结论**：个股领跌" }), tool("bash", { command: "echo **不是 Markdown**" })]);
	assert.deepEqual(steps.map((s) => [s.title, s.detail, s.markdown ?? false]), [["提交结果", "**结论**：个股领跌", true], ["执行命令", "echo **不是 Markdown**", false]]);
});

test("页面：Markdown 里的多行段落保留换行，没有 Markdown 记号的文字原样是一段", () => {
	assert.deepEqual(page.parseMarkdown("第一行\n第二行"), [{ kind: "p", spans: [{ text: "第一行\n第二行" }] }]);
	assert.deepEqual(page.parseMarkdown("a*b 和 snake_case_name"), [{ kind: "p", spans: [{ text: "a*b 和 snake_case_name" }] }]);
});

test("页面：Markdown 解析对括号密集的长文本仍是线性的，正常链接照常解析", () => {
	for (const text of ["[".repeat(200_000), "[a](x".repeat(40_000), "[a]".repeat(70_000) + "(", "](".repeat(100_000)]) {
		const started = performance.now();
		page.parseMarkdown(text);
		const ms = performance.now() - started;
		assert.ok(ms < 100, `${JSON.stringify(text.slice(0, 6))}… ${text.length} 字用了 ${Math.round(ms)} ms`);
	}
	assert.deepEqual(page.parseMarkdown("看 [路透](https://reuters.com/a_b?x=1) 和 [官方](https://nvidia.com)")[0], {
		kind: "p", spans: [{ text: "看 " }, { text: "路透" }, { text: "（https://reuters.com/a_b?x=1） 和 " }, { text: "官方" }, { text: "（https://nvidia.com）" }],
	});
});

const capQuestion = { reportId: "ask_cap_2026-11-09", text: "现在有 2 位成员在排队，同时运行的成员上限是 4。今天放宽到 10 吗？", options: ["今天放宽到 10", "保持 4"], askedAt: 5 * MIN };

test("页面：宿主关于成员上限的问题排在待你处理的最前面，是一张不属于任何任务的卡片，带两个按钮；标题的数字把它算上", () => {
	const view = page.emptyView();
	page.applyMessage(view, snapshot({ board: [row({ id: "tkt_a", stage: "awaiting_answer", question: asked() })], memberCap: { limit: 4, question: capQuestion } }), 0);
	const left = page.leftColumn(view, 0);
	assert.deepEqual(left.capCard, {
		title: "成员上限", source: "白宫 · 系统", stage: "待回复", latest: capQuestion.text,
		choice: { reportId: "ask_cap_2026-11-09", buttons: [{ label: "今天放宽到 10", option: 0, picked: false }, { label: "保持 4", option: 1, picked: false }], locked: false, note: "" },
	});
	assert.deepEqual(left.needsYou.map((c) => c.id), ["tkt_a"]);
	assert.equal(left.needsYouLine, "待你处理 · 2");
	page.applyMessage(view, { ...board(view.rows), memberCap: { limit: 10, question: null } } as HostToClient, 0);
	assert.equal(page.leftColumn(view, 0).capCard, null, "答过之后卡片收起");
	assert.equal(page.leftColumn(view, 0).needsYouLine, "待你处理 · 1");
	page.applyMessage(view, board(view.rows), 0);
	assert.equal(page.leftColumn(view, 0).capCard, null, "老宿主的帧没有这一项也不出错");
});

test("页面：助手照着成员上限的卡片提一个问题，标题、问题、选项都一样，也还是任务卡片：写的是助手的名字，没有「白宫 · 系统」这一行", () => {
	const view = page.emptyView();
	const copy = row({ id: "tkt_copy", title: "成员上限", stage: "awaiting_answer", question: asked({ text: capQuestion.text, options: capQuestion.options }) });
	const named = row({ id: "tkt_named", title: "成员上限 · 白宫 · 系统", stage: "awaiting_answer", question: asked({ reportId: "rpt_q2", text: capQuestion.text, options: capQuestion.options }) });
	page.applyMessage(view, snapshot({ board: [copy, named], memberCap: { limit: 4, question: capQuestion } }), 0);
	const left = page.leftColumn(view, 0);
	assert.equal(left.capCard?.source, "白宫 · 系统");
	for (const card of left.needsYou) {
		assert.equal("source" in card, false, card.title);
		assert.equal(card.helper, "青檀 · 对话助手 #1", card.title);
	}
	page.applyMessage(view, { ...board(view.rows), memberCap: { limit: 4, question: null } } as HostToClient, 0);
	assert.equal(page.leftColumn(view, 0).capCard, null, "宿主没有在问的时候，助手的同名卡片不会变成宿主的卡片");
});

test("页面：点了成员上限的按钮，发送中锁住并标出选的那一项；宿主收下后写「已发送」，不提幕僚长；看板上问题没了就放下", () => {
	const view = page.emptyView();
	page.applyMessage(view, snapshot({ memberCap: { limit: 4, question: capQuestion } }), 0);
	const sending = new Map<string, { option: number; triggerId?: string }>([[capQuestion.reportId, { option: 0 }]]);
	const seen = () => {
		const c = page.leftColumn(view, 0, sending).capCard?.choice;
		return c && [c.locked, c.buttons.map((b) => b.picked), c.note];
	};
	assert.deepEqual(seen(), [true, [true, false], "发送中…"]);
	sending.set(capQuestion.reportId, { option: 0, triggerId: capQuestion.reportId });
	page.settleSending(view, sending);
	assert.deepEqual(seen(), [true, [true, false], "已发送"]);
	page.applyMessage(view, { ...board([]), memberCap: { limit: 10, question: null } } as HostToClient, 0);
	page.settleSending(view, sending);
	assert.equal(sending.size, 0);
});

test("页面：排队的成员标签带上现在的上限，使用者看得到放宽有没有生效", () => {
	const view = page.emptyView();
	const queued: Dispatching = { tkt_t: [onBoard("c1", "财报解读", "queued")] };
	const frame = (limit: number) => ({ ...board([row({ id: "tkt_t", stage: "running", workerState: "running", helper: { name: "高山流水", team: "看盘队", seq: 1 } })], zeroToday(), noHelpers, {}, queued), memberCap: { limit, question: null } }) as HostToClient;
	page.applyMessage(view, frame(4), 0);
	assert.deepEqual(page.helperStrip(view, 0).chips[0].members.map((m) => m.label), ["财报解读 · 排队中 · 上限 4"]);
	page.applyMessage(view, frame(10), 0);
	assert.deepEqual(page.helperStrip(view, 0).chips[0].members.map((m) => m.label), ["财报解读 · 排队中 · 上限 10"]);
});

test("页面：有外写的任务卡片多一行，确切写入和推测的可能写入分开数，带最多三个路径；只有推测的只说可能；没有外写的这一行是空的", () => {
	const left = page.leftColumn(withRows([
		row({ id: "tkt_out", stage: "closed", outside: { wrote: 5, maybe: 0, sample: ["/repo/a.ts", "/repo/b.ts", "/repo"] } }),
		row({ id: "tkt_one", stage: "closed", outside: { wrote: 1, maybe: 0, sample: ["/repo/a.ts"] } }),
		row({ id: "tkt_mix", stage: "closed", outside: { wrote: 2, maybe: 1, sample: ["/repo/a.ts", "/repo/b.ts", "/repo"] } }),
		row({ id: "tkt_may", stage: "closed", outside: { wrote: 0, maybe: 3, sample: ["/repo/a.ts", "/repo/b.ts", "/repo"] } }),
		row({ id: "tkt_cln", stage: "closed", outside: null }),
	]), 0);
	assert.deepEqual(Object.fromEntries(left.done.map((c) => [c.id, c.outside])), {
		tkt_cln: "",
		tkt_one: "写到成品目录之外 1 处：/repo/a.ts",
		tkt_out: "写到成品目录之外 5 处：/repo/a.ts、/repo/b.ts、/repo …",
		tkt_mix: "写到成品目录之外 2 处，另有 1 处可能：/repo/a.ts、/repo/b.ts、/repo",
		tkt_may: "可能写到成品目录之外 3 处：/repo/a.ts、/repo/b.ts、/repo",
	});
});

const sent = (id: string, text: string, who: "user" | "router" = "user"): ConversationLine => ({ id, who, text, at: Number(id.slice(1)) });
const fresh = { index: null, draft: "" };
const key = (k: string, over: Partial<KeyboardEvent> = {}) => ({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0, ...over });

test("页面：输入框的历史是你自己发过的话，按时间先后，清屏藏起的也算；连着发两遍同一句只算一次；幕僚长的话和点选项的回答不算", () => {
	const view = page.emptyView();
	const cardAnswer = sent("u5", answerSentence("查天气", "要带伞"));
	page.applyMessage(view, snapshot({ cleared: { at: 1, lines: [sent("u1", "查天气"), sent("r2", "多云", "router")] }, conversation: [sent("u3", "改成 B"), sent("u4", "改成 B"), cardAnswer, sent("u6", "查天气"), sent("r7", "好", "router")] }), 0);
	assert.deepEqual(page.sentHistory(view), ["查天气", "改成 B", "查天气"]);
});

test("页面：没有历史时按 ↑ 不接管，光标照常移动", () => {
	assert.equal(page.historyStep(fresh, "up", [], "草稿"), null);
});

test("页面：按 ↑ 从最新一句往回走，走到最早一句停住；第一次按下前输入框里的字存为草稿", () => {
	const entries = ["一", "二", "三"];
	const first = page.historyStep(fresh, "up", entries, "没写完")!;
	assert.equal(first.text, "三");
	const second = page.historyStep(first.state, "up", entries, first.text)!;
	assert.equal(second.text, "二");
	const third = page.historyStep(second.state, "up", entries, second.text)!;
	assert.equal(third.text, "一");
	assert.equal(page.historyStep(third.state, "up", entries, third.text), null);
});

test("页面：按 ↓ 往新的走，越过最新一句回到草稿；不在翻历史时 ↓ 不接管", () => {
	const entries = ["一", "二"];
	assert.equal(page.historyStep(fresh, "down", entries, "没写完"), null);
	const back2 = page.historyStep(page.historyStep(fresh, "up", entries, "没写完")!.state, "up", entries, "二")!;
	const forward = page.historyStep(back2.state, "down", entries, back2.text)!;
	assert.equal(forward.text, "二");
	const draft = page.historyStep(forward.state, "down", entries, forward.text)!;
	assert.equal(draft.text, "没写完");
	assert.equal(page.historyStep(draft.state, "down", entries, draft.text), null);
});

test("页面：翻到历史后改了字，再按 ↑ 从最新一句重新开始，改过的字成了新草稿", () => {
	const entries = ["一", "二", "三"];
	const back = page.historyStep(page.historyStep(fresh, "up", entries, "旧草稿")!.state, "up", entries, "三")!;
	const again = page.historyStep(back.state, "up", entries, "二改了")!;
	assert.equal(again.text, "三");
	const home = page.historyStep(again.state, "down", entries, again.text)!;
	assert.equal(home.text, "二改了");
});

test("页面：只有光标在第一行按 ↑、在最后一行按 ↓ 才翻历史；选中文字、按着修饰键、输入法正在拼字时都不翻", () => {
	const text = "第一行\n第二行\n第三行";
	assert.equal(page.historyKey(key("ArrowUp"), text, 2, 2), "up");
	assert.equal(page.historyKey(key("ArrowUp"), text, 5, 5), null);
	assert.equal(page.historyKey(key("ArrowDown"), text, 5, 5), null);
	assert.equal(page.historyKey(key("ArrowDown"), text, 10, 10), "down");
	assert.equal(page.historyKey(key("ArrowUp"), "\n下面", 0, 0), "up");
	assert.equal(page.historyKey(key("ArrowUp"), "一行", 0, 2), null);
	for (const held of ["shiftKey", "altKey", "ctrlKey", "metaKey", "isComposing"] as const) assert.equal(page.historyKey(key("ArrowUp", { [held]: true }), "", 0, 0), null, held);
	assert.equal(page.historyKey(key("ArrowUp", { keyCode: 229 }), "", 0, 0), null);
	assert.equal(page.historyKey(key("Enter"), "", 0, 0), null);
});

test("宿主：有面板的来源程序在关注的来源里带上面板和今日提醒数，没面板的只带今日提醒数，没有来源程序的来源都不带", async (t) => {
	const market = fakeFeed("us-market", () => ({ watchlist: ["NVDA", "SPY"], tripwires: [NVDA_COST] }));
	const plain = fakeFeed("plain-feed");
	const watching = ["us-market", "plain-feed", "toy-market"].map((source) => ({ source, timers: [], rules: [] }));
	const { host } = await webHost(t, () => [], { feeds: [market.spec, plain.spec], watching });
	market.ctx!.post({ kind: "alert", externalId: "NVDA:x", text: "NVDA 涨了 5.3%", occurredAt: 1 });
	market.ctx!.post({ kind: "receipt", text: "已记下：NVDA" });
	assert.deepEqual(host.snapshot().watching, [
		{ source: "us-market", timers: [], rules: [], panel: { watchlist: ["NVDA", "SPY"], tripwires: [NVDA_COST] }, alertsToday: 1 },
		{ source: "plain-feed", timers: [], rules: [], alertsToday: 0 },
		{ source: "toy-market", timers: [], rules: [] },
	]);
});

test("网关：改了盯盘条件、贴了提醒，开着的网页从 board 帧拿到新的面板和今日提醒数", async (t) => {
	let tripwires: string[] = [];
	const market = fakeFeed("us-market", () => ({ watchlist: ["NVDA"], tripwires }));
	const { events } = await webHost(t, () => [], { feeds: [market.spec], watching: [{ source: "us-market", timers: [], rules: [] }] });
	const stream = events();
	await until(() => ofType(stream.got, "snapshot").length === 1, "快照");
	const panelOf = (m: { watching: WatchedSource[] }) => m.watching.find((w) => w.source === "us-market");
	tripwires = [NVDA_COST];
	market.ctx!.post({ kind: "receipt", text: "已添加：NVDA" });
	await until(() => ofType(stream.got, "board").some((m) => panelOf(m)?.panel?.tripwires[0] === NVDA_COST), "board 帧带新条件");
	market.ctx!.post({ kind: "alert", externalId: "NVDA:x", text: "NVDA 涨了 5.3%", occurredAt: 1 });
	await until(() => ofType(stream.got, "board").some((m) => panelOf(m)?.alertsToday === 1), "board 帧带今日提醒数");
});

test("网关：贴了提醒，开着的网页从 board 帧拿到今天的提醒列表，快照里也有", async (t) => {
	const market = fakeFeed("us-market");
	const { events, host } = await webHost(t, () => [], { feeds: [market.spec], watching: [{ source: "us-market", timers: [], rules: [] }] });
	const stream = events();
	await until(() => ofType(stream.got, "snapshot").length === 1, "快照");
	market.ctx!.post({ kind: "alert", externalId: "NVDA:x", text: "NVDA 涨了 5.3%", occurredAt: 1 });
	await until(() => ofType(stream.got, "board").some((m) => m.alerts?.[0]?.text === "NVDA 涨了 5.3%"), "board 帧带今天的提醒");
	assert.deepEqual(host.snapshot().alerts.map((l) => [l.who, l.text]), [["alert", "NVDA 涨了 5.3%"]]);
});

test("网关：来源贴的提醒和收据经事件流到网页，各一帧；重复的提醒不再发；之后连上的网页在快照里看到它们", async (t) => {
	const feed = fakeFeed("us-market");
	const { events } = await webHost(t, () => [], { feeds: [feed.spec] });
	const stream = events();
	await until(() => ofType(stream.got, "snapshot").length === 1, "快照");
	feed.ctx!.post({ kind: "alert", externalId: "NVDA:x", text: "NVDA 涨了 5.3%", occurredAt: 1 });
	feed.ctx!.post({ kind: "alert", externalId: "NVDA:x", text: "NVDA 涨了 5.3%", occurredAt: 1 });
	feed.ctx!.post({ kind: "receipt", text: "已记下：NVDA" });
	await until(() => ofType(stream.got, "host_line").length === 2, "两帧宿主行");
	await new Promise((r) => setTimeout(r, 200));
	assert.deepEqual(ofType(stream.got, "host_line").map((m) => [m.who, m.text]), [["alert", "NVDA 涨了 5.3%"], ["receipt", "已记下：NVDA"]]);
	const later = events();
	await until(() => ofType(later.got, "snapshot").length === 1, "新网页的快照");
	assert.deepEqual(ofType(later.got, "snapshot")[0].conversation.map((l) => [l.who, l.text]), [["alert", "NVDA 涨了 5.3%"], ["receipt", "已记下：NVDA"]]);
});

const panelAfter = (...events: Parameters<typeof page.panelStep>[1][]) => events.reduce(page.panelStep, page.firstPanel());

test("右栏：开始停在「今天」，没有任务标签", () => {
	assert.deepEqual(page.firstPanel(), { showing: "today", task: null, last: "today", flash: null, place: "todo", dot: false });
});

test("右栏：选中任务，任务标签切过去；切到别的标签任务标签留着；在任务标签上点 × 回到选任务之前的标签", () => {
	const opened = panelAfter({ kind: "pick", tab: "sources" }, { kind: "open", ticketId: "tkt_a" });
	assert.deepEqual([opened.showing, opened.task], ["task", "tkt_a"]);
	const away = page.panelStep(opened, { kind: "pick", tab: "modules" });
	assert.deepEqual([away.showing, away.task], ["modules", "tkt_a"]);
	const back = page.panelStep(away, { kind: "pick", tab: "task" });
	assert.equal(back.showing, "task");
	assert.equal(page.panelStep(opened, { kind: "close" }).showing, "sources");
	assert.deepEqual(page.panelStep(back, { kind: "close" }), { showing: "modules", task: null, last: "modules", flash: null, place: "todo", dot: false });
});

test("右栏：在别的标签上关任务，停在原地", () => {
	const closed = panelAfter({ kind: "open", ticketId: "tkt_a" }, { kind: "pick", tab: "done" }, { kind: "close" });
	assert.deepEqual([closed.showing, closed.task], ["done", null]);
});

test("右栏：选另一个任务换掉任务标签，× 仍回到最早那个概况标签", () => {
	const second = panelAfter({ kind: "pick", tab: "modules" }, { kind: "open", ticketId: "tkt_a" }, { kind: "open", ticketId: "tkt_b" });
	assert.deepEqual([second.showing, second.task], ["task", "tkt_b"]);
	assert.equal(page.panelStep(second, { kind: "close" }).showing, "modules");
});

test("右栏：没有任务时点任务标签不动", () => {
	assert.equal(page.panelStep(page.firstPanel(), { kind: "pick", tab: "task" }).showing, "today");
});

test("右栏：来了不属于任务的提醒，切到「今天」并高亮这条，任务标签留着；再选标签高亮消失", () => {
	const alerted = panelAfter({ kind: "open", ticketId: "tkt_a" }, { kind: "pick", tab: "sources" }, { kind: "alert", lineId: "hln_1" });
	assert.deepEqual(alerted, { showing: "today", task: "tkt_a", last: "today", flash: "hln_1", place: "todo", dot: true });
	assert.equal(page.panelStep(alerted, { kind: "pick", tab: "modules" }).flash, null);
	assert.equal(page.panelStep(alerted, { kind: "close" }).flash, "hln_1", "关任务标签不影响高亮");
});

test("右栏：来了属于某个任务的提醒，打开那个任务的标签", () => {
	const alerted = panelAfter({ kind: "pick", tab: "modules" }, { kind: "alert", lineId: "hln_1", ticketId: "tkt_b" });
	assert.deepEqual([alerted.showing, alerted.task, alerted.flash], ["task", "tkt_b", null]);
	assert.equal(page.panelStep(alerted, { kind: "close" }).showing, "modules");
});

const hostAlert = (id: string, text: string) => ({ id, who: "alert" as const, text, at: 1 });

test("右栏标签：今天 = 今日来源消息 + 今日提醒，来源、模块、已完成各带数字；有任务时任务标签排第一，写编号前 4 位", () => {
	const view = page.emptyView();
	const today = zeroToday();
	today.byDisposition.opened_ticket = 2;
	today.byDisposition.ignored = 1;
	page.applyMessage(view, {
		...board([row({ id: "tkt_9f3a77", stage: "closed" }), row({ id: "tkt_b", stage: "running" })], today, noHelpers, {}, {}, [{ source: "inbox", timers: [], rules: [] }]),
		modules: [taxCard(), taxCard({ name: "health" })],
		alerts: [hostAlert("hln_1", "NVDA 涨了 5.3%")],
	} as HostToClient, 0);
	const tabs = (panel: ReturnType<typeof page.firstPanel>) => page.overviewTabs(view, panel).map((t) => [t.key, t.label, t.count, t.selected]);
	assert.deepEqual(tabs(page.firstPanel()), [["today", "今天", 4, true], ["sources", "来源", 1, false], ["modules", "模块", 2, false], ["done", "已完成", 1, false]]);
	assert.deepEqual(tabs(panelAfter({ kind: "open", ticketId: "tkt_9f3a77" }))[0], ["task", "任务 #9f3a", null, true]);
});

test("右栏「今天」：今日提醒新的在前，写条数；没有提醒时写一句", () => {
	const view = page.emptyView();
	page.applyMessage(view, { ...board([]), alerts: [hostAlert("hln_1", "NVDA 涨了 5.3%"), hostAlert("hln_2", "SPY 跌了 3%")] } as HostToClient, 0);
	const left = page.leftColumn(view, 0);
	assert.equal(left.alertsLine, "今日提醒 · 2");
	assert.deepEqual(left.alerts, [{ id: "hln_2", text: "SPY 跌了 3%" }, { id: "hln_1", text: "NVDA 涨了 5.3%" }]);
	const quiet = page.leftColumn(withRows([]), 0);
	assert.deepEqual([quiet.alertsLine, quiet.alerts], ["今日暂无提醒", []]);
});

test("右栏「模块」：一行一个模块，运行中的写标题，别的写状态；标题行写运行中几个", () => {
	const view = page.emptyView();
	page.applyMessage(view, { ...board([]), modules: [taxCard({ name: "stock-ta", title: "股票技术分析", on: true, label: "运行中", reason: "0.1.0", tone: "ok" }), taxCard({ title: undefined })] } as HostToClient, 0);
	const left = page.leftColumn(view, 0);
	assert.equal(left.modulesLine, "模块 · 2 · 运行中 1");
	assert.deepEqual(left.modules.map((m) => [m.name, m.on, m.note]), [["stock-ta", true, "股票技术分析"], ["tax", false, "已停用"]]);
});

test("手机：开始在「待办」；选屏换屏；任务打开时显示任务详情，返回回到点任务之前的屏，任务标签留着", () => {
	assert.equal(page.phoneScreen(page.firstPanel()), "todo");
	const chat = panelAfter({ kind: "place", place: "chat" });
	assert.equal(page.phoneScreen(chat), "chat");
	const detail = page.panelStep(chat, { kind: "open", ticketId: "tkt_a" });
	assert.equal(page.phoneScreen(detail), "task");
	const back = page.panelStep(detail, { kind: "pick", tab: detail.last });
	assert.deepEqual([page.phoneScreen(back), back.task], ["chat", "tkt_a"]);
});

test("手机：在任务详情点底栏换屏，离开详情；进概况时看的是最后那个概况分段", () => {
	const detail = panelAfter({ kind: "pick", tab: "modules" }, { kind: "open", ticketId: "tkt_a" });
	const overview = page.panelStep(detail, { kind: "place", place: "overview" });
	assert.deepEqual([page.phoneScreen(overview), overview.showing, overview.task], ["overview", "modules", "tkt_a"]);
});

test("手机：不在概况时来了提醒，不换屏，分段切到「今天」，概况带提醒点；进概况后提醒点消失", () => {
	const alerted = panelAfter({ kind: "place", place: "chat" }, { kind: "alert", lineId: "hln_1" });
	assert.deepEqual([page.phoneScreen(alerted), alerted.showing, alerted.flash, alerted.dot], ["chat", "today", "hln_1", true]);
	const seen = page.panelStep(alerted, { kind: "place", place: "overview" });
	assert.deepEqual([page.phoneScreen(seen), seen.dot, seen.flash], ["overview", false, "hln_1"]);
});

test("手机：正在看概况时来了提醒，不带提醒点", () => {
	assert.equal(panelAfter({ kind: "place", place: "overview" }, { kind: "pick", tab: "sources" }, { kind: "alert", lineId: "hln_1" }).dot, false);
});

test("手机：「待办」上的数字是待你处理的条数", () => {
	const view = withRows([row({ id: "tkt_a", stage: "awaiting_answer" }), row({ id: "tkt_b", stage: "running" })]);
	assert.equal(page.leftColumn(view, 0).needsYouCount, 1);
});
