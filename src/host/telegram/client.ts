// The Telegram client: a long-poll loop for what the user writes, a send loop for the outbox, and the
// fan-out of host broadcasts into the outbox. Its public surface is start / broadcast / stop.
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { Clock } from "../../kernel/types.ts";
import type { Broadcast, ImChat, SayOptions } from "../server.ts";
import { TelegramError, type BotApi, type TelegramErrorKind, type Update } from "./bot-api.ts";
import { decide, mirrorText, NOTES, render } from "./rules.ts";
import { TelegramStore, type Pending } from "./store.ts";

export interface TelegramTiming {
	pollTimeoutSec: number;
	/** One send per this many ms across all chats: Telegram allows about one message a second in a private chat. */
	minGapMs: number;
	/** Waits after consecutive failures; the last one repeats. */
	backoffMs: readonly number[];
	conflictBackoffMs: number;
	/** How long stop() lets a send in flight finish, so its message_id is recorded. */
	stopGraceMs: number;
}

export interface TelegramOptions {
	api: BotApi;
	allowedUserIds: ReadonlySet<number>;
	timing?: Partial<TelegramTiming>;
}

export interface TelegramHost {
	say(text: string, options: SayOptions): string;
}

export const DEFAULT_TIMING: TelegramTiming = {
	pollTimeoutSec: 50,
	minGapMs: 1000,
	backoffMs: [1000, 2000, 5000, 15_000, 30_000],
	conflictBackoffMs: 30_000,
	stopGraceMs: 5000,
};
const DROP_LOG_EVERY_MS = 60 * 60_000;
const HANDLE_TRIES = 5;

type PollReaction = "exit" | "disable" | "retry" | "pause" | "conflict";
type SendReaction = "disable" | "retry" | "pause" | "block" | "give-up" | "maybe-sent";

const ON_POLL_ERROR: Record<TelegramErrorKind, PollReaction> = {
	stopped: "exit",
	unauthorized: "disable",
	conflict: "conflict",
	rate_limited: "pause",
	unreachable: "retry",
	network: "retry",
	server: "retry",
	forbidden: "retry",
	bad_request: "retry",
	bad_response: "retry",
};

// A send is repeated only when Telegram surely did not take it: the request never left, or Telegram answered in JSON
// with a refusal or a wait. After anything else, an abort at stop included, the message may be on the phone already,
// so it is not sent again and the chat gets one note instead.
const ON_SEND_ERROR: Record<TelegramErrorKind, SendReaction> = {
	stopped: "maybe-sent",
	unauthorized: "disable",
	conflict: "retry",
	rate_limited: "pause",
	unreachable: "retry",
	network: "maybe-sent",
	server: "maybe-sent",
	bad_response: "maybe-sent",
	forbidden: "block",
	bad_request: "give-up",
};

export class TelegramClient {
	readonly #api: BotApi;
	readonly #allowed: ReadonlySet<number>;
	readonly #timing: TelegramTiming;
	readonly #host: TelegramHost;
	readonly #store: TelegramStore;
	readonly #clock: Clock;
	readonly #log: (line: string) => void;
	readonly #polling = new AbortController();
	readonly #sending = new AbortController();
	#state: "running" | "stopping" | "off" = "running";
	#loops: Promise<void>[] = [];
	#wake: (() => void) | undefined;
	#pauseUntil = 0;
	#lastSendAt = -Infinity;
	#dropped = 0;
	#droppedLoggedAt = -Infinity;
	#failedUpdate: { updateId: number; tries: number } | undefined;

	constructor(options: TelegramOptions & { host: TelegramHost; db: DatabaseSync; clock: Clock; log: (line: string) => void }) {
		this.#api = options.api;
		this.#allowed = options.allowedUserIds;
		this.#timing = { ...DEFAULT_TIMING, ...options.timing };
		this.#host = options.host;
		this.#clock = options.clock;
		this.#log = options.log;
		this.#store = new TelegramStore(options.db, options.api.botId, options.clock.now);
	}

	/** Makes no network call, so a Telegram problem never holds up the host's start. */
	start(): void {
		this.#loops = [this.#run()];
	}

	/** Synchronous and never throws: Telegram must not delay or fail what the web page and the TUI get. Before start and while stopping it still queues. */
	broadcast(message: Broadcast, from?: ImChat): void {
		if (this.#state === "off") return;
		try {
			if (message.type === "reply") {
				for (const chat of this.#store.openChats()) this.#store.put(chat, `line:${message.replyId}`, message.replyId, { kind: "line", text: message.text, silent: false });
			} else if (message.type === "user") {
				for (const chat of this.#store.openChats()) {
					if (chat !== from?.chatId) this.#store.put(chat, `line:${message.id}`, message.id, { kind: "line", text: mirrorText(message.text, from), silent: true });
				}
			}
			this.#wake?.();
		} catch (error) {
			this.#log(`[telegram] 没能记下要发到 Telegram 的消息：${(error as Error).message}`);
		}
	}

	/** Aborts the long poll at once and gives a send in flight stopGraceMs to finish. */
	async stop(): Promise<void> {
		if (this.#state === "running") this.#state = "stopping";
		this.#polling.abort();
		this.#wake?.();
		const grace = setTimeout(() => this.#sending.abort(), this.#timing.stopGraceMs);
		await Promise.all(this.#loops);
		clearTimeout(grace);
	}

	/** A local state error at start is waited out like any other, so the client never needs a host restart to come up. */
	async #run(): Promise<void> {
		for (let failures = 0; this.#state === "running"; failures++) {
			try {
				this.#store.claim(this.#allowed);
				break;
			} catch (error) {
				await this.#afterLocalError(error, failures);
			}
		}
		if (this.#state !== "running") return;
		if (this.#allowed.size === 0) this.#log("[telegram] 名单为空：只告诉来信的人他自己的数字 id，不把任何消息交给幕僚长");
		await Promise.all([this.#poll(), this.#send()]);
	}

	async #poll(): Promise<void> {
		const signal = this.#polling.signal;
		for (let failures = 0; this.#state === "running"; failures++) {
			try {
				const { username } = await this.#api.getMe(signal);
				this.#log(`[telegram] 已连上 @${username}，${this.#allowed.size ? `名单 ${this.#allowed.size} 人` : "设置模式"}`);
				break;
			} catch (error) {
				if (!(await this.#afterPollError(error, failures))) return;
			}
		}
		let failures = 0;
		let localFailures = 0;
		while (this.#state === "running") {
			try {
				const offset = this.#store.nextUpdateId();
				let updates: Update[];
				try {
					updates = await this.#api.getUpdates(offset, this.#timing.pollTimeoutSec, signal);
					failures = 0;
				} catch (error) {
					if (!(await this.#afterPollError(error, failures++))) return;
					continue;
				}
				await this.#handleAll(updates);
				localFailures = 0;
			} catch (error) {
				await this.#afterLocalError(error, localFailures++);
			}
		}
	}

	/** The offset moves past an update only once it is handled, so one that failed comes back with the next poll. */
	async #handleAll(updates: Update[]): Promise<void> {
		for (const update of updates) {
			if (!this.#handle(update)) {
				const tries = this.#failedUpdate?.updateId === update.updateId ? this.#failedUpdate.tries + 1 : 1;
				this.#failedUpdate = { updateId: update.updateId, tries };
				if (tries < HANDLE_TRIES) {
					await this.#pause(this.#backoff(tries - 1));
					return;
				}
				this.#log(`[telegram] 一条 Telegram 消息连续 ${HANDLE_TRIES} 次没能交给宿主，跳过了它`);
			}
			this.#store.setNextUpdateId(update.updateId + 1);
		}
	}

	/** Every effect is keyed by the update, so handling a redelivered one changes nothing. False when it failed. */
	#handle({ updateId, event }: Update): boolean {
		try {
			const inbound = decide(event, this.#allowed);
			switch (inbound.do) {
				case "ignore":
					break;
				case "drop":
					this.#countDrop();
					break;
				case "tell-id":
					this.#store.put(inbound.chatId, "setup", null, { kind: "note", text: NOTES.setup(inbound.chatId) });
					break;
				case "note":
					this.#store.openChat(inbound.chatId);
					this.#store.put(inbound.chatId, `note:${updateId}`, null, { kind: "note", text: NOTES[inbound.note] });
					break;
				case "say": {
					this.#store.openChat(inbound.chatId);
					const lineId = this.#host.say(inbound.text, { externalId: `tg:${this.#api.botId}:${updateId}`, from: { client: "telegram", chatId: inbound.chatId } });
					this.#store.received(inbound.chatId, lineId, inbound.messageId);
					break;
				}
			}
			this.#wake?.();
			return true;
		} catch (error) {
			this.#log(`[telegram] 处理一条 Telegram 消息出错：${(error as Error).message}`);
			return false;
		}
	}

	#countDrop(): void {
		this.#dropped++;
		const now = this.#clock.now();
		if (now - this.#droppedLoggedAt < DROP_LOG_EVERY_MS) return;
		this.#log(`[telegram] 丢弃了 ${this.#dropped} 条不在名单里的人或群里的消息（不记 id 和内容；这一行一小时最多一次）`);
		this.#dropped = 0;
		this.#droppedLoggedAt = now;
	}

	/** False when the loop should end. */
	async #afterPollError(error: unknown, failures: number): Promise<boolean> {
		const reaction = error instanceof TelegramError ? ON_POLL_ERROR[error.kind] : "retry";
		if (reaction === "exit") return false;
		if (reaction === "disable") {
			this.#disable();
			return false;
		}
		const waitMs = reaction === "conflict" ? this.#timing.conflictBackoffMs : reaction === "pause" ? ((error as TelegramError).retryAfterMs ?? this.#backoff(failures)) : this.#backoff(failures);
		if (failures === 0) {
			const why = reaction === "conflict" ? "另一处在用同一个 bot token 取消息，或这个机器人设了 webhook" : (error as Error).message;
			this.#log(`[telegram] 取消息失败（${why}），${Math.round(waitMs / 1000)} 秒后重试`);
		}
		await this.#pause(waitMs);
		return true;
	}

	/** A failed read or write of the local tables: the loop waits and goes on, it never ends the host. */
	async #afterLocalError(error: unknown, failures: number): Promise<void> {
		const waitMs = this.#backoff(failures);
		if (failures === 0) this.#log(`[telegram] 本地状态出错（${(error as Error).message}），${Math.round(waitMs / 1000)} 秒后再试`);
		await this.#pause(waitMs);
	}

	async #send(): Promise<void> {
		let failures = 0;
		let localFailures = 0;
		while (this.#state === "running") {
			try {
				const row = this.#store.next();
				if (!row) {
					await new Promise<void>((wake) => (this.#wake = wake));
					continue;
				}
				await this.#pause(Math.max(this.#lastSendAt + this.#timing.minGapMs, this.#pauseUntil) - Date.now());
				if (this.#state !== "running") return;
				this.#lastSendAt = Date.now();
				const { text, silent } = render(row.body);
				let messageId: number;
				try {
					messageId = await this.#api.send(row.chatId, text, silent, this.#sending.signal);
				} catch (error) {
					await this.#afterSendError(error, row, failures++);
					continue;
				}
				failures = 0;
				await this.#record(() => this.#store.sent(row, messageId));
				localFailures = 0;
			} catch (error) {
				await this.#afterLocalError(error, localFailures++);
			}
		}
	}

	async #afterSendError(error: unknown, row: Pending, failures: number): Promise<void> {
		const reaction = error instanceof TelegramError ? ON_SEND_ERROR[error.kind] : "maybe-sent";
		const message = (error as Error).message;
		switch (reaction) {
			case "disable":
				return this.#disable();
			case "block":
				await this.#record(() => this.#store.blockChat(row.chatId));
				return this.#log("[telegram] 一个聊天屏蔽了机器人，不再往那里发，直到对方再发消息");
			case "give-up":
				await this.#record(() => this.#store.giveUp(row, message));
				return this.#log(`[telegram] Telegram 不收一条消息，不再重试：${message}`);
			case "maybe-sent":
				// A setup-mode writer is not the user yet, and the note points at a page they cannot open.
				await this.#record(() => (row.key === "setup" ? this.#store.giveUp(row, "maybe-sent") : this.#store.maybeSent(row, { kind: "note", text: NOTES.missed })));
				return this.#log(`[telegram] 一条消息可能已经发到，也可能没有（${message}），不再重发；一阵故障只补一句说明`);
			default: {
				const waitMs = reaction === "pause" ? ((error as TelegramError).retryAfterMs ?? this.#backoff(failures)) : this.#backoff(failures);
				this.#pauseUntil = Date.now() + waitMs;
				if (failures === 0) this.#log(`[telegram] 发消息失败（${message}），${Math.round(waitMs / 1000)} 秒后重试；没发出的按顺序等着`);
			}
		}
	}

	/** Writes down what Telegram already did. Retried on its own: sending again is never the way to recover a local failure. */
	async #record(write: () => void): Promise<void> {
		for (let failures = 0; ; failures++) {
			try {
				write();
				return;
			} catch (error) {
				if (failures === 0) this.#log(`[telegram] 没能在本地记下 Telegram 的结果（${(error as Error).message}），稍后再记，不重发`);
				if (this.#state !== "running") return;
				await this.#pause(this.#backoff(failures));
			}
		}
	}

	#backoff(failures: number): number {
		const steps = this.#timing.backoffMs;
		return steps[Math.min(failures, steps.length - 1)];
	}

	/** Ends early when the client stops. */
	async #pause(ms: number): Promise<void> {
		if (ms > 0) await sleep(ms, undefined, { signal: this.#polling.signal }).catch(() => {});
	}

	#disable(): void {
		if (this.#state === "off") return;
		this.#state = "off";
		this.#log("[telegram] Telegram 拒绝了 bot token（401），Telegram 客户端已停用；改好 TELEGRAM_BOT_TOKEN 后重启宿主");
		this.#polling.abort();
		this.#sending.abort();
		this.#wake?.();
	}
}
