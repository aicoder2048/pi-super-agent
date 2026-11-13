import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Kernel } from "../kernel/kernel.ts";
import type { Basis, Quote, ReportStatus, Ticket, TicketInput, WorkerReport, WriteCheck } from "../kernel/types.ts";
import { REPORT_STATUSES } from "../kernel/types.ts";
import type { ModelSelector } from "../model-selector.ts";
import { formatModelRef, type ModelRef } from "../models.ts";
import { INPUT_LABEL, quoteContext } from "../client/board-format.mjs";
import { parseOptions } from "../kernel/question.ts";
import type { Usage } from "./worker-events.ts";
import { NO_DOMAIN, type DomainKit, type Domains } from "../modules.ts";
import { refusalText } from "../modules/gateway.ts";
import type { ComponentName, Digest, ModuleName } from "../modules/manifest.ts";
import type { Alert, Gateway, Json, Query, Request, WorkerCaller } from "../modules/protocol.ts";
import type { Member } from "../teams.ts";
import type { TranscriptMessage } from "../client/protocol.ts";
import { canCode, isRooted, memberTools, profileOf, type Profile } from "../worker/tools.ts";
import { realRoots } from "../worker/read-roots.ts";
import type { OutputRoot } from "./output.ts";
import { DispatchDesk, memberSessionDir, parseDispatch, type DispatchResult, type Dispatching, type MemberLimit, type MemberRun } from "./dispatch.ts";

const MEMBER_METHODS = ["worker.lookup", "worker.read_web", "worker.domain_tool", "worker.knowledge", "worker.data"];

const TAGS: Record<Request["kind"], string> = { tool: "[模块工具]", knowledge: "[模块知识]", data: "[模块数据]", watch: "[提醒条件]" };

/** The `data` tool's arguments as a gateway request. `list` is a query with no conditions. */
function dataRequest(p: Record<string, unknown>): Request {
	const collection = String(p.collection ?? "") as ComponentName;
	const refuse = (note: string) => new Error(`${TAGS.data} ${refusalText({ code: "bad-input", note })}`);
	if (p.op === "write") {
		if (!Array.isArray(p.rows)) throw refuse("write 要给 rows：要写的行组成的数组");
		return { kind: "data", collection, op: "write", rows: p.rows as Json[], from: typeof p.from === "string" ? p.from : "" };
	}
	const limit: Query = typeof p.limit === "number" ? { limit: p.limit } : {};
	if (p.op === "list") return { kind: "data", collection, op: "query", query: limit };
	if (p.op !== "query") throw refuse(`op 只能是 list、query 或 write，收到 ${JSON.stringify(p.op)}`);
	const query: Query = {
		...limit,
		...(p.where !== null && typeof p.where === "object" && { where: p.where as Query["where"] }),
		...(typeof p.since === "string" && { since: p.since }),
		...(typeof p.until === "string" && { until: p.until }),
	};
	return { kind: "data", collection, op: "query", query };
}

function watchRequest(p: Record<string, unknown>): Request {
	const collection = String(p.collection ?? "") as ComponentName;
	if (p.op === "set") return { kind: "watch", collection, op: "set", watch: { key: p.key, condition: p.condition, note: p.note, id: p.id } as never };
	if (p.op === "remove") return { kind: "watch", collection, op: "remove", id: String(p.id ?? "") };
	return { kind: "watch", collection, op: "list" };
}

const HEARD = { trigger: "收到过来源发来的内容", note: "收到过幕僚长的备注", web: "读过网页" } as const;

export interface WorkerSpec extends DomainKit {
	ticketId: string;
	sessionId: string;
	workdir: string;
	/** Beside `profile` because `prepare` and `tripwire` go by basis: an inference ticket runs no `prepare`, only a request ticket gets `tripwire`. */
	basis: Basis;
	profile: Profile;
	readRoots: readonly string[];
	token: string;
	model: ModelRef;
	resume: boolean;
	/** The output rule, for a helper that can write files. */
	outputRule?: string;
	/** The module tools this helper may call, one line each. Absent: it has no `domain_tool`. */
	domainTools?: string;
	knowledge?: string;
	/** The module's collections this helper may read and write, one line each. Absent: it has no `data`. */
	data?: string;
	/** The watched series this helper may list or set conditions on, one line each. Absent: it has no `watch`. */
	watch?: string;
}

export interface WorkerEvents {
	turnStarted(): void;
	toolCalled(): void;
	usage(u: Usage): void;
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

export function quoteSuffix(kernel: Kernel, quote: Quote | null): string {
	return quote ? `\n${quoteContext(quote, quote.ticketId ? kernel.ticketName(quote.ticketId) : undefined)}` : "";
}

export function formatInputs(kernel: Kernel, inputs: TicketInput[]): string {
	return inputs
		.map((input) => {
			const found = input.triggerId ? kernel.read(input.triggerId) : undefined;
			const meta = found?.type === "trigger" ? ` ${found.trigger.id} · 来源 ${found.trigger.source} · 发出者 ${found.trigger.sender}` : "";
			return `[${INPUT_LABEL[input.kind]}]${meta}\n${input.body}${quoteSuffix(kernel, found?.type === "trigger" ? found.quote : null)}`;
		})
		.join("\n\n");
}

interface Live {
	handle: WorkerHandle;
	token: string;
	bgRunning: number;
	stopping: boolean;
	crew: readonly Member[];
	profile: Profile;
	readRoots: readonly string[];
}

export interface DispatchOptions {
	/** One dispatch's limit for a member that cannot write, edit or run commands in the ticket; also the longest wait for a slot. */
	timeoutMs: number;
	/** One dispatch's limit for a member that can. */
	codingTimeoutMs: number;
	/** A running member with no event of any kind for this long is ended. */
	stallMs: number;
	/** `maxConcurrentExperts`: the cap until the user raises it for a day. */
	maxConcurrent: number;
}

export type DeskDispatchOptions = Omit<DispatchOptions, "maxConcurrent"> & { cap: MemberLimit };

export interface WorkerExecutorOptions {
	kernel: Kernel;
	spawner: WorkerSpawner;
	stateDir: string;
	output: OutputRoot;
	afterCommand: () => void;
	onTranscript?: (ticketId: string, event: unknown) => void;
	/** One message of a member at work on dispatch `callId`; `index` is its place among that dispatch's messages. */
	onMemberTranscript?: (ticketId: string, member: { callId: string; index: number }, message: TranscriptMessage) => void;
	onError?: (ticketId: string, error: unknown) => void;
	models: WorkerModels;
	lookup?: (source: string, op: string, args: unknown) => Promise<unknown>;
	tripwires?: (source: string, op: string, args: unknown) => unknown;
	/** The lookup by a ticket's domain and pinned version. Without it every ticket runs as if it had no domain. */
	kitFor?: Domains["kitFor"];
	/** Without it every helper works alone. */
	dispatch?: DeskDispatchOptions;
	gateway?: Gateway;
	alert?: (module: ModuleName, alert: Alert) => void;
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
	readonly #domainless = new Set<string>();

	constructor(options: WorkerExecutorOptions) {
		this.#o = options;
		const { dispatch, spawner } = options;
		if (dispatch && spawner.runMember) {
			this.#desk = new DispatchDesk({ queueTimeoutMs: dispatch.timeoutMs, stallMs: dispatch.stallMs, cap: dispatch.cap, run: (run) => spawner.runMember!(run), onChange: options.afterCommand });
		}
	}

	dispatching(): Dispatching {
		return this.#desk?.live() ?? {};
	}

	membersWaitingForSlot(): number {
		return this.#desk?.waitingForSlot() ?? 0;
	}

	/** Starts the waiting members that fit; call it after the member cap went up. */
	recheckMemberSlots(): void {
		this.#desk?.recheck();
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
		const resume = kernel.getTicket(ticketId)?.startedAt != null;
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
				if (live && !live.stopping) this.#report(ticketId, { status: "failed", summary: "Worker 进程在一轮中途意外退出。" });
				kernel.workerExited(ticketId);
			}),
			transcript: (event) => this.#o.onTranscript?.(ticketId, event),
		};
		const kit = this.#kitFor(ticketId, ticket);
		const catalogue = this.#catalogue(ticketId, null);
		const profile = profileOf(ticket.basis, kernel.openedBySource(ticketId));
		const readRoots = realRoots([workdir, kit.knowledgeDir, kit.skillsDir, ...kit.crew.flatMap((m) => m.skills)].filter((d) => d !== undefined));
		let handle: WorkerHandle;
		try {
			handle = await spawner.spawn(
				{ ticketId, sessionId: ticket.workerSessionId, workdir, basis: ticket.basis, profile, readRoots, ...kit, token, model: choice.model, resume, ...(!isRooted(profile) && { outputRule: this.#o.output.prompt("helper") }), ...catalogue },
				events,
			);
		} catch (error) {
			kernel.workerExited(ticketId);
			afterCommand();
			throw error;
		}
		live = { handle, token, bgRunning: 0, stopping: false, crew: kit.crew, profile, readRoots };
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
				this.#report(ticketId, { status: "failed", summary: `Worker 这一轮因模型错误中断：${error}` });
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
			this.#checkWrites(ticketId),
		);
	}

	handleRequest(ticketId: string, token: string, method: string, params: unknown): unknown {
		const live = this.#live.get(ticketId);
		const holder = live !== undefined && live.token !== token ? this.#desk?.holder(ticketId, token) : undefined;
		if (!live || (live.token !== token && !holder)) throw new Error("未知的 Worker 或令牌不符");
		if (holder && !MEMBER_METHODS.includes(method)) throw new Error("成员只能经宿主查数据（lookup）、调模块工具（domain_tool）、查模块知识（knowledge）和读写模块数据（data），不能汇报、交回、读任务或再派活");
		const { kernel, afterCommand } = this.#o;
		const p = (params ?? {}) as Record<string, unknown>;
		try {
			switch (method) {
				case "worker.report": {
					const status = p.status as ReportStatus;
					if (!REPORT_STATUSES.includes(status)) throw new Error(`未知的汇报状态 ${String(p.status)}`);
					if (typeof p.summary !== "string" || !p.summary.trim()) throw new Error("汇报需要 summary");
					const question = typeof p.question === "string" && p.question.trim() ? p.question : undefined;
					const result = this.#report(ticketId, {
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
					return kernel.workerRead(ticketId, typeof p.id === "string" ? p.id : undefined);
				case "worker.lookup":
					if (!this.#mayLookup(ticketId, live.profile, holder)) throw new Error("这项任务里不能用 lookup：任务的领域没有在 module.json 的 tools 里开 lookup，或这位成员的 tools 没写 lookup");
					if (!this.#o.lookup) throw new Error("没有可查询的来源");
					return this.#o.lookup(String(p.source), String(p.op), p.args);
				case "worker.domain_tool":
					return this.#gatewayCall(ticketId, holder?.name ?? null, { kind: "tool", name: String(p.name) as ComponentName, input: (p.input ?? {}) as Json });
				case "worker.knowledge":
					return this.#gatewayCall(ticketId, holder?.name ?? null, { kind: "knowledge", op: "search", query: String(p.query ?? "") });
				case "worker.data":
					return this.#gatewayCall(ticketId, holder?.name ?? null, dataRequest(p));
				case "worker.watch":
					return this.#gatewayCall(ticketId, null, watchRequest(p));
				case "worker.read_web":
					kernel.readWeb(ticketId);
					return { recorded: true };
				case "worker.tripwire": {
					const refusal = this.#tripwireRefusal(ticketId);
					if (refusal) throw new Error(refusal);
					if (!this.#o.tripwires) throw new Error("没有可改盯盘条件的来源");
					return this.#o.tripwires(String(p.source), String(p.op), p.args);
				}
				case "worker.new_app":
					if (kernel.getTicket(ticketId)!.basis === "inference") throw new Error("推断开的任务只读，不能开应用");
					return this.#o.output.newApp(ticketId, p.short);
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

	/** Every report a worker makes or the host makes for it. One that reaches the Router carries the host's check of writes outside the output root. */
	#report(ticketId: string, report: WorkerReport): { reportId: string } {
		const { kernel } = this.#o;
		const reachesRouter = report.question !== undefined || report.status !== "progress";
		const writes = reachesRouter ? this.#checkWrites(ticketId) : undefined;
		return kernel.workerReport(ticketId, { ...report, ...(writes && { writes }) });
	}

	#checkWrites(ticketId: string): WriteCheck {
		const { kernel, output } = this.#o;
		return output.checkWrites(kernel.getTicket(ticketId)!, kernel.writeScan(ticketId));
	}

	#mayLookup(ticketId: string, profile: Profile, holder: Member | undefined): boolean {
		const ticket = this.#o.kernel.getTicket(ticketId)!;
		return holder ? memberTools(profile, holder.tools).includes("lookup") : this.#kitFor(ticketId, ticket).granted.includes("lookup");
	}

	/** Assembled at each call: `heardOthers` changes while the ticket runs. */
	#callerOf(ticketId: string, member: string | null): WorkerCaller | undefined {
		const { kernel } = this.#o;
		const { domain, moduleDigest, basis } = kernel.getTicket(ticketId)!;
		if (domain === null || moduleDigest === null) return undefined;
		const pin = { module: domain as ModuleName, digest: moduleDigest as Digest };
		return { who: "worker", ticket: ticketId, pin, basis, member, heardOthers: kernel.heardOtherThanUser(ticketId) !== undefined };
	}

	#catalogue(ticketId: string, member: string | null): { domainTools?: string; knowledge?: string; data?: string; watch?: string } {
		const caller = this.#callerOf(ticketId, member);
		const entries = caller && this.#o.gateway ? this.#o.gateway.catalogue(caller) : [];
		const lines = (kind: Request["kind"]) => entries.filter((e) => e.request === kind).map((e) => `${e.name} · ${e.title}：${e.help}`);
		const tools = lines("tool");
		const knowledge = entries.find((e) => e.request === "knowledge");
		const data = lines("data");
		const watch = member === null ? lines("watch") : [];
		return { ...(tools.length && { domainTools: tools.join("\n") }), ...(knowledge && { knowledge: knowledge.help }), ...(data.length && { data: data.join("\n") }), ...(watch.length && { watch: watch.join("\n") }) };
	}

	async #gatewayCall(ticketId: string, member: string | null, request: Request): Promise<Json> {
		const tag = TAGS[request.kind];
		const caller = this.#callerOf(ticketId, member);
		if (!caller || !this.#o.gateway) throw new Error(`${tag} 这个任务不属于模块包，没有模块的工具和知识可用`);
		const reply = await this.#o.gateway.call(caller, request);
		if (!reply.ok) throw new Error(`${tag} ${refusalText(reply.refusal)}`);
		if (reply.private) this.#o.kernel.touchPrivate(ticketId);
		for (const alert of reply.alerts ?? []) this.#o.alert?.(caller.pin.module, alert);
		return reply.output;
	}

	#tripwireRefusal(ticketId: string): string | undefined {
		const { kernel } = this.#o;
		const ticket = kernel.getTicket(ticketId)!;
		const { basis } = ticket;
		if (basis !== "request") return `只有使用者在对话里开的任务能改盯盘条件，这个任务是${basis === "rule" ? "规则" : "推断"}开的。请在汇报里告诉使用者：在对话里再说一次要怎么改。`;
		const heard = kernel.heardOtherThanUser(ticketId);
		if (heard) return `这个任务${HEARD[heard]}，不能再改盯盘条件，免得其中夹带的话被当成使用者的意思。请在汇报里请使用者在对话里重新说一次，会新开一个任务来改。`;
		if (!this.#kitFor(ticketId, ticket).granted.includes("tripwire")) return "这个任务的领域没有在 module.json 的 tools 里开 tripwire，不能改盯盘条件。";
		return undefined;
	}

	#kitFor(ticketId: string, { domain, moduleDigest }: Pick<Ticket, "domain" | "moduleDigest">): DomainKit {
		if (domain === null) return NO_DOMAIN;
		const kit = this.#o.kitFor?.(domain, moduleDigest);
		if (kit) return this.#desk ? kit : { ...kit, crew: [] };
		if (!this.#domainless.has(ticketId)) {
			this.#domainless.add(ticketId);
			this.#o.onError?.(ticketId, `领域「${domain}」的模块已不在，这个任务按没有领域的单个助手继续，没有这个领域的技能，也不能派活`);
		}
		return NO_DOMAIN;
	}

	// A member reports no outcome to the selector, so it must not start a probe or ride on the helper's.
	#memberModel(member: Member): { model: ModelRef; onFallback: boolean } {
		const { selector } = this.#o.models;
		const steady = selector.steady();
		if (steady.fellBack || !member.model) return { model: steady.model, onFallback: steady.fellBack };
		return { model: member.model, onFallback: member.model.provider === selector.fallback.provider };
	}

	#dispatch(ticketId: string, live: Live, params: unknown): Promise<DispatchResult> {
		if (!this.#desk || live.crew.length === 0) throw new Error("这个任务的领域没有可派的成员");
		if (live.stopping) throw new Error("任务已停止");
		const { member, task, callId } = parseDispatch(params, live.crew);
		const { model, onFallback } = this.#memberModel(member);
		const { kernel, stateDir, afterCommand, models } = this.#o;
		const refusal = () => {
			if (!onFallback || kernel.usageToday(model.provider) < models.fallbackDailyTokens) return undefined;
			const [fallback, own] = [formatModelRef(models.selector.fallback), formatModelRef(model)];
			return `回退模型 ${fallback} 今日用量已达上限，这次不能派活${own === fallback ? "" : `（成员的模型 ${own} 和它同属 ${model.provider}，用量一起计）`}`;
		};
		const refused = refusal();
		if (refused !== undefined) throw new Error(refused);
		kernel.recordDispatch(ticketId, member.title);
		const { profile, readRoots } = live;
		const { timeoutMs, codingTimeoutMs } = this.#o.dispatch!;
		const codes = canCode(memberTools(profile, member.tools));
		const catalogue = this.#catalogue(ticketId, member.name);
		return this.#desk.dispatch({
			ticketId, callId, member, task, profile, readRoots,
			limitMs: codes ? codingTimeoutMs : timeoutMs,
			...(codes && { outputRule: this.#o.output.prompt("member") }),
			...catalogue,
			model,
			refusal,
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
			onMessage: (message, index) => this.#o.onMemberTranscript?.(ticketId, { callId, index }, message),
			onProgress: () => {
				try {
					kernel.recordMemberProgress(ticketId);
				} catch (error) {
					this.#o.onError?.(ticketId, error);
				}
			},
		});
	}
}
