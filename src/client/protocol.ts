import type { DashboardRow, Disposition } from "../kernel/types.ts";

export type ConversationLine = { id: string; who: "user" | "router"; text: string; at: number };

/** `ask` is the latest report's question, set only while the ticket waits on the user. */
export interface BoardRow extends DashboardRow {
	ask: string | null;
}

/** `resumed` counts the running tickets recovered at this start; 0 means a clean start. */
export interface Duty {
	since: number;
	resumed: number;
}

/** Today's triggers (host local day), the user's own words and watchdog notices excluded. */
export interface TodayCounts {
	byDisposition: Record<Disposition, number>;
	bySource: Record<string, number>;
}

export interface WatchedSource {
	source: string;
	timers: { everyMinutes: number; body: string }[];
	rules: { id: string; text: string; by: "user" | "module" }[];
}

/** The left column's changing state, sent whole in the snapshot and in every board frame. */
export interface BoardState {
	rows: BoardRow[];
	today: TodayCounts;
	duty: Duty;
}

export type ClientToHost =
	| { type: "hello"; role: "client" }
	| { type: "say"; text: string; requestId: string }
	| { type: "watch"; ticketId?: string };

export type HostToClient =
	| { type: "snapshot"; conversation: ConversationLine[]; board: BoardRow[]; today: TodayCounts; duty: Duty; watching: WatchedSource[] }
	| { type: "user"; id: string; text: string; at: number }
	| { type: "ack"; requestId: string; triggerId: string }
	| { type: "reply"; text: string; at: number; replyId: string }
	| ({ type: "board" } & BoardState)
	| { type: "transcript_history"; ticketId: string; messages: TranscriptMessage[] }
	| { type: "transcript"; ticketId: string; message: TranscriptMessage };

export interface TranscriptMessage {
	role: string;
	content?: string | Array<{ type: string; text?: string; name?: string; arguments?: unknown; thinking?: string }>;
	customType?: string;
	toolName?: string;
	isError?: boolean;
}
