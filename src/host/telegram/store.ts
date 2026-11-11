// Sole owner of the telegram_* tables in the shared state.db. Offsets, chat ids and message ids only mean
// something to one bot, so they live together here and are wiped together when the bot changes.
import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "../../kernel/store.ts";
import type { OutboundBody } from "./rules.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_bot (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	bot_id INTEGER NOT NULL,
	next_update_id INTEGER
);
CREATE TABLE IF NOT EXISTS telegram_chats (
	chat_id INTEGER PRIMARY KEY,
	opened_at INTEGER NOT NULL,
	blocked_at INTEGER
);
CREATE TABLE IF NOT EXISTS telegram_messages (
	chat_id INTEGER NOT NULL,
	key TEXT NOT NULL,
	line_id TEXT,
	body TEXT NOT NULL,
	version INTEGER NOT NULL,
	sent_version INTEGER,
	message_id INTEGER,
	gave_up TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (chat_id, key)
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_messages_shown ON telegram_messages(chat_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telegram_messages_due ON telegram_messages(chat_id) WHERE gave_up IS NULL AND (sent_version IS NULL OR sent_version < version);
`;

const DUE = "gave_up IS NULL AND (sent_version IS NULL OR sent_version < version)";

/** `line:<lineId>` shows a conversation line, `note:<updateId>` answers one update, `setup` tells a writer their id, `missed` says a message may not have arrived. */
export type MessageKey = `line:${string}` | `note:${number}` | "setup" | "missed";

export type SendableBody = Exclude<OutboundBody, { kind: "received" }>;

export interface Pending {
	chatId: number;
	key: MessageKey;
	version: number;
	messageId: number | null;
	body: SendableBody;
}

export class TelegramStore {
	readonly #db: DatabaseSync;
	readonly #botId: number;
	readonly #now: () => number;

	/** Only creates the tables: a host that loses the race for the state directory must not change another host's rows. */
	constructor(db: DatabaseSync, botId: number, now: () => number) {
		this.#db = db;
		this.#botId = botId;
		this.#now = now;
		db.exec(SCHEMA);
	}

	/** Wipes everything when the bot changed, and the chats of ids no longer allowed. */
	claim(allowed: ReadonlySet<number>): void {
		const keep = JSON.stringify([...allowed]);
		inTransaction(this.#db, () => {
			const bot = this.#db.prepare("SELECT bot_id FROM telegram_bot WHERE id = 1").get() as { bot_id: number } | undefined;
			if (bot?.bot_id !== this.#botId) {
				this.#db.exec("DELETE FROM telegram_messages; DELETE FROM telegram_chats; DELETE FROM telegram_bot");
				this.#db.prepare("INSERT INTO telegram_bot (id, bot_id) VALUES (1, ?)").run(this.#botId);
			}
			this.#db.prepare("DELETE FROM telegram_messages WHERE chat_id NOT IN (SELECT value FROM json_each(?))").run(keep);
			this.#db.prepare("DELETE FROM telegram_chats WHERE chat_id NOT IN (SELECT value FROM json_each(?))").run(keep);
		});
	}

	nextUpdateId(): number | undefined {
		const row = this.#db.prepare("SELECT next_update_id FROM telegram_bot WHERE id = 1").get() as { next_update_id: number | null } | undefined;
		return row?.next_update_id ?? undefined;
	}

	setNextUpdateId(id: number): void {
		this.#db.prepare("UPDATE telegram_bot SET next_update_id = ? WHERE id = 1").run(id);
	}

	openChats(): number[] {
		return (this.#db.prepare("SELECT chat_id FROM telegram_chats WHERE blocked_at IS NULL ORDER BY chat_id").all() as { chat_id: number }[]).map((r) => r.chat_id);
	}

	/** True when the chat was not open before: new, or blocked until now. */
	openChat(chatId: number): boolean {
		const changed = this.#db
			.prepare("INSERT INTO telegram_chats (chat_id, opened_at) VALUES (?, ?) ON CONFLICT (chat_id) DO UPDATE SET blocked_at = NULL WHERE blocked_at IS NOT NULL")
			.run(chatId, this.#now()).changes;
		return changed > 0;
	}

	/** Telegram said the user blocked the bot. What was waiting for this chat is dropped, so unblocking does not replay it. */
	blockChat(chatId: number): void {
		inTransaction(this.#db, () => {
			this.#db.prepare("UPDATE telegram_chats SET blocked_at = ? WHERE chat_id = ?").run(this.#now(), chatId);
			this.#db.prepare(`UPDATE telegram_messages SET gave_up = 'blocked' WHERE chat_id = ? AND ${DUE}`).run(chatId);
		});
	}

	/** Upserts what Telegram should show. The same body again changes nothing; a new body is a new version. */
	put(chatId: number, key: MessageKey, lineId: string | null, body: SendableBody): void {
		this.#db
			.prepare(
				`INSERT INTO telegram_messages (chat_id, key, line_id, body, version, created_at) VALUES (?, ?, ?, ?, 1, ?)
				 ON CONFLICT (chat_id, key) DO UPDATE SET body = excluded.body, version = version + 1 WHERE body != excluded.body`,
			)
			.run(chatId, key, lineId, JSON.stringify(body), this.#now());
	}

	/** The user's own message: it is on the phone already, so it is recorded as sent. */
	received(chatId: number, lineId: string, messageId: number): void {
		this.#db
			.prepare(
				`INSERT INTO telegram_messages (chat_id, key, line_id, body, version, sent_version, message_id, created_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)
				 ON CONFLICT (chat_id, key) DO NOTHING`,
			)
			.run(chatId, `line:${lineId}`, lineId, JSON.stringify({ kind: "received" } satisfies OutboundBody), messageId, this.#now());
	}

	next(): Pending | undefined {
		const row = this.#db.prepare(`SELECT chat_id, key, version, message_id, body FROM telegram_messages WHERE ${DUE} ORDER BY rowid LIMIT 1`).get() as
			| { chat_id: number; key: MessageKey; version: number; message_id: number | null; body: string }
			| undefined;
		return row && { chatId: row.chat_id, key: row.key, version: row.version, messageId: row.message_id, body: JSON.parse(row.body) };
	}

	/** A late finish of an older version cannot undo a newer one. */
	sent(row: Pending, messageId: number): void {
		this.#db
			.prepare("UPDATE telegram_messages SET sent_version = MAX(COALESCE(sent_version, 0), ?), message_id = ? WHERE chat_id = ? AND key = ?")
			.run(row.version, messageId, row.chatId, row.key);
	}

	giveUp(row: Pending, reason: string): void {
		this.#db.prepare("UPDATE telegram_messages SET gave_up = ? WHERE chat_id = ? AND key = ?").run(reason, row.chatId, row.key);
	}

	/**
	 * Telegram may have shown `row` already, so it is never sent again; the chat gets `note` instead. One note waits per chat
	 * however many rows end this way before it goes out; a later one goes to the back of the queue.
	 */
	maybeSent(row: Pending, note: SendableBody): void {
		inTransaction(this.#db, () => {
			this.giveUp(row, "maybe-sent");
			if (this.#db.prepare(`SELECT 1 FROM telegram_messages WHERE chat_id = ? AND key = 'missed' AND ${DUE}`).get(row.chatId)) return;
			this.#db.prepare("DELETE FROM telegram_messages WHERE chat_id = ? AND key = 'missed'").run(row.chatId);
			this.put(row.chatId, "missed", null, note);
		});
	}
}
