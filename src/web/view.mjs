// @ts-check

/** @typedef {import("../kernel/types.ts").DashboardRow} DashboardRow */
/** @typedef {import("../client/protocol.ts").ConversationLine} ConversationLine */
/** @typedef {import("../client/protocol.ts").HostToClient} HostToClient */

import { BASIS_LABEL, STAGE_LABEL, formatElapsed, formatTokens, isLive, modelText, selectRows, shortId } from "../client/board-format.mjs";

/**
 * @typedef {object} View
 * @property {Map<string, ConversationLine>} lines
 * @property {DashboardRow[]} rows
 * @property {number} receivedAt
 */

/** @returns {View} */
export function emptyView() {
	return { lines: new Map(), rows: [], receivedAt: 0 };
}

/** @param {View} view @param {ConversationLine} line */
function addLine(view, line) {
	if (!view.lines.has(line.id)) view.lines.set(line.id, line);
}

/**
 * @param {View} view @param {HostToClient} message @param {number} now
 * @returns {("conversation" | "board")[]}
 */
export function applyMessage(view, message, now) {
	switch (message.type) {
		case "snapshot":
			for (const line of message.conversation) addLine(view, line);
			view.rows = message.board;
			view.receivedAt = now;
			return ["conversation", "board"];
		case "user":
			addLine(view, { id: message.id, who: "user", text: message.text, at: message.at });
			return ["conversation"];
		case "reply":
			addLine(view, { id: message.replyId, who: "router", text: message.text, at: message.at });
			return ["conversation"];
		case "board":
			view.rows = message.rows;
			view.receivedAt = now;
			return ["board"];
	}
	return [];
}

/** @param {View} view @param {number} now */
export function boardModel(view, now) {
	const { shown, hiddenClosed, active } = selectRows(view.rows);
	const cards = shown.map((row) => ({
		id: row.id,
		shortId: shortId(row.id),
		title: row.title,
		stage: row.stage,
		stageLabel: STAGE_LABEL[row.stage],
		basisLabel: BASIS_LABEL[row.basis],
		summary: row.latestSummary ?? "（暂无汇报）",
		model: modelText(row),
		tokens: `${formatTokens(row.tokensIn + row.tokensOut)} tok`,
		toolCalls: row.toolCalls,
		elapsed: formatElapsed(row.elapsedMs + (isLive(row) ? now - view.receivedAt : 0)),
	}));
	return { cards, hiddenClosed, active };
}

const STALE_AFTER_MS = 35_000;

/** @param {number} lastFrameAt @param {number} now */
export function isStale(lastFrameAt, now) {
	return now - lastFrameAt > STALE_AFTER_MS;
}
