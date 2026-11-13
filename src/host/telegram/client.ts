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
import { alertText, cardView, closedView, decide, mirrorText, NOTES, render, repeatsQuestion } from "./rules.ts";
import { privateLine, telegramText } from "../../modules/protocol.ts";
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
	/** Null when the line cannot be quoted. */
	sayQuoting(text: string, lineId: string, options: SayOptions): string | null;
	answer(reportId: string, option: number, options: { from: ImChat }): AnswerResult;
	board(): Board;
	/** The module's title when the ticket touched private data: its reports and cards then go out as one line pointing to the web page. Null: in full. */
	privateTitle(ticketId: string): string | null;
}

export const DEFAULT_TIMING: TelegramTiming = {
	pollTimeoutSec: 50,
	minGapMs: 1000,
	backoffMs: [1000, 2000, 5000, 15_000, 30_000],
	conflictBackoffMs: 30_000,
	stopGraceMs: 5000,
};
const DROP_LOG_EVERY_MS = 60 * 60_000;
const TAP_TAKEN = "已发送";
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
// so it is not sent again and the chat owes a note instead.
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
	#failedUpdate: { updateId: number; tries: number } | undefined;

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
		this.#loops = [this.#run()];
	}

	/** Synchronous and never throws: Telegram must not delay or fail what the web page and the TUI get. Before start and while stopping it still queues. */
	broadcast(message: Broadcast, from?: ImChat): void {
		if (this.#state === "off") return;
		try {
			switch (message.type) {
				case "reply": {
					const title = message.ticketId === undefined ? null : this.#host.privateTitle(message.ticketId);
					if (title !== null || !this.#cardStandsIn(message)) {
						for (const chat of this.#store.openChats()) this.#store.put(chat, `line:${message.replyId}`, message.replyId, { kind: "line", text: telegramText(message.text, title), silent: false });
					}
					break;
				}
				case "user": {
					const title = message.ticketId === undefined ? null : this.#host.privateTitle(message.ticketId);
					for (const chat of this.#store.openChats()) {
						if (chat !== from?.chatId) this.#store.put(chat, `line:${message.id}`, message.id, { kind: "line", text: telegramText(mirrorText(message.text, from), title), silent: true });
					}
					break;
				}
				case "board":
					for (const chat of this.#store.openChats()) this.#syncCards(chat, message);
					break;
				case "host_line":
					if (message.who === "alert") {
						const text = telegramText(alertText(message), message.module?.private ? message.module.title : null);
						for (const chat of this.#store.openChats()) this.#store.put(chat, `alert:${message.id}`, null, { kind: "line", text, silent: false });
					}
					break;
				case "cleared":
					break;
				default: {
					const unknown: never = message;
					this.#log(`[telegram] 不认识的广播类型 ${(unknown as { type: string }).type}，没有发到 Telegram`);
					return;
				}
			}
			this.#wake?.();
		} catch (error) {
			this.#log(`[telegram] 没能记下要发到 Telegram 的消息：${(error as Error).message}`);
		}
	}

	/** Fails open: when the board can't be read or the card can't be queued, the reply goes out, so at worst the phone sees the question twice. */
	#cardStandsIn(message: { text: string; at: number; ticketId?: string }): boolean {
		if (!message.ticketId) return false;
		try {
			const board = this.#host.board();
			if (!repeatsQuestion(message, board.rows.find((row) => row.id === message.ticketId)?.question ?? null)) return false;
			// Board frames wait 100ms after a change, so a quick Router turn can beat the frame with the card: queue the card here, then drop the repeat.
			for (const chat of this.#store.openChats()) this.#syncCards(chat, board);
			return true;
		} catch (error) {
			this.#log(`[telegram] 没能确认这句回复是不是卡片上的问题，照常发到 Telegram：${(error as Error).message}`);
			return false;
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
				const board = this.#host.board();
				for (const chat of this.#store.openChats()) this.#syncCards(chat, board);
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
					this.#openChat(inbound.chatId);
					this.#store.put(inbound.chatId, `note:${updateId}`, null, { kind: "note", text: NOTES[inbound.note] });
					break;
				case "say": {
					this.#openChat(inbound.chatId);
					const options: SayOptions = { externalId: `tg:${this.#api.botId}:${updateId}`, from: { client: "telegram", chatId: inbound.chatId } };
					const quoted = inbound.replyTo === null ? undefined : this.#store.lineOf(inbound.chatId, inbound.replyTo);
					const lineId = (quoted && this.#host.sayQuoting(inbound.text, quoted, options)) ?? this.#host.say(inbound.text, options);
					this.#store.received(inbound.chatId, lineId, inbound.messageId);
					break;
				}
				case "answer": {
					const { chatId, messageId, reportId, option } = inbound;
					const toast = this.#store.tapOnce(updateId, () => {
						if (!this.#store.isCard(chatId, messageId, reportId)) return refusalText({ kind: "closed" });
						const result = this.#host.answer(reportId, option, { from: { client: "telegram", chatId } });
						return result.ok ? TAP_TAKEN : refusalText(result.refusal);
					});
					this.#answerTap(inbound.callbackId, toast);
					break;
				}
				case "refuse-tap":
					this.#answerTap(inbound.callbackId, inbound.toast);
					break;
			}
			this.#wake?.();
			return true;
		} catch (error) {
			this.#log(`[telegram] 处理一条 Telegram 消息出错：${(error as Error).message}`);
			return false;
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
				const title = this.#host.privateTitle(row.id);
				if (title !== null) {
					this.#store.put(chatId, `private:${view.reportId}`, null, { kind: "line", text: privateLine(title), silent: false });
					continue;
				}
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
				const message = render(row.body, row.note);
				let messageId: number;
				try {
					if (row.messageId === null) messageId = await this.#api.send(row.chatId, message, this.#sending.signal);
					else {
						await this.#api.edit(row.chatId, row.messageId, message, this.#sending.signal);
						messageId = row.messageId;
					}
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
		const kind = error instanceof TelegramError ? ON_SEND_ERROR[error.kind] : "maybe-sent";
		// An edit sets the card to a state, so landing it twice is the same as once (Telegram answers "not modified"): repeat it after a doubtful failure.
		const reaction = kind === "maybe-sent" && row.messageId !== null ? "retry" : kind;
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
				await this.#record(() => (row.key === "setup" ? this.#store.giveUp(row, "maybe-sent") : this.#store.maybeSent(row)));
				return this.#log(`[telegram] 一条消息可能已经发到，也可能没有（${message}），不再重发；手机上的下一条文字消息开头带一句说明`);
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
