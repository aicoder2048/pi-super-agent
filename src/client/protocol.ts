import type { DashboardRow, Disposition, HelpersToday, Routes } from "../kernel/types.ts";

/** ticketId: on a 幕僚长 line, the task it concerns; the page puts that task's option buttons under its last such line. */
export type ConversationLine = { id: string; who: "user" | "router"; text: string; at: number; ticketId?: string };

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
	title?: string;
	description?: string;
	problem?: string;
	timers: { everyMinutes: number; body: string }[];
	rules: { id: string; text: string; by: "user" | "module" }[];
}

export interface BoardState {
	rows: DashboardRow[];
	today: TodayCounts;
	duty: Duty;
	/** Helpers opened on today's New York date and their tokens. */
	helpers: HelpersToday;
	/** What became of each of the user's recent messages, so a line under it can change without a reload. */
	routes: Routes;
}

export type ClientToHost =
	| { type: "hello"; role: "client" }
	| { type: "say"; text: string; requestId: string }
	/** A click on option `option` of the question in report `reportId`; the host words it as the user's message. */
	| { type: "answer"; reportId: string; option: number; requestId: string }
	| { type: "watch"; ticketId?: string };

export type HostToClient =
	| { type: "snapshot"; conversation: ConversationLine[]; board: DashboardRow[]; today: TodayCounts; duty: Duty; helpers: HelpersToday; routes: Routes; watching: WatchedSource[] }
	| { type: "user"; id: string; text: string; at: number }
	| { type: "ack"; requestId: string; triggerId: string }
	| { type: "refused"; requestId: string; reason: string }
	| { type: "reply"; text: string; at: number; replyId: string; ticketId?: string }
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
