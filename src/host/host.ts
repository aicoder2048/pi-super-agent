import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { writeHeartbeat } from "../heartbeat.ts";
import { relocateState } from "./relocate.ts";
import { WATCHDOG_SOURCE } from "../watchdog/watchdog.ts";
import { join } from "node:path";
import { Kernel } from "../kernel/kernel.ts";
import { openStore } from "../kernel/store.ts";
import { CONVERSATION_THREAD_ID, type Clock, type KernelConfig, type RouterNotice, type SourcePolicy } from "../kernel/types.ts";
import type { TriggerSubmission } from "../kernel/types.ts";
import { GenericSource } from "../sources/generic.ts";
import { TimerSource, type TimerEntry } from "../sources/timer.ts";
import { Dispatcher } from "./dispatcher.ts";
import { HostServer } from "./server.ts";
import { WorkerExecutor, type WorkerModels, type WorkerSpawner } from "./workers.ts";

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
	rulesFor?: (triggerSource: string) => string[];
	timers?: TimerEntry[];
	heartbeatMs?: number;
	workerModels: WorkerModels;
	createRouter(deps: HostDeps): Promise<RouterLike>;
	createSpawner(deps: HostDeps): WorkerSpawner;
	log?: (line: string) => void;
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
	readonly #log: (line: string) => void;
	readonly #stateDir: string;
	#boardTimer: NodeJS.Timeout | undefined;
	#heartbeat: NodeJS.Timeout | undefined;

	private constructor(options: HostOptions) {
		mkdirSync(options.stateDir, { recursive: true });
		this.#log = options.log ?? ((line) => console.error(line));
		if (relocateState(options.stateDir)) this.#log(`[host] 状态目录换了位置，已把会话记录的工作目录改到 ${options.stateDir}`);
		this.#stateDir = options.stateDir;
		this.socketPath = join(options.stateDir, "host.sock");
		const clock = options.clock ?? { now: () => Date.now() };
		this.kernel = new Kernel({
			db: openStore(join(options.stateDir, "state.db")),
			clock,
			sourcePolicy: (trigger) => (trigger.source === WATCHDOG_SOURCE ? "notice" : (options.sourcePolicy?.(trigger) ?? "candidate")),
			ruleAllows: options.ruleAllows,
			config: options.config,
		});
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
		const deps: HostDeps = { kernel: this.kernel, afterCommand: () => this.#changed(), stateDir: options.stateDir, socketPath: this.socketPath, rulesFor: options.rulesFor ?? (() => []) };
		this.workers = new WorkerExecutor({
			kernel: this.kernel,
			spawner: options.createSpawner(deps),
			stateDir: options.stateDir,
			afterCommand: deps.afterCommand,
			onTranscript: (ticketId, event) => this.#transcript(ticketId, event),
			onError: (ticketId, error) => this.#log(`[worker ${ticketId}] ${String(error)}`),
			models: options.workerModels,
		});
		this.dispatcher = new Dispatcher({
			kernel: this.kernel,
			handlers: {
				"router.notify": (notice, actionId) => this.router.inject(notice, actionId),
				"worker.wake": ({ ticketId }) => this.workers.wake(ticketId),
				"worker.stop": ({ ticketId }) => this.workers.stop(ticketId),
				"channel.reply": ({ threadId, text, replyId }) => this.#deliverReply(threadId, text, replyId),
			},
			onError: (action, error) => this.#log(`[dispatcher] ${action.kind} 失败（第 ${action.attempts + 1} 次）：${String(error)}`),
		});
		this.server = new HostServer(
			{
				onSay: (text) => this.say(text),
				snapshot: () => this.snapshot(),
				transcript: (ticketId) => this.transcript(ticketId),
			},
			(ticketId, token, method, params) => this.workers.handleRequest(ticketId, token, method, params),
		);
	}

	static async start(options: HostOptions): Promise<Host> {
		const host = new Host(options);
		const deps: HostDeps = { kernel: host.kernel, afterCommand: () => host.#changed(), stateDir: options.stateDir, socketPath: host.socketPath, rulesFor: options.rulesFor ?? (() => []) };
		host.router = await options.createRouter(deps);
		await host.server.listen(host.socketPath);
		const recovered = host.kernel.recoverOnStartup();
		if (recovered.length) host.#log(`[host] 恢复 ${recovered.length} 个执行中的任务：${recovered.join(", ")}`);
		host.generic.start();
		host.timer.start();
		host.#beat();
		host.#heartbeat = setInterval(() => host.#beat(), options.heartbeatMs ?? 30_000);
		host.#heartbeat.unref();
		host.dispatcher.kick();
		return host;
	}

	say(text: string): string {
		const at = Date.now();
		const { triggerId } = this.kernel.submitTrigger({
			source: "conversation",
			externalId: randomUUID(),
			threads: [{ id: CONVERSATION_THREAD_ID, title: "对话" }],
			sender: "user",
			body: text,
			occurredAt: at,
		});
		this.server.broadcast({ type: "user", id: triggerId, text, at });
		this.#changed();
		return triggerId;
	}

	snapshot() {
		return { conversation: this.kernel.conversation(50), board: this.kernel.listTickets() };
	}

	#deliverReply(threadId: string, text: string, replyId: string): void {
		if (threadId !== CONVERSATION_THREAD_ID) throw new Error(`线程 ${threadId} 没有渠道`);
		this.server.broadcast({ type: "reply", text, at: Date.now(), replyId });
		this.kernel.markReplyDelivered(replyId);
	}

	#transcript(ticketId: string, event: unknown): void {
		const e = event as { type?: string; message?: unknown };
		if (e.type === "message_end" && e.message) this.server.sendTranscript(ticketId, e.message);
	}

	transcript(ticketId: string): unknown[] {
		const ticket = this.kernel.getTicket(ticketId);
		if (!ticket) return [];
		const dir = join(this.#stateDir, "sessions", "workers");
		const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(`_${ticket.workerSessionId}.jsonl`)) : undefined;
		if (!file) return [];
		return readFileSync(join(dir, file), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; message?: { role?: string } })
			.filter((entry) => entry.type === "message" && entry.message?.role !== "system")
			.map((entry) => entry.message);
	}

	#beat(): void {
		writeHeartbeat(this.#stateDir, { pid: process.pid, at: Date.now() });
	}

	#changed(): void {
		this.dispatcher.kick();
		if (this.#boardTimer) return;
		this.#boardTimer = setTimeout(() => {
			this.#boardTimer = undefined;
			this.server.broadcast({ type: "board", rows: this.kernel.listTickets() });
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
		clearInterval(this.#heartbeat);
		this.generic.stop();
		this.timer.stop();
		this.dispatcher.stop();
		clearTimeout(this.#boardTimer);
		await this.workers.shutdown();
		this.router.dispose();
		await this.server.close();
	}
}
