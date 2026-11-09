export const BASES = ["request", "rule", "inference"] as const;
export type Basis = (typeof BASES)[number];

export const WORKER_STATES = ["none", "queued", "running", "idle"] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

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
}

export const DEFAULT_CONFIG: KernelConfig = {
	maxWorkers: 3,
	reservedSlots: 1,
	inferenceConcurrent: 1,
	inferenceDaily: 24,
	replyMaxChars: 200,
	repliesPerCause: 2,
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
	| { kind: "channel.reply"; payload: { threadId: string; text: string; replyId: string } };

export type PendingAction = Action & { id: string; attempts: number; createdAt: number };

export type Decision =
	| {
			kind: "open_ticket";
			title: string;
			basis: Basis;
			ruleId?: string;
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
	/** Already parsed at the Worker boundary: 2 to 4 short answers, only with a question. */
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
	/** Empty for an open question or no question. */
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
	tokensIn: number;
	tokensOut: number;
	stage: Stage;
	latestReport: Report | null;
}

export interface DashboardRow {
	id: string;
	title: string;
	stage: Stage;
	basis: Basis;
	latestSummary: string | null;
	latestQuestion: string | null;
	model: string | null;
	fellBack: boolean;
	toolCalls: number;
	tokensIn: number;
	tokensOut: number;
	elapsedMs: number;
	lastProgressAt: number | null;
}

export type ReadResult =
	| { type: "trigger"; trigger: Trigger; threadIds: string[]; ticketIds: string[] }
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
