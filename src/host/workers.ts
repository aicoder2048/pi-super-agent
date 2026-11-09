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
import { DEFAULT_LEAD } from "../kernel/types.ts";
import { askOne, consultText, parseConsult, type ConsultQuestion, type ConsultResult, type ExpertAsk } from "./consult.ts";

export interface WorkerSpec {
	ticketId: string;
	sessionId: string;
	workdir: string;
	basis: Basis;
	ruleId: string | null;
	role: string;
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
	/** Runs one consult question as a one-shot expert. A spawner without it cannot host consults. */
	ask?(a: ExpertAsk): Promise<string>;
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

interface LiveExpert {
	title: string;
	token: string;
}

interface Live {
	handle: WorkerHandle;
	token: string;
	bgRunning: number;
	stopping: boolean;
	/** Aborts every expert this lead is consulting; fired by a stop, a shutdown or the lead's exit. */
	abort: AbortController;
	experts: Set<LiveExpert>;
	consults: Set<Promise<unknown>>;
}

export interface ConsultOptions {
	/** Expert role name → title. */
	experts: ReadonlyMap<string, string>;
	timeoutMs: number;
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
	/** Lead role names; without it only the built-in deputy leads. */
	leads?: ReadonlyMap<string, string>;
	consult?: ConsultOptions;
}

export interface WorkerModels {
	selector: ModelSelector;
	fallbackDailyTokens: number;
	/** A role's own model, used instead of the worker primary until the selector falls back. */
	roleModel?: (role: string) => ModelRef | undefined;
}

export class WorkerExecutor {
	readonly #o: WorkerExecutorOptions;
	readonly #live = new Map<string, Live>();
	readonly #spawning = new Map<string, Promise<Live | undefined>>();
	#shuttingDown = false;

	constructor(options: WorkerExecutorOptions) {
		this.#o = options;
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
			const choice = this.#forTurn(ticket.role);
			if (formatModelRef(choice.model) !== live.handle.model) await this.#switchModel(ticketId, live, choice.model, choice.fellBack);
		}
		await live.handle.deliver(formatInputs(kernel, inputs));
		kernel.markInputsDelivered(ticketId, inputs.map((i) => i.id));
	}

	async stop(ticketId: string): Promise<void> {
		const live = this.#live.get(ticketId);
		if (!live) return;
		live.stopping = true;
		await this.#endConsults(live);
		await live.handle.stop();
	}

	/** ticketId → titles of the experts answering that lead right now. */
	consulting(): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		for (const [ticketId, live] of this.#live) if (live.experts.size) out[ticketId] = [...live.experts].map((e) => e.title);
		return out;
	}

	async #endConsults(live: Live): Promise<void> {
		live.abort.abort(new Error("任务已停止"));
		await Promise.allSettled(live.consults);
	}

	// On host shutdown the kernel keeps the running state so restart recovery re-wakes these tickets.
	async shutdown(): Promise<void> {
		this.#shuttingDown = true;
		await Promise.all([...this.#live.keys()].map((id) => this.stop(id)));
	}

	#start(ticketId: string): Promise<Live | undefined> {
		const existing = this.#spawning.get(ticketId);
		if (existing) return existing;
		const started = this.#spawn(ticketId).finally(() => this.#spawning.delete(ticketId));
		this.#spawning.set(ticketId, started);
		return started;
	}

	#forTurn(role: string): { model: ModelRef; fellBack: boolean } {
		const choice = this.#o.models.selector.forTurn();
		return choice.fellBack ? choice : { model: this.#o.models.roleModel?.(role) ?? choice.model, fellBack: false };
	}

	// Experts report no outcome to the selector, so they must not start a probe or ride on the lead's.
	#expertModel(role: string): ModelRef {
		const choice = this.#o.models.selector.steady();
		return choice.fellBack ? choice.model : (this.#o.models.roleModel?.(role) ?? choice.model);
	}

	async #spawn(ticketId: string): Promise<Live | undefined> {
		const { kernel, spawner, stateDir, afterCommand } = this.#o;
		const ticket = kernel.getTicket(ticketId)!;
		const choice = this.#forTurn(ticket.role);
		if (choice.fellBack && this.#capReached()) {
			this.#blockForCap(ticketId);
			afterCommand();
			return undefined;
		}
		if (!kernel.claimSlot(ticketId)) return undefined;
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
				if (live) void this.#endConsults(live);
				this.#live.delete(ticketId);
				if (this.#shuttingDown) return;
				if (live && !live.stopping) kernel.workerReport(ticketId, { status: "failed", summary: "Worker 进程在一轮中途意外退出。" });
				kernel.workerExited(ticketId);
			}),
			transcript: (event) => this.#o.onTranscript?.(ticketId, event),
		};
		let handle: WorkerHandle;
		try {
			handle = await spawner.spawn(
				{ ticketId, sessionId: ticket.workerSessionId, workdir, basis: ticket.basis, ruleId: ticket.ruleId, role: ticket.role, token, model: choice.model },
				events,
			);
		} catch (error) {
			kernel.workerExited(ticketId);
			afterCommand();
			throw error;
		}
		live = { handle, token, bgRunning: 0, stopping: false, abort: new AbortController(), experts: new Set(), consults: new Set() };
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
		const expert = live !== undefined && [...live.experts].some((e) => e.token === token);
		if (!live || (live.token !== token && !expert)) throw new Error("未知的 Worker 或令牌不符");
		if (expert && method !== "worker.lookup") throw new Error("专家只能经宿主查数据（lookup），不能汇报、交回或会诊");
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
				case "worker.consult":
					return this.#consult(ticketId, live, params);
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

	async #consult(ticketId: string, live: Live, params: unknown): Promise<ConsultResult> {
		const consult = this.#o.consult;
		const role = this.#o.kernel.getTicket(ticketId)!.role;
		if (!(this.#o.leads ? this.#o.leads.has(role) : role === DEFAULT_LEAD)) throw new Error("只有牵头角色能会诊");
		if (!consult || !this.#o.spawner.ask) throw new Error("这个宿主没有配置会诊");
		const questions = parseConsult(params, consult.experts);
		if (this.#capReached()) throw new Error(`回退模型 ${formatModelRef(this.#o.models.selector.current().model)} 今日用量已达上限，这次不能会诊`);
		const running = Promise.all(questions.map((q) => this.#ask(ticketId, live, q, consult.timeoutMs)));
		live.consults.add(running);
		try {
			const outcomes = await running;
			return { text: consultText(outcomes), details: { kind: "consult", experts: outcomes } };
		} finally {
			live.consults.delete(running);
		}
	}

	async #ask(ticketId: string, live: Live, q: ConsultQuestion, timeoutMs: number) {
		const { kernel, spawner, stateDir, afterCommand } = this.#o;
		const expert: LiveExpert = { title: q.title, token: randomUUID() };
		const model = this.#expertModel(q.expert);
		live.experts.add(expert);
		afterCommand();
		try {
			return await askOne(q, timeoutMs, live.abort.signal, (signal, tally) =>
				spawner.ask!({
					...q, ticketId, token: expert.token, model, workdir: join(stateDir, "workers", ticketId), signal,
					onUsage: (u) => {
						tally(u);
						try {
							kernel.recordUsage(ticketId, u);
						} catch (error) {
							this.#o.onError?.(ticketId, error);
						}
						afterCommand();
					},
				}),
			);
		} finally {
			live.experts.delete(expert);
			afterCommand();
		}
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
