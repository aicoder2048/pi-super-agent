import type { CapQuestion, Cleared, ConversationLine, DashboardRow, Disposition, HelpersToday, HostLine, Routes } from "../kernel/types.ts";
import type { Dispatching } from "../host/dispatch.ts";
import type { KindDir } from "../modules/manifest.ts";

export type { Cleared, ConversationLine, HostLine, Quote } from "../kernel/types.ts";

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
	panel?: SourcePanel;
	/** Only for a source run by a feed: its alerts posted since local midnight. */
	alertsToday?: number;
}

/** What a feed is watching, for the page's left column. A tripwire line may carry a cost basis and shares, so it never leaves this machine (ADR-0017). */
export interface SourcePanel {
	watchlist: string[];
	tripwires: string[];
}

/** How many member processes may run at once right now, and the host's open question about raising it. Null on a host that cannot dispatch. */
export type MemberCapBoard = { limit: number; question: CapQuestion | null } | null;

export interface ModuleCard {
	name: string;
	title?: string;
	on: boolean;
	/** `reason` is empty when it would repeat the version or the first problem. */
	label: string;
	reason: string;
	tone: "ok" | "busy" | "bad" | "off";
	/** At most five `where：reason` lines. */
	problems: string[];
	/** Serving, else the one on disk. `digest` is its first 12 characters. */
	version: { label: string; digest: string };
	components: Partial<Record<KindDir | "rules", number>>;
	/** Names only, from the tools and feeds. Never a value. */
	secrets: string[];
	pinnedOld: number;
	/** Names only; the page builds each import command so a card stays under 1 KB. */
	notImported: string[];
}

export interface BoardState {
	rows: DashboardRow[];
	today: TodayCounts;
	duty: Duty;
	/** Helpers opened on today's New York date and their tokens. */
	helpers: HelpersToday;
	/** What became of each of the user's recent messages, so a line under it can change without a reload. */
	routes: Routes;
	/** ticketId → that helper's dispatches: waiting, running, and ended ones until its whole batch is back. */
	dispatching: Dispatching;
	memberCap: MemberCapBoard;
	watching: WatchedSource[];
	modules: ModuleCard[];
	/** Today's alerts (host local day), oldest first. */
	alerts: HostLine[];
}

export type ClientToHost =
	| { type: "hello"; role: "client"; token: string }
	| { type: "say"; text: string; requestId: string }
	/** A click on option `option` of the question `reportId`: a helper's report, or the host's own question about the member cap. The host words it as the user's message. */
	| { type: "answer"; reportId: string; option: number; requestId: string }
	| { type: "watch"; ticketId?: string };

export type HostToClient =
	| { type: "snapshot"; conversation: ConversationLine[]; cleared: Cleared | null; board: DashboardRow[]; today: TodayCounts; duty: Duty; helpers: HelpersToday; routes: Routes; dispatching: Dispatching; memberCap: MemberCapBoard; watching: WatchedSource[]; modules: ModuleCard[]; alerts: HostLine[] }
	| ({ type: "user" } & ConversationLine & { who: "user" })
	| { type: "ack"; requestId: string; triggerId: string }
	| { type: "refused"; requestId: string; reason: string }
	| { type: "reply"; text: string; at: number; replyId: string; ticketId?: string }
	| ({ type: "host_line" } & HostLine)
	| ({ type: "board" } & BoardState)
	/** A 清屏 on the host: every front end's conversation is now exactly `conversation`, and `cleared` is what it took away. */
	| { type: "cleared"; conversation: ConversationLine[]; cleared: Cleared }
	| ({ type: "transcript_history"; ticketId: string } & TranscriptHistory)
	/** `member`: the message is from the member at work on that dispatch, and is that dispatch's `index`-th message. */
	| { type: "transcript"; ticketId: string; message: TranscriptMessage; member?: { callId: string; index: number } };

/** A ticket's 执行过程 so far. */
export interface TranscriptHistory {
	/** The helper's own messages. */
	messages: TranscriptMessage[];
	/** Only for a ticket whose helper has members: each member's title by name, and each dispatch's own messages by the helper's call id. */
	team?: { titles: Record<string, string>; steps: Record<string, TranscriptMessage[]> };
}

export interface TranscriptMessage {
	role: string;
	content?: string | Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown; thinking?: string }>;
	customType?: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	details?: unknown;
	/** When Pi finished the message, in ms. */
	timestamp?: number;
	/** On an assistant message: what the model call used. */
	usage?: { input?: number; output?: number; cacheRead?: number };
}
