import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Kernel } from "../kernel/kernel.ts";
import type { Basis, ReportStatus, TicketInput } from "../kernel/types.ts";
import { REPORT_STATUSES } from "../kernel/types.ts";
import type { ModelSelector } from "../model-selector.ts";
import { formatModelRef, type ModelRef } from "../models.ts";
import { INPUT_LABEL } from "../client/board-format.mjs";
import { parseOptions } from "../kernel/question.ts";
import type { Member } from "../teams.ts";
import { canCode, memberTools } from "../worker/tools.ts";
import { DispatchDesk, memberSessionDir, parseDispatch, type DispatchResult, type Dispatching, type MemberRun } from "./dispatch.ts";

export interface WorkerSpec {
	ticketId: string;
	sessionId: string;
	workdir: string;
	basis: Basis;
	ruleId: string | null;
	/** The members this helper may dispatch to. Empty: it works alone. */
	crew: readonly Member[];
	token: string;
	model: ModelRef;
}

export interface WorkerEvents {
	turnStarted(): void;
	toolCalled(): void;
	usage(u: { provider: string; tokensIn: number; tokensOut: number }): void;
	settled(error?: string): void;
	exited(): void;
	transcript(event: unknown): void;
}

export interface WorkerHandle {
	readonly model: string;
	isStreaming(): boolean;
	setModel(model: ModelRef): Promise<void>;
	deliver(text: string): Promise<void>;
	stop(): Promise<void>;
}

export interface WorkerSpawner {
	spawn(spec: WorkerSpec, events: WorkerEvents): Promise<WorkerHandle>;
	/** Runs one dispatch as a one-shot member process. A spawner without it cannot host a team. */
	runMember?(run: MemberRun): Promise<string>;
}

export function formatInputs(kernel: Kernel, inputs: TicketInput[]): string {
	return inputs
		.map((input) => {
			const found = input.triggerId ? kernel.read(input.triggerId) : undefined;
			const meta = found?.type === "trigger" ? ` ${found.trigger.id} · 来源 ${found.trigger.source} · 发出者 ${found.trigger.sender}` : "";
			return `[${INPUT_LABEL[input.kind]}]${meta}\n${input.body}`;
		})
		.join("\n\n");
}

interface Live {
	handle: WorkerHandle;
	token: string;
	bgRunning: number;
	stopping: boolean;
	crew: readonly Member[];
}

export interface DispatchOptions {
	/** The members a team's helper may dispatch to; undefined when the team is not in the roster. */
	crewOf(team: string): readonly Member[] | undefined;
	/** One dispatch's limit for a member that cannot write, edit or run commands in the ticket; also the longest wait for a slot. */
	timeoutMs: number;
	/** One dispatch's limit for a member that can. */
	codingTimeoutMs: number;
	/** A running member with no event of any kind for this long is ended. */
	stallMs: number;
	maxConcurrent: number;
}

export interface WorkerExecutorOptions {
	kernel: Kernel;
	spawner: WorkerSpawner;
	stateDir: string;
	afterCommand: () => void;
	onTranscript?: (ticketId: string, event: unknown) => void;
	onError?: (ticketId: string, error: unknown) => void;
	models: WorkerModels;
	lookup?: (source: string, op: string, args: unknown) => Promise<unknown>;
	/** Without it every helper works alone. */
	dispatch?: DispatchOptions;
}

export interface WorkerModels {
	selector: ModelSelector;
	fallbackDailyTokens: number;
}

export class WorkerExecutor {
	readonly #o: WorkerExecutorOptions;
	readonly #live = new Map<string, Live>();
	readonly #spawning = new Map<string, Promise<Live | undefined>>();
	#shuttingDown = false;
	readonly #desk: DispatchDesk | undefined;
	readonly #teamless = new Set<string>();

	constructor(options: WorkerExecutorOptions) {
		this.#o = options;
		const { dispatch, spawner } = options;
		if (dispatch && spawner.runMember) {
			this.#desk = new DispatchDesk({ queueTimeoutMs: dispatch.timeoutMs, stallMs: dispatch.stallMs, maxConcurrent: dispatch.maxConcurrent, run: (run) => spawner.runMember!(run), onChange: options.afterCommand });
		}
	}

	dispatching(): Dispatching {
		return this.#desk?.live() ?? {};
	}

	liveCount(): number {
		return this.#live.size;
	}

	async wake(ticketId: string): Promise<void> {
		const { kernel } = this.#o;
		const ticket = kernel.getTicket(ticketId);
		if (!ticket || ticket.stoppedAt !== null) return;
		const current = this.#live.get(ticketId);
		if (current?.stopping) return;
		const live = current ?? (await this.#start(ticketId));
		if (!live) return;
		const inputs = kernel.pendingInputs(ticketId);
		if (inputs.length === 0) return;
		if (this.#capReached()) {
			this.#blockForCap(ticketId);
			await this.stop(ticketId);
			return;
		}
		if (current && !live.handle.isStreaming()) {
			const choice = this.#o.models.selector.forTurn();
			if (formatModelRef(choice.model) !== live.handle.model) await this.#switchModel(ticketId, live, choice.model, choice.fellBack);
		}
		await live.handle.deliver(formatInputs(kernel, inputs));
		kernel.markInputsDelivered(ticketId, inputs.map((i) => i.id));
	}

	async stop(ticketId: string): Promise<void> {
		const live = this.#live.get(ticketId);
		if (live) live.stopping = true;
		// The helper goes first: a member stopped while its helper still runs would hand it a result to act on.
		try {
			await live?.handle.stop();
		} finally {
			await this.#desk?.end(ticketId);
		}
	}

	// On host shutdown the kernel keeps the running state so restart recovery re-wakes these tickets.
	async shutdown(): Promise<void> {
		this.#shuttingDown = true;
		await Promise.all([...this.#live.keys()].map((id) => this.stop(id)));
		await this.#desk?.endAll();
	}

	#start(ticketId: string): Promise<Live | undefined> {
		const existing = this.#spawning.get(ticketId);
		if (existing) return existing;
		const started = this.#spawn(ticketId).finally(() => this.#spawning.delete(ticketId));
		this.#spawning.set(ticketId, started);
		return started;
	}

	async #spawn(ticketId: string): Promise<Live | undefined> {
		const { kernel, spawner, stateDir, afterCommand } = this.#o;
		const choice = this.#o.models.selector.forTurn();
		if (choice.fellBack && this.#capReached()) {
			this.#blockForCap(ticketId);
			afterCommand();
			return undefined;
		}
		if (!kernel.claimSlot(ticketId)) return undefined;
		const ticket = kernel.getTicket(ticketId)!;
		const workdir = join(stateDir, "workers", ticketId);
		mkdirSync(workdir, { recursive: true });
		const token = randomUUID();
		const guard = (fn: () => void) => () => {
			try {
				fn();
			} catch (error) {
				this.#o.onError?.(ticketId, error);
			}
			afterCommand();
		};
		let live: Live | undefined;
		const events: WorkerEvents = {
			turnStarted: guard(() => kernel.claimSlot(ticketId)),
			toolCalled: guard(() => kernel.recordWorkerProgress(ticketId)),
			usage: (u) => guard(() => kernel.recordUsage(ticketId, u))(),
			settled: (error) => void this.#onSettled(ticketId, live, error).catch((e) => this.#o.onError?.(ticketId, e)).finally(afterCommand),
			exited: guard(() => {
				void this.#desk?.end(ticketId);
				this.#live.delete(ticketId);
				if (this.#shuttingDown) return;
				if (live && !live.stopping) kernel.workerReport(ticketId, { status: "failed", summary: "Worker 进程在一轮中途意外退出。" });
				kernel.workerExited(ticketId);
			}),
			transcript: (event) => this.#o.onTranscript?.(ticketId, event),
		};
		const crew = this.#crewOf(ticketId, ticket.team);
		let handle: WorkerHandle;
		try {
			handle = await spawner.spawn(
				{ ticketId, sessionId: ticket.workerSessionId, workdir, basis: ticket.basis, ruleId: ticket.ruleId, crew, token, model: choice.model },
				events,
			);
		} catch (error) {
			kernel.workerExited(ticketId);
			afterCommand();
			throw error;
		}
		live = { handle, token, bgRunning: 0, stopping: false, crew };
		this.#live.set(ticketId, live);
		if (kernel.getTicket(ticketId)?.stoppedAt != null) {
			await this.stop(ticketId);
			return undefined;
		}
		kernel.workerStarted(ticketId, { model: handle.model, fellBack: choice.fellBack });
		return live;
	}

	async #onSettled(ticketId: string, live: Live | undefined, error: string | undefined): Promise<void> {
		const { kernel } = this.#o;
		const models = this.#o.models;
		if (live && !live.stopping) {
			if (error) {
				const result = models.selector.onError(error);
				if (result.switched && result.notify) {
					kernel.notifyRouter(`Worker 的主模型额度用尽或被限流，已切到回退模型 ${formatModelRef(models.selector.current().model)}。请用一句话告诉使用者。`);
				}
			} else {
				models.selector.onSuccess();
			}
			const current = models.selector.current();
			if (this.#capReached()) {
				this.#blockForCap(ticketId);
			} else if (error && current.fellBack && live.handle.model !== formatModelRef(current.model)) {
				await this.#switchModel(ticketId, live, current.model, true);
				await live.handle.deliver("[通知] 上一轮因模型额度或限流中断，已切换到回退模型。请从中断处继续。");
				return;
			} else if (error) {
				kernel.workerReport(ticketId, { status: "failed", summary: `Worker 这一轮因模型错误中断：${error}` });
			}
		}
		kernel.workerTurnEnded(ticketId, { bgRunning: (live?.bgRunning ?? 0) > 0 });
		const after = kernel.getTicket(ticketId);
		if (live && !live.stopping && after && (after.workerState === "idle" || after.stoppedAt !== null)) {
			live.stopping = true;
			void live.handle.stop();
		}
	}

	async #switchModel(ticketId: string, live: Live, model: ModelRef, fellBack: boolean): Promise<void> {
		await live.handle.setModel(model);
		this.#o.kernel.workerStarted(ticketId, { model: formatModelRef(model), fellBack });
	}

	#capReached(): boolean {
		const { selector, fallbackDailyTokens } = this.#o.models;
		const current = selector.current();
		return current.fellBack && this.#o.kernel.usageToday(current.model.provider) >= fallbackDailyTokens;
	}

	#blockForCap(ticketId: string): void {
		const { kernel, models } = this.#o;
		kernel.blockForCap(
			ticketId,
			`回退模型 ${formatModelRef(models.selector.current().model)} 今日用量已达上限（${models.fallbackDailyTokens} token），等主模型恢复或明天再继续。`,
		);
	}

	handleRequest(ticketId: string, token: string, method: string, params: unknown): unknown {
		const live = this.#live.get(ticketId);
		const member = live !== undefined && live.token !== token && this.#desk?.holds(ticketId, token) === true;
		if (!live || (live.token !== token && !member)) throw new Error("未知的 Worker 或令牌不符");
		if (member && method !== "worker.lookup") throw new Error("成员只能经宿主查数据（lookup），不能汇报、交回、读任务或再派活");
		const { kernel, afterCommand } = this.#o;
		const p = (params ?? {}) as Record<string, unknown>;
		try {
			switch (method) {
				case "worker.report": {
					const status = p.status as ReportStatus;
					if (!REPORT_STATUSES.includes(status)) throw new Error(`未知的汇报状态 ${String(p.status)}`);
					if (typeof p.summary !== "string" || !p.summary.trim()) throw new Error("汇报需要 summary");
					const question = typeof p.question === "string" && p.question.trim() ? p.question : undefined;
					const result = kernel.workerReport(ticketId, {
						status,
						summary: p.summary,
						question,
						options: parseOptions(p.options, question),
						drafts: Array.isArray(p.drafts) ? p.drafts : undefined,
						waiting: p.waiting === true,
					});
					return { recorded: true, ...result };
				}
				case "worker.hand_back":
					if (typeof p.body !== "string") throw new Error("交回需要 body");
					kernel.workerHandBack(ticketId, { body: p.body });
					return { handedBack: true };
				case "worker.read":
					return this.#readForWorker(ticketId, typeof p.id === "string" ? p.id : undefined);
				case "worker.lookup":
					if (!this.#o.lookup) throw new Error("没有可查询的来源");
					return this.#o.lookup(String(p.source), String(p.op), p.args);
				case "worker.dispatch":
					return this.#dispatch(ticketId, live, params);
				case "worker.bg":
					live.bgRunning = Number(p.running) || 0;
					return { ok: true };
				default:
					throw new Error(`未知方法 ${method}`);
			}
		} finally {
			afterCommand();
		}
	}

	#crewOf(ticketId: string, team: string): readonly Member[] {
		if (!this.#desk) return [];
		const crew = this.#o.dispatch!.crewOf(team);
		if (crew) return crew;
		if (!this.#teamless.has(ticketId)) {
			this.#teamless.add(ticketId);
			this.#o.onError?.(ticketId, `团队「${team}」已不在名册里，这个任务按单个助手运行，不能派活`);
		}
		return [];
	}

	// A member reports no outcome to the selector, so it must not start a probe or ride on the helper's.
	#memberModel(member: Member): { model: ModelRef; onFallback: boolean } {
		const { selector } = this.#o.models;
		const steady = selector.steady();
		if (steady.fellBack || !member.model) return { model: steady.model, onFallback: steady.fellBack };
		return { model: member.model, onFallback: formatModelRef(member.model) === formatModelRef(selector.fallback) };
	}

	#dispatch(ticketId: string, live: Live, params: unknown): Promise<DispatchResult> {
		if (!this.#desk || live.crew.length === 0) throw new Error("这个任务的团队没有可派的成员");
		if (live.stopping) throw new Error("任务已停止");
		const { member, task, callId } = parseDispatch(params, live.crew);
		const { model, onFallback } = this.#memberModel(member);
		if (onFallback && this.#o.kernel.usageToday(model.provider) >= this.#o.models.fallbackDailyTokens) {
			throw new Error(`回退模型 ${formatModelRef(model)} 今日用量已达上限，这次不能派活`);
		}
		const { kernel, stateDir, afterCommand } = this.#o;
		const { basis } = kernel.getTicket(ticketId)!;
		const { timeoutMs, codingTimeoutMs } = this.#o.dispatch!;
		return this.#desk.dispatch({
			ticketId, callId, member, task, basis,
			limitMs: canCode(memberTools(basis, member.tools)) ? codingTimeoutMs : timeoutMs,
			model,
			workdir: join(stateDir, "workers", ticketId),
			sessionDir: memberSessionDir(stateDir, ticketId, member.name),
			onUsage: (u) => {
				try {
					kernel.recordUsage(ticketId, u);
				} catch (error) {
					this.#o.onError?.(ticketId, error);
				}
				afterCommand();
			},
			// A helper waiting on a member makes no tool call of its own; the member's activity is the ticket's progress.
			onProgress: () => {
				try {
					kernel.recordMemberProgress(ticketId);
				} catch (error) {
					this.#o.onError?.(ticketId, error);
				}
			},
		});
	}

	#readForWorker(ticketId: string, id: string | undefined): unknown {
		const { kernel } = this.#o;
		const own = kernel.read(ticketId);
		if (own?.type !== "ticket") throw new Error(`找不到任务 ${ticketId}`);
		if (!id || id === ticketId) return own;
		const target = kernel.read(id);
		const allowed =
			(target?.type === "thread" && own.threadIds.includes(id)) ||
			(target?.type === "trigger" &&
				(target.threadIds.some((t) => own.threadIds.includes(t)) || own.recentInputs.some((i) => i.triggerId === id)));
		if (!allowed) throw new Error(`${id} 不属于本任务，读不到`);
		return target;
	}
}
