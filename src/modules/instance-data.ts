/** Stored structure only grows (design.md H6). `_structure` holds everything ever stored, hidden fields and aliases included. */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { moduleDataDir } from "./knowledge.ts";
import { structureChanges, type CollectionDescriptor, type Component, type ComponentName, type DataClass, type FieldDescriptor, type ModuleName } from "./manifest.ts";
import type { Json, Query, Row } from "./protocol.ts";
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

/** Declaring an old name again creates a new thing, so its alias is dropped. */
const unshadowed = (aliases: Record<string, string>, names: object) => Object.fromEntries(Object.entries(aliases).filter(([old]) => !Object.hasOwn(names, old)));

const asComponents = (stored: Stored): Component[] =>
	Object.entries(stored.collections).map(([name, { aliases: _, ...collection }]) => ({ kind: "data", name: name as ComponentName, collection, seeded: false }));

function plan(stored: Stored, components: readonly Component[]): { sql: string[]; next: Stored } {
	const sql: string[] = [];
	const next: Stored = { collections: { ...stored.collections }, aliases: { ...stored.aliases } };
	for (const component of components) {
		if (component.kind !== "data") continue;
		const { name, collection } = component;
		const { was, fields: declared, ...described } = collection;
		const from = [name, was].find((n) => n !== undefined && Object.hasOwn(next.collections, n));
		if (from === undefined) {
			sql.push(`CREATE TABLE ${quote(name)} ("_id" INTEGER PRIMARY KEY, "_from" TEXT NOT NULL, "_sources" TEXT${Object.entries(declared).map(([f, d]) => `, ${column(f, d)}`).join("")})`);
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
					sql.push(`UPDATE ${quote(name)} SET "_sources" = json_set(json_remove("_sources", '$.${old}'), '$.${field}', "_sources" ->> '$.${old}') WHERE "_sources" ->> '$.${old}' IS NOT NULL`);
					delete fields[old];
					aliases = renamed(aliases, old, field);
				} else sql.push(`ALTER TABLE ${quote(name)} ADD COLUMN ${column(field, descriptor)}`);
			}
			fields[field] = plain(descriptor);
		}
		next.collections[name] = { ...described, fields, aliases: unshadowed(aliases, fields) };
	}
	next.aliases = unshadowed(next.aliases, next.collections);
	return { sql, next };
}

function readStored(db: DatabaseSync): Stored {
	if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_structure'").get() === undefined) return EMPTY;
	const row = db.prepare("SELECT json FROM _structure").get() as { json: string } | undefined;
	return row === undefined ? EMPTY : (JSON.parse(row.json) as Stored);
}

/** A leftover journal belongs to the replaced file, and SQLite would replay it onto the snapshot. */
function restore(path: string, snapshot: string): void {
	for (const suffix of ["-journal", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
	copyFileSync(snapshot, path);
}

/**
 * A snapshot lives only inside one `migrate` call. One left by a crash is never restored: rows
 * written since would be lost, and SQLite's own journal already brings `data.db` back to whole.
 * Opening read-write lets SQLite roll that journal back.
 */
function openDiscardingSnapshot(path: string): DatabaseSync {
	rmSync(`${path}.snapshot`, { force: true });
	return new DatabaseSync(path);
}

const failed = (error: unknown) => (error instanceof Error ? error.message : String(error));

const problemText = (problems: readonly { where: string; reason: string }[]) => problems.map((p) => `${p.where}：${p.reason}`).join("；");

const problemsFor = (stored: Stored, components: readonly Component[]) => structureChanges(asComponents(stored), components).problems;

export class DataInputError extends Error {}

type DataComponent = Extract<Component, { kind: "data" }>;
type Value = Extract<SQLInputValue, string | number | null>;
type Op = "read" | "write";

/** What a read or write touched. `collection` is the current name, whatever name the caller used. */
export type Accessed = { collection: ComponentName; class: DataClass; rows: Row[] };

/** `components` is the serving version: its structure is ensured first, and it decides which fields show. */
export interface ModuleRows {
	query(module: ModuleName, components: readonly Component[], collection: string, query: Query, who: string): Accessed;
	write(module: ModuleName, components: readonly Component[], collection: string, rows: readonly Json[], from: string, who: string): Accessed;
}

const LIMIT = { fallback: 50, max: 500 };

/**
 * An old name reaches the current one through the stored aliases or a declared `was`. A declared
 * name wins over both, because an old name can be given to a new collection or field later.
 */
function resolve(stored: Stored, components: readonly Component[], requested: string) {
	const collections = components.filter((c): c is DataComponent => c.kind === "data");
	const declared = (name: string | undefined) => collections.find((c) => c.name === name);
	const component = declared(requested) ?? declared(stored.aliases[requested]) ?? collections.find((c) => c.collection.was === requested);
	if (component === undefined) throw new DataInputError(`没有「${requested}」这类数据`);
	const { fields } = component.collection;
	const aliases = stored.collections[component.name]?.aliases ?? {};
	const field = (name: string): string => {
		const now = Object.hasOwn(fields, name) ? name : (aliases[name] ?? Object.keys(fields).find((f) => fields[f]!.was === name));
		if (now === undefined || !Object.hasOwn(fields, now)) throw new DataInputError(`「${component.name}」没有字段「${name}」，有：${Object.keys(fields).join("、")}`);
		return now;
	};
	return { component, field };
}

function valueOf(field: FieldDescriptor, name: string, value: Json | undefined): Value {
	if (value === null || value === undefined) return null;
	if (field.type === "number" && typeof value === "number" && Number.isFinite(value)) return value;
	if (field.type !== "number" && typeof value === "string") return value;
	throw new DataInputError(`字段「${name}」要${field.type === "number" ? "数字" : "文字"}，收到 ${JSON.stringify(value)}`);
}

const timeField = ({ watch, fields }: CollectionDescriptor) => watch?.at ?? Object.keys(fields).find((name) => fields[name]!.type === "date");

const sourcesOf = (row: Record<string, Value>): Record<string, string> => (row._sources === null || row._sources === undefined ? {} : JSON.parse(String(row._sources)));

function rowOf(fields: readonly string[], row: Record<string, Value>): Row {
	const sources = Object.fromEntries(Object.entries(sourcesOf(row)).filter(([field]) => fields.includes(field)));
	return {
		id: String(row._id),
		from: String(row._from),
		fields: Object.fromEntries(fields.map((f) => [f, row[f] ?? null])),
		...(Object.keys(sources).length > 0 && { sources }),
	};
}

export function instanceData(stateDir: string): InstanceData & ModuleRows {
	const pathOf = (module: ModuleName) => join(moduleDataDir(stateDir, module), "data.db");
	/** Ensures the structure, then one short-lived connection in rollback-journal mode, so migrate's file snapshot always holds every committed row. */
	const withRows = <T>(module: ModuleName, components: readonly Component[], access: { who: string; collection: string; op: Op }, use: (db: DatabaseSync, stored: Stored) => T): T => {
		const ensured = data.migrate(module, components);
		if (!ensured.ok) throw new Error(ensured.reason);
		const db = new DatabaseSync(pathOf(module));
		try {
			db.exec("CREATE TABLE IF NOT EXISTS _access (at TEXT NOT NULL, who TEXT NOT NULL, collection TEXT NOT NULL, op TEXT NOT NULL, rows INTEGER NOT NULL, outcome TEXT NOT NULL)");
			return use(db, readStored(db));
		} catch (error) {
			if (error instanceof DataInputError) logAccess(db, access.who, access.collection, access.op, 0, `refused：${error.message}`);
			throw error;
		} finally {
			db.close();
		}
	};
	const logAccess = (db: DatabaseSync, who: string, collection: string, op: Op, rows: number, outcome = "ok") =>
		db.prepare("INSERT INTO _access VALUES (?, ?, ?, ?, ?, ?)").run(new Date().toISOString(), who, collection, op, rows, outcome);

	const data: InstanceData & ModuleRows = {
		check(module, components) {
			const path = pathOf(module);
			if (!existsSync(path)) return [];
			try {
				const db = openDiscardingSnapshot(path);
				try {
					return problemsFor(readStored(db), components);
				} finally {
					db.close();
				}
			} catch (error) {
				return [{ where: "data.db", reason: `the stored data could not be read: ${failed(error)}` }];
			}
		},
		migrate(module, components) {
			const path = pathOf(module);
			const snapshot = `${path}.snapshot`;
			if (!existsSync(path) && !components.some((c) => c.kind === "data")) return { ok: true };
			let db: DatabaseSync | undefined;
			try {
				mkdirSync(join(dirname(path), "blobs"), { recursive: true });
				db = openDiscardingSnapshot(path);
				const before = readStored(db);
				const problems = problemsFor(before, components);
				if (problems.length > 0) return { ok: false, reason: problemText(problems) };
				const { sql, next } = plan(before, components);
				if (JSON.stringify(next) === JSON.stringify(before)) return { ok: true };
				copyFileSync(path, snapshot);
				try {
					db.exec("BEGIN");
					for (const statement of sql) db.exec(statement);
					db.exec("CREATE TABLE IF NOT EXISTS _structure (json TEXT NOT NULL); DELETE FROM _structure");
					db.prepare("INSERT INTO _structure VALUES (?)").run(JSON.stringify(next));
					db.exec("COMMIT");
				} catch (error) {
					db.close();
					restore(path, snapshot);
					return { ok: false, reason: failed(error) };
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, reason: failed(error) };
			} finally {
				if (db?.isOpen) db.close();
				rmSync(snapshot, { force: true });
			}
		},
		purge(module) {
			rmSync(moduleDataDir(stateDir, module), { recursive: true, force: true });
		},
		query(module, components, collection, query, who) {
			return withRows(module, components, { who, collection, op: "read" }, (db, stored) => {
				const { component, field } = resolve(stored, components, collection);
				const visible = Object.keys(component.collection.fields);
				const time = timeField(component.collection);
				const where = Object.entries(query.where ?? {}).map(([name, value]) => {
					if (typeof value !== "string" && typeof value !== "number") throw new DataInputError(`条件「${name}」要是文字或数字，收到 ${JSON.stringify(value)}`);
					return [field(name), value] as const;
				});
				if ((query.since !== undefined || query.until !== undefined) && time === undefined) throw new DataInputError(`「${component.name}」没有日期字段，不能按时间查`);
				const conditions = [
					...where.map(([name, value]) => [`${quote(name)} = ?`, value] as const),
					...(query.since === undefined ? [] : [[`${quote(time!)} >= ?`, query.since] as const]),
					...(query.until === undefined ? [] : [[`${quote(time!)} <= ?`, query.until] as const]),
				];
				const limit = Math.min(Math.max(0, Math.trunc(query.limit ?? LIMIT.fallback)), LIMIT.max);
				const sql = `SELECT * FROM ${quote(component.name)}${conditions.length ? ` WHERE ${conditions.map(([c]) => c).join(" AND ")}` : ""} ORDER BY ${time === undefined ? "" : `${quote(time)} DESC, `}"_id" DESC LIMIT ?`;
				const rows = (db.prepare(sql).all(...conditions.map(([, v]) => v), limit) as Record<string, Value>[]).map((row) => rowOf(visible, row));
				logAccess(db, who, component.name, "read", rows.length);
				return { collection: component.name, class: component.collection.class, rows };
			});
		},
		write(module, components, collection, rows, from, who) {
			return withRows(module, components, { who, collection, op: "write" }, (db, stored) => {
				if (from.trim() === "") throw new DataInputError("写数据要写 from：这些行从哪里来，例如原件的路径，或「使用者口述」");
				const { component, field } = resolve(stored, components, collection);
				const { fields, kind } = component.collection;
				const table = quote(component.name);
				const ids: number[] = [];
				db.exec("BEGIN");
				try {
					for (const row of rows) {
						if (row === null || typeof row !== "object" || Array.isArray(row)) throw new DataInputError(`每一行要是一个对象，收到 ${JSON.stringify(row)}`);
						const { id, ...given } = row as Record<string, Json>;
						const values = Object.entries(given).map(([name, value]) => {
							const now = field(name);
							return [now, valueOf(fields[now]!, name, value)] as const;
						});
						if (id === undefined) {
							const names = ["_from", ...values.map(([n]) => n)].map(quote);
							const result = db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(from, ...values.map(([, v]) => v));
							ids.push(Number(result.lastInsertRowid));
							continue;
						}
						if (kind === "series") throw new DataInputError(`「${component.name}」是 series，只能追加新行，不能按 id 改`);
						const before = db.prepare(`SELECT "_from", "_sources" FROM ${table} WHERE "_id" = ?`).get(Number(id)) as Record<string, Value> | undefined;
						if (before === undefined) throw new DataInputError(`「${component.name}」没有 id 为 ${JSON.stringify(id)} 的一行`);
						const sources = sourcesOf(before);
						for (const [name] of values) {
							if (from === before._from) delete sources[name];
							else sources[name] = from;
						}
						const set = [...values.map(([n]) => `${quote(n)} = ?`), `"_sources" = ?`].join(", ");
						db.prepare(`UPDATE ${table} SET ${set} WHERE "_id" = ?`).run(...values.map(([, v]) => v), Object.keys(sources).length > 0 ? JSON.stringify(sources) : null, Number(id));
						ids.push(Number(id));
					}
					logAccess(db, who, component.name, "write", ids.length);
					db.exec("COMMIT");
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
				const visible = Object.keys(fields);
				const read = db.prepare(`SELECT * FROM ${table} WHERE "_id" = ?`);
				return { collection: component.name, class: component.collection.class, rows: ids.map((id) => rowOf(visible, read.get(id) as Record<string, Value>)) };
			});
		},
	};
	return data;
}
