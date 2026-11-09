import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { answerExternalId, answerSentence, reportIdOfAnswer } from "./question.ts";
import { deriveStage } from "./stage.ts";
import { stallMinutes } from "../client/board-format.mjs";
import { inTransaction } from "./store.ts";
import {
	CONVERSATION_SOURCE,
	CONVERSATION_THREAD_ID,
	DEFAULT_CONFIG,
	RETRY_BACKOFF_MS,
	SYSTEM_PROBLEM_STREAK,
} from "./types.ts";
import type {
	Action,
	ActionKind,
	AnswerClick,
	Basis,
	Clock,
	DashboardRow,
	Decision,
	DecisionLogEntry,
	PendingQuestion,
	DecisionResult,
	Disposition,
	InputKind,
	KernelConfig,
	PendingAction,
	ReadResult,
	Report,
	Result,
	RouterNotice,
	SourcePolicy,
	Stall,
	SystemProblem,
	Thread,
	Ticket,
	TicketInput,
	Trigger,
	TriggerSubmission,
	WorkerReport,
	WorkerState,
} from "./types.ts";

type Row = Record<string, any>;

const RECOVERY_NOTE = "process restarted; inspect your workdir before repeating any external action";

const reject = (reason: string) => ({ ok: false as const, reason });

const answerOnly = (triggerId: string, ticketId: string) =>
	`${triggerId} is the user's click answering ${ticketId}'s question; route hand_over to ${ticketId}`;

function localDayStart(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function localDayKey(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toTrigger(r: Row): Trigger {
	return {
		id: r.id,
		source: r.source,
		externalId: r.external_id,
		sender: r.sender,
		body: r.body,
		occurredAt: r.occurred_at,
		receivedAt: r.received_at,
		disposition: r.disposition,
		dispositionDetail: r.disposition_detail,
	};
}

function toReport(r: Row): Report {
	return {
		id: r.id,
		ticketId: r.ticket_id,
		status: r.status,
		summary: r.summary,
		question: r.question,
		options: JSON.parse(r.options),
		drafts: JSON.parse(r.drafts),
		waiting: r.waiting === 1,
		createdAt: r.created_at,
	};
}

function toInput(r: Row): TicketInput {
	return {
		id: r.id,
		ticketId: r.ticket_id,
		kind: r.kind,
		triggerId: r.trigger_id,
		body: r.body,
		createdAt: r.created_at,
		deliveredAt: r.delivered_at,
	};
}

const SOURCE_THREAD = /^thr_([\w-]+):.+$/;

/** When the next running task that has not stalled yet will, or null when none is running. */
export function nextStallAt(rows: DashboardRow[], stuckMs: number): number | null {
	const at = rows.filter((r) => r.stage === "running" && !r.stall && r.lastProgressAt !== null).map((r) => r.lastProgressAt! + stuckMs);
	return at.length ? Math.min(...at) : null;
}

export interface KernelOptions {
	db: DatabaseSync;
	clock: Clock;
	sourcePolicy: SourcePolicy;
	ruleAllows?: (ruleId: string, triggerSource: string) => boolean;
	config?: Partial<KernelConfig>;
}

export class Kernel {
	readonly #db: DatabaseSync;
	readonly #clock: Clock;
	readonly #sourcePolicy: SourcePolicy;
	readonly #ruleAllows: (ruleId: string, triggerSource: string) => boolean;
	readonly config: KernelConfig;

	constructor({ db, clock, sourcePolicy, ruleAllows = () => true, config }: KernelOptions) {
		this.#ruleAllows = ruleAllows;
		this.#db = db;
		this.#clock = clock;
		this.#sourcePolicy = sourcePolicy;
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	submitTrigger(sub: TriggerSubmission): { triggerId: string; duplicate: boolean } {
		return this.#tx(() => {
			const existing = this.#get("SELECT id FROM triggers WHERE source = ? AND external_id = ?", sub.source, sub.externalId);
			if (existing) return { triggerId: existing.id, duplicate: true };

			for (const t of sub.threads) {
				this.#run(
					`INSERT INTO threads (id, source, title) VALUES (?, ?, ?)
					 ON CONFLICT (id) DO UPDATE SET title = COALESCE(excluded.title, threads.title)`,
					t.id,
					sub.source,
					t.title ?? null,
				);
			}

			const threadIds = sub.threads.map((t) => t.id);
			const isConversation = threadIds.includes(CONVERSATION_THREAD_ID);
			const policy = isConversation ? "candidate" : this.#sourcePolicy(sub);
			const ignored = policy === "ignore";
			const subscribers = isConversation || policy !== "candidate" ? [] : this.#subscribersOf(threadIds);
			const disposition: Disposition = ignored ? "ignored" : subscribers.length > 0 ? "delivered" : "to_router";

			const triggerId = this.#id("trg");
			this.#run(
				`INSERT INTO triggers (id, source, external_id, sender, body, occurred_at, received_at, disposition)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				triggerId,
				sub.source,
				sub.externalId,
				sub.sender,
				sub.body,
				sub.occurredAt,
				this.#now(),
				disposition,
			);
			for (const threadId of new Set(threadIds)) {
				this.#run("INSERT INTO trigger_threads (trigger_id, thread_id) VALUES (?, ?)", triggerId, threadId);
			}

			if (disposition === "delivered") {
				for (const ticketId of subscribers) this.#addInput(ticketId, "trigger", sub.body, triggerId);
			} else if (disposition === "to_router") {
				const payload: RouterNotice =
					policy === "notice" ? { kind: "notice", body: sub.body } : { kind: isConversation ? "conversation" : "candidate", triggerId };
				this.#enqueue({ kind: "router.notify", payload });
			}
			return { triggerId, duplicate: false };
		});
	}

	userSaid({ text, at, externalId = randomUUID() }: { text: string; at: number; externalId?: string }): { triggerId: string; duplicate: boolean } {
		return this.submitTrigger({
			source: CONVERSATION_SOURCE,
			externalId,
			threads: [{ id: CONVERSATION_THREAD_ID, title: "对话" }],
			sender: "user",
			body: text,
			occurredAt: at,
		});
	}

	answerQuestion({ reportId, option, at }: { reportId: string; option: number; at: number }): Result<{ triggerId: string; text: string; duplicate: boolean }> {
		return this.#tx(() => {
			const externalId = answerExternalId(reportId);
			const existing = this.#get("SELECT id, body FROM triggers WHERE source = ? AND external_id = ?", CONVERSATION_SOURCE, externalId);
			if (existing) return { ok: true, triggerId: existing.id, text: existing.body, duplicate: true };
			const report = this.#get("SELECT ticket_id, options FROM reports WHERE id = ?", reportId);
			if (!report) return reject(`unknown report ${reportId}`);
			const ticket = this.#ticket(report.ticket_id)!;
			if (ticket.stage !== "awaiting_answer" || ticket.latestReport?.id !== reportId) {
				return reject("这个问题已经回答过，或已不在等待回答");
			}
			const options: string[] = JSON.parse(report.options);
			if (options.length === 0) return reject("这个问题没有选项，请直接回复");
			if (!Number.isInteger(option) || option < 0 || option >= options.length) return reject(`这个问题只有 ${options.length} 个选项`);
			const text = answerSentence(ticket.title, options[option]);
			const { triggerId } = this.userSaid({ text, at, externalId });
			return { ok: true, triggerId, text, duplicate: false };
		});
	}

	route(decisions: Decision[]): DecisionResult[] {
		const takenThisRoute = new Set<string>();
		return this.#tx(() =>
			decisions.map((decision) => {
				const result = this.#decide(decision, takenThisRoute);
				this.#run(
					"INSERT INTO decisions (decision, ok, reason, ticket_id, created_at) VALUES (?, ?, ?, ?, ?)",
					JSON.stringify(decision),
					result.ok ? 1 : 0,
					result.ok ? null : result.reason,
					(result.ok && result.ticketId) || ("ticketId" in decision ? decision.ticketId : null),
					this.#now(),
				);
				return result;
			}),
		);
	}

	reply({ threadId, text, cause }: { threadId: string; text: string; cause: string }): Result<{ replyId: string }> {
		return this.#tx(() => {
			if (!this.#get("SELECT 1 FROM threads WHERE id = ?", threadId)) return reject(`unknown thread ${threadId}`);
			const length = [...text].length;
			if (length > this.config.replyMaxChars) {
				return reject(`reply has ${length} characters, limit is ${this.config.replyMaxChars}`);
			}
			const problem = this.#causeProblem(cause);
			if (problem) return reject(problem);
			const used = this.#get("SELECT COUNT(*) AS n FROM reply_receipts WHERE cause = ?", cause).n as number;
			if (used >= this.config.repliesPerCause) return reject(`already replied ${used} times about ${cause}`);
			const replyId = this.#id("rpl");
			this.#run(
				"INSERT INTO reply_receipts (id, thread_id, cause, text, created_at) VALUES (?, ?, ?, ?, ?)",
				replyId,
				threadId,
				cause,
				text,
				this.#now(),
			);
			this.#enqueue({ kind: "channel.reply", payload: { threadId, text, replyId, about: cause.startsWith("tkt_") ? cause : null } });
			return { ok: true, replyId };
		});
	}

	#causeProblem(cause: string | undefined): string | undefined {
		if (!cause) return "a reply needs a cause: the conversation trigger, ticket or notice id it answers";
		if (cause.startsWith("trg_")) {
			if (!this.#get("SELECT 1 FROM triggers WHERE id = ?", cause)) return `unknown trigger ${cause}`;
			return this.#inConversation(cause) ? undefined : "a source trigger is data, not something to answer; open a ticket or ignore it";
		}
		if (cause.startsWith("tkt_")) {
			const ticket = this.#ticketRow(cause);
			if (!ticket) return `unknown ticket ${cause}`;
			if (ticket.basis !== "inference") return undefined;
			const latest = this.#latestReportRow(cause);
			const answerable = latest && (latest.question || ["ready", "blocked", "failed"].includes(latest.status));
			return answerable ? undefined : "inference tickets stay quiet until they have a result to report";
		}
		if (cause.startsWith("act_")) {
			const action = this.#get("SELECT kind, payload FROM actions WHERE id = ?", cause);
			const notice = action?.kind === "router.notify" && JSON.parse(action.payload).kind === "notice";
			return notice ? undefined : `${cause} is not a notice`;
		}
		return `unknown cause ${cause}`;
	}

	markReplyDelivered(replyId: string): boolean {
		return this.#tx(
			() =>
				this.#run("UPDATE reply_receipts SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL", this.#now(), replyId)
					.changes > 0,
		);
	}

	note({ ticketId, text }: { ticketId: string; text: string }): Result {
		return this.#tx(() => {
			const problem = this.#acceptsInput(ticketId);
			if (problem) return reject(problem);
			this.#addInput(ticketId, "note", text);
			return { ok: true };
		});
	}

	askStatus({ ticketId }: { ticketId: string }): Result {
		return this.#tx(() => {
			const ticket = this.#ticket(ticketId);
			if (!ticket) return reject(`unknown ticket ${ticketId}`);
			if (ticket.stage !== "idle") return reject(`ticket is ${ticket.stage}, status queries need an idle worker`);
			this.#addInput(ticketId, "status_query", "report your current status");
			return { ok: true };
		});
	}

	workerReport(ticketId: string, report: WorkerReport): { reportId: string } {
		return this.#tx(() => {
			const ticket = this.#requireTicket(ticketId);
			const reportId = this.#id("rpt");
			const now = this.#now();
			this.#run(
				`INSERT INTO reports (id, seq, ticket_id, status, summary, question, options, drafts, waiting, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				reportId,
				this.#nextSeq(),
				ticketId,
				report.status,
				report.summary,
				report.question ?? null,
				JSON.stringify(report.options ?? []),
				JSON.stringify(report.drafts ?? []),
				report.waiting ? 1 : 0,
				now,
			);
			this.#run("UPDATE tickets SET last_progress_at = ? WHERE id = ?", now, ticketId);
			if (ticket.stopped_at !== null) return { reportId };

			if (report.status === "no_action") {
				this.#close(ticketId);
				return { reportId };
			}
			if (report.question) {
				this.#enqueue({ kind: "router.notify", payload: { kind: "question", ticketId, reportId } });
			} else if (report.status !== "progress") {
				this.#enqueue({ kind: "router.notify", payload: { kind: "report", ticketId, reportId } });
			}
			if (report.status === "ready" && !report.waiting && !report.question) this.#close(ticketId);
			return { reportId };
		});
	}

	workerHandBack(ticketId: string, { body }: { body: string }): void {
		this.#tx(() => {
			const ticket = this.#requireTicket(ticketId);
			if (ticket.stopped_at !== null) return;
			this.#enqueue({ kind: "router.notify", payload: { kind: "handback", ticketId, body } });
		});
	}

	notifyRouter(body: string): void {
		this.#tx(() => this.#enqueue({ kind: "router.notify", payload: { kind: "notice", body } }));
	}

	addBackgroundResult(ticketId: string, body: string): Result {
		return this.#tx(() => {
			const problem = this.#acceptsInput(ticketId);
			if (problem) return reject(problem);
			this.#addInput(ticketId, "bg_result", body);
			return { ok: true };
		});
	}

	claimSlot(ticketId: string): boolean {
		return this.#tx(() => {
			const ticket = this.#requireTicket(ticketId);
			if (ticket.stopped_at !== null) return false;
			if (ticket.worker_state === "running") return true;
			if (ticket.basis === "inference" && this.#inferenceRunning() >= this.config.inferenceConcurrent) {
				this.#setState(ticketId, "queued");
				return false;
			}
			const running = this.#get("SELECT COUNT(*) AS n FROM tickets WHERE worker_state = 'running'").n as number;
			const general = running < this.config.maxWorkers;
			const reserved =
				running < this.config.maxWorkers + this.config.reservedSlots &&
				(ticket.basis === "request" || this.#hasUndeliveredUserMessage(ticketId));
			if (!general && !reserved) {
				this.#setState(ticketId, "queued");
				return false;
			}
			const now = this.#now();
			this.#run(
				`UPDATE tickets SET worker_state = 'running',
				 started_at = COALESCE(started_at, ?), last_progress_at = ? WHERE id = ?`,
				now,
				now,
				ticketId,
			);
			return true;
		});
	}

	workerStarted(ticketId: string, { model, fellBack = false }: { model: string; fellBack?: boolean }): void {
		this.#tx(() => {
			this.#requireTicket(ticketId);
			this.#run("UPDATE tickets SET model = ?, fell_back = ? WHERE id = ?", model, fellBack ? 1 : 0, ticketId);
		});
	}

	markInputsDelivered(ticketId: string, inputIds: string[]): void {
		this.#tx(() => {
			for (const id of inputIds) {
				this.#run(
					"UPDATE ticket_inputs SET delivered_at = ? WHERE id = ? AND ticket_id = ? AND delivered_at IS NULL",
					this.#now(),
					id,
					ticketId,
				);
			}
		});
	}

	workerTurnEnded(ticketId: string, { bgRunning }: { bgRunning: boolean }): void {
		this.#tx(() => {
			const ticket = this.#requireTicket(ticketId);
			const live = ticket.stopped_at === null;
			if (live && this.#undeliveredCount(ticketId) > 0) {
				this.#run("UPDATE tickets SET worker_state = 'running', bg_running = ? WHERE id = ?", bgRunning ? 1 : 0, ticketId);
				this.#wake(ticketId);
			} else if (live && bgRunning) {
				this.#run("UPDATE tickets SET worker_state = 'running', bg_running = 1 WHERE id = ?", ticketId);
			} else {
				this.#run("UPDATE tickets SET worker_state = 'idle', bg_running = 0 WHERE id = ?", ticketId);
				this.#wakeNextQueued();
			}
		});
	}

	workerExited(ticketId: string): void {
		this.#tx(() => {
			const ticket = this.#requireTicket(ticketId);
			const resume = ticket.stopped_at === null && this.#undeliveredCount(ticketId) > 0;
			if (!resume && ticket.worker_state !== "running") return;
			this.#run("UPDATE tickets SET worker_state = ?, bg_running = 0 WHERE id = ?", resume ? "queued" : "idle", ticketId);
			if (resume) this.#wake(ticketId);
			this.#wakeNextQueued();
		});
	}

	recordWorkerProgress(ticketId: string): void {
		this.#tx(() => {
			this.#requireTicket(ticketId);
			this.#run("UPDATE tickets SET last_progress_at = ?, tool_calls = tool_calls + 1 WHERE id = ?", this.#now(), ticketId);
		});
	}

	recordUsage(ticketId: string, { provider, tokensIn, tokensOut }: { provider: string; tokensIn: number; tokensOut: number }): void {
		this.#tx(() => {
			this.#requireTicket(ticketId);
			this.#run(
				"UPDATE tickets SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE id = ?",
				tokensIn,
				tokensOut,
				ticketId,
			);
			this.#addUsage(provider, tokensIn + tokensOut);
		});
	}

	recordRouterUsage({ provider, tokensIn, tokensOut }: { provider: string; tokensIn: number; tokensOut: number }): void {
		this.#tx(() => this.#addUsage(provider, tokensIn + tokensOut));
	}

	#addUsage(provider: string, tokens: number): void {
		this.#run(
			`INSERT INTO usage_daily (day, provider, tokens) VALUES (?, ?, ?)
			 ON CONFLICT (day, provider) DO UPDATE SET tokens = tokens + excluded.tokens`,
			localDayKey(this.#now()),
			provider,
			tokens,
		);
	}

	blockForCap(ticketId: string, summary: string): void {
		this.#tx(() => {
			const latest = this.#latestReportRow(ticketId);
			if (!(latest?.status === "blocked" && latest.summary === summary)) this.workerReport(ticketId, { status: "blocked", summary });
			this.#run("UPDATE tickets SET worker_state = 'idle' WHERE id = ? AND worker_state = 'queued'", ticketId);
		});
	}

	recoverOnStartup(): string[] {
		return this.#tx(() => {
			this.#run("UPDATE tickets SET worker_state = 'idle', bg_running = 0 WHERE worker_state = 'running' AND stopped_at IS NOT NULL");
			const running = this.#all("SELECT id FROM tickets WHERE worker_state = 'running' ORDER BY created_at, rowid").map(
				(r) => r.id as string,
			);
			for (const ticketId of running) {
				this.#run("UPDATE tickets SET worker_state = 'queued', bg_running = 0 WHERE id = ?", ticketId);
				this.#addInput(ticketId, "recovery", RECOVERY_NOTE);
			}
			return running;
		});
	}

	dueActions(limit = 50): PendingAction[] {
		return this.#all(
			"SELECT * FROM actions WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY seq LIMIT ?",
			this.#now(),
			limit,
		).map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload), attempts: r.attempts, createdAt: r.created_at }));
	}

	completeAction(actionId: string): void {
		this.#tx(() => {
			const action = this.#stillPendingAction(actionId);
			if (!action) return;
			this.#run("UPDATE actions SET status = 'done', attempts = attempts + 1, last_error = NULL WHERE id = ?", actionId);
			this.#logAttempt(action, true, null);
		});
	}

	failAction(actionId: string, error: string): { nextAttemptAt: number } | undefined {
		return this.#tx(() => {
			const action = this.#stillPendingAction(actionId);
			if (!action) return undefined;
			const attempts = (action.attempts as number) + 1;
			const nextAttemptAt = this.#now() + RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length) - 1];
			this.#run(
				"UPDATE actions SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
				attempts,
				nextAttemptAt,
				error,
				actionId,
			);
			this.#logAttempt(action, false, error);
			return { nextAttemptAt };
		});
	}

	systemProblems(): SystemProblem[] {
		const kinds = this.#all("SELECT DISTINCT kind FROM action_attempts").map((r) => r.kind as ActionKind);
		return kinds.flatMap((kind) => {
			const recent = this.#all(
				"SELECT ok, error, at FROM action_attempts WHERE kind = ? ORDER BY seq DESC LIMIT ?",
				kind,
				SYSTEM_PROBLEM_STREAK,
			);
			if (recent.length < SYSTEM_PROBLEM_STREAK || recent.some((r) => r.ok === 1)) return [];
			const since = this.#get(
				`SELECT MIN(at) AS at FROM action_attempts WHERE kind = ?
				 AND seq > COALESCE((SELECT MAX(seq) FROM action_attempts WHERE kind = ? AND ok = 1), 0)`,
				kind,
				kind,
			).at as number;
			return [{ kind, lastError: recent[0].error, since }];
		});
	}

	getTicket(ticketId: string): Ticket | undefined {
		return this.#ticket(ticketId);
	}

	listTickets(): DashboardRow[] {
		const now = this.#now();
		return this.#all("SELECT id FROM tickets ORDER BY created_at, rowid").map((r) => {
			const t = this.#ticket(r.id)!;
			const end = t.stoppedAt ?? t.closedAt ?? now;
			return {
				id: t.id,
				title: t.title,
				stage: t.stage,
				basis: t.basis,
				latestSummary: t.latestReport?.summary ?? null,
				question: t.stage === "awaiting_answer" ? this.#pendingQuestion(t.title, t.latestReport!) : null,
				stall: this.#stall(t, now),
				model: t.model,
				fellBack: t.fellBack,
				toolCalls: t.toolCalls,
				tokensIn: t.tokensIn,
				tokensOut: t.tokensOut,
				elapsedMs: t.startedAt === null ? 0 : end - t.startedAt,
				lastProgressAt: t.lastProgressAt,
			};
		});
	}

	#stall(t: Ticket, now: number): Stall | null {
		if (t.stage !== "running" || t.lastProgressAt === null) return null;
		const quietMs = now - t.lastProgressAt;
		return quietMs >= this.config.stuckMs ? { since: t.lastProgressAt, minutes: stallMinutes(t.lastProgressAt, now) } : null;
	}

	#pendingQuestion(title: string, report: Report): PendingQuestion {
		const click = this.#get("SELECT body FROM triggers WHERE source = ? AND external_id = ?", CONVERSATION_SOURCE, answerExternalId(report.id));
		const picked = click ? report.options.findIndex((o) => answerSentence(title, o) === click.body) : -1;
		return { reportId: report.id, text: report.question!, options: report.options, askedAt: report.createdAt, answered: picked === -1 ? null : picked };
	}

	#answerOf(trigger: Trigger): AnswerClick | null {
		const reportId = trigger.source === CONVERSATION_SOURCE ? reportIdOfAnswer(trigger.externalId) : null;
		if (!reportId) return null;
		const r = this.#get("SELECT r.ticket_id, r.question, r.options, t.title FROM reports r JOIN tickets t ON t.id = r.ticket_id WHERE r.id = ?", reportId);
		if (!r) return null;
		const option = (JSON.parse(r.options) as string[]).find((o) => answerSentence(r.title, o) === trigger.body) ?? "";
		return { ticketId: r.ticket_id, reportId, question: r.question, option };
	}

	#boundTicket(triggerId: string): string | null {
		const row = this.#get("SELECT * FROM triggers WHERE id = ?", triggerId);
		return row ? (this.#answerOf(toTrigger(row))?.ticketId ?? null) : null;
	}

	pendingInputs(ticketId: string): TicketInput[] {
		return this.#all("SELECT * FROM ticket_inputs WHERE ticket_id = ? AND delivered_at IS NULL ORDER BY seq", ticketId).map(
			toInput,
		);
	}

	read(id: string): ReadResult | undefined {
		if (id.startsWith("trg_")) {
			const row = this.#get("SELECT * FROM triggers WHERE id = ?", id);
			if (!row) return undefined;
			const trigger = toTrigger(row);
			return {
				type: "trigger",
				trigger,
				answers: this.#answerOf(trigger),
				threadIds: this.#column("SELECT thread_id AS v FROM trigger_threads WHERE trigger_id = ?", id),
				ticketIds: this.#column(
					`SELECT ticket_id AS v FROM ticket_inputs WHERE trigger_id = ?
					 UNION SELECT id AS v FROM tickets WHERE origin_trigger_id = ?`,
					id,
					id,
				),
			};
		}
		if (id.startsWith("thr_")) {
			const row = this.#get("SELECT * FROM threads WHERE id = ?", id);
			if (!row) return undefined;
			const thread: Thread = { id: row.id, source: row.source, title: row.title };
			return {
				type: "thread",
				thread,
				recentTriggerIds: this.#column(
					`SELECT t.id AS v FROM triggers t JOIN trigger_threads tt ON tt.trigger_id = t.id
					 WHERE tt.thread_id = ? ORDER BY t.received_at DESC, t.rowid DESC LIMIT 20`,
					id,
				),
				subscribedTicketIds: this.#column("SELECT ticket_id AS v FROM subscriptions WHERE thread_id = ?", id),
			};
		}
		if (id.startsWith("tkt_")) {
			const ticket = this.#ticket(id);
			if (!ticket) return undefined;
			return {
				type: "ticket",
				ticket,
				threadIds: this.#column("SELECT thread_id AS v FROM subscriptions WHERE ticket_id = ?", id),
				recentInputs: this.#all("SELECT * FROM ticket_inputs WHERE ticket_id = ? ORDER BY seq DESC LIMIT 20", id).map(toInput),
				recentReports: this.#all("SELECT * FROM reports WHERE ticket_id = ? ORDER BY seq DESC LIMIT 10", id).map(toReport),
				originTriggerId: ticket.originTriggerId,
			};
		}
		return undefined;
	}

	triggerLog(limit = 100): Trigger[] {
		return this.#all("SELECT * FROM triggers ORDER BY received_at DESC, rowid DESC LIMIT ?", limit).map(toTrigger);
	}

	triggerCountsToday(): { source: string; disposition: Disposition; count: number }[] {
		return this.#all(
			"SELECT source, disposition, COUNT(*) AS count FROM triggers WHERE received_at >= ? GROUP BY source, disposition",
			localDayStart(this.#now()),
		).map((r) => ({ source: r.source, disposition: r.disposition, count: r.count }));
	}

	decisionLog(limit = 100): DecisionLogEntry[] {
		return this.#all("SELECT * FROM decisions ORDER BY seq DESC LIMIT ?", limit).map((r) => ({
			decision: JSON.parse(r.decision),
			ok: r.ok === 1,
			reason: r.reason,
			ticketId: r.ticket_id,
			createdAt: r.created_at,
		}));
	}

	conversation(limit = 50): { id: string; who: "user" | "router"; text: string; at: number; about?: string }[] {
		return this.#all(
			`SELECT * FROM (
				SELECT t.id AS id, 'user' AS who, t.body AS text, t.received_at AS at, t.rowid AS ord, NULL AS cause FROM triggers t
				JOIN trigger_threads tt ON tt.trigger_id = t.id WHERE tt.thread_id = ?
				UNION ALL
				SELECT r.id, 'router', r.text, r.created_at, r.rowid, r.cause FROM reply_receipts r WHERE r.thread_id = ?
			) ORDER BY at DESC, who = 'router' DESC, ord DESC LIMIT ?`,
			CONVERSATION_THREAD_ID,
			CONVERSATION_THREAD_ID,
			limit,
		)
			.reverse()
			.map((r) => ({ id: r.id, who: r.who, text: r.text, at: r.at, ...(r.cause?.startsWith("tkt_") ? { about: r.cause } : {}) }));
	}

	sourceCursor(source: string): string | undefined {
		return this.#get("SELECT cursor FROM source_cursors WHERE source = ?", source)?.cursor;
	}

	setSourceCursor(source: string, cursor: string): void {
		this.#tx(() => {
			this.#run(
				`INSERT INTO source_cursors (source, cursor, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
				source,
				cursor,
				this.#now(),
			);
		});
	}

	usageToday(provider: string): number {
		return this.#get("SELECT tokens FROM usage_daily WHERE day = ? AND provider = ?", localDayKey(this.#now()), provider)?.tokens ?? 0;
	}

	#decide(d: Decision, takenThisRoute: Set<string>): DecisionResult {
		switch (d.kind) {
			case "open_ticket":
				return this.#openTicket(d, takenThisRoute);
			case "hand_over": {
				const trigger = this.#get("SELECT id, body FROM triggers WHERE id = ?", d.triggerId);
				if (!trigger) return reject(`unknown trigger ${d.triggerId}`);
				const unusable = this.#evidenceProblem(d.triggerId, takenThisRoute);
				if (unusable) return reject(unusable);
				const bound = this.#boundTicket(d.triggerId);
				if (bound && bound !== d.ticketId) return reject(answerOnly(d.triggerId, bound));
				const problem = this.#acceptsInput(d.ticketId);
				if (problem) return reject(problem);
				const kind: InputKind = this.#inConversation(d.triggerId) ? "user_message" : "trigger";
				this.#addInput(d.ticketId, kind, trigger.body, d.triggerId);
				this.#setDisposition(d.triggerId, "handed_over", d.ticketId);
				takenThisRoute.add(d.triggerId);
				return { ok: true, ticketId: d.ticketId };
			}
			case "ignore": {
				if (!this.#get("SELECT 1 FROM triggers WHERE id = ?", d.triggerId)) return reject(`unknown trigger ${d.triggerId}`);
				const unusable = this.#evidenceProblem(d.triggerId, takenThisRoute);
				if (unusable) return reject(unusable);
				this.#setDisposition(d.triggerId, "router_ignored", d.reason);
				return { ok: true };
			}
			case "stop": {
				const ticket = this.#ticketRow(d.ticketId);
				if (!ticket) return reject(`unknown ticket ${d.ticketId}`);
				if (ticket.stopped_at !== null) return { ok: true, ticketId: d.ticketId };
				this.#run("UPDATE tickets SET stopped_at = ? WHERE id = ?", this.#now(), d.ticketId);
				this.#run(
					"UPDATE actions SET status = 'cancelled' WHERE status = 'pending' AND kind = 'worker.wake' AND ticket_id = ?",
					d.ticketId,
				);
				this.#enqueue({ kind: "worker.stop", payload: { ticketId: d.ticketId } });
				return { ok: true, ticketId: d.ticketId };
			}
		}
	}

	#evidenceProblem(triggerId: string, takenThisRoute: Set<string>): string | undefined {
		if (takenThisRoute.has(triggerId)) return undefined;
		const row = this.#get("SELECT disposition FROM triggers WHERE id = ?", triggerId);
		return row.disposition === "to_router" ? undefined : `trigger ${triggerId} was already handled (${row.disposition}); it cannot back another decision`;
	}

	#openTicket(d: Extract<Decision, { kind: "open_ticket" }>, takenThisRoute: Set<string>): DecisionResult {
		if (typeof d.title !== "string" || !d.title.trim()) return reject("open_ticket needs a title");
		if (typeof d.brief !== "string" || !d.brief.trim()) return reject("open_ticket needs a brief for the worker");
		const trigger = d.triggerId === undefined ? undefined : this.#get("SELECT id, source FROM triggers WHERE id = ?", d.triggerId);
		if (d.triggerId !== undefined && !trigger) return reject(`unknown trigger ${d.triggerId}`);
		const unusable = d.triggerId === undefined ? undefined : this.#evidenceProblem(d.triggerId, takenThisRoute);
		if (unusable) return reject(unusable);
		const bound = d.triggerId === undefined ? null : this.#boundTicket(d.triggerId);
		if (bound) return reject(answerOnly(d.triggerId!, bound));
		if (d.basis === "request" && (d.triggerId === undefined || !this.#inConversation(d.triggerId))) {
			return reject("basis request requires a conversation trigger from the user");
		}
		if (d.basis === "rule") {
			if (!d.ruleId) return reject("basis rule requires a ruleId");
			if (!trigger || this.#inConversation(trigger.id)) return reject("basis rule requires an unhandled trigger from a source, not from the conversation");
			if (!this.#ruleAllows(d.ruleId, trigger.source)) {
				return reject(`rule ${d.ruleId} does not exist in the user's rule files or does not apply to source ${trigger.source}`);
			}
		}
		const threads = [...new Set(d.threads ?? [])];
		for (const threadId of threads) {
			if (threadId === CONVERSATION_THREAD_ID) return reject("the conversation thread cannot be subscribed");
			if (!this.#get("SELECT 1 FROM threads WHERE id = ?", threadId) && !SOURCE_THREAD.test(threadId)) {
				return reject(`unknown thread ${threadId}; new threads must look like thr_<source>:<thread>`);
			}
		}
		if (d.basis === "inference") {
			const limitProblem = this.#inferenceDailyLimitProblem();
			if (limitProblem) return reject(limitProblem);
		}

		const ticketId = this.#id("tkt");
		this.#run(
			`INSERT INTO tickets (id, title, basis, rule_id, origin_trigger_id, created_at, worker_session_id, worker_state)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
			ticketId,
			d.title,
			d.basis,
			d.ruleId ?? null,
			d.triggerId ?? null,
			this.#now(),
			randomUUID(),
		);
		for (const threadId of threads) {
			const source = threadId.match(SOURCE_THREAD)?.[1];
			if (source) this.#run("INSERT INTO threads (id, source, title) VALUES (?, ?, NULL) ON CONFLICT (id) DO NOTHING", threadId, source);
			this.#run("INSERT INTO subscriptions (ticket_id, thread_id) VALUES (?, ?)", ticketId, threadId);
		}
		this.#addInput(ticketId, "brief", d.brief, d.triggerId ?? null);
		if (d.triggerId !== undefined) takenThisRoute.add(d.triggerId);
		if (d.triggerId !== undefined) this.#setDisposition(d.triggerId, "opened_ticket", ticketId);
		return { ok: true, ticketId };
	}

	#inferenceRunning(): number {
		return this.#get("SELECT COUNT(*) AS n FROM tickets WHERE basis = 'inference' AND worker_state = 'running'").n as number;
	}

	#inferenceDailyLimitProblem(): string | null {
		const today = this.#get(
			"SELECT COUNT(*) AS n FROM tickets WHERE basis = 'inference' AND created_at >= ?",
			localDayStart(this.#now()),
		).n as number;
		if (today >= this.config.inferenceDaily) {
			return `inference limit: ${today} opened today, at most ${this.config.inferenceDaily} per day`;
		}
		return null;
	}

	#addInput(ticketId: string, kind: InputKind, body: string, triggerId: string | null = null): void {
		this.#run(
			"INSERT INTO ticket_inputs (id, seq, ticket_id, kind, trigger_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			this.#id("inp"),
			this.#nextSeq(),
			ticketId,
			kind,
			triggerId,
			body,
			this.#now(),
		);
		this.#run(
			`UPDATE tickets SET closed_at = NULL,
			 worker_state = CASE WHEN worker_state IN ('none', 'idle') THEN 'queued' ELSE worker_state END
			 WHERE id = ?`,
			ticketId,
		);
		this.#wake(ticketId);
	}

	#acceptsInput(ticketId: string): string | null {
		const ticket = this.#ticketRow(ticketId);
		if (!ticket) return `unknown ticket ${ticketId}`;
		if (ticket.stopped_at !== null) return `ticket ${ticketId} was stopped and accepts no input`;
		return null;
	}

	#wake(ticketId: string): void {
		if (this.#get("SELECT 1 FROM actions WHERE status = 'pending' AND kind = 'worker.wake' AND ticket_id = ?", ticketId)) return;
		this.#enqueue({ kind: "worker.wake", payload: { ticketId } });
	}

	#wakeNextQueued(): void {
		const next = this.#get(
			`SELECT t.id FROM tickets t
			 WHERE t.worker_state = 'queued' AND t.stopped_at IS NULL
			   AND EXISTS (SELECT 1 FROM ticket_inputs i WHERE i.ticket_id = t.id AND i.delivered_at IS NULL)
			   AND NOT (t.basis = 'inference' AND ? >= ?)
			 ORDER BY
			   EXISTS (SELECT 1 FROM ticket_inputs i WHERE i.ticket_id = t.id AND i.delivered_at IS NULL AND i.kind = 'user_message') DESC,
			   t.basis = 'request' DESC,
			   t.created_at, t.rowid
			 LIMIT 1`,
			this.#inferenceRunning(),
			this.config.inferenceConcurrent,
		);
		if (next) this.#wake(next.id);
	}

	#close(ticketId: string): void {
		this.#run("UPDATE tickets SET closed_at = ? WHERE id = ?", this.#now(), ticketId);
	}

	#setState(ticketId: string, state: WorkerState): void {
		this.#run("UPDATE tickets SET worker_state = ? WHERE id = ?", state, ticketId);
	}

	#setDisposition(triggerId: string, disposition: Disposition, detail: string): void {
		this.#run("UPDATE triggers SET disposition = ?, disposition_detail = ? WHERE id = ?", disposition, detail, triggerId);
	}

	#subscribersOf(threadIds: string[]): string[] {
		if (threadIds.length === 0) return [];
		return this.#column(
			`SELECT DISTINCT s.ticket_id AS v FROM subscriptions s JOIN tickets t ON t.id = s.ticket_id
			 WHERE t.stopped_at IS NULL AND s.thread_id IN (${threadIds.map(() => "?").join(", ")})
			 ORDER BY t.created_at`,
			...threadIds,
		);
	}

	#inConversation(triggerId: string): boolean {
		return !!this.#get(
			"SELECT 1 FROM trigger_threads WHERE trigger_id = ? AND thread_id = ?",
			triggerId,
			CONVERSATION_THREAD_ID,
		);
	}

	#hasUndeliveredUserMessage(ticketId: string): boolean {
		return !!this.#get(
			"SELECT 1 FROM ticket_inputs WHERE ticket_id = ? AND delivered_at IS NULL AND kind = 'user_message'",
			ticketId,
		);
	}

	#undeliveredCount(ticketId: string): number {
		return this.#get("SELECT COUNT(*) AS n FROM ticket_inputs WHERE ticket_id = ? AND delivered_at IS NULL", ticketId).n;
	}

	#latestReportRow(ticketId: string): Row | undefined {
		return this.#get("SELECT * FROM reports WHERE ticket_id = ? ORDER BY seq DESC LIMIT 1", ticketId);
	}

	#ticketRow(ticketId: string): Row | undefined {
		return this.#get("SELECT * FROM tickets WHERE id = ?", ticketId);
	}

	#requireTicket(ticketId: string): Row {
		const row = this.#ticketRow(ticketId);
		if (!row) throw new Error(`unknown ticket ${ticketId}`);
		return row;
	}

	#ticket(ticketId: string): Ticket | undefined {
		const r = this.#ticketRow(ticketId);
		if (!r) return undefined;
		const latest = this.#latestReportRow(ticketId);
		const userSpokeAfterLatestReport =
			latest !== undefined &&
			!!this.#get(
				"SELECT 1 FROM ticket_inputs WHERE ticket_id = ? AND kind = 'user_message' AND seq > ?",
				ticketId,
				latest.seq,
			);
		const inputAfterLatestReport =
			latest !== undefined && !!this.#get("SELECT 1 FROM ticket_inputs WHERE ticket_id = ? AND seq > ?", ticketId, latest.seq);
		const stage = deriveStage({
			inputAfterLatestReport,
			stopped: r.stopped_at !== null,
			closed: r.closed_at !== null,
			workerState: r.worker_state,
			latestReport: latest ? { status: latest.status, hasQuestion: !!latest.question } : null,
			userSpokeAfterLatestReport,
		});
		return {
			id: r.id,
			title: r.title,
			basis: r.basis as Basis,
			ruleId: r.rule_id,
			originTriggerId: r.origin_trigger_id,
			createdAt: r.created_at,
			workerSessionId: r.worker_session_id,
			workerState: r.worker_state,
			bgRunning: r.bg_running === 1,
			stoppedAt: r.stopped_at,
			closedAt: r.closed_at,
			lastProgressAt: r.last_progress_at,
			startedAt: r.started_at,
			model: r.model,
			fellBack: r.fell_back === 1,
			toolCalls: r.tool_calls,
			tokensIn: r.tokens_in,
			tokensOut: r.tokens_out,
			stage,
			latestReport: latest ? toReport(latest) : null,
		};
	}

	#stillPendingAction(actionId: string): Row | undefined {
		const action = this.#get("SELECT * FROM actions WHERE id = ?", actionId);
		if (!action) throw new Error(`unknown action ${actionId}`);
		return action.status === "pending" ? action : undefined;
	}

	#logAttempt(action: Row, ok: boolean, error: string | null): void {
		this.#run(
			"INSERT INTO action_attempts (action_id, kind, ok, error, at) VALUES (?, ?, ?, ?, ?)",
			action.id,
			action.kind,
			ok ? 1 : 0,
			error,
			this.#now(),
		);
	}

	#enqueue(action: Action): void {
		const ticketId = "ticketId" in action.payload ? action.payload.ticketId : null;
		this.#run(
			`INSERT INTO actions (id, seq, kind, payload, ticket_id, status, next_attempt_at, created_at)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
			this.#id("act"),
			this.#nextSeq(),
			action.kind,
			JSON.stringify(action.payload),
			ticketId,
			this.#now(),
			this.#now(),
		);
	}

	#nextSeq(): number {
		return this.#get("UPDATE sequence SET value = value + 1 WHERE id = 1 RETURNING value").value;
	}

	#id(prefix: string): string {
		return `${prefix}_${randomUUID()}`;
	}

	#now(): number {
		return this.#clock.now();
	}

	#tx<T>(fn: () => T): T {
		return inTransaction(this.#db, fn);
	}

	#get(sql: string, ...params: SQLInputValue[]): Row | undefined {
		return this.#db.prepare(sql).get(...params) as Row | undefined;
	}

	#all(sql: string, ...params: SQLInputValue[]): Row[] {
		return this.#db.prepare(sql).all(...params) as Row[];
	}

	#column(sql: string, ...params: SQLInputValue[]): string[] {
		return this.#all(sql, ...params).map((r) => r.v as string);
	}

	#run(sql: string, ...params: SQLInputValue[]) {
		return this.#db.prepare(sql).run(...params);
	}
}
