import { DatabaseSync } from "node:sqlite";
import { oneLine } from "../client/board-format.mjs";
import type { ModuleRecord } from "../modules/lifecycle.ts";
import {
	ACTION_KINDS,
	ACTION_STATUSES,
	BASES,
	CONVERSATION_SOURCE,
	CONVERSATION_THREAD_ID,
	DISPOSITIONS,
	HELPER_ROLES,
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
-- Covering, so triggerCountsToday uses it even before SQLite has table statistics.
CREATE INDEX IF NOT EXISTS triggers_today ON triggers (received_at, source, disposition);

CREATE TABLE IF NOT EXISTS threads (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	title TEXT
);
INSERT OR IGNORE INTO threads (id, source, title) VALUES ('${CONVERSATION_THREAD_ID}', '${CONVERSATION_SOURCE}', '对话');

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
	tokens_cached INTEGER NOT NULL DEFAULT 0,
	tokens_out INTEGER NOT NULL DEFAULT 0,
	helper_name TEXT,
	helper_role TEXT ${oneOf("helper_role", HELPER_ROLES)},
	helper_seq INTEGER,
	domain TEXT,
	module_digest TEXT,
	dispatched_to TEXT,
	read_web_at INTEGER,
	touched_private_at INTEGER,
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
	options TEXT NOT NULL DEFAULT '[]',
	drafts TEXT NOT NULL,
	waiting INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	outside_writes TEXT NOT NULL DEFAULT '[]',
	outside_omitted INTEGER NOT NULL DEFAULT 0,
	-- The scan cursor after the host's write check; NULL on a report the host did not check.
	write_scan TEXT,
	write_problem TEXT
);

-- A click on an option of the question in report_id; the trigger is the sentence the host wrote for it.
CREATE TABLE IF NOT EXISTS answer_clicks (
	trigger_id TEXT PRIMARY KEY REFERENCES triggers(id),
	report_id TEXT NOT NULL REFERENCES reports(id),
	option INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS answer_clicks_report ON answer_clicks (report_id);

CREATE TABLE IF NOT EXISTS trigger_quotes (
	trigger_id TEXT PRIMARY KEY REFERENCES triggers(id),
	line_id TEXT NOT NULL CHECK (line_id GLOB 'trg_*' OR line_id GLOB 'rpl_*' OR line_id GLOB 'ask_cap_*'),
	who TEXT NOT NULL CHECK (who IN ('user', 'router')),
	said_at INTEGER NOT NULL,
	text TEXT NOT NULL CHECK (length(text) > 0 AND instr(text, char(10)) = 0 AND instr(text, char(13)) = 0),
	ticket_id TEXT REFERENCES tickets(id)
);

-- One row per New York day on which the host asked the user to raise the member cap. said is the user's sentence for the answer.
CREATE TABLE IF NOT EXISTS cap_asks (
	day TEXT PRIMARY KEY,
	state TEXT NOT NULL CHECK (state IN ('asked', 'granted', 'declined')),
	asked_at INTEGER NOT NULL,
	answered_at INTEGER,
	said TEXT,
	expired_at INTEGER,
	CHECK ((state = 'asked') = (answered_at IS NULL) AND (state = 'asked') = (said IS NULL))
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

CREATE TABLE IF NOT EXISTS source_user_data (
	source TEXT PRIMARY KEY,
	data TEXT NOT NULL,
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

-- AUTOINCREMENT: sqlite_sequence keeps the highest number ever given, so a deleted row's number never comes back.
CREATE TABLE IF NOT EXISTS apps (
	number INTEGER PRIMARY KEY AUTOINCREMENT,
	short TEXT NOT NULL CHECK (length(short) BETWEEN 1 AND 24),
	ticket_id TEXT NOT NULL REFERENCES tickets(id),
	created_at INTEGER NOT NULL,
	UNIQUE (ticket_id, short)
);

CREATE TABLE IF NOT EXISTS conversation_hidden (
	line_id TEXT PRIMARY KEY,
	hidden_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_hidden_at ON conversation_hidden(hidden_at);

CREATE TABLE IF NOT EXISTS host_lines (
	id TEXT PRIMARY KEY CHECK (id GLOB 'hln_*'),
	kind TEXT NOT NULL CHECK (kind IN ('alert', 'receipt')),
	source TEXT NOT NULL,
	external_id TEXT,
	text TEXT NOT NULL,
	occurred_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	delivered_at INTEGER,
	module_title TEXT,
	module_private INTEGER,
	CHECK (
		(kind = 'alert' AND external_id IS NOT NULL AND length(text) BETWEEN 1 AND 1000 AND instr(text, char(10)) = 0 AND instr(text, char(13)) = 0)
		OR (kind = 'receipt' AND external_id IS NULL AND length(text) BETWEEN 1 AND 16000)
	),
	UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS host_lines_today ON host_lines (kind, created_at, source);

-- Two writers, one column each: the user's switch (just module on|off, the first-boot import) and the host's lifecycle record (JSON).
CREATE TABLE IF NOT EXISTS module_records (
	name TEXT PRIMARY KEY,
	switch INTEGER CHECK (switch IN (0, 1)),
	record TEXT
);
`;

export function openStore(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA foreign_keys = ON");
	if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
	db.exec(SCHEMA);
	const replyColumns = db.prepare("PRAGMA table_info(reply_receipts)").all().map((c) => (c as { name: string }).name);
	if (!replyColumns.includes("cause")) db.exec("ALTER TABLE reply_receipts ADD COLUMN cause TEXT");
	db.exec("CREATE INDEX IF NOT EXISTS reply_receipts_cause ON reply_receipts(cause)");
	const reportColumns = db.prepare("PRAGMA table_info(reports)").all().map((c) => (c as { name: string }).name);
	if (!reportColumns.includes("options")) db.exec("ALTER TABLE reports ADD COLUMN options TEXT NOT NULL DEFAULT '[]'");
	if (!reportColumns.includes("outside_writes")) db.exec("ALTER TABLE reports ADD COLUMN outside_writes TEXT NOT NULL DEFAULT '[]'");
	if (!reportColumns.includes("outside_omitted")) db.exec("ALTER TABLE reports ADD COLUMN outside_omitted INTEGER NOT NULL DEFAULT 0");
	if (!reportColumns.includes("write_scan")) db.exec("ALTER TABLE reports ADD COLUMN write_scan TEXT");
	if (!reportColumns.includes("write_problem")) db.exec("ALTER TABLE reports ADD COLUMN write_problem TEXT");
	const ticketColumns = db.prepare("PRAGMA table_info(tickets)").all().map((c) => (c as { name: string }).name);
	if (!ticketColumns.includes("helper_name")) {
		db.exec(`ALTER TABLE tickets ADD COLUMN helper_name TEXT;
			ALTER TABLE tickets ADD COLUMN helper_role TEXT ${oneOf("helper_role", HELPER_ROLES)};
			ALTER TABLE tickets ADD COLUMN helper_seq INTEGER`);
	}
	if (!ticketColumns.includes("domain")) db.exec("ALTER TABLE tickets ADD COLUMN domain TEXT");
	if (!ticketColumns.includes("module_digest")) db.exec("ALTER TABLE tickets ADD COLUMN module_digest TEXT");
	if (!ticketColumns.includes("dispatched_to")) db.exec("ALTER TABLE tickets ADD COLUMN dispatched_to TEXT");
	if (!ticketColumns.includes("read_web_at")) db.exec("ALTER TABLE tickets ADD COLUMN read_web_at INTEGER");
	if (!ticketColumns.includes("touched_private_at")) db.exec("ALTER TABLE tickets ADD COLUMN touched_private_at INTEGER");
	const hostLineColumns = db.prepare("PRAGMA table_info(host_lines)").all().map((c) => (c as { name: string }).name);
	const triggerColumns = db.prepare("PRAGMA table_info(triggers)").all().map((c) => (c as { name: string }).name);
	if (!triggerColumns.includes("private")) db.exec("ALTER TABLE triggers ADD COLUMN private INTEGER NOT NULL DEFAULT 0");
	if (!hostLineColumns.includes("module_title")) db.exec("ALTER TABLE host_lines ADD COLUMN module_title TEXT; ALTER TABLE host_lines ADD COLUMN module_private INTEGER");
	if (!ticketColumns.includes("tokens_cached")) db.exec("ALTER TABLE tickets ADD COLUMN tokens_cached INTEGER NOT NULL DEFAULT 0");
	const retitle = db.prepare("UPDATE tickets SET title = ? WHERE id = ?");
	for (const { id, title } of db.prepare("SELECT id, title FROM tickets").all() as { id: string; title: string }[]) {
		if (oneLine(title) !== title) retitle.run(oneLine(title), id);
	}
	return db;
}

export interface ModuleRow {
	name: string;
	/** Null: the user never switched it, so its default applies. */
	switch: boolean | null;
	/** Null: the host has not seen it yet. */
	record: ModuleRecord | null;
}

export function moduleRows(db: DatabaseSync): ModuleRow[] {
	return (db.prepare("SELECT name, switch, record FROM module_records ORDER BY name").all() as { name: string; switch: number | null; record: string | null }[]).map((r) => ({
		name: r.name,
		switch: r.switch === null ? null : r.switch === 1,
		record: r.record === null ? null : withOpened(JSON.parse(r.record)),
	}));
}

function withOpened(record: Omit<ModuleRecord, "opened"> & { opened?: boolean }): ModuleRecord {
	const { state } = record;
	return { ...record, opened: record.opened ?? (record.attempts > 0 || state.at === "staging" || state.at === "active" || (state.at === "missing" && state.wasOn)) };
}

export function setModuleSwitch(db: DatabaseSync, name: string, on: boolean): void {
	db.prepare("INSERT INTO module_records (name, switch) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET switch = excluded.switch").run(name, on ? 1 : 0);
}

export function saveModuleRecord(db: DatabaseSync, record: ModuleRecord): void {
	db.prepare("INSERT INTO module_records (name, record) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET record = excluded.record").run(record.name, JSON.stringify(record));
}

/** The package versions open tickets are pinned to. Their copies must stay. */
export function pinnedCopies(db: DatabaseSync): { module: string; digest: string; tickets: number }[] {
	return db.prepare("SELECT domain AS module, module_digest AS digest, COUNT(*) AS tickets FROM tickets WHERE closed_at IS NULL AND module_digest IS NOT NULL GROUP BY domain, module_digest").all() as { module: string; digest: string; tickets: number }[];
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
