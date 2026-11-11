// The Telegram client: a long-poll loop for what the user writes and taps, a send loop for the outbox, and the
// fan-out of host broadcasts (lines and question cards) into the outbox. Its public surface is start / broadcast / stop.
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { BoardState } from "../../client/protocol.ts";
import { refusalText } from "../../kernel/question.ts";
import { inTransaction } from "../../kernel/store.ts";
import type { Clock } from "../../kernel/types.ts";
import type { AnswerResult, Broadcast, ImChat, SayOptions } from "../server.ts";
import { TelegramError, type BotApi, type TelegramErrorKind, type Update } from "./bot-api.ts";
import { cardView, closedView, decide, mirrorText, NOTES, render } from "./rules.ts";
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

type Board = Pick<BoardState, "rows" | "memberCap">;

export interface TelegramHost {
	say(text: string, options: SayOptions): string;
	answer(reportId: string, option: number, options: { from: ImChat }): AnswerResult;
	board(): Board;
}

const DEFAULT_TIMING: TelegramTiming = {
	pollTimeoutSec: 50,
	minGapMs: 1000,
	backoffMs: [1000, 2000, 5000, 15_000, 30_000, 60_000],
	conflictBackoffMs: 30_000,
	stopGraceMs: 5000,
};
const DROP_LOG_EVERY_MS = 60 * 60_000;
const TAP_TAKEN = "已发送";

type Reaction = "exit" | "disable" | "retry" | "pause" | "block" | "give-up" | "conflict";

const ON_POLL_ERROR: Record<TelegramErrorKind, Reaction> = {
	stopped: "exit",
	unauthorized: "disable",
	conflict: "conflict",
	rate_limited: "pause",
	network: "retry",
	server: "retry",
	forbidden: "retry",
	bad_request: "retry",
	bad_response: "retry",
};

// A send Telegram answered with something unreadable may still have arrived, so it is not sent again.
const ON_SEND_ERROR: Record<TelegramErrorKind, Reaction> = {
	stopped: "exit",
	unauthorized: "disable",
	conflict: "retry",
	rate_limited: "pause",
	network: "retry",
	server: "retry",
	forbidden: "block",
	bad_request: "give-up",
	bad_response: "give-up",
};

export class TelegramClient {
	readonly #api: BotApi;
	readonly #allowed: ReadonlySet<number>;
	readonly #timing: TelegramTiming;
	readonly #host: TelegramHost;
	readonly #store: TelegramStore;
	readonly #db: DatabaseSync;
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

	constructor(options: TelegramOptions & { host: TelegramHost; db: DatabaseSync; clock: Clock; log: (line: string) => void }) {
		this.#api = options.api;
		this.#allowed = options.allowedUserIds;
		this.#timing = { ...DEFAULT_TIMING, ...options.timing };
		this.#host = options.host;
		this.#clock = options.clock;
		this.#log = options.log;
		this.#db = options.db;
		this.#store = new TelegramStore(options.db, options.api.botId, options.clock.now);
	}

	/** Makes no network call, so a Telegram problem never holds up the host's start. */
	start(): void {
		this.#store.forgetChatsExcept(this.#allowed);
		if (this.#allowed.size === 0) this.#log("[telegram] 名单为空：只告诉来信的人他自己的数字 id，不把任何消息交给幕僚长");
		const board = this.#host.board();
		for (const chat of this.#store.openChats()) this.#syncCards(chat, board);
		this.#loops = [this.#poll(), this.#send()];
	}

	/** Synchronous and never throws: Telegram must not delay or fail what the web page and the TUI get. While stopping it still queues, for the next start to send. */
	broadcast(message: Broadcast, from?: ImChat): void {
		if (this.#state === "off") return;
		try {
			if (message.type === "reply") {
				for (const chat of this.#store.openChats()) this.#store.put(chat, `line:${message.replyId}`, message.replyId, { kind: "line", text: message.text, silent: false });
			} else if (message.type === "user") {
				for (const chat of this.#store.openChats()) {
					if (chat !== from?.chatId) this.#store.put(chat, `line:${message.id}`, message.id, { kind: "line", text: mirrorText(message.text, from), silent: true });
				}
			} else if (message.type === "board") {
				for (const chat of this.#store.openChats()) this.#syncCards(chat, message);
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
		while (this.#state === "running") {
			let updates: Update[];
			try {
				updates = await this.#api.getUpdates(this.#store.nextUpdateId(), this.#timing.pollTimeoutSec, signal);
				failures = 0;
			} catch (error) {
				if (!(await this.#afterPollError(error, failures++))) return;
				continue;
			}
			for (const update of updates) {
				this.#handle(update);
				this.#store.setNextUpdateId(update.updateId + 1);
			}
		}
	}

	/** Every effect is keyed by the update, so handling a redelivered one changes nothing. */
	#handle({ updateId, event }: Update): void {
		try {
			const inbound = decide(event, this.#allowed);
			switch (inbound.do) {
				case "ignore":
					return;
				case "drop":
					return this.#countDrop();
				case "tell-id":
					this.#store.put(inbound.chatId, "setup", null, { kind: "note", text: NOTES.setup(inbound.chatId) });
					break;
				case "note":
					this.#openChat(inbound.chatId);
					this.#store.put(inbound.chatId, `note:${updateId}`, null, { kind: "note", text: NOTES[inbound.note] });
					break;
				case "say": {
					this.#openChat(inbound.chatId);
					const lineId = this.#host.say(inbound.text, { externalId: `tg:${this.#api.botId}:${updateId}`, from: { client: "telegram", chatId: inbound.chatId } });
					this.#store.received(inbound.chatId, lineId, inbound.messageId);
					break;
				}
				case "answer": {
					const result = this.#host.answer(inbound.reportId, inbound.option, { from: { client: "telegram", chatId: inbound.chatId } });
					this.#answerTap(inbound.callbackId, result.ok ? TAP_TAKEN : refusalText(result.refusal));
					return;
				}
				case "refuse-tap":
					return this.#answerTap(inbound.callbackId, inbound.toast);
			}
			this.#wake?.();
		} catch (error) {
			this.#log(`[telegram] 处理一条 Telegram 消息出错：${(error as Error).message}`);
		}
	}

	/** A chat that opens (or reopens after a block) gets the cards of the questions already waiting. */
	#openChat(chatId: number): void {
		if (this.#store.openChat(chatId)) this.#syncCards(chatId, this.#host.board());
	}

	/** One card per question per chat, as desired state: an unchanged card is a no-op, a changed one becomes an edit, a gone one closes. */
	#syncCards(chatId: number, { rows, memberCap }: Board): void {
		inTransaction(this.#db, () => {
			const onBoard = new Set<string>();
			for (const row of rows) {
				const view = cardView(row);
				if (!view) continue;
				onBoard.add(view.reportId);
				this.#store.put(chatId, `ask:${view.reportId}`, null, { kind: "card", view });
			}
			for (const view of this.#store.openCards(chatId)) {
				if (!onBoard.has(view.reportId)) this.#store.put(chatId, `ask:${view.reportId}`, null, { kind: "card", view: closedView(view) });
			}
			const cap = memberCap?.question;
			if (cap) this.#store.put(chatId, `cap:${cap.reportId}`, null, { kind: "note", text: NOTES.cap });
		});
	}

	/** Straight to Telegram, not through the outbox: a toast is only worth showing right after the tap. */
	#answerTap(callbackId: string, toast: string): void {
		this.#api.answerTap(callbackId, toast, this.#polling.signal).catch((error) => {
			if (!(error instanceof TelegramError && error.kind === "stopped")) this.#log(`[telegram] 没能回应一次按钮点击：${(error as Error).message}`);
		});
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

	async #send(): Promise<void> {
		let failures = 0;
		while (this.#state === "running") {
			const row = this.#store.next();
			if (!row) {
				await new Promise<void>((wake) => (this.#wake = wake));
				continue;
			}
			await this.#pause(Math.max(this.#lastSendAt + this.#timing.minGapMs, this.#pauseUntil) - Date.now());
			if (this.#state === "off") return;
			this.#lastSendAt = Date.now();
			try {
				const message = render(row.body);
				if (row.messageId === null) this.#store.sent(row, await this.#api.send(row.chatId, message, this.#sending.signal));
				else {
					await this.#api.edit(row.chatId, row.messageId, message, this.#sending.signal);
					this.#store.sent(row, row.messageId);
				}
				failures = 0;
			} catch (error) {
				if (!this.#afterSendError(error, row, failures++)) return;
			}
		}
	}

	/** False when the loop should end. */
	#afterSendError(error: unknown, row: Pending, failures: number): boolean {
		const reaction = error instanceof TelegramError ? ON_SEND_ERROR[error.kind] : "retry";
		const message = (error as Error).message;
		switch (reaction) {
			case "exit":
				return false;
			case "disable":
				this.#disable();
				return false;
			case "block":
				this.#store.blockChat(row.chatId);
				this.#log("[telegram] 一个聊天屏蔽了机器人，不再往那里发，直到对方再发消息");
				return true;
			case "give-up":
				this.#store.giveUp(row, message);
				this.#log(`[telegram] Telegram 不收一条消息，不再重试：${message}`);
				return true;
			default: {
				const waitMs = reaction === "pause" ? ((error as TelegramError).retryAfterMs ?? this.#backoff(failures)) : this.#backoff(failures);
				this.#pauseUntil = Date.now() + waitMs;
				if (failures === 0) this.#log(`[telegram] 发消息失败（${message}），${Math.round(waitMs / 1000)} 秒后重试；没发出的按顺序等着`);
				return true;
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
