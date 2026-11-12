/**
 * Instance data: one SQLite file per module at `<stateDir>/modules-data/<name>/data.db`, originals
 * under `blobs/`. One table per collection, one column per field, and `_from` on every row naming
 * the original or the feed it came from. Stored structure only grows (design.md H6): the
 * structure as stored so far lives in the `_structure` table, hidden fields and aliases included.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { moduleDataDir } from "./knowledge.ts";
import { structureChanges, type CollectionDescriptor, type Component, type ComponentName, type FieldDescriptor, type ModuleName } from "./manifest.ts";
import type { InstanceData } from "./registry.ts";

/** `aliases` maps each old name to the current one, so a ticket pinned to an older version still reads and writes. */
type StoredCollection = Omit<CollectionDescriptor, "was"> & { fields: Record<string, Omit<FieldDescriptor, "was">>; aliases: Record<string, string> };
type Stored = { collections: Record<string, StoredCollection>; aliases: Record<string, string> };

const EMPTY: Stored = { collections: {}, aliases: {} };
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const column = (name: string, field: FieldDescriptor) => `${quote(name)} ${field.type === "number" ? "REAL" : "TEXT"}`;
const plain = ({ was: _, ...field }: FieldDescriptor) => field;
const renamed = (aliases: Record<string, string>, from: string, to: string) => ({
	...Object.fromEntries(Object.entries(aliases).map(([old, now]) => [old, now === from ? to : now])),
	[from]: to,
});

const asComponents = (stored: Stored): Component[] =>
	Object.entries(stored.collections).map(([name, { aliases: _, ...collection }]) => ({ kind: "data", name: name as ComponentName, collection, seeded: false }));

/** The statements that grow `stored` to cover `components`, and the stored structure after them. Pure. */
function plan(stored: Stored, components: readonly Component[]): { sql: string[]; next: Stored } {
	const sql: string[] = [];
	const next: Stored = { collections: { ...stored.collections }, aliases: { ...stored.aliases } };
	for (const component of components) {
		if (component.kind !== "data") continue;
		const { name, collection } = component;
		const { was, fields: declared, ...described } = collection;
		const from = [name, was].find((n) => n !== undefined && Object.hasOwn(next.collections, n));
		if (from === undefined) {
			sql.push(`CREATE TABLE ${quote(name)} ("_id" INTEGER PRIMARY KEY, "_from" TEXT NOT NULL${Object.entries(declared).map(([f, d]) => `, ${column(f, d)}`).join("")})`);
			next.collections[name] = { ...described, fields: Object.fromEntries(Object.entries(declared).map(([f, d]) => [f, plain(d)])), aliases: {} };
			continue;
		}
		if (from !== name) {
			sql.push(`ALTER TABLE ${quote(from)} RENAME TO ${quote(name)}`);
			next.aliases = renamed(next.aliases, from, name);
		}
		const before = next.collections[from]!;
		delete next.collections[from];
		const fields = { ...before.fields };
		let aliases = before.aliases;
		for (const [field, descriptor] of Object.entries(declared)) {
			if (!Object.hasOwn(fields, field)) {
				const old = descriptor.was;
				if (old !== undefined && Object.hasOwn(fields, old)) {
					sql.push(`ALTER TABLE ${quote(name)} RENAME COLUMN ${quote(old)} TO ${quote(field)}`);
					delete fields[old];
					aliases = renamed(aliases, old, field);
				} else sql.push(`ALTER TABLE ${quote(name)} ADD COLUMN ${column(field, descriptor)}`);
			}
			fields[field] = plain(descriptor);
		}
		next.collections[name] = { ...described, fields, aliases };
	}
	return { sql, next };
}

function readStored(db: DatabaseSync): Stored {
	if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_structure'").get() === undefined) return EMPTY;
	const row = db.prepare("SELECT json FROM _structure").get() as { json: string } | undefined;
	return row === undefined ? EMPTY : (JSON.parse(row.json) as Stored);
}

/** Puts the snapshot back over the database. A leftover rollback journal belongs to the replaced file, so it goes first. */
function restore(path: string, snapshot: string): void {
	for (const suffix of ["-journal", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
	copyFileSync(snapshot, path);
	rmSync(snapshot, { force: true });
}

const problemText = (problems: readonly { where: string; reason: string }[]) => problems.map((p) => `${p.where}：${p.reason}`).join("；");

const problemsFor = (stored: Stored, components: readonly Component[]) => structureChanges(asComponents(stored), components).problems;

export function instanceData(stateDir: string): InstanceData {
	const pathOf = (module: ModuleName) => join(moduleDataDir(stateDir, module), "data.db");
	return {
		check(module, components) {
			const path = pathOf(module);
			if (!existsSync(path)) return [];
			const db = new DatabaseSync(path, { readOnly: true });
			try {
				return problemsFor(readStored(db), components);
			} finally {
				db.close();
			}
		},
		migrate(module, components) {
			const path = pathOf(module);
			const snapshot = `${path}.snapshot`;
			if (!existsSync(path) && !components.some((c) => c.kind === "data")) return { ok: true };
			mkdirSync(join(dirname(path), "blobs"), { recursive: true });
			// A snapshot is only left behind by a run that stopped before it finished.
			if (existsSync(snapshot)) restore(path, snapshot);
			const db = new DatabaseSync(path);
			try {
				const before = readStored(db);
				const problems = problemsFor(before, components);
				if (problems.length > 0) return { ok: false, reason: problemText(problems) };
				const { sql, next } = plan(before, components);
				if (JSON.stringify(next) === JSON.stringify(before)) return { ok: true };
				copyFileSync(path, `${snapshot}.partial`);
				renameSync(`${snapshot}.partial`, snapshot);
				try {
					db.exec("BEGIN");
					for (const statement of sql) db.exec(statement);
					db.exec("CREATE TABLE IF NOT EXISTS _structure (json TEXT NOT NULL); DELETE FROM _structure");
					db.prepare("INSERT INTO _structure VALUES (?)").run(JSON.stringify(next));
					db.exec("COMMIT");
				} catch (error) {
					db.close();
					restore(path, snapshot);
					return { ok: false, reason: error instanceof Error ? error.message : String(error) };
				}
				rmSync(snapshot, { force: true });
				return { ok: true };
			} finally {
				if (db.isOpen) db.close();
			}
		},
		purge(module) {
			rmSync(moduleDataDir(stateDir, module), { recursive: true, force: true });
		},
	};
}
