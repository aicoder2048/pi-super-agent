// @ts-check

/** @typedef {import("../kernel/types.ts").DashboardRow} DashboardRow */
/** @typedef {import("./protocol.ts").TranscriptMessage} TranscriptMessage */

/** @type {Record<DashboardRow["stage"], string>} */
export const STAGE_LABEL = {
	awaiting_answer: "等你回答",
	awaiting_review: "等你验收",
	blocked_or_failed: "受阻/失败",
	queued: "排队",
	idle: "空闲",
	running: "执行中",
	closed: "已结束",
	stopped: "已叫停",
};

/** @type {Record<DashboardRow["basis"], string>} */
export const BASIS_LABEL = { request: "请求", rule: "规则", inference: "推断" };

const TERMINAL = ["closed", "stopped"];
const CLOSED_SHOWN = 2;

/** @param {DashboardRow} row */
export const isLive = (row) => row.stage === "running" || row.stage === "queued";

/** @param {DashboardRow[]} rows */
export function selectRows(rows) {
	const active = rows.filter((r) => !TERMINAL.includes(r.stage));
	const closed = rows.filter((r) => TERMINAL.includes(r.stage));
	return { shown: [...active, ...closed.slice(-CLOSED_SHOWN)], hiddenClosed: Math.max(0, closed.length - CLOSED_SHOWN), active: active.length };
}

/** @param {string} ticketId */
export const shortId = (ticketId) => ticketId.replace(/^tkt_/, "").slice(0, 4);

/** @param {DashboardRow} row */
export const modelText = (row) => (row.model ? `${row.model.split("/").pop()}${row.fellBack ? "（已回退）" : ""}` : "未启动");

/** @param {number} n */
export function formatTokens(n) {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/** @param {number} ms */
export function formatElapsed(ms) {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}秒`;
	if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
	return `${Math.floor(s / 3600)}时${Math.floor((s % 3600) / 60)}分`;
}

/** Counts code points, so a surrogate pair is never split. @param {unknown} s @param {number} n */
export function clip(s, n) {
	if (typeof s !== "string") return "";
	const chars = [...s];
	return chars.length <= n ? s : `${chars.slice(0, n).join("")}…`;
}

/** @param {TranscriptMessage} message */
export function blocks(message) {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content ?? []);
}

/** @param {TranscriptMessage} message */
export const textOf = (message) => blocks(message).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
