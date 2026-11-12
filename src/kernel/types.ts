export const BASES = ["request", "rule", "inference"] as const;
export type Basis = (typeof BASES)[number];

export const WORKER_STATES = ["none", "queued", "running", "idle"] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

/** conversation: the user's own words; market: a rule fired by a market source; rule: any other rule; watch: the Router's own inference. */
export const HELPER_ROLES = ["conversation", "market", "rule", "watch"] as const;
export type HelperRole = (typeof HELPER_ROLES)[number];

export type Helper = { name: string; seq: number } & ({ role: HelperRole } | { team: string | null });

export interface DomainEntry {
	/** The team's name when the module has members. Null: its helper works alone. */
	team: string | null;
	/** The 幕僚长 was offered this domain. False: only the module's own rules put a ticket in it. */
	onRoster: boolean;
	/** The package version that serves now. A ticket opened in this domain is pinned to it. Absent for a legacy module, which has no copy to pin. */
	digest?: string;
	/** The module's Chinese name, for the line Telegram gets instead of a report that touched private data. */
	title?: string;
}

/** All the kernel knows about domains: one entry per serving module, by the module's name. */
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
	/** From a feed that fills private data (design.md §5): a ticket that takes it has touched private data. */
	private?: boolean;
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

export type Writer = { role: "helper" } | { role: "member"; name: string };

/** A write by a helper or member that landed outside the output root, its ticket's workdir and the temp directories (ADR-0015). */
export type OutsideWrite =
	/** A write or edit call's exact path, absolute. */
	| { kind: "wrote"; path: string; tool: "write" | "edit"; by: Writer }
	/** Paths a bash or bg_start command may have written, by a best-effort parse of `command`, which is cut short. */
	| { kind: "maybe"; paths: string[]; command: string; tool: "bash" | "bg_start"; by: Writer };

/** Session file, relative to the state directory so it survives a move, to the count of complete lines already scanned. */
export type ScanCursor = Readonly<Record<string, number>>;

export interface WriteCheck {
	outside: OutsideWrite[];
	/** Outside writes left out of `outside` to keep it short. */
	omitted: number;
	/** Where the next check starts. */
	scanned: ScanCursor;
	/** Why some of it could not be checked; `outside` may then be short. */
	problem?: string;
}

export interface WorkerReport {
	status: ReportStatus;
	summary: string;
	question?: string;
	options?: string[];
	drafts?: unknown[];
	waiting?: boolean;
	/** Set by the host before the report reaches the kernel; never from the worker's own params. */
	writes?: WriteCheck;
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
	outsideWrites: OutsideWrite[];
	outsideOmitted: number;
	writeProblem: string | null;
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
	/** The package version the ticket is pinned to: its skills and members come from that copy. Null: no domain, or a legacy module. */
	moduleDigest: string | null;
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
	/** Every outside write in the ticket's reports, with up to three of their paths; null when there is none. */
	outside: OutsideTally | null;
	moduleOff: boolean;
}

export interface OutsideTally {
	/** Exact write and edit calls. */
	wrote: number;
	/** Bash and bg_start guesses, plus entries past the per-check cap, whose kind was never recorded. */
	maybe: number;
	sample: string[];
}

export interface Quote {
	lineId: string;
	who: "user" | "router";
	at: number;
	text: string;
	ticketId: string | null;
}

/**
 * What a source says to the user directly, past the Router (ADR-0017). The kind alone decides where it may go:
 * an alert reaches every front end, Telegram included, and is deduped on (source, externalId); a receipt never leaves this machine.
 */
export type HostLinePost =
	| { kind: "alert"; externalId: string; text: string; occurredAt: number; module?: AlertModule }
	| { kind: "receipt"; text: string };

/** A private module's alert leaves this machine only as a notice naming the module. */
export type AlertModule = { title: string; private: boolean };

/** A host line in the conversation. `who` is the kind. It cannot be quoted. `module`: absent for the market source's alerts. */
export type HostLine = { id: string; who: HostLinePost["kind"]; text: string; at: number; module?: AlertModule };

/** One line of the 对话 column. ticketId: on a 幕僚长 line, the task it concerns; the page puts that task's option buttons under its last such line. On a user line, the task whose question it answers. */
export type ConversationLine = { id: string; who: "user" | "router"; text: string; at: number; ticketId?: string; quote?: Quote } | HostLine;

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
