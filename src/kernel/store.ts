import { DatabaseSync } from "node:sqlite";
import {
	ACTION_KINDS,
	ACTION_STATUSES,
	BASES,
	CONVERSATION_THREAD_ID,
	DISPOSITIONS,
	INPUT_KINDS,
	REPORT_STATUSES,
	WORKER_STATES,
} from "./types.ts";

const oneOf = (column: string, values: readonly string[]) =>
	`CHECK (${column} IN (${values.map((v) => `'${v}'`).join(", ")}))`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sequence (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
INSERT OR IGNORE INTO sequence (id, value) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS triggers (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	external_id TEXT NOT NULL,
	sender TEXT NOT NULL,
	body TEXT NOT NULL,
	occurred_at INTEGER NOT NULL,
	received_at INTEGER NOT NULL,
	disposition TEXT NOT NULL ${oneOf("disposition", DISPOSITIONS)},
	disposition_detail TEXT,
	UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS threads (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	title TEXT
);
INSERT OR IGNORE INTO threads (id, source, title) VALUES ('${CONVERSATION_THREAD_ID}', 'conversation', '对话');

CREATE TABLE IF NOT EXISTS trigger_threads (
	trigger_id TEXT NOT NULL REFERENCES triggers(id),
	thread_id TEXT NOT NULL REFERENCES threads(id),
	PRIMARY KEY (trigger_id, thread_id)
);

CREATE TABLE IF NOT EXISTS tickets (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	basis TEXT NOT NULL ${oneOf("basis", BASES)},
	rule_id TEXT,
	origin_trigger_id TEXT REFERENCES triggers(id),
	created_at INTEGER NOT NULL,
	worker_session_id TEXT NOT NULL,
	worker_state TEXT NOT NULL ${oneOf("worker_state", WORKER_STATES)},
	bg_running INTEGER NOT NULL DEFAULT 0,
	stopped_at INTEGER,
	closed_at INTEGER,
	last_progress_at INTEGER,
	started_at INTEGER,
	model TEXT,
	fell_back INTEGER NOT NULL DEFAULT 0,
	tool_calls INTEGER NOT NULL DEFAULT 0,
	tokens_in INTEGER NOT NULL DEFAULT 0,
	tokens_out INTEGER NOT NULL DEFAULT 0,
	CHECK (basis <> 'rule' OR rule_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS subscriptions (
	ticket_id TEXT NOT NULL REFERENCES tickets(id),
	thread_id TEXT NOT NULL REFERENCES threads(id) CHECK (thread_id <> '${CONVERSATION_THREAD_ID}'),
	PRIMARY KEY (ticket_id, thread_id)
);

CREATE TABLE IF NOT EXISTS ticket_inputs (
	id TEXT PRIMARY KEY,
	seq INTEGER NOT NULL,
	ticket_id TEXT NOT NULL REFERENCES tickets(id),
	kind TEXT NOT NULL ${oneOf("kind", INPUT_KINDS)},
	trigger_id TEXT REFERENCES triggers(id),
	body TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	delivered_at INTEGER
);

CREATE TABLE IF NOT EXISTS reports (
	id TEXT PRIMARY KEY,
	seq INTEGER NOT NULL,
	ticket_id TEXT NOT NULL REFERENCES tickets(id),
	status TEXT NOT NULL ${oneOf("status", REPORT_STATUSES)},
	summary TEXT NOT NULL,
	question TEXT,
	drafts TEXT NOT NULL,
	waiting INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	decision TEXT NOT NULL,
	ok INTEGER NOT NULL,
	reason TEXT,
	ticket_id TEXT,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
	id TEXT PRIMARY KEY,
	seq INTEGER NOT NULL,
	kind TEXT NOT NULL ${oneOf("kind", ACTION_KINDS)},
	payload TEXT NOT NULL,
	ticket_id TEXT,
	status TEXT NOT NULL ${oneOf("status", ACTION_STATUSES)},
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at INTEGER NOT NULL,
	last_error TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_due ON actions (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS action_attempts (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	action_id TEXT NOT NULL REFERENCES actions(id),
	kind TEXT NOT NULL,
	ok INTEGER NOT NULL,
	error TEXT,
	at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS source_cursors (
	source TEXT PRIMARY KEY,
	cursor TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily (
	day TEXT NOT NULL,
	provider TEXT NOT NULL,
	tokens INTEGER NOT NULL,
	PRIMARY KEY (day, provider)
);

CREATE TABLE IF NOT EXISTS reply_receipts (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL REFERENCES threads(id),
	ticket_id TEXT REFERENCES tickets(id),
	cause TEXT,
	text TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	delivered_at INTEGER
);
`;

export function openStore(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA foreign_keys = ON");
	if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
	db.exec(SCHEMA);
	const replyColumns = db.prepare("PRAGMA table_info(reply_receipts)").all().map((c) => (c as { name: string }).name);
	if (!replyColumns.includes("cause")) db.exec("ALTER TABLE reply_receipts ADD COLUMN cause TEXT");
	return db;
}

export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
	if (db.isTransaction) return fn();
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
