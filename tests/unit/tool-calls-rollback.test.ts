import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { instanceData } from "../../src/modules/instance-data.ts";
import type { Component, ModuleName } from "../../src/modules/manifest.ts";

// e40f990's statements on data.db, verbatim: what the host runs if it is rolled back to before _tool_calls.
const MAIN_TABLES =
	"CREATE TABLE IF NOT EXISTS _access (at TEXT NOT NULL, who TEXT NOT NULL, collection TEXT NOT NULL, op TEXT NOT NULL, rows INTEGER NOT NULL, outcome TEXT NOT NULL); CREATE TABLE IF NOT EXISTS _conditions (id TEXT PRIMARY KEY, collection TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, params TEXT NOT NULL, set_at TEXT NOT NULL, note TEXT); CREATE TABLE IF NOT EXISTS _feed_rows (source TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (source, id)); CREATE TABLE IF NOT EXISTS _feeds (source TEXT PRIMARY KEY, cursor TEXT, last_run_at INTEGER); CREATE TABLE IF NOT EXISTS _feed_connectors (source TEXT PRIMARY KEY, cursor TEXT)";
const MAIN_ACCESS = "INSERT INTO _access VALUES (?, ?, ?, ?, ?, ?)";

const notes: Component = { kind: "data", name: "notes" as Component["name"], collection: { title: "笔记", kind: "record", class: "shareable", fields: { text: { type: "text", title: "内容" } } }, seeded: false } as Component;

test("记过 _tool_calls 的 data.db，回退到 e40f990 后旧语句照常建表、写 _access，读写集合不受影响", () => {
	const data = instanceData(mkdtempSync(join(tmpdir(), "psa-rollback-")));
	const module = "alpha" as ModuleName;
	data.write(module, [notes], "notes", [{ text: "a" }], "tkt_1", "tkt_1 helper");
	data.recordToolCall(module, { caller: "beta" as ModuleName, ticket: "tkt_1", member: "analyst", basis: "inference", tool: "tools/level", outcome: "ok", ms: 12 });

	const db = new DatabaseSync(join(data.dir(module), "data.db"));
	try {
		db.exec(MAIN_TABLES);
		db.prepare(MAIN_ACCESS).run("2026-11-16T00:00:00.000Z", "tkt_2 helper", "notes", "read", 1, "ok");
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM _tool_calls").get() as { n: number }).n, 1, "回退不动 _tool_calls");
	} finally {
		db.close();
	}
	assert.deepEqual(data.check(module, [notes]), []);
	assert.deepEqual(data.query(module, [notes], "notes", {}, "tkt_3 helper").rows.map((r) => r.fields.text), ["a"]);
});
