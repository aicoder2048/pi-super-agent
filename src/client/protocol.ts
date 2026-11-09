import type { DashboardRow } from "../kernel/types.ts";

export type ConversationLine = { id: string; who: "user" | "router"; text: string; at: number };

export type ClientToHost =
	| { type: "hello"; role: "client" }
	| { type: "say"; text: string; requestId: string }
	| { type: "watch"; ticketId?: string };

export type HostToClient =
	| { type: "snapshot"; conversation: ConversationLine[]; board: DashboardRow[] }
	| { type: "user"; id: string; text: string; at: number }
	| { type: "ack"; requestId: string; triggerId: string }
	| { type: "reply"; text: string; at: number; replyId: string }
	| { type: "board"; rows: DashboardRow[] }
	| { type: "transcript_history"; ticketId: string; messages: TranscriptMessage[] }
	| { type: "transcript"; ticketId: string; message: TranscriptMessage };

export interface TranscriptMessage {
	role: string;
	content?: string | Array<{ type: string; text?: string; name?: string; arguments?: unknown; thinking?: string }>;
	customType?: string;
	toolName?: string;
	isError?: boolean;
}
