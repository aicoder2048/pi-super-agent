// @ts-check

/** @typedef {import("../kernel/types.ts").DashboardRow} DashboardRow */
/** @typedef {import("../kernel/types.ts").InputKind} InputKind */
/** @typedef {import("../client/protocol.ts").ConversationLine} ConversationLine */
/** @typedef {import("../client/protocol.ts").Duty} Duty */
/** @typedef {import("../kernel/types.ts").HelpersToday} HelpersToday */
/** @typedef {import("../kernel/types.ts").Routes} Routes */
/** @typedef {import("../client/protocol.ts").HostToClient} HostToClient */
/** @typedef {import("../client/protocol.ts").TodayCounts} TodayCounts */
/** @typedef {import("../client/protocol.ts").TranscriptMessage} TranscriptMessage */
/** @typedef {import("../client/protocol.ts").WatchedSource} WatchedSource */

import { INPUT_LABEL, blocks, clip, formatElapsed, formatTokens, helperFullName, helperRoleText, modelText, shortId, stallMinutes, textOf } from "../client/board-format.mjs";

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
 */

/** @returns {View} */
export function emptyView() {
	return { lines: new Map(), rows: [], receivedAt: 0, today: undefined, duty: undefined, helpers: undefined, watching: [], routes: {} };
}

/** @param {View} view @param {ConversationLine} line */
function addLine(view, line) {
	if (!view.lines.has(line.id)) view.lines.set(line.id, line);
}

/**
 * @param {View} view @param {HostToClient} message @param {number} now
 * @returns {("conversation" | "left" | "header")[]}
 */
export function applyMessage(view, message, now) {
	switch (message.type) {
		case "snapshot":
			for (const line of message.conversation) addLine(view, line);
			Object.assign(view, { rows: message.board, today: message.today, duty: message.duty, helpers: message.helpers, watching: message.watching, routes: message.routes, receivedAt: now });
			return ["conversation", "left", "header"];
		case "user":
			addLine(view, { id: message.id, who: "user", text: message.text, at: message.at });
			return ["conversation"];
		case "reply":
			addLine(view, { id: message.replyId, who: "router", text: message.text, at: message.at, ...(message.ticketId ? { ticketId: message.ticketId } : {}) });
			return ["conversation"];
		case "board":
			Object.assign(view, { rows: message.rows, today: message.today, duty: message.duty, helpers: message.helpers, routes: message.routes, receivedAt: now });
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

/** @param {DashboardRow} row @param {Sending} sending @returns {Choice | null} */
function choiceOf(row, sending) {
	const q = row.question;
	if (!q || q.options.length === 0) return null;
	const local = sending.get(q.reportId);
	const click = q.click;
	const shown = local
		? { option: local.option, note: CHOICE_NOTE[local.triggerId ? "sent" : "sending"] }
		: click && click.state !== "dropped"
			? { option: click.option, note: CHOICE_NOTE[click.state] }
			: null;
	return {
		reportId: q.reportId,
		buttons: q.options.map((label, option) => ({ label, option, picked: option === shown?.option })),
		locked: shown !== null || q.spoke,
		note: shown?.note ?? (q.spoke ? CHOICE_NOTE.spoke : click?.state === "dropped" ? CHOICE_NOTE.dropped : ""),
	};
}

/** Forgets a posted click once the board carries the host's trigger for it, or the question is gone. @param {View} view @param {Sending} sending */
export function settleSending(view, sending) {
	for (const [reportId, { triggerId }] of sending) {
		if (!triggerId) continue;
		const q = view.rows.find((r) => r.question?.reportId === reportId)?.question;
		if (!q || q.click?.triggerId === triggerId) sending.delete(reportId);
	}
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
		choice: choiceOf(row, sending),
	};
}

/** @param {View} view @param {Sending} sending @returns {Map<string, Choice>} */
export function choicesInConversation(view, sending) {
	const lines = [...view.lines.values()];
	/** @type {Map<string, Choice>} */
	const placed = new Map();
	for (const row of view.rows) {
		const choice = choiceOf(row, sending);
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
	return {
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
 * @property {"ok" | "error" | "pending"} state
 * @property {string} raw
 * @property {string} [tool]
 */

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

/** @type {Record<string, string>} */
const LOOKUP_TITLE = { quote: "查询报价", bars: "查询 K 线", session: "查询交易时段" };

/** @param {Record<string, unknown>} a */
function lookupStep(a) {
	const args = a.args && typeof a.args === "object" ? /** @type {Record<string, unknown>} */ (a.args) : {};
	const op = typeof a.op === "string" ? a.op : "";
	const symbols = Array.isArray(args.symbols) ? args.symbols : typeof args.symbol === "string" ? [args.symbol] : [];
	return {
		title: LOOKUP_TITLE[op] ?? `查询 ${clip(op, 20)}`,
		detail: clip(symbols.filter((s) => typeof s === "string").join(" "), 60),
	};
}

const STEP_BY_LABEL = new Map(/** @type {[InputKind, string][]} */ (Object.entries(INPUT_LABEL)).map(([kind, label]) => [label, INPUT_STEP[kind]]));

/** @type {Record<string, (a: Record<string, unknown>) => { title: string, detail: string }>} */
const TOOL_STEP = {
	read: (a) => ({ title: "读取文件", detail: baseName(a.path) }),
	grep: (a) => ({ title: "搜索文件内容", detail: clip(a.pattern, 40) }),
	find: (a) => ({ title: "查找文件", detail: clip(a.pattern, 40) }),
	ls: (a) => ({ title: "列出目录", detail: baseName(a.path) }),
	bash: (a) => ({ title: "执行命令", detail: clip(firstLine(a.command), 60) }),
	edit: (a) => ({ title: "修改文件", detail: baseName(a.path) }),
	write: (a) => ({ title: "写入文件", detail: baseName(a.path) }),
	web_get: (a) => ({ title: "读取网页", detail: hostOf(a.url) }),
	lookup: (a) => lookupStep(a),
	read_ticket: () => ({ title: "查阅任务记录", detail: "" }),
	hand_back: () => ({ title: "交回幕僚长", detail: "" }),
	bg_start: (a) => ({ title: "启动后台命令", detail: clip(firstLine(a.command), 60) }),
	bg_status: () => ({ title: "查看后台命令", detail: "" }),
	bg_stop: () => ({ title: "停止后台命令", detail: "" }),
	report: (a) => ({ title: reportTitle(a), detail: clip(a.question || a.summary, 120) }),
};

/** @param {Record<string, unknown>} a */
function reportTitle(a) {
	if (a.question) return "提出问题";
	if (a.status === "ready") return "提交结果";
	if (a.status === "blocked" || a.status === "failed") return "报告受阻";
	if (a.status === "no_action") return "无需处理";
	return "汇报进度";
}

const RAW_LIMIT = 2000;

/** @param {TranscriptMessage} message @returns {Step[]} */
function stepsFrom(message) {
	if (message.role === "user" || (message.role === "custom" && message.customType === "psa-bg-result")) {
		const text = textOf(message);
		if (message.role === "custom") return [{ title: "后台命令完成", detail: clip(firstLine(text), 80), state: "ok", raw: clip(text, RAW_LIMIT) }];
		return text.split(/\n\n(?=\[)/).map((part) => {
			const label = /^\[([^\]]+)\]/.exec(part)?.[1] ?? "";
			const body = part.split("\n").slice(1).join("\n");
			return { title: STEP_BY_LABEL.get(label) ?? "收到新消息", detail: clip(firstLine(body), 80), state: "ok", raw: clip(part, RAW_LIMIT) };
		});
	}
	if (message.role !== "assistant") return [];
	return blocks(message).flatMap((c) => {
		if (c.type === "text" && c.text?.trim()) return [{ title: "思考", detail: clip(c.text.trim(), 200), state: /** @type {const} */ ("ok"), raw: clip(c.text, RAW_LIMIT) }];
		if (c.type !== "toolCall" || !c.name) return [];
		const args = typeof c.arguments === "object" && c.arguments !== null ? /** @type {Record<string, unknown>} */ (c.arguments) : {};
		const known = TOOL_STEP[c.name]?.(args) ?? { title: `调用工具 ${c.name}`, detail: "" };
		return [{ ...known, state: /** @type {const} */ ("pending"), raw: clip(`${c.name} ${JSON.stringify(c.arguments ?? {}, null, 2)}`, RAW_LIMIT), tool: c.name }];
	});
}

/**
 * @typedef {object} Watch
 * @property {string} ticketId
 * @property {Step[]} steps
 */

/** @param {string} ticketId @returns {Watch} */
export function emptyWatch(ticketId) {
	return { ticketId, steps: [] };
}

/** @param {Watch} watch @param {TranscriptMessage} message */
function append(watch, message) {
	if (message.role !== "toolResult") return void watch.steps.push(...stepsFrom(message));
	const step = watch.steps.findLast((s) => s.state === "pending" && s.tool === message.toolName);
	if (!step) return;
	step.state = message.isError ? "error" : "ok";
	step.raw = clip(`${step.raw}\n\n→ ${textOf(message)}`, RAW_LIMIT);
}

/**
 * @param {Watch} watch @param {HostToClient} message @returns {boolean}
 */
export function applyTranscript(watch, message) {
	if ((message.type !== "transcript_history" && message.type !== "transcript") || message.ticketId !== watch.ticketId) return false;
	if (message.type === "transcript_history") {
		watch.steps = [];
		for (const m of message.messages) append(watch, m);
		return true;
	}
	append(watch, message.message);
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
 */

/** One chip per helper on duty (a ticket not yet ended), then today's total. @param {View} view @param {number} now @returns {{ chips: HelperChip[], total: string }} */
export function helperStrip(view, now) {
	const chips = view.rows.flatMap((row) => {
		if (row.endedAt !== null || !row.helper) return [];
		return [{
			id: row.id,
			...DUTY_MARK[row.workerState],
			name: row.helper.name,
			role: helperRoleText(row.helper),
			elapsed: elapsedOf(row, now, view.receivedAt),
			tokens: `${formatTokens(row.tokensIn + row.tokensOut)} tokens`,
		}];
	});
	const total = view.helpers ? `今日 ${view.helpers.count} 位 · ${formatTokens(view.helpers.tokens)} tokens` : "";
	return { chips, total };
}

/** @param {number} ms @param {string} [timeZone] the page's own zone when omitted */
const clockTime = (ms, timeZone) => new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });

/** @param {DashboardRow | undefined} row @param {number} now @param {number} receivedAt @param {string} [timeZone] */
export function lifecycleLine(row, now, receivedAt, timeZone) {
	if (!row) return "";
	const span = row.startedAt === null
		? ["尚未开始"]
		: [`开始 ${clockTime(row.startedAt, timeZone)}`, row.endedAt === null ? "进行中" : `结束 ${clockTime(row.endedAt, timeZone)}`, `用时 ${elapsedOf(row, now, receivedAt)}`];
	return [...span, `模型 ${modelText(row)}`, `工具 ${row.toolCalls} 次`, `tokens 入 ${formatTokens(row.tokensIn)} / 出 ${formatTokens(row.tokensOut)}`].join(" · ");
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

// A timed-out POST may still have reached the host; its echo in the conversation is the confirmation.
/**
 * @param {{ state: SayState, text: string }} say @param {string} composer @param {ConversationLine[]} arrived
 * @returns {{ state: SayState, composer: string }}
 */
export function settleSay(say, composer, arrived) {
	if (say.state !== "maybe_lost" || !arrived.some((line) => line.who === "user" && line.text === say.text)) return { state: say.state, composer };
	return { state: "delivered", composer: composer === say.text ? "" : composer };
}

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

/** @param {unknown} s */
const firstLine = (s) => (typeof s === "string" ? (s.split("\n").find((l) => l.trim()) ?? "").trim() : "");

/** @param {unknown} p */
const baseName = (p) => (typeof p === "string" ? clip(p.split("/").filter(Boolean).pop() ?? p, 60) : "");

/** @param {unknown} u */
const hostOf = (u) => (typeof u === "string" ? (URL.parse(u)?.host ?? clip(u, 60)) : "");
