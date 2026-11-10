// @ts-check

/** @typedef {import("../kernel/types.ts").DashboardRow} DashboardRow */
/** @typedef {import("../kernel/types.ts").InputKind} InputKind */
/** @typedef {import("../client/protocol.ts").ConversationLine} ConversationLine */
/** @typedef {import("../client/protocol.ts").Cleared} Cleared */
/** @typedef {import("../client/protocol.ts").Duty} Duty */
/** @typedef {import("../kernel/types.ts").HelpersToday} HelpersToday */
/** @typedef {import("../kernel/types.ts").Routes} Routes */
/** @typedef {import("../client/protocol.ts").HostToClient} HostToClient */
/** @typedef {import("../client/protocol.ts").TodayCounts} TodayCounts */
/** @typedef {import("../client/protocol.ts").MemberCapBoard} MemberCapBoard */
/** @typedef {import("../kernel/types.ts").CapQuestion} CapQuestion */
/** @typedef {import("../client/protocol.ts").TranscriptMessage} TranscriptMessage */
/** @typedef {import("../client/protocol.ts").WatchedSource} WatchedSource */
/** @typedef {import("../host/dispatch.ts").Dispatching} Dispatching */
/** @typedef {import("../host/dispatch.ts").BoardDispatch} BoardDispatch */
/** @typedef {import("../host/dispatch.ts").DispatchState} DispatchState */

import { HOST_SOURCE, INPUT_LABEL, QUOTE_WHO, blocks, clip, firstLine, formatElapsed, formatTokens, helperFullName, helperLabel, modelText, oneLine, shortId, stallMinutes, textOf, toolStep } from "../client/board-format.mjs";

/** @type {Record<DashboardRow["basis"], string>} */
export const BASIS_PHRASE = { request: "你的请求", rule: "规则触发", inference: "主动发现" };

/** @type {Record<DashboardRow["stage"], string>} */
export const STAGE_PHRASE = {
	awaiting_answer: "待回复",
	awaiting_review: "待确认",
	blocked_or_failed: "受阻",
	queued: "排队中",
	running: "进行中",
	idle: "等待中",
	closed: "已完成",
	stopped: "已停止",
};

/** @typedef {"needsYou" | "doing" | "done"} Group */

/** @type {Record<DashboardRow["stage"], Group>} */
const GROUP = {
	awaiting_answer: "needsYou",
	awaiting_review: "needsYou",
	blocked_or_failed: "needsYou",
	queued: "doing",
	running: "doing",
	idle: "doing",
	closed: "done",
	stopped: "done",
};

/**
 * @typedef {object} View
 * @property {Map<string, ConversationLine>} lines
 * @property {DashboardRow[]} rows
 * @property {number} receivedAt
 * @property {TodayCounts | undefined} today
 * @property {Duty | undefined} duty
 * @property {HelpersToday | undefined} helpers
 * @property {WatchedSource[]} watching
 * @property {Routes} routes
 * @property {Dispatching} dispatching
 * @property {MemberCapBoard} memberCap null from a host that cannot dispatch, or one older than this field
 * @property {Map<string, Map<string, BoardDispatch>>} lastOnBoard each unfinished ticket's dispatches as the board last listed them, by ticket then call id
 * @property {Cleared | null} cleared the host's latest 清屏 (its `at` names it), or null
 * @property {boolean} showEarlier this tab shows the lines that 清屏 hid; only this tab, until the next 清屏 or a reload
 */

/** @returns {View} */
export function emptyView() {
	return { lines: new Map(), rows: [], receivedAt: 0, today: undefined, duty: undefined, helpers: undefined, watching: [], routes: {}, dispatching: {}, memberCap: null, lastOnBoard: new Map(), cleared: null, showEarlier: false };
}

/** @param {View} view @param {Dispatching | undefined} dispatching */
function setDispatching(view, dispatching) {
	view.dispatching = dispatching ?? {};
	const unfinished = new Set(view.rows.filter((r) => r.endedAt === null).map((r) => r.id));
	for (const ticketId of view.lastOnBoard.keys()) if (!unfinished.has(ticketId)) view.lastOnBoard.delete(ticketId);
	for (const [ticketId, listed] of Object.entries(view.dispatching)) {
		if (!unfinished.has(ticketId)) continue;
		const calls = view.lastOnBoard.get(ticketId) ?? new Map();
		for (const d of listed) calls.set(d.callId, d);
		view.lastOnBoard.set(ticketId, calls);
	}
}

/** @param {View} view @param {ConversationLine} line */
function addLine(view, line) {
	if (!view.lines.has(line.id)) view.lines.set(line.id, line);
}

/** @param {View} view @param {ConversationLine[]} lines @param {Cleared | null} cleared */
function resetConversation(view, lines, cleared) {
	view.lines = new Map(lines.map((l) => [l.id, l]));
	view.cleared = cleared;
	view.showEarlier = false;
}

/**
 * @param {View} view @param {HostToClient} message @param {number} now
 * @returns {("conversation" | "left" | "header")[]}
 */
export function applyMessage(view, message, now) {
	switch (message.type) {
		case "snapshot": {
			const cleared = message.cleared ?? null;
			if (cleared?.at !== view.cleared?.at) resetConversation(view, message.conversation, cleared);
			else for (const line of message.conversation) addLine(view, line);
			Object.assign(view, { rows: message.board, today: message.today, duty: message.duty, helpers: message.helpers, watching: message.watching, routes: message.routes, memberCap: message.memberCap ?? null, receivedAt: now });
			setDispatching(view, message.dispatching);
			return ["conversation", "left", "header"];
		}
		case "cleared":
			resetConversation(view, message.conversation, message.cleared);
			return ["conversation"];
		case "user": {
			const { type, ...line } = message;
			addLine(view, line);
			return ["conversation"];
		}
		case "reply":
			addLine(view, { id: message.replyId, who: "router", text: message.text, at: message.at, ...(message.ticketId ? { ticketId: message.ticketId } : {}) });
			return ["conversation"];
		case "board":
			Object.assign(view, { rows: message.rows, today: message.today, duty: message.duty, helpers: message.helpers, routes: message.routes, memberCap: message.memberCap ?? null, receivedAt: now });
			setDispatching(view, message.dispatching);
			return ["conversation", "left", "header"];
	}
	return [];
}

/** @param {DashboardRow} row @returns {Group} */
const groupOf = (row) => (row.stall ? "needsYou" : GROUP[row.stage]);

/** A click this page posted, by report id; triggerId arrives with the host's 200. @typedef {Map<string, { option: number, triggerId?: string }>} Sending */

const CHOICE_NOTE = {
	sending: "发送中…",
	sent: "已发送，等待幕僚长转交",
	handed_over: "已回答",
	dropped: "幕僚长没有转交这次选择，请重选或直接回复",
	spoke: "你刚发了一句话，等幕僚长处理完再点",
};

/**
 * @typedef {object} Choice
 * @property {string} reportId
 * @property {{ label: string, option: number, picked: boolean }[]} buttons
 * @property {boolean} locked
 * @property {string} note
 */

const CAP_SENT_NOTE = "已发送";

/**
 * @param {(CapQuestion & Partial<Pick<NonNullable<DashboardRow["question"]>, "click" | "spoke">>) | null | undefined} q a helper's question, or the host's own, which is never clicked on the board and never locked
 * @param {Sending} sending @param {string} [sentNote] @returns {Choice | null}
 */
function choiceOf(q, sending, sentNote = CHOICE_NOTE.sent) {
	if (!q || q.options.length === 0) return null;
	const local = sending.get(q.reportId);
	const click = q.click ?? null;
	const spoke = q.spoke ?? false;
	const shown = local
		? { option: local.option, note: local.triggerId ? sentNote : CHOICE_NOTE.sending }
		: click && click.state !== "dropped"
			? { option: click.option, note: CHOICE_NOTE[click.state] }
			: null;
	return {
		reportId: q.reportId,
		buttons: q.options.map((label, option) => ({ label, option, picked: option === shown?.option })),
		locked: shown !== null || spoke,
		note: shown?.note ?? (spoke ? CHOICE_NOTE.spoke : click?.state === "dropped" ? CHOICE_NOTE.dropped : ""),
	};
}

/** Forgets a posted click once the board carries the host's trigger for it, or the question is gone. @param {View} view @param {Sending} sending */
export function settleSending(view, sending) {
	for (const [reportId, { triggerId }] of sending) {
		if (!triggerId) continue;
		const q = questionOf(view, reportId);
		if (!q || ("click" in q && q.click?.triggerId === triggerId)) sending.delete(reportId);
	}
}

/** The open question with this id: a helper's, or the host's own. @param {View} view @param {string} reportId */
export function questionOf(view, reportId) {
	const cap = view.memberCap?.question;
	return cap?.reportId === reportId ? cap : view.rows.find((r) => r.question?.reportId === reportId)?.question;
}

/**
 * @typedef {object} TaskCard
 * @property {string} id
 * @property {string} title
 * @property {string} helper
 * @property {string} why
 * @property {string} stage
 * @property {string} latest
 * @property {boolean} canStop
 * @property {Choice | null} choice
 */

/** @param {DashboardRow} row @param {number} now @param {Sending} sending @returns {TaskCard} */
function card(row, now, sending) {
	return {
		id: row.id,
		title: row.title,
		helper: helperFullName(row.helper),
		why: BASIS_PHRASE[row.basis],
		stage: row.stall ? `久无进展 · ${stallMinutes(row.stall.since, now)} 分钟` : STAGE_PHRASE[row.stage],
		latest: row.question?.text ?? row.latestSummary ?? "已开始，暂无进展",
		canStop: GROUP[row.stage] === "doing",
		choice: choiceOf(row.question, sending),
	};
}

/** The host's question about the member cap. It belongs to no task, so it has no helper and nothing to open; `source` stands where a task card names its helper. @typedef {{ title: string, source: string, stage: string, latest: string, choice: Choice }} CapCard */

/** @param {View} view @param {Sending} sending @returns {CapCard | null} */
function capCard(view, sending) {
	const q = view.memberCap?.question;
	const choice = choiceOf(q, sending, CAP_SENT_NOTE);
	return q && choice ? { title: "成员上限", source: HOST_SOURCE, stage: STAGE_PHRASE.awaiting_answer, latest: q.text, choice } : null;
}

/** @param {View} view @param {Sending} sending @returns {Map<string, Choice>} */
export function choicesInConversation(view, sending) {
	const lines = [...view.lines.values()];
	/** @type {Map<string, Choice>} */
	const placed = new Map();
	for (const row of view.rows) {
		const choice = choiceOf(row.question, sending);
		const askedAt = row.question?.askedAt ?? Infinity;
		const line = lines.findLast((l) => l.who === "router" && l.ticketId === row.id && l.at >= askedAt);
		if (choice && line) placed.set(line.id, choice);
	}
	return placed;
}

/** @type {Record<"answered" | "pending" | "router_ignored", string>} */
const ROUTE_COPY = { answered: "幕僚长直接回答", pending: "幕僚长处理中", router_ignored: "幕僚长判断无需处理" };

/** The line under one of the user's messages; a task's line opens that task. @param {View} view @param {string} lineId @returns {{ text: string, ticketId?: string } | null} */
export function routeLine(view, lineId) {
	const route = view.routes[lineId];
	if (!route) return null;
	if (route.kind !== "opened_ticket" && route.kind !== "handed_over") return { text: ROUTE_COPY[route.kind] };
	const row = view.rows.find((r) => r.id === route.ticketId);
	const { ticketId } = route;
	const helper = helperFullName(row?.helper ?? null) || "助手";
	if (route.kind === "opened_ticket") return { text: row ? `已开新任务「${row.title}」 · ${helper}` : "已开新任务", ticketId };
	return { text: row ? `已交给 ${helper}（${row.title}）` : "已交给助手", ticketId };
}

/** @param {string} reportId @param {number} option */
export const answerBody = (reportId, option) => JSON.stringify({ answer: { reportId, option } });

/** @param {View} view @param {number} now @param {Sending} [sending] */
export function leftColumn(view, now, sending = new Map()) {
	/** @type {Record<Group, TaskCard[]>} */
	const groups = { needsYou: [], doing: [], done: [] };
	for (const row of view.rows) groups[groupOf(row)].push(card(row, now, sending));
	const hits = view.today?.bySource ?? {};
	const cap = capCard(view, sending);
	return {
		capCard: cap,
		needsYouLine: `待你处理 · ${groups.needsYou.length + (cap ? 1 : 0)}`,
		needsYou: groups.needsYou,
		doing: groups.doing,
		done: groups.done.reverse(),
		doneLine: `已完成 · ${groups.done.length}`,
		watching: view.watching.map((w) => ({ name: w.title ?? w.source, rule: [w.problem, w.description ?? watchRule(w)].filter(Boolean).join(" · "), hits: hits[w.source] ? `今日 ${hits[w.source]} 条` : "", problem: !!w.problem })),
		today: todayCopy(view.today),
	};
}

/** @param {WatchedSource} w */
function watchRule(w) {
	const rule = w.rules[0]?.text.split("\n").map((l) => l.trim()).find(Boolean);
	if (rule) return rule;
	const timer = w.timers[0];
	if (timer) return `${every(timer.everyMinutes)}：${timer.body}`;
	return "收到新消息时处理";
}

/** @param {number} minutes */
function every(minutes) {
	if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`;
	if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
	return `每 ${minutes} 分钟`;
}

/** @param {TodayCounts | undefined} counts @returns {{ headline: string, detail: string }} */
export function todayCopy(counts) {
	if (!counts) return { headline: "", detail: "" };
	const d = counts.byDisposition;
	const total = Object.values(d).reduce((a, b) => a + b, 0);
	if (total === 0) return { headline: "今日暂无来源消息", detail: "" };
	const handed = d.delivered + d.handed_over;
	const ignored = d.ignored + d.router_ignored;
	const clauses = [
		d.opened_ticket && `新建任务 ${d.opened_ticket}`,
		handed && `转入进行中任务 ${handed}`,
		d.to_router && `处理中 ${d.to_router}`,
		ignored && `无需处理 ${ignored}`,
	].filter(Boolean);
	return { headline: `今日来源消息 · ${total}`, detail: clauses.join(" · ") };
}

const RESTART_NOTICE_MS = 30 * 60_000;

/** @param {Duty | undefined} duty @param {number} now @param {boolean} [connected] */
export function dutyLine(duty, now, connected = true) {
	if (!duty || !connected) return "";
	const minutes = Math.floor((now - duty.since) / 60_000);
	if (minutes < 1) return "在线 · 刚启动";
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const span = days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
	return `在线 · 已运行 ${span}`;
}

/** @param {Duty | undefined} duty @param {number} now */
export function restartNotice(duty, now) {
	return duty && duty.resumed > 0 && now - duty.since < RESTART_NOTICE_MS ? "已重启，进行中的任务已恢复" : "";
}

export const HELPER_TINTS = 6;

/** FNV-1a over the ticket id, so a task keeps its helper colour across reloads. @param {string} ticketId */
export function helperTint(ticketId) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < ticketId.length; i++) hash = Math.imul(hash ^ ticketId.charCodeAt(i), 0x01000193);
	return (hash >>> 0) % HELPER_TINTS;
}

/** @param {string} title */
export const stopSentence = (title) => `停止任务「${title}」`;

/**
 * @typedef {object} Step
 * @property {string} title
 * @property {string} detail
 * @property {"ok" | "error" | "pending" | "stopped"} state stopped: it never got a result, because its ticket, helper or host stopped first
 * @property {string} raw
 * @property {string} [tool]
 * @property {string} [callId]
 * @property {number} [at] when the helper issued it
 * @property {true} [markdown] the detail is the helper's own prose, shown as Markdown
 * @property {DispatchEntry} [dispatch]
 */

/**
 * One dispatch as the page words it. Only the member's title, never its name.
 * @typedef {object} DispatchEntry
 * @property {string} title
 * @property {string} task
 * @property {string} reply
 * @property {DispatchState} state
 * @property {string} stateText
 * @property {string} note
 * @property {string} tokens
 * @property {Step[]} steps
 */

/** @type {Record<DispatchState, string>} */
const DISPATCH_STATE = { queued: "排队中", running: "进行中", done: "完成", timed_out: "超时", stalled: "无进展", stopped: "已停止", failed: "出错" };

/** @type {Record<DispatchState, Step["state"]>} */
const DISPATCH_STEP_STATE = { queued: "pending", running: "pending", done: "ok", timed_out: "error", stalled: "error", stopped: "stopped", failed: "error" };

/** @param {Pick<DispatchEntry, "title" | "stateText">} entry */
const dispatchDetail = (entry) => [entry.title, entry.stateText].filter(Boolean).join(" · ");

/** The part of a token count read from the prompt cache, "" when none. @param {number | undefined} cached */
const cachedText = (cached) => (cached ? `（其中缓存 ${formatTokens(cached)}）` : "");

/** @param {number} tokens @param {number} [cached] */
const tokensText = (tokens, cached = 0) => `${formatTokens(tokens)} tokens${cachedText(cached)}`;

/** @param {unknown} details @returns {DispatchEntry | undefined} */
function dispatchEntry(details) {
	const d = /** @type {Record<string, any>} */ (details ?? {});
	if (d.kind !== "dispatch" || !(d.state in DISPATCH_STATE)) return undefined;
	return {
		title: String(d.title ?? ""),
		task: String(d.task ?? ""),
		reply: typeof d.reply === "string" ? `${d.reply}${typeof d.replyFile === "string" ? `\n\n…（全文 ${Number(d.replyChars) || 0} 字，存在任务目录的 ${d.replyFile}）` : ""}` : "",
		state: d.state,
		stateText: DISPATCH_STATE[/** @type {DispatchState} */ (d.state)],
		note: typeof d.note === "string" ? d.note : "",
		tokens: tokensText((Number(d.tokensIn) || 0) + (Number(d.tokensOut) || 0), Number(d.tokensCached) || 0),
		steps: [],
	};
}

/** @param {Record<string, unknown>} a @param {Record<string, string>} titles @returns {DispatchEntry} */
const pendingDispatch = (a, titles) => ({ title: titles[String(a.agent)] ?? "", task: String(a.task ?? ""), reply: "", state: "queued", stateText: DISPATCH_STATE.queued, note: "", tokens: "", steps: [] });

/** @type {Record<InputKind, string>} */
const INPUT_STEP = {
	brief: "接收任务",
	trigger: "收到新消息",
	user_message: "收到你的补充说明",
	note: "幕僚长附加说明",
	status_query: "进度询问",
	recovery: "重启后恢复",
	bg_result: "后台命令完成",
};

const KIND_BY_LABEL = new Map(/** @type {[InputKind, string][]} */ (Object.entries(INPUT_LABEL)).map(([kind, label]) => [label, kind]));

// The host writes this input's body in English for the model.
const RECOVERY_DETAIL = "宿主重启过，助手先看看做到哪了再接着做";

const RAW_LIMIT = 2000;

/** @param {TranscriptMessage} message @param {Record<string, string>} titles @returns {Step[]} */
function stepsFrom(message, titles) {
	if (message.role === "user" || (message.role === "custom" && message.customType === "psa-bg-result")) {
		const text = textOf(message);
		if (message.role === "custom") return [{ title: "后台命令完成", detail: clip(firstLine(text), 80), state: "ok", raw: clip(text, RAW_LIMIT) }];
		return text.split(/\n\n(?=\[)/).map((part) => {
			const label = /^\[([^\]]+)\]/.exec(part)?.[1] ?? "";
			const body = part.split("\n").slice(1).join("\n");
			const kind = KIND_BY_LABEL.get(label) ?? "trigger";
			return { title: INPUT_STEP[kind], detail: kind === "recovery" ? RECOVERY_DETAIL : clip(firstLine(body), 80), state: "ok", raw: clip(part, RAW_LIMIT) };
		});
	}
	if (message.role !== "assistant") return [];
	return blocks(message).flatMap((c) => {
		if (c.type === "text" && c.text?.trim()) return [{ title: "思考", detail: clip(c.text.trim(), 200), state: /** @type {const} */ ("ok"), raw: clip(c.text, RAW_LIMIT) }];
		if (c.type !== "toolCall" || !c.name) return [];
		const args = typeof c.arguments === "object" && c.arguments !== null ? /** @type {Record<string, unknown>} */ (c.arguments) : {};
		const dispatch = c.name === "dispatch_agent" ? pendingDispatch(args, titles) : undefined;
		const known = dispatch ? { title: toolStep(c.name, args).title, detail: dispatchDetail(dispatch), dispatch } : toolStep(c.name, args);
		return [{ ...known, state: /** @type {const} */ ("pending"), raw: clip(`${c.name} ${JSON.stringify(c.arguments ?? {}, null, 2)}`, RAW_LIMIT), tool: c.name, ...(c.id ? { callId: c.id } : {}), ...(message.timestamp !== undefined ? { at: message.timestamp } : {}), ...(c.name === "report" ? { markdown: /** @type {const} */ (true) } : {}) }];
	});
}

/**
 * @typedef {object} Watch
 * @property {string} ticketId
 * @property {Step[]} steps the helper's own steps
 * @property {Record<string, string>} titles the crew's titles by member name
 * @property {Map<string, TranscriptMessage[]>} members each dispatch's own messages, by the helper's call id
 */

/** @param {string} ticketId @returns {Watch} */
export function emptyWatch(ticketId) {
	return { ticketId, steps: [], titles: {}, members: new Map() };
}

/** @param {Step} step @returns {Step} */
function stopped(step) {
	if (!step.dispatch) return { ...step, state: "stopped" };
	const dispatch = { ...step.dispatch, state: /** @type {const} */ ("stopped"), stateText: DISPATCH_STATE.stopped };
	return { ...step, state: "stopped", dispatch, detail: dispatchDetail(dispatch) };
}

/** New input reaches a helper only after every call of its last turn has a result. @param {Step[]} steps */
function stopUnanswered(steps) {
	for (const [i, step] of steps.entries()) if (step.state === "pending") steps[i] = stopped(step);
}

/** @param {Step[]} steps @param {TranscriptMessage} message @param {Record<string, string>} titles */
function append(steps, message, titles) {
	if (message.role !== "toolResult") {
		if (message.role !== "assistant") stopUnanswered(steps);
		return void steps.push(...stepsFrom(message, titles));
	}
	// Parallel calls of one tool finish in any order, so the call id decides when there is one.
	const step = steps.findLast((s) => s.state === "pending" && (message.toolCallId && s.callId ? s.callId === message.toolCallId : s.tool === message.toolName));
	if (!step) return;
	step.state = message.isError ? "error" : "ok";
	step.raw = clip(`${step.raw}\n\n→ ${textOf(message)}`, RAW_LIMIT);
	if (!step.dispatch) return;
	step.dispatch = dispatchEntry(message.details);
	step.detail = step.dispatch ? dispatchDetail(step.dispatch) : "";
	if (step.dispatch) step.state = DISPATCH_STEP_STATE[step.dispatch.state];
}

/** A member's message without a tool call ends its turn, so its text is the reply. @param {TranscriptMessage} message */
const isMemberReply = (message) => message.role === "assistant" && !blocks(message).some((c) => c.type === "toolCall");

/** @param {Watch} watch @param {string | undefined} callId @param {boolean} dispatchEnded @returns {Step[]} */
function memberSteps(watch, callId, dispatchEnded) {
	/** @type {Step[]} */
	const steps = [];
	for (const message of watch.members.get(callId ?? "") ?? []) if (message && !isMemberReply(message)) append(steps, message, {});
	return dispatchEnded ? steps.map((s) => (s.state === "pending" ? stopped(s) : s)) : steps;
}

/** What a dispatch's member has used, input plus output, and the part of it read from the cache, by its own messages. @param {Watch} watch @param {string | undefined} callId */
function memberTokens(watch, callId) {
	let tokens = 0;
	let cached = 0;
	for (const message of watch.members.get(callId ?? "") ?? []) {
		tokens += (message?.usage?.input ?? 0) + (message?.usage?.cacheRead ?? 0) + (message?.usage?.output ?? 0);
		cached += message?.usage?.cacheRead ?? 0;
	}
	return { tokens, cached };
}

/**
 * The watched steps as they stand now. An unfinished dispatch takes its state from the board. A step
 * that can no longer finish reads as stopped: its helper is not running, or it was issued before this
 * host started. A pending dispatch the board has never listed has just been called and waits.
 * @param {Watch} watch @param {View} view @returns {Step[]}
 */
export function liveSteps(watch, view) {
	const onBoard = new Map((view.dispatching[watch.ticketId] ?? []).map((d) => [d.callId, d]));
	const row = view.rows.find((r) => r.id === watch.ticketId);
	const helperGone = row?.workerState !== "running" || row.endedAt !== null;
	const hostSince = view.duty?.since ?? 0;
	// A dispatch cut off by a stop or a killed host has no result to carry its count, and after a restart no board entry either.
	const used = (/** @type {string | undefined} */ callId, /** @type {number | undefined} */ counted, /** @type {number | undefined} */ cached) => {
		if (counted !== undefined) return tokensText(counted, cached);
		const own = memberTokens(watch, callId);
		return own.tokens > 0 ? tokensText(own.tokens, own.cached) : "";
	};
	return watch.steps.map((step) => {
		if (step.state !== "pending") return step.dispatch ? { ...step, dispatch: { ...step.dispatch, tokens: step.dispatch.tokens || used(step.callId), steps: memberSteps(watch, step.callId, true) } } : step;
		const dead = helperGone || (step.at ?? Infinity) < hostSince;
		if (!step.dispatch) return dead ? stopped(step) : step;
		const seen = onBoard.get(step.callId ?? "") ?? view.lastOnBoard.get(watch.ticketId)?.get(step.callId ?? "");
		const last = seen?.state ?? "queued";
		/** @type {DispatchState} */
		const state = dead && (last === "queued" || last === "running") ? "stopped" : last;
		const dispatch = {
			...step.dispatch,
			title: seen?.title ?? step.dispatch.title,
			state,
			stateText: DISPATCH_STATE[state],
			note: seen?.note ?? "",
			tokens: used(step.callId, seen?.tokens, seen?.tokensCached),
			steps: memberSteps(watch, step.callId, DISPATCH_STEP_STATE[state] !== "pending"),
		};
		return { ...step, state: DISPATCH_STEP_STATE[state], dispatch, detail: dispatchDetail(dispatch) };
	});
}

/**
 * @param {Watch} watch @param {HostToClient} message @returns {boolean}
 */
export function applyTranscript(watch, message) {
	if ((message.type !== "transcript_history" && message.type !== "transcript") || message.ticketId !== watch.ticketId) return false;
	if (message.type === "transcript_history") {
		watch.steps = [];
		watch.titles = message.team?.titles ?? {};
		watch.members = new Map(Object.entries(message.team?.steps ?? {}));
		for (const m of message.messages) append(watch.steps, m, watch.titles);
		return true;
	}
	if (message.member) {
		const { callId, index } = message.member;
		const own = watch.members.get(callId) ?? [];
		own[index] = message.message;
		watch.members.set(callId, own);
		return true;
	}
	append(watch.steps, message.message, watch.titles);
	return true;
}

/** @param {DashboardRow | undefined} row */
export const smallPrint = (row) => (row ? `编号 ${shortId(row.id)}` : "");

/** The host's elapsed time grows until the ticket ends, so the page adds the time since the frame arrived. @param {DashboardRow} row @param {number} now @param {number} receivedAt */
const elapsedOf = (row, now, receivedAt) => formatElapsed(row.elapsedMs + (row.startedAt !== null && row.endedAt === null ? now - receivedAt : 0));

/** @type {Record<DashboardRow["workerState"], { duty: "running" | "idle" | "queued", mark: string, state: string }>} */
const DUTY_MARK = {
	running: { duty: "running", mark: "●", state: "运行中" },
	idle: { duty: "idle", mark: "◐", state: "空闲" },
	queued: { duty: "queued", mark: "○", state: "排队" },
	none: { duty: "queued", mark: "○", state: "排队" },
};

/** @param {number} ms */
function ago(ms) {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 5) return "刚刚";
	return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
}

/** @param {number} ms */
function runningFor(ms) {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 1) return "刚刚";
	return seconds < 60 ? `已 ${seconds} 秒` : `已 ${Math.floor(seconds / 60)} 分钟`;
}

/**
 * @typedef {object} HelperChip
 * @property {string} id
 * @property {"running" | "idle" | "queued"} duty
 * @property {string} mark
 * @property {string} state
 * @property {string} name
 * @property {string} role
 * @property {string} elapsed
 * @property {string} tokens
 * @property {{ title: string, state: "queued" | "running", label: string }[]} members the team members at work or waiting for this helper right now; a working one reads 「新闻研究员 · 读取网页 · 12 秒前」, or 「新闻研究员 · 执行命令 · 已 2 分钟」 while a tool call is in flight
 */

/** One chip per helper on duty (a ticket not yet ended), then today's total. @param {View} view @param {number} now @returns {{ chips: HelperChip[], total: string }} */
export function helperStrip(view, now) {
	const queued = view.memberCap ? `${DISPATCH_STATE.queued} · 上限 ${view.memberCap.limit}` : DISPATCH_STATE.queued;
	const chips = view.rows.flatMap((row) => {
		if (row.endedAt !== null || !row.helper) return [];
		return [{
			id: row.id,
			...DUTY_MARK[row.workerState],
			name: row.helper.name,
			role: helperLabel(row.helper),
			elapsed: elapsedOf(row, now, view.receivedAt),
			tokens: `${formatTokens(row.tokensIn + row.tokensOut)} tokens`,
			members: (view.dispatching[row.id] ?? []).flatMap((d) => {
				if (d.state === "queued") return [{ title: d.title, state: d.state, label: `${d.title} · ${queued}` }];
				if (d.state !== "running") return [];
				const sinceFrame = now - view.receivedAt;
				const when = d.toolMs === undefined ? ago(d.quietMs + sinceFrame) : runningFor(d.toolMs + sinceFrame);
				return [{ title: d.title, state: d.state, label: `${d.title} · ${d.step || "启动中"} · ${when}` }];
			}),
		}];
	});
	const total = view.helpers ? `今日 ${view.helpers.count} 位 · ${formatTokens(view.helpers.tokens)} tokens` : "";
	return { chips, total };
}

/** @param {number} ms @param {string} [timeZone] the page's own zone when omitted */
const clockTime = (ms, timeZone) => new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });

/** @param {number} ms @param {string} [timeZone] @param {Intl.DateTimeFormatOptions} [options] */
const dayOf = (ms, timeZone, options = {}) => new Date(ms).toLocaleDateString("zh-CN", { ...options, timeZone });

/** @param {View} view @param {number} now @param {string} [timeZone] @returns {{ text: string, expanded: boolean } | null} */
export function clearedBar(view, now, timeZone) {
	if (!view.cleared) return null;
	const { at } = view.cleared;
	const day = dayOf(at, timeZone) === dayOf(now, timeZone) ? "" : `${dayOf(at, timeZone, { month: "long", day: "numeric" })} `;
	return { text: `已清屏 · ${day}${clockTime(at, timeZone)} · ${view.showEarlier ? "收起" : "显示之前的"}`, expanded: view.showEarlier };
}

/** @param {View} view */
export const earlierLines = (view) => (view.showEarlier && view.cleared ? view.cleared.lines : []);

/** @param {View} view */
export const toggleEarlier = (view) => {
	view.showEarlier = view.cleared !== null && !view.showEarlier;
};

/** @param {View} view */
export const canClear = (view) => view.lines.size > 0;

export const CLEAR_FAILED = "清屏没有成功，请稍后再试。";

/** @param {View} view */
const knownLines = (view) => [...(view.cleared?.lines ?? []), ...view.lines.values()];

/** @param {View} view */
export const knownLineIds = (view) => new Set(knownLines(view).map((l) => l.id));

/** @param {View} view @param {Set<string>} seen */
export const linesNotIn = (view, seen) => knownLines(view).filter((l) => !seen.has(l.id));

/** @param {DashboardRow | undefined} row @param {number} now @param {number} receivedAt @param {string} [timeZone] */
export function lifecycleLine(row, now, receivedAt, timeZone) {
	if (!row) return "";
	const span = row.startedAt === null
		? ["尚未开始"]
		: [`开始 ${clockTime(row.startedAt, timeZone)}`, row.endedAt === null ? "进行中" : `结束 ${clockTime(row.endedAt, timeZone)}`, `用时 ${elapsedOf(row, now, receivedAt)}`];
	return [...span, `模型 ${modelText(row)}`, `工具 ${row.toolCalls} 次`, `tokens 入 ${formatTokens(row.tokensIn)}${cachedText(row.tokensCached) || " "}/ 出 ${formatTokens(row.tokensOut)}`].join(" · ");
}

/** @typedef {"idle" | "sending" | "delivered" | "maybe_lost" | "expired" | "rejected"} SayState */

/** @type {Record<SayState, string>} */
export const SAY_COPY = {
	idle: "任务在后台进行，完成或需要你决定时会通知你。",
	sending: "发送中…",
	delivered: "已发送",
	maybe_lost: "未收到确认。请检查对话中是否已有这条消息，如没有请重新发送。",
	expired: "链接已失效，请使用宿主日志中的最新链接。",
	rejected: "发送失败，请稍后重试。",
};

// The server's own bodies are written for curl users; the page names the cause in its own words.
/** @type {Record<number, string>} */
const REJECTED_COPY = {
	400: "发送失败：内容为空或格式不正确。",
	403: "发送失败：请求来源不被允许。",
	409: "发送失败：这个问题已经回答过，或已不在等待回答。",
	413: "发送失败：内容过长，请分几次发送。",
	415: "发送失败：请求格式不正确。",
};

/**
 * @param {number} status @param {{ refused?: unknown, option?: unknown } | null} body the refused answer's JSON, or null
 * @param {string[]} options the question's options as this page shows them
 */
export function answerRefusedCopy(status, body, options) {
	const label = body?.refused === "chosen" && typeof body.option === "number" ? options[body.option] : undefined;
	if (label !== undefined) return `发送失败：已选「${label}」。`;
	const refused = body?.refused;
	return typeof refused === "string" && Object.hasOwn(ANSWER_REFUSED_COPY, refused) ? ANSWER_REFUSED_COPY[refused] : sayCopy("rejected", status);
}

/** @type {Record<string, string>} */
const ANSWER_REFUSED_COPY = {
	spoke: "发送失败：你刚发了一句话，幕僚长处理完之前不能点选项。",
	no_question: "发送失败：这个问题不存在。",
};

/** @param {SayState} state @param {number} [status] */
export function sayCopy(state, status) {
	return state === "rejected" && status !== undefined ? (REJECTED_COPY[status] ?? SAY_COPY.rejected) : SAY_COPY[state];
}

/** @param {{ status: number } | "timeout" | "network"} outcome @returns {SayState} */
export function sayOutcome(outcome) {
	if (typeof outcome === "string") return "maybe_lost";
	if (outcome.status === 200) return "delivered";
	if (outcome.status === 401) return "expired";
	return "rejected";
}

/** @typedef {{ text: string, quoteOf: string | null }} Said */

/** @param {Said} said */
export const sayBody = (said) => JSON.stringify(said.quoteOf ? { text: said.text, quoteOf: said.quoteOf } : { text: said.text });

/** @param {Said} sent @param {Said} now */
export const sameAsSent = (sent, now) => now.text === sent.text && now.quoteOf === sent.quoteOf;

// A timed-out POST may still have reached the host; its echo in the conversation is the confirmation.
/** @param {{ state: SayState } & Said} say @param {ConversationLine[]} arrived @returns {SayState} */
export function settleSay(say, arrived) {
	const echoed = arrived.some((line) => line.who === "user" && line.text === say.text && (line.quote?.lineId ?? null) === say.quoteOf);
	return say.state === "maybe_lost" && echoed ? "delivered" : say.state;
}

/** @param {Span[]} spans */
const spanText = (spans) => spans.map((s) => s.text).join("");

/** @param {string} text */
const plainText = (text) =>
	parseMarkdown(text)
		.flatMap((b) => (b.kind === "p" || b.kind === "h" ? [b.spans] : b.kind === "table" ? [...b.head, ...b.rows.flat()] : b.items))
		.map(spanText)
		.join(" ");

/** @param {{ who: "user" | "router", text: string }} said */
export const quoteShown = (said) => ({
	who: QUOTE_WHO[said.who],
	text: oneLine(said.who === "router" ? plainText(said.text) : said.text),
});

/** @param {string} text */
export const canSend = (text) => text.trim() !== "";

/** @typedef {"light" | "dark"} Theme */

/** @param {string | null} stored @param {boolean} systemDark @returns {Theme} */
export function resolveTheme(stored, systemDark) {
	if (stored === "light" || stored === "dark") return stored;
	return systemDark ? "dark" : "light";
}

/** @param {Theme} theme @returns {Theme} */
export const toggleTheme = (theme) => (theme === "dark" ? "light" : "dark");

const STALE_AFTER_MS = 35_000;

/** @param {number} lastFrameAt @param {number} now */
export function isStale(lastFrameAt, now) {
	return now - lastFrameAt > STALE_AFTER_MS;
}

/**
 * The safe Markdown subset the page renders, as data the page turns into DOM nodes (never HTML).
 * @typedef {{ text: string, bold?: true, italic?: true, code?: true }} Span
 * @typedef {{ kind: "p", spans: Span[] } | { kind: "h", level: number, spans: Span[] } | { kind: "ul" | "ol", items: Span[][] } | { kind: "table", head: Span[][], rows: Span[][][] }} MdBlock
 */

// Each alternative excludes its own delimiters from its body, so no input makes the match backtrack.
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|\[([^\[\]\n]+)\]\(([^()\[\]\s]+)\)/g;

/** @param {string} text @returns {Span[]} */
function inlineSpans(text) {
	/** @type {Span[]} */
	const spans = [];
	const plain = (/** @type {string} */ t) => {
		if (!t) return;
		const last = spans.at(-1);
		if (last && Object.keys(last).length === 1) last.text += t;
		else spans.push({ text: t });
	};
	let at = 0;
	for (const m of text.matchAll(INLINE)) {
		plain(text.slice(at, m.index));
		if (m[1] !== undefined) spans.push({ text: m[1], code: true });
		else if (m[2] !== undefined || m[3] !== undefined) spans.push({ text: m[2] ?? m[3], bold: true });
		else if (m[4] !== undefined) spans.push({ text: m[4], italic: true });
		else spans.push({ text: m[5] }, { text: `（${m[6]}）` });
		at = m.index + m[0].length;
	}
	plain(text.slice(at));
	return spans;
}

/** @param {string} line */
function tableCells(line) {
	const row = line.trim();
	return row.length > 1 && row.startsWith("|") && row.endsWith("|") ? row.slice(1, -1).split("|").map((cell) => cell.trim()) : null;
}

/** @param {string | undefined} line */
const isTableRule = (line) => tableCells(line ?? "")?.every((cell) => /^:?-+:?$/.test(cell)) ?? false;

/** @param {string} text @returns {MdBlock[]} */
export function parseMarkdown(text) {
	/** @type {MdBlock[]} */
	const out = [];
	/** @type {string[]} */
	let para = [];
	const flush = () => {
		if (para.length) out.push({ kind: "p", spans: inlineSpans(para.join("\n")) });
		para = [];
	};
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const head = tableCells(line);
		if (head && isTableRule(lines[i + 1])) {
			flush();
			/** @type {Span[][][]} */
			const rows = [];
			for (let cells = tableCells(lines[i + 2] ?? ""); cells; cells = tableCells(lines[++i + 2] ?? "")) rows.push(head.map((_, k) => inlineSpans(cells[k] ?? "")));
			i++;
			out.push({ kind: "table", head: head.map(inlineSpans), rows });
			continue;
		}
		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		const item = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.*)$/);
		if (!line.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(line)) flush();
		else if (heading) {
			flush();
			out.push({ kind: "h", level: heading[1].length, spans: inlineSpans(heading[2].trim()) });
		} else if (item) {
			flush();
			const kind = item[1] ? "ul" : "ol";
			const last = out.at(-1);
			if (last && last.kind === kind) last.items.push(inlineSpans(item[2]));
			else out.push({ kind, items: [inlineSpans(item[2])] });
		} else para.push(line);
	}
	flush();
	return out;
}
