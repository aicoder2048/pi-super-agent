/** Read-only rows of this module's collections, straight from the host's data.db (spec「工具读集合的行」). Tools never write it. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DbRow = Readonly<Record<string, unknown>>;

/** Each table in host row order, `_id` kept as the row's number; a collection the module never wrote has no table yet and reads empty. */
export function readCollections<Name extends string>(names: readonly Name[]): Record<Name, DbRow[]> {
	const empty = Object.fromEntries(names.map((name) => [name, []])) as unknown as Record<Name, DbRow[]>;
	const path = join(process.env["PSA_MODULE_DATA"] ?? "", "data.db");
	if (process.env["PSA_MODULE_DATA"] === undefined || !existsSync(path)) return empty;
	const db = new DatabaseSync(path, { readOnly: true });
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
