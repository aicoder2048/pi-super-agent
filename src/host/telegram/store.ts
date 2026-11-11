// Sole owner of the telegram_* tables in the shared state.db. Offsets, chat ids and message ids only mean
// something to one bot, so they live together here and are wiped together when the bot changes.
import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "../../kernel/store.ts";
import type { CardView, OutboundBody } from "./rules.ts";

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
CREATE TABLE IF NOT EXISTS telegram_taps (
	update_id INTEGER PRIMARY KEY,
	toast TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_owed_notes (
	chat_id INTEGER PRIMARY KEY
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_messages_shown ON telegram_messages(chat_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS telegram_messages_due ON telegram_messages(chat_id) WHERE gave_up IS NULL AND (sent_version IS NULL OR sent_version < version);
`;

const DUE = "gave_up IS NULL AND (sent_version IS NULL OR sent_version < version)";
const CARD_STATUS = "body ->> '$.view.status.kind'";
// A card that closed before Telegram ever showed it has nothing to tell the user. If its first send is still in flight, sent() records the message_id and the close goes out as an edit.
const NOTHING_TO_CLOSE = `message_id IS NULL AND ${CARD_STATUS} IS 'closed'`;
// Only a new text message carries the may-be-missing note: a message edited in place, such as a card, would not show it as news.
const CARRIES_NOTE = "body ->> '$.kind' IN ('line', 'note') AND message_id IS NULL";
// The standalone note is an empty text message: the note it carries is all it says.
const STANDALONE_NOTE: SendableBody = { kind: "note", text: "" };

/**
 * `line:<lineId>` shows a conversation line, `ask:<reportId>` is the card for a helper's question, `cap:<capAskId>` the member-cap note,
 * `note:<updateId>` answers one update, `setup` tells a writer their id, `missed` carries an owed note when nothing else will,
 * `alert:<hostLineId>` is a source's alert.
 */
export type MessageKey = `line:${string}` | `ask:${string}` | `cap:${string}` | `note:${number}` | `alert:${string}` | "setup" | "missed";

export type SendableBody = Exclude<OutboundBody, { kind: "received" }>;

export interface Pending {
	chatId: number;
	key: MessageKey;
	version: number;
	messageId: number | null;
	body: SendableBody;
	/** The chat owes the may-be-missing note and this message carries it. */
	note: boolean;
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
				this.#db.exec("DELETE FROM telegram_messages; DELETE FROM telegram_chats; DELETE FROM telegram_taps; DELETE FROM telegram_owed_notes; DELETE FROM telegram_bot");
				this.#db.prepare("INSERT INTO telegram_bot (id, bot_id) VALUES (1, ?)").run(this.#botId);
			}
			this.#db.prepare("DELETE FROM telegram_messages WHERE chat_id NOT IN (SELECT value FROM json_each(?))").run(keep);
			this.#db.prepare("DELETE FROM telegram_chats WHERE chat_id NOT IN (SELECT value FROM json_each(?))").run(keep);
			this.#db.prepare("DELETE FROM telegram_owed_notes WHERE chat_id NOT IN (SELECT value FROM json_each(?))").run(keep);
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

	/** Telegram said the user blocked the bot. What was waiting for this chat is dropped, an owed note too, so unblocking does not replay it. */
	blockChat(chatId: number): void {
		inTransaction(this.#db, () => {
			this.#db.prepare("UPDATE telegram_chats SET blocked_at = ? WHERE chat_id = ?").run(this.#now(), chatId);
			this.#db.prepare(`UPDATE telegram_messages SET gave_up = 'blocked' WHERE chat_id = ? AND ${DUE}`).run(chatId);
			this.#forgiveNote(chatId);
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

	/** The conversation line a message in the chat shows; undefined for a card, a note, or a message this store never saw. */
	lineOf(chatId: number, messageId: number): string | undefined {
		const row = this.#db.prepare("SELECT line_id FROM telegram_messages WHERE chat_id = ? AND message_id = ?").get(chatId, messageId) as { line_id: string | null } | undefined;
		return row?.line_id ?? undefined;
	}

	openCards(chatId: number): CardView[] {
		const rows = this.#db.prepare(`SELECT body FROM telegram_messages WHERE chat_id = ? AND key LIKE 'ask:%' AND ${CARD_STATUS} != 'closed'`).all(chatId) as { body: string }[];
		return rows.map((r) => JSON.parse(r.body).view);
	}

	/** callback_data comes from the phone and can name any question, so a tap counts only on the card that shows that question. */
	isCard(chatId: number, messageId: number, reportId: string): boolean {
		return this.#db.prepare("SELECT 1 FROM telegram_messages WHERE chat_id = ? AND message_id = ? AND key = ?").get(chatId, messageId, `ask:${reportId}`) !== undefined;
	}

	/**
	 * Handles a tap once per update: `handle` runs in the same transaction that records its toast, and a redelivered
	 * update gets that toast back without running it again.
	 */
	tapOnce(updateId: number, handle: () => string): string {
		return inTransaction(this.#db, () => {
			const seen = this.#db.prepare("SELECT toast FROM telegram_taps WHERE update_id = ?").get(updateId) as { toast: string } | undefined;
			if (seen) return seen.toast;
			const toast = handle();
			this.#db.prepare("INSERT INTO telegram_taps (update_id, toast) VALUES (?, ?)").run(updateId, toast);
			return toast;
		});
	}

	/** Also queues the standalone note for a chat that owes one and has no text waiting to carry it: one per debt. */
	next(): Pending | undefined {
		this.#db
			.prepare(
				`INSERT INTO telegram_messages (chat_id, key, body, version, created_at)
				 SELECT o.chat_id, 'missed', ?, 1, ? FROM telegram_owed_notes o
				 WHERE NOT EXISTS (SELECT 1 FROM telegram_messages m WHERE m.chat_id = o.chat_id AND (m.key = 'missed' OR (${DUE} AND ${CARRIES_NOTE})))`,
			)
			.run(JSON.stringify(STANDALONE_NOTE), this.#now());
		const row = this.#db
			.prepare(
				`SELECT m.chat_id, key, version, message_id, body, o.chat_id IS NOT NULL AND ${CARRIES_NOTE} AS note
				 FROM telegram_messages m LEFT JOIN telegram_owed_notes o ON o.chat_id = m.chat_id WHERE ${DUE} AND NOT (${NOTHING_TO_CLOSE}) ORDER BY m.rowid LIMIT 1`,
			)
			.get() as { chat_id: number; key: MessageKey; version: number; message_id: number | null; body: string; note: number } | undefined;
		return row && { chatId: row.chat_id, key: row.key, version: row.version, messageId: row.message_id, body: JSON.parse(row.body), note: row.note === 1 };
	}

	/** A late finish of an older version cannot undo a newer one. Telegram showing a message that carried the note settles the chat's debt. */
	sent(row: Pending, messageId: number): void {
		inTransaction(this.#db, () => {
			this.#db
				.prepare("UPDATE telegram_messages SET sent_version = MAX(COALESCE(sent_version, 0), ?), message_id = ? WHERE chat_id = ? AND key = ?")
				.run(row.version, messageId, row.chatId, row.key);
			if (row.note) this.#forgiveNote(row.chatId);
		});
	}

	giveUp(row: Pending, reason: string): void {
		this.#db.prepare("UPDATE telegram_messages SET gave_up = ? WHERE chat_id = ? AND key = ?").run(reason, row.chatId, row.key);
	}

	/**
	 * Telegram may have shown `row` already, so it is never sent again, and the chat owes the may-be-missing note until a
	 * message carrying it surely arrives. A doubtful send of a carrying message, the standalone note included, leaves the debt
	 * as it was: Telegram may take messages and still answer with errors, and a retried note would flood the phone.
	 */
	maybeSent(row: Pending): void {
		inTransaction(this.#db, () => {
			this.giveUp(row, "maybe-sent");
			this.#db.prepare("INSERT INTO telegram_owed_notes (chat_id) VALUES (?) ON CONFLICT DO NOTHING").run(row.chatId);
		});
	}

	/** Dropping the standalone row lets the next debt queue its own. */
	#forgiveNote(chatId: number): void {
		this.#db.prepare("DELETE FROM telegram_owed_notes WHERE chat_id = ?").run(chatId);
		this.#db.prepare("DELETE FROM telegram_messages WHERE chat_id = ? AND key = 'missed'").run(chatId);
	}
}
