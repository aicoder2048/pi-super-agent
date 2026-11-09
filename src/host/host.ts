import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Kernel } from "../kernel/kernel.ts";
import { openStore } from "../kernel/store.ts";
import { CONVERSATION_THREAD_ID, type Clock, type KernelConfig, type RouterNotice, type SourcePolicy } from "../kernel/types.ts";
import { Dispatcher } from "./dispatcher.ts";
import { HostServer } from "./server.ts";
import { WorkerExecutor, type WorkerSpawner } from "./workers.ts";

export interface RouterLike {
	inject(notice: RouterNotice): void;
	waitForIdle(): Promise<void>;
	dispose(): void;
}

export interface HostDeps {
	kernel: Kernel;
	afterCommand: () => void;
	stateDir: string;
	socketPath: string;
}

export interface HostOptions {
	stateDir: string;
	clock?: Clock;
	config?: Partial<KernelConfig>;
	sourcePolicy?: SourcePolicy;
	createRouter(deps: HostDeps): Promise<RouterLike>;
	createSpawner(deps: HostDeps): WorkerSpawner;
	log?: (line: string) => void;
}

const TRANSCRIPT_KEEP = 500;

export class Host {
	readonly kernel: Kernel;
	readonly socketPath: string;
	readonly dispatcher: Dispatcher;
	readonly workers: WorkerExecutor;
	readonly server: HostServer;
	router!: RouterLike;
	readonly #transcripts = new Map<string, unknown[]>();
	readonly #log: (line: string) => void;
	#boardTimer: NodeJS.Timeout | undefined;

	private constructor(options: HostOptions) {
		mkdirSync(options.stateDir, { recursive: true });
		this.#log = options.log ?? ((line) => console.error(line));
		this.socketPath = join(options.stateDir, "host.sock");
		const clock = options.clock ?? { now: () => Date.now() };
		this.kernel = new Kernel({
			db: openStore(join(options.stateDir, "state.db")),
			clock,
			sourcePolicy: options.sourcePolicy ?? (() => "candidate"),
			config: options.config,
		});
		const deps: HostDeps = { kernel: this.kernel, afterCommand: () => this.#changed(), stateDir: options.stateDir, socketPath: this.socketPath };
		this.workers = new WorkerExecutor({
			kernel: this.kernel,
			spawner: options.createSpawner(deps),
			stateDir: options.stateDir,
			afterCommand: deps.afterCommand,
			onTranscript: (ticketId, event) => this.#transcript(ticketId, event),
			onError: (ticketId, error) => this.#log(`[worker ${ticketId}] ${String(error)}`),
		});
		this.dispatcher = new Dispatcher({
			kernel: this.kernel,
			handlers: {
				"router.notify": (notice) => this.router.inject(notice),
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
				transcript: (ticketId) => this.#transcripts.get(ticketId) ?? [],
			},
			(ticketId, token, method, params) => this.workers.handleRequest(ticketId, token, method, params),
		);
	}

	static async start(options: HostOptions): Promise<Host> {
		const host = new Host(options);
		const deps: HostDeps = { kernel: host.kernel, afterCommand: () => host.#changed(), stateDir: options.stateDir, socketPath: host.socketPath };
		host.router = await options.createRouter(deps);
		await host.server.listen(host.socketPath);
		const recovered = host.kernel.recoverOnStartup();
		if (recovered.length) host.#log(`[host] 恢复 ${recovered.length} 个执行中的任务：${recovered.join(", ")}`);
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
		this.server.broadcast({ type: "user", text, at });
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
		const type = (event as { type?: string }).type;
		if (type === "message_update" || type === "tool_execution_update") return this.server.sendTranscript(ticketId, event);
		const list = this.#transcripts.get(ticketId) ?? [];
		list.push(event);
		if (list.length > TRANSCRIPT_KEEP) list.splice(0, list.length - TRANSCRIPT_KEEP);
		this.#transcripts.set(ticketId, list);
		this.server.sendTranscript(ticketId, event);
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
		this.dispatcher.stop();
		clearTimeout(this.#boardTimer);
		await this.workers.shutdown();
		this.router.dispose();
		await this.server.close();
	}
}
