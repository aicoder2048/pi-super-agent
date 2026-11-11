export const BASES = ["request", "rule", "inference"] as const;
export type Basis = (typeof BASES)[number];

export const WORKER_STATES = ["none", "queued", "running", "idle"] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

/** conversation: the user's own words; market: a rule fired by a market source; rule: any other rule; watch: the Router's own inference. */
export const HELPER_ROLES = ["conversation", "market", "rule", "watch"] as const;
export type HelperRole = (typeof HELPER_ROLES)[number];

/**
 * Who a ticket shows as. The name, the number and which of the two forms it takes are fixed when the ticket opens.
 * One helper has a role and counts within that role: 「青檀 · 行情助手 #2」.
 * A helper whose domain has members to dispatch to is that team's 领队 and counts within that domain: 「高山流水 · 美股看盘队领队 #2」.
 * Both count within one New York day. `team` is read from the module each time: its current team name, or null once it has no members or is gone.
 */
export type Helper = { name: string; seq: number } & ({ role: HelperRole } | { team: string | null });

export interface DomainEntry {
	/** The team's name when the module has members. Null: its helper works alone. */
	team: string | null;
	/** The 幕僚长 was offered this domain. False: only the module's own rules put a ticket in it. */
	onRoster: boolean;
}

/** All the kernel knows about domains, built once at startup: one entry per loaded module, by the module's name. */
export type DomainBook = ReadonlyMap<string, DomainEntry>;

/** A rule's id is its namespace and its heading: a module's name for the module's rules, `user` for the user's own. */
export const ruleId = (namespace: string, heading: string) => `${namespace}/${heading}`;
export const ruleNamespace = (id: string) => id.split("/")[0];

export interface HelpersToday {
	count: number;
	tokens: number;
}

export const REPORT_STATUSES = ["progress", "ready", "blocked", "failed", "no_action"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const INPUT_KINDS = ["brief", "trigger", "user_message", "note", "status_query", "recovery", "bg_result"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export const DISPOSITIONS = ["ignored", "delivered", "to_router", "opened_ticket", "handed_over", "router_ignored"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const ACTION_STATUSES = ["pending", "done", "cancelled"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ACTION_KINDS = ["router.notify", "worker.wake", "worker.stop", "channel.reply"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const STAGES = [
	"stopped",
	"closed",
	"awaiting_answer",
	"awaiting_review",
	"blocked_or_failed",
	"queued",
	"idle",
	"running",
] as const;
export type Stage = (typeof STAGES)[number];

export const CONVERSATION_SOURCE = "conversation";
export const CONVERSATION_THREAD_ID = "thr_conversation";

export interface Clock {
	now(): number;
}

export interface TriggerSubmission {
	source: string;
	externalId: string;
	threads: { id: string; title?: string }[];
	sender: string;
	body: string;
	occurredAt: number;
}

export type SourcePolicy = (trigger: TriggerSubmission) => "ignore" | "candidate" | "notice";

export interface KernelConfig {
	maxWorkers: number;
	reservedSlots: number;
	inferenceConcurrent: number;
	inferenceDaily: number;
	replyMaxChars: number;
	repliesPerCause: number;
	stuckMs: number;
}

export const DEFAULT_CONFIG: KernelConfig = {
	maxWorkers: 3,
	reservedSlots: 1,
	inferenceConcurrent: 1,
	inferenceDaily: 24,
	replyMaxChars: 200,
	repliesPerCause: 2,
	stuckMs: 30 * 60_000,
};

export const RETRY_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000] as const;
export const SYSTEM_PROBLEM_STREAK = 3;

export type Rejection = { ok: false; reason: string };
export type Result<T extends object = {}> = ({ ok: true } & T) | Rejection;

export type RouterNotice =
	| { kind: "conversation"; triggerId: string }
	| { kind: "candidate"; triggerId: string }
	| { kind: "report"; ticketId: string; reportId: string }
	| { kind: "question"; ticketId: string; reportId: string }
	| { kind: "handback"; ticketId: string; body: string }
	| { kind: "notice"; body: string };

export type Action =
	| { kind: "router.notify"; payload: RouterNotice }
	| { kind: "worker.wake"; payload: { ticketId: string } }
	| { kind: "worker.stop"; payload: { ticketId: string } }
	| { kind: "channel.reply"; payload: { threadId: string; text: string; replyId: string; ticketId: string | null } };

export type PendingAction = Action & { id: string; attempts: number; createdAt: number };

export type Decision =
	| {
			kind: "open_ticket";
			title: string;
			basis: Basis;
			ruleId?: string;
			/** A module's name. Omitted, null or blank: the ticket has no domain. */
			domain?: string | null;
			triggerId?: string;
			threads?: string[];
			brief: string;
	  }
	| { kind: "hand_over"; triggerId: string; ticketId: string }
	| { kind: "ignore"; triggerId: string; reason: string }
	| { kind: "stop"; ticketId: string };

export type DecisionResult = Result<{ ticketId?: string }>;

export interface WorkerReport {
	status: ReportStatus;
	summary: string;
	question?: string;
	options?: string[];
	drafts?: unknown[];
	waiting?: boolean;
}

export interface Trigger {
	id: string;
	source: string;
	externalId: string;
	sender: string;
	body: string;
	occurredAt: number;
	receivedAt: number;
	disposition: Disposition;
	dispositionDetail: string | null;
}

export interface Thread {
	id: string;
	source: string;
	title: string | null;
}

export interface Report {
	id: string;
	ticketId: string;
	status: ReportStatus;
	summary: string;
	question: string | null;
	options: string[];
	drafts: unknown[];
	waiting: boolean;
	createdAt: number;
}

export interface TicketInput {
	id: string;
	ticketId: string;
	kind: InputKind;
	triggerId: string | null;
	body: string;
	createdAt: number;
	deliveredAt: number | null;
}

export interface Ticket {
	id: string;
	title: string;
	basis: Basis;
	ruleId: string | null;
	/** The module this ticket belongs to, fixed when it opens. Null: no domain. The module may have been removed since. */
	domain: string | null;
	originTriggerId: string | null;
	createdAt: number;
	workerSessionId: string;
	workerState: WorkerState;
	bgRunning: boolean;
	stoppedAt: number | null;
	closedAt: number | null;
	lastProgressAt: number | null;
	startedAt: number | null;
	model: string | null;
	fellBack: boolean;
	toolCalls: number;
	/** New input plus cache reads. Cache writes are not counted. */
	tokensIn: number;
	/** The part of `tokensIn` read from the provider's prompt cache. */
	tokensCached: number;
	tokensOut: number;
	/** Null only on a ticket from before helpers existed that the host has not named yet. */
	helper: Helper | null;
	/** Titles of the members the 领队 dispatched to, in first-dispatch order. Null: no record, because the ticket has no team or was opened before records were kept. */
	dispatchedTo: string[] | null;
	stage: Stage;
	latestReport: Report | null;
}

export interface PendingQuestion {
	reportId: string;
	text: string;
	options: string[];
	askedAt: number;
	/** The latest click on one of the options, or null when nobody clicked. */
	click: QuestionClick | null;
	/** The user said something after the question and the Router has not finished with it; a click now could contradict it. */
	spoke: boolean;
}

/** The host's own question about the member cap. `reportId` is its id on the answer wire, never a report's. */
export type CapQuestion = Pick<PendingQuestion, "reportId" | "text" | "options" | "askedAt">;

/**
 * sent: the Router has not finished with the click yet. handed_over: the asking task got it.
 * dropped: the Router ignored it or ended its turn without handing it over, so the options are open again.
 */
export interface QuestionClick {
	option: number;
	state: "sent" | "handed_over" | "dropped";
	triggerId: string;
}

export interface Stall {
	since: number;
	minutes: number;
}

export interface DashboardRow {
	id: string;
	title: string;
	stage: Stage;
	basis: Basis;
	latestSummary: string | null;
	question: PendingQuestion | null;
	stall: Stall | null;
	model: string | null;
	fellBack: boolean;
	toolCalls: number;
	/** New input plus cache reads. Cache writes are not counted. */
	tokensIn: number;
	/** The part of `tokensIn` read from the provider's prompt cache. */
	tokensCached: number;
	tokensOut: number;
	elapsedMs: number;
	lastProgressAt: number | null;
	helper: Helper | null;
	dispatchedTo: string[] | null;
	workerState: WorkerState;
	startedAt: number | null;
	/** closedAt, or stoppedAt for a stopped ticket; null while the ticket is open. */
	endedAt: number | null;
}

export interface Quote {
	lineId: string;
	who: "user" | "router";
	at: number;
	text: string;
	ticketId: string | null;
}

/** One line of the 对话 column. ticketId: on a 幕僚长 line, the task it concerns; the page puts that task's option buttons under its last such line. */
export type ConversationLine = { id: string; who: "user" | "router"; text: string; at: number; ticketId?: string; quote?: Quote };

/**
 * The latest 清屏. `at` is when it happened, and also its identity: every effective 清屏 has a strictly later `at` than the one before.
 * `lines` holds the newest hidden lines from every 清屏 so far, oldest first. Never empty: a 清屏 that hid nothing is not recorded.
 */
export interface Cleared {
	at: number;
	lines: ConversationLine[];
}

export interface AnswerClick {
	ticketId: string;
	reportId: string;
	question: string;
	option: string;
}

export type ReadResult =
	| { type: "trigger"; trigger: Trigger; threadIds: string[]; ticketIds: string[]; answers: AnswerClick | null; quote: Quote | null }
	| { type: "thread"; thread: Thread; recentTriggerIds: string[]; subscribedTicketIds: string[] }
	| {
			type: "ticket";
			ticket: Ticket;
			threadIds: string[];
			recentInputs: TicketInput[];
			recentReports: Report[];
			originTriggerId: string | null;
	  };

export interface DecisionLogEntry {
	decision: Decision;
	ok: boolean;
	reason: string | null;
	ticketId: string | null;
	createdAt: number;
}

export interface SystemProblem {
	kind: ActionKind;
	lastError: string;
	since: number;
}

/** What became of one of the user's messages: a task took it, the Router answered it, is still on it, or set it aside. */
export type Routing = { kind: "opened_ticket" | "handed_over"; ticketId: string } | { kind: "answered" | "pending" | "router_ignored" };
/** By conversation trigger id. A message the Router saw and left without a decision or a reply has no entry. */
export type Routes = Record<string, Routing>;
