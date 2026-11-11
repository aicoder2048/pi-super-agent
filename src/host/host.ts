import { existsSync, mkdirSync, readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { writeHeartbeat } from "../heartbeat.ts";
import { relocateState } from "./relocate.ts";
import { endLeftoverMembers } from "./member-ledger.ts";
import { WATCHDOG_SOURCE } from "../watchdog/watchdog.ts";
import { join } from "node:path";
import { isCapAskId } from "../kernel/cap-ask.ts";
import { msUntilNextNewYorkDay } from "../kernel/helper-names.ts";
import { Kernel, nextStallAt } from "../kernel/kernel.ts";
import { openStore } from "../kernel/store.ts";
import { CONVERSATION_SOURCE, CONVERSATION_THREAD_ID, DISPOSITIONS, type Clock, type DashboardRow, type Disposition, type HostLine, type HostLinePost, type KernelConfig, type RouterNotice, type SourcePolicy } from "../kernel/types.ts";
import type { TriggerSubmission } from "../kernel/types.ts";
import { GenericSource } from "../sources/generic.ts";
import { TimerSource, type TimerEntry } from "../sources/timer.ts";
import type { Feed, FeedSpec } from "../sources/feeds.ts";
import { Dispatcher } from "./dispatcher.ts";
import { HostServer, type AnswerResult, type Broadcast, type ImChat, type SayOptions } from "./server.ts";
import type { BoardState, Duty, MemberCapBoard, TodayCounts, TranscriptHistory, TranscriptMessage, WatchedSource } from "../client/protocol.ts";
import { readSessionEntries } from "../jsonl.ts";
import { helperSessionDir, memberTranscripts } from "./dispatch.ts";
import { WebGateway } from "./web.ts";
import { loadToken } from "./web-token.ts";
import type { TailnetName } from "./web-hosts.ts";
import { MemberCap } from "./member-cap.ts";
import { ConfigError } from "../config-error.ts";
import { OutputRoot } from "./output.ts";
import { WorkerExecutor, type DispatchOptions, type WorkerModels, type WorkerSpawner } from "./workers.ts";
import type { Domains } from "../modules.ts";
import { TelegramClient, type TelegramOptions } from "./telegram/client.ts";

export interface RouterLike {
	inject(notice: RouterNotice, actionId: string): Promise<void> | void;
	waitForIdle(): Promise<void>;
	dispose(): void;
}

export interface HostDeps {
	kernel: Kernel;
	afterCommand: () => void;
	stateDir: string;
	socketPath: string;
	rulesFor: (triggerSource: string) => string[];
}

export interface HostOptions {
	stateDir: string;
	clock?: Clock;
	config?: Partial<KernelConfig>;
	sourcePolicy?: SourcePolicy;
	ruleAllows?: (ruleId: string, triggerSource: string) => boolean;
	isMarketSource?: (source: string) => boolean;
	/** The loaded modules. Without it no ticket has a domain. */
	domains?: Domains;
	rulesFor?: (triggerSource: string) => string[];
	timers?: TimerEntry[];
	heartbeatMs?: number;
	workerModels: WorkerModels;
	/** Absolute. Defaults to <stateDir>/output. */
	outputDir?: string;
	dispatch?: DispatchOptions;
	createRouter(deps: HostDeps): Promise<RouterLike>;
	createSpawner(deps: HostDeps): WorkerSpawner;
	log?: (line: string) => void;
	webPort?: number;
	webHosts?: readonly TailnetName[];
	watching?: WatchedSource[];
	feeds?: FeedSpec[];
	/** Runs `run` once, `ms` from now, and returns its cancel. The host waits for the New York day change with it; tests pass their own to make that moment arrive. */
	after?: (ms: number, run: () => void) => () => void;
	telegram?: TelegramOptions;
}

const afterRealTime: NonNullable<HostOptions["after"]> = (ms, run) => {
	const timer = setTimeout(run, ms);
	timer.unref();
	return () => clearTimeout(timer);
};


// sun_path holds 104 bytes on macOS and 108 on Linux, including the terminating NUL.
// setTimeout fires at once for a longer delay.
const MAX_TIMER_MS = 2 ** 31 - 1;
const CONVERSATION_LINES = 50;
const SOCKET_PATH_MAX_BYTES = process.platform === "darwin" ? 103 : 107;

function assertSocketPathFits(socketPath: string): void {
	const bytes = Buffer.byteLength(socketPath);
	if (bytes > SOCKET_PATH_MAX_BYTES) {
		throw new ConfigError(
			`状态目录路径太长：socket 路径 ${socketPath} 有 ${bytes} 字节，超过本系统上限 ${SOCKET_PATH_MAX_BYTES}。请把 PSA_STATE_DIR 设到更短的路径（默认 ~/.pi-super-agent）。`,
		);
	}
}

export class Host {
	readonly kernel: Kernel;
	readonly socketPath: string;
	readonly dispatcher: Dispatcher;
	readonly workers: WorkerExecutor;
	readonly server: HostServer;
	router!: RouterLike;
	readonly generic: GenericSource;
	readonly timer: TimerSource;
	readonly feeds: Map<string, Feed>;
	readonly #log: (line: string) => void;
	readonly #stateDir: string;
	#boardTimer: NodeJS.Timeout | undefined;
	#midnightTimer: NodeJS.Timeout | undefined;
	#stallTimer: NodeJS.Timeout | undefined;
	#stallAt: number | null = null;
	#heartbeat: NodeJS.Timeout | undefined;
	#web: WebGateway | undefined;
	readonly #telegram: TelegramClient | undefined;
	readonly #db: DatabaseSync;
	readonly #watching: WatchedSource[];
	readonly #clock: Clock;
	readonly #kitFor: Domains["kitFor"] | undefined;
	readonly #memberCap: MemberCap | undefined;
	readonly #after: NonNullable<HostOptions["after"]>;
	#cancelNewYorkDay: (() => void) | undefined;
	#duty!: Duty;

	private constructor(options: HostOptions) {
		this.socketPath = join(options.stateDir, "host.sock");
		assertSocketPathFits(this.socketPath);
		mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
		this.#log = options.log ?? ((line) => console.error(line));
		if (relocateState(options.stateDir)) this.#log(`[host] 状态目录换了位置，已把会话记录的工作目录改到 ${options.stateDir}`);
		this.#stateDir = options.stateDir;
		const clock = options.clock ?? { now: () => Date.now() };
		this.#clock = clock;
		this.#after = options.after ?? afterRealTime;
		this.#watching = options.watching ?? [];
		this.#kitFor = options.domains?.kitFor;
		this.#db = openStore(join(options.stateDir, "state.db"));
		this.kernel = new Kernel({
			db: this.#db,
			clock,
			sourcePolicy: (trigger) => (trigger.source === WATCHDOG_SOURCE ? "notice" : (options.sourcePolicy?.(trigger) ?? "candidate")),
			ruleAllows: options.ruleAllows,
			isMarketSource: options.isMarketSource,
			domains: options.domains?.book,
			log: this.#log,
			config: options.config,
		});
		const output = new OutputRoot({ root: options.outputDir ?? join(options.stateDir, "output"), stateDir: options.stateDir, ledger: this.kernel });
		output.prepare();
		const submit = (trigger: TriggerSubmission) => {
			this.kernel.submitTrigger(trigger);
			this.#changed();
		};
		this.generic = new GenericSource({ inboxDir: join(options.stateDir, "inbox"), submit, now: clock.now, log: this.#log });
		this.timer = new TimerSource({
			entries: options.timers ?? [],
			submit,
			now: clock.now,
			readCursor: () => {
				const cursor = this.kernel.sourceCursor("timer");
				return cursor === undefined ? undefined : Number(cursor);
			},
			writeCursor: (at) => this.kernel.setSourceCursor("timer", String(at)),
		});
		this.feeds = new Map((options.feeds ?? []).map((spec) => [spec.source, spec.create({
			clock,
			submit,
			readCursor: () => this.kernel.sourceCursor(spec.source),
			writeCursor: (value) => this.kernel.setSourceCursor(spec.source, value),
			post: (line) => this.#postHostLine(spec.source, line),
			raised: (externalId) => this.kernel.raised(spec.source, externalId),
			log: this.#log,
		})]));
		const deps: HostDeps = { kernel: this.kernel, afterCommand: () => this.#changed(), stateDir: options.stateDir, socketPath: this.socketPath, rulesFor: options.rulesFor ?? (() => []) };
		const memberCap = options.dispatch && new MemberCap({ configured: options.dispatch.maxConcurrent, clock, store: this.kernel.capAsks, log: this.#log });
		this.#memberCap = memberCap;
		this.workers = new WorkerExecutor({
			kernel: this.kernel,
			spawner: options.createSpawner(deps),
			stateDir: options.stateDir,
			output,
			afterCommand: deps.afterCommand,
			onTranscript: (ticketId, event) => this.#transcript(ticketId, event),
			onMemberTranscript: (ticketId, member, message) => this.#web?.sendTranscript(ticketId, message, member),
			onError: (ticketId, error) => this.#log(`[worker ${ticketId}] ${String(error)}`),
			models: options.workerModels,
			kitFor: this.#kitFor,
			dispatch: memberCap && { ...options.dispatch!, cap: { limit: () => memberCap.limit(), membersWaiting: (waiting) => this.#askAboutMemberCap(memberCap, waiting) } },
			lookup: async (source, op, args) => {
				const feed = this.feeds.get(source);
				if (!feed) throw new Error(`没有来源 ${source} 可查；可查：${[...this.feeds.keys()].join("、") || "无"}`);
				return feed.lookup(op, args);
			},
		});
		this.dispatcher = new Dispatcher({
			kernel: this.kernel,
			handlers: {
				"router.notify": (notice, actionId) => this.router.inject(notice, actionId),
				"worker.wake": ({ ticketId }) => this.workers.wake(ticketId),
				"worker.stop": ({ ticketId }) => this.workers.stop(ticketId),
				"channel.reply": ({ threadId, text, replyId, ticketId }) => this.#deliverReply(threadId, text, replyId, ticketId),
			},
			onError: (action, error) => this.#log(`[dispatcher] ${action.kind} 失败（第 ${action.attempts + 1} 次）：${String(error)}`),
			// A click the Router saw and did not hand over shows as dropped only once its notice is done.
			onComplete: (action) => action.kind === "router.notify" && this.#changed(),
		});
		this.server = new HostServer(
			{
				onSay: (text) => this.say(text),
				onAnswer: (reportId, option) => this.answer(reportId, option),
				snapshot: () => this.snapshot(),
				transcript: (ticketId) => this.transcript(ticketId).messages,
			},
			(ticketId, token, method, params) => this.workers.handleRequest(ticketId, token, method, params),
			this.#log,
		);
		// Built before any client can say a line, so every line and reply reaches it; it touches the network only once started.
		this.#telegram = options.telegram && new TelegramClient({ ...options.telegram, host: { say: (text, o) => this.say(text, o), sayQuoting: (text, lineId, o) => this.sayQuoting(text, lineId, o), answer: (reportId, option, o) => this.answer(reportId, option, o), board: () => ({ rows: this.kernel.listTickets(), memberCap: this.#memberCapBoard() }) }, db: this.#db, clock, log: this.#log });
	}

	static async start(options: HostOptions): Promise<Host> {
		const host = new Host(options);
		if (options.webPort !== undefined) {
			host.#web = new WebGateway({ snapshot: () => host.snapshot(), transcript: (ticketId) => host.transcript(ticketId), say: (text) => host.say(text), sayQuoting: (text, lineId) => host.sayQuoting(text, lineId), answer: (reportId, option) => host.answer(reportId, option), clear: () => host.clearConversation() }, loadToken(options.stateDir, "web-token", host.#log), host.#log, options.webHosts ?? []);
			await host.#web.listen(options.webPort);
		}
		try {
			const clientToken = loadToken(options.stateDir, "client-token", host.#log);
			const deps: HostDeps = { kernel: host.kernel, afterCommand: () => host.#changed(), stateDir: options.stateDir, socketPath: host.socketPath, rulesFor: options.rulesFor ?? (() => []) };
			// The socket bind is what turns a second host on this state directory away; with webPort 0 the web port does not.
			await host.server.listen(host.socketPath, clientToken);
			await endLeftoverMembers(options.stateDir, host.#log);
			host.router = await options.createRouter(deps);
		} catch (error) {
			await Promise.all([host.server.close(), host.#web?.close()]);
			throw error;
		}
		host.kernel.nameUnnamedHelpers();
		const recovered = host.kernel.recoverOnStartup();
		host.#duty = { since: host.#clock.now(), resumed: recovered.length };
		if (recovered.length) host.#log(`[host] 恢复 ${recovered.length} 个执行中的任务：${recovered.join(", ")}`);
		for (const line of host.kernel.undeliveredAlerts()) host.#deliverHostLine(line);
		host.generic.start();
		host.timer.start();
		for (const feed of host.feeds.values()) feed.start();
		host.#beat();
		host.#heartbeat = setInterval(() => host.#beat(), options.heartbeatMs ?? 30_000);
		host.#heartbeat.unref();
		host.#atNextMidnight();
		if (host.#memberCap) host.#atNextNewYorkDay(host.#memberCap);
		host.#pushBoardAtNextStall(host.kernel.listTickets());
		// Only now do the Router and every client exist; a reply delivered earlier would miss the ones still missing.
		host.dispatcher.start();
		host.#telegram?.start();
		return host;
	}

	get webUrl(): string | undefined {
		return this.#web?.url;
	}

	get remoteWebUrls(): readonly string[] {
		return this.#web?.remoteUrls ?? [];
	}

	/** A repeated externalId returns the first line's id and changes nothing. */
	say(text: string, { externalId, from }: SayOptions = {}): string {
		const at = Date.now();
		const { triggerId, duplicate } = this.kernel.userSaid({ text, at, externalId });
		if (duplicate) return triggerId;
		this.#broadcast({ type: "user", id: triggerId, who: "user", text, at }, from);
		this.#changed();
		return triggerId;
	}

	/** Null when lineId is not a shown conversation line. A repeated externalId returns the first line's id and changes nothing. */
	sayQuoting(text: string, lineId: string, { externalId, from }: SayOptions = {}): string | null {
		const at = Date.now();
		const said = this.kernel.userSaidQuoting({ text, at, lineId, externalId });
		if (!said) return null;
		if (said.duplicate) return said.triggerId;
		this.#broadcast({ type: "user", id: said.triggerId, who: "user", text, at, quote: said.quote }, from);
		this.#changed();
		return said.triggerId;
	}

	/**
	 * Only the user's front ends reach this: the web gateway after its token and origin checks, a socket connection that said hello as a client,
	 * and an IM client (`from`) for a listed account. The member cap is answered on the web page or in the TUI only (ADR-0010, ADR-0016).
	 */
	answer(reportId: string, option: number, { from }: { from?: ImChat } = {}): AnswerResult {
		if (isCapAskId(reportId)) return from ? { ok: false, refusal: { kind: "not_here" } } : this.#answerCapAsk(reportId, option);
		const at = Date.now();
		const result = this.kernel.answerQuestion({ reportId, option, at });
		if (!result.ok) return result;
		if (!result.duplicate) {
			this.#broadcast({ type: "user", id: result.triggerId, who: "user", text: result.text, at }, from);
			this.#changed();
		}
		return { ok: true, triggerId: result.triggerId };
	}

	#askAboutMemberCap(cap: MemberCap, waiting: number): void {
		try {
			cap.membersWaiting(waiting);
		} catch (error) {
			this.#log(`[host] 成员上限：没能记下要问使用者的问题：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#answerCapAsk(reportId: string, option: number): AnswerResult {
		const result = this.#memberCap?.answer(reportId, option) ?? { ok: false as const, refusal: { kind: "closed" as const } };
		if (!result.ok) return result;
		if (!result.duplicate) {
			this.#broadcast({ type: "user", id: result.lineId, who: "user", text: result.text, at: this.#clock.now() });
			this.workers.recheckMemberSlots();
			this.#changed();
		}
		return { ok: true, triggerId: result.lineId };
	}

	snapshot() {
		const { rows, today, duty, helpers, routes, dispatching, memberCap } = this.#boardState();
		const watching = this.#watching.map((w) => {
			const problem = this.feeds.get(w.source)?.problem();
			return problem ? { ...w, problem } : w;
		});
		return { conversation: this.kernel.conversation(CONVERSATION_LINES), cleared: this.kernel.cleared(CONVERSATION_LINES), board: rows, today, duty, helpers, routes, dispatching, memberCap, watching };
	}

	clearConversation(): void {
		const cleared = this.kernel.clearConversation(CONVERSATION_LINES);
		if (cleared) this.#broadcast({ type: "cleared", conversation: this.kernel.conversation(CONVERSATION_LINES), cleared });
	}

	#boardState(): BoardState {
		return { rows: this.kernel.listTickets(), today: todayCounts(this.kernel.triggerCountsToday()), duty: this.#duty, helpers: this.kernel.helpersToday(), routes: this.kernel.conversationRoutes(CONVERSATION_LINES), dispatching: this.workers.dispatching(), memberCap: this.#memberCapBoard() };
	}

	#memberCapBoard(): MemberCapBoard {
		const cap = this.#memberCap;
		return cap ? { limit: cap.limit(), question: cap.question(this.workers.membersWaitingForSlot()) } : null;
	}

	#deliverReply(threadId: string, text: string, replyId: string, ticketId: string | null | undefined): void {
		if (threadId !== CONVERSATION_THREAD_ID) throw new Error(`线程 ${threadId} 没有渠道`);
		this.#broadcast({ type: "reply", text, at: Date.now(), replyId, ...(ticketId ? { ticketId } : {}) });
		this.kernel.markReplyDelivered(replyId);
	}

	#postHostLine(source: string, post: HostLinePost): void {
		const { line, duplicate } = this.kernel.postHostLine(source, post);
		if (!duplicate) this.#deliverHostLine(line);
	}

	// Telegram's outbox upserts on the line id, so delivering again after a stop between the two steps sends nothing twice.
	#deliverHostLine(line: HostLine): void {
		this.#broadcast({ type: "host_line", ...line });
		if (line.who === "alert") this.kernel.markHostLineDelivered(line.id);
	}

	#broadcast(message: Broadcast, from?: ImChat): void {
		this.server.broadcast(message);
		this.#web?.broadcast(message);
		this.#telegram?.broadcast(message, from);
	}

	#transcript(ticketId: string, event: unknown): void {
		const e = event as { type?: string; message?: TranscriptMessage };
		if (e.type !== "message_end" || !e.message) return;
		this.server.sendTranscript(ticketId, e.message);
		this.#web?.sendTranscript(ticketId, e.message);
	}

	transcript(ticketId: string): TranscriptHistory {
		const ticket = this.kernel.getTicket(ticketId);
		if (!ticket) return { messages: [] };
		const dir = helperSessionDir(this.#stateDir);
		const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(`_${ticket.workerSessionId}.jsonl`)) : undefined;
		const messages = file ? readSessionEntries(join(dir, file)).filter((entry) => entry.type === "message" && entry.message?.role !== "system").map((entry) => entry.message as TranscriptMessage) : [];
		const crew = (ticket.domain !== null && this.#kitFor?.(ticket.domain)?.crew) || [];
		const titles = Object.fromEntries(crew.map((m) => [m.name, m.title]));
		const steps = memberTranscripts(this.#stateDir, ticketId);
		const hasTeam = Object.keys(titles).length > 0 || Object.keys(steps).length > 0;
		return { messages, ...(hasTeam && { team: { titles, steps } }) };
	}

	#beat(): void {
		writeHeartbeat(this.#stateDir, { pid: process.pid, at: Date.now() });
	}

	// Today's counts change at local midnight even when nothing happens, and board frames otherwise go out only on #changed().
	#atNextMidnight(): void {
		const now = this.#clock.now();
		const midnight = new Date(now);
		midnight.setHours(24, 0, 0, 0);
		this.#midnightTimer = setTimeout(() => {
			this.#pushBoard();
			this.#atNextMidnight();
		}, midnight.getTime() - now);
		this.#midnightTimer.unref();
	}

	// The day's grant and question end at New York midnight even when nothing happens. A member that still waits then got no answer for the new day, and no new dispatch has to arrive for the host to ask.
	#atNextNewYorkDay(cap: MemberCap): void {
		this.#cancelNewYorkDay = this.#after(Math.min(msUntilNextNewYorkDay(this.#clock.now()), MAX_TIMER_MS), () => {
			this.#atNextNewYorkDay(cap);
			this.#askAboutMemberCap(cap, this.workers.membersWaitingForSlot());
			this.#pushBoard();
		});
	}

	#pushBoardAtNextStall(rows: DashboardRow[]): void {
		const at = nextStallAt(rows, this.kernel.config.stuckMs);
		if (at === this.#stallAt) return;
		clearTimeout(this.#stallTimer);
		this.#stallAt = at;
		if (at === null) return;
		this.#stallTimer = setTimeout(() => {
			this.#stallAt = null;
			this.#pushBoard();
		}, Math.min(Math.max(0, at - this.#clock.now()), MAX_TIMER_MS));
		this.#stallTimer.unref();
	}

	#pushBoard(): void {
		const state = this.#boardState();
		this.#broadcast({ type: "board", ...state });
		this.#pushBoardAtNextStall(state.rows);
	}

	#changed(): void {
		this.dispatcher.kick();
		if (this.#boardTimer) return;
		this.#boardTimer = setTimeout(() => {
			this.#boardTimer = undefined;
			this.#pushBoard();
		}, 100);
	}

	async settled(): Promise<void> {
		for (let i = 0; i < 50; i++) {
			await this.dispatcher.settled();
			await this.router.waitForIdle();
			await new Promise((r) => setImmediate(r));
			if (this.kernel.dueActions(1).length === 0) return;
		}
	}

	async stop(): Promise<void> {
		await this.#telegram?.stop();
		clearInterval(this.#heartbeat);
		this.generic.stop();
		this.timer.stop();
		for (const feed of this.feeds.values()) feed.stop();
		this.dispatcher.stop();
		clearTimeout(this.#boardTimer);
		clearTimeout(this.#midnightTimer);
		this.#cancelNewYorkDay?.();
		clearTimeout(this.#stallTimer);
		await this.workers.shutdown();
		this.router.dispose();
		await Promise.all([this.server.close(), this.#web?.close()]);
	}
}

function todayCounts(rows: { source: string; disposition: Disposition; count: number }[]): TodayCounts {
	const byDisposition = Object.fromEntries(DISPOSITIONS.map((d) => [d, 0])) as Record<Disposition, number>;
	const bySource: Record<string, number> = {};
	for (const { source, disposition, count } of rows) {
		if (source === CONVERSATION_SOURCE || source === WATCHDOG_SOURCE) continue;
		byDisposition[disposition] += count;
		bySource[source] = (bySource[source] ?? 0) + count;
	}
	return { byDisposition, bySource };
}
