/** Read-only rows of this module's collections, straight from the host's data.db (spec「工具读集合的行」). Tools never write it. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DbRow = Readonly<Record<string, unknown>>;

/**
 * How long a read waits for the host's write to finish. data.db uses SQLite's rollback journal, so a reader opened while the
 * host commits another feed's rows (feeds run together on the hour and half hour) is locked out; without a wait it failed with
 * "database is locked" (vol-alerts, 2026-11-19).
 */
export const READ_WAIT_MS = 5_000;

/** The module's data.db opened read-only, waiting up to READ_WAIT_MS for a writer. */
export const openReadOnly = (path: string): DatabaseSync => new DatabaseSync(path, { readOnly: true, timeout: READ_WAIT_MS });

/** The module's data.db, or undefined when the host gave no data folder or nothing was written yet; never a relative path. */
export function dataDbPath(): string | undefined {
	const folder = process.env["PSA_MODULE_DATA"];
	if (folder === undefined || folder === "") return undefined;
	const path = join(folder, "data.db");
	return existsSync(path) ? path : undefined;
}

/** Each table in host row order, `_id` kept as the row's number; a collection the module never wrote has no table yet and reads empty. */
export function readCollections<Name extends string>(names: readonly Name[]): Record<Name, DbRow[]> {
	const empty = Object.fromEntries(names.map((name) => [name, []])) as unknown as Record<Name, DbRow[]>;
	const path = dataDbPath();
	if (path === undefined) return empty;
	const db = openReadOnly(path);
	try {
		const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
		for (const name of names) {
			if (!tables.has(name)) continue;
			empty[name] = (db.prepare(`SELECT * FROM "${name}" ORDER BY "_id"`).all() as Record<string, unknown>[]).map(({ _from: _f, _sources: _s, ...row }) => row);
		}
		return empty;
	} finally {
		db.close();
	}
}
