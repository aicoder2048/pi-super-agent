import { BotApi, TelegramError, type TelegramErrorKind } from "../host/telegram/bot-api.ts";
import { render } from "../host/telegram/rules.ts";
import { scrub } from "../host/health.ts";
import type { OutboundMessage } from "../host/telegram/bot-api.ts";

// Retrying cannot change these answers: the token or the chat is refused, or the message itself is.
const GIVE_UP = new Set<TelegramErrorKind>(["unauthorized", "forbidden", "bad_request"]);
const RETRY_MS = 60_000;

export interface PhoneOptions {
	api: BotApi;
	chats: readonly number[];
	log: (line: string) => void;
	retryMs?: number;
}

/**
 * The Watchdog's own way to the user's phone while the host is down. Send-only: it never polls getUpdates, so the host's
 * poller gets no 409. `tell` returns at once and never throws, so a dead network never holds up a restart.
 */
export class Phone {
	readonly #o: PhoneOptions;
	readonly #queue: { chatId: number; message: OutboundMessage }[] = [];
	#sending = false;
	#retry: NodeJS.Timeout | undefined;

	constructor(options: PhoneOptions) {
		this.#o = options;
	}

	tell(text: string, silent: boolean): void {
		const message = render({ kind: "line", role: "notice", text, silent, noPreview: true });
		for (const chatId of this.#o.chats) this.#queue.push({ chatId, message });
		void this.#flush();
	}

	async #flush(): Promise<void> {
		if (this.#sending) return;
		this.#sending = true;
		clearTimeout(this.#retry);
		try {
			while (this.#queue.length) {
				const { chatId, message } = this.#queue[0];
				try {
					await this.#o.api.send(chatId, message, new AbortController().signal);
					this.#queue.shift();
				} catch (error) {
					const reason = error instanceof TelegramError ? error.message : scrub(String(error));
					if (error instanceof TelegramError && GIVE_UP.has(error.kind)) {
						this.#o.log(`[watchdog] 发到 Telegram 聊天 ${chatId} 被拒绝（${reason}），这条不再重试`);
						this.#queue.shift();
						continue;
					}
					const waitMs = (error instanceof TelegramError && error.retryAfterMs) || (this.#o.retryMs ?? RETRY_MS);
					this.#o.log(`[watchdog] Telegram 暂时发不出去（${reason}），${Math.ceil(waitMs / 1000)} 秒后再试`);
					this.#retry = setTimeout(() => void this.#flush(), waitMs);
					this.#retry.unref();
					return;
				}
			}
		} finally {
			this.#sending = false;
		}
	}
}
