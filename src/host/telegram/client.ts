import type { BotApi } from "./bot-api.ts";

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

/** What HostOptions.telegram carries: built by wiring, or by a test around a fake Bot API. */
export interface TelegramOptions {
	api: BotApi;
	allowedUserIds: ReadonlySet<number>;
	timing?: Partial<TelegramTiming>;
}
