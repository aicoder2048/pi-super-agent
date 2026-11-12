/** Stored structure only grows (design.md H6). `_structure` holds everything ever stored, hidden fields and aliases included. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { alertText, met, need, parseWatch, receiptText, type Point, type SetCondition } from "./conditions.ts";
import { moduleDataDir } from "./knowledge.ts";
import { structureChanges, type CollectionDescriptor, type Component, type ComponentName, type DataClass, type FieldDescriptor, type ModuleName } from "./manifest.ts";
import type { Alert, Condition, Json, Query, Request, Row } from "./protocol.ts";
import type { InstanceData } from "./registry.ts";

/** `aliases` maps each old name to the current one, so a ticket pinned to an older version still reads and writes. */
type StoredCollection = Omit<CollectionDescriptor, "was"> & { fields: Record<string, Omit<FieldDescriptor, "was">>; aliases: Record<string, string> };
type Stored = { collections: Record<string, StoredCollection>; aliases: Record<string, string> };

const EMPTY: Stored = { collections: {}, aliases: {} };
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
const CONDITIONS = "CREATE TABLE IF NOT EXISTS _conditions (id TEXT PRIMARY KEY, collection TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, params TEXT NOT NULL, set_at TEXT NOT NULL, note TEXT)";
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
			sql.push(`ALTER TABLE ${quote(from)} RENAME TO ${quote(name)}`, `UPDATE _conditions SET collection = ${literal(name)} WHERE collection = ${literal(from)}`);
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

const addMissingSourcesColumn = (db: DatabaseSync, stored: Stored) =>
	Object.keys(stored.collections)
		.filter((name) => db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = '_sources'`).get(name) === undefined)
		.map((name) => `ALTER TABLE ${quote(name)} ADD COLUMN "_sources" TEXT`);

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
	write(module: ModuleName, components: readonly Component[], collection: string, rows: readonly Json[], from: string, who: string): Written;
	watch(module: ModuleName, components: readonly Component[], request: WatchRequest, who: string): Watched;
}

/** `alerts`: the conditions the written rows met, for the host to post. `alertProblem`: why they could not be checked; the rows are written anyway. */
export type Written = Accessed & { alerts: readonly Alert[]; alertProblem?: string };

export type WatchRequest = Extract<Request, { kind: "watch" }>;
export type Watched = { collection: ComponentName; class: DataClass; output: { conditions: SetCondition[] } | { condition: SetCondition; receipt: string } };

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

type ConditionRow = { id: string; collection: string; key: string; kind: Condition["when"]; params: string; set_at: string; note: string | null };

function conditionsOf(db: DatabaseSync, collection: string): SetCondition[] {
	return (db.prepare("SELECT * FROM _conditions WHERE collection = ? ORDER BY rowid").all(collection) as ConditionRow[]).map((r) => ({
		id: r.id, collection: r.collection, key: r.key, condition: { when: r.kind, ...JSON.parse(r.params) } as Condition, ...(r.note !== null && { note: r.note }), setAt: r.set_at,
	}));
}

/**
 * Runs before the write: rows older than a key's stored latest time are backfill and never alert. Equal
 * times count as new, because a date-only time cannot order two readings taken the same day. A key with
 * no stored reading takes the write as history, so only its latest time counts.
 */
function watchBeforeWrite(db: DatabaseSync, { name, collection }: DataComponent): (written: readonly Record<string, Value>[]) => Alert[] {
	const watch = collection.watch;
	if (watch === undefined) return () => [];
	try {
		const conditions = conditionsOf(db, name);
		if (conditions.length === 0) return () => [];
		const [key, value, at] = [watch.key, watch.value, watch.at].map(quote);
		db.exec(`CREATE INDEX IF NOT EXISTS ${quote(`_watch_${name}`)} ON ${quote(name)} (${key}, ${at})`);
		const history = db.prepare(`SELECT ${value} AS value, ${at} AS at, "_from" AS "from" FROM ${quote(name)} WHERE ${key} = ? AND ${value} IS NOT NULL AND ${at} IS NOT NULL AND (${at} < ? OR (${at} = ? AND "_id" <= ?)) ORDER BY ${at} DESC, "_id" DESC LIMIT ?`);
		const latestOf = db.prepare(`SELECT MAX(${at}) AS at FROM ${quote(name)} WHERE ${key} = ?`);
		const latest = (k: string) => (latestOf.get(k) as { at: Value }).at;
		const before = new Map([...new Set(conditions.map((c) => c.key))].map((k) => [k, latest(k)]));
		return (written) => {
			const cutoff = new Map([...before].map(([k, t]) => [k, t ?? latest(k)]));
			const isNew = (row: Record<string, Value>) => {
				const [t, from] = [row[watch.at], cutoff.get(String(row[watch.key]))];
				return typeof row[watch.value] === "number" && typeof t === "string" && typeof from === "string" && t >= from;
			};
			const byTime = (a: Record<string, Value>, b: Record<string, Value>) => {
				const [x, y] = [String(a[watch.at]), String(b[watch.at])];
				return x < y ? -1 : x > y ? 1 : Number(a._id) - Number(b._id);
			};
			return written.filter(isNew).toSorted(byTime).flatMap((row) => {
				const [k, t] = [String(row[watch.key]), String(row[watch.at])];
				const mine = conditions.filter((c) => c.key === k);
				const points = (history.all(k, t, t, row._id!, Math.max(...mine.map((c) => need(c.condition)))) as Point[]).reverse();
				return mine.flatMap((c) => {
					const happened = met(c.condition, points);
					return happened === undefined ? [] : [{ externalId: `${c.id}:${row._id}`, text: alertText(collection.title, c, points.at(-1)!, happened), at: t, private: collection.class === "private" }];
				});
			});
		};
	} catch (error) {
		return () => {
			throw error;
		};
	}
}

export function instanceData(stateDir: string): InstanceData & ModuleRows {
	const pathOf = (module: ModuleName) => join(moduleDataDir(stateDir, module), "data.db");
	const withRows = <T>(module: ModuleName, components: readonly Component[], access: { who: string; collection: string; op: Op }, use: (db: DatabaseSync, stored: Stored) => T): T => {
		const ensured = data.migrate(module, components);
		if (!ensured.ok) throw new Error(ensured.reason);
		const db = new DatabaseSync(pathOf(module));
		try {
			db.exec(`CREATE TABLE IF NOT EXISTS _access (at TEXT NOT NULL, who TEXT NOT NULL, collection TEXT NOT NULL, op TEXT NOT NULL, rows INTEGER NOT NULL, outcome TEXT NOT NULL); ${CONDITIONS}`);
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
				const db = new DatabaseSync(path);
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
			if (!existsSync(path) && !components.some((c) => c.kind === "data")) return { ok: true };
			let db: DatabaseSync | undefined;
			try {
				mkdirSync(join(dirname(path), "blobs"), { recursive: true });
				db = new DatabaseSync(path);
				const before = readStored(db);
				const problems = problemsFor(before, components);
				if (problems.length > 0) return { ok: false, reason: problemText(problems) };
				const sourcesBackfill = addMissingSourcesColumn(db, before);
				const { sql, next } = plan(before, components);
				if (sourcesBackfill.length === 0 && JSON.stringify(next) === JSON.stringify(before)) return { ok: true };
				// SQLite is the rollback: closing with the transaction still open undoes it, and a hot
				// journal left by a crash is rolled back on the next open.
				db.exec("BEGIN");
				db.exec(CONDITIONS);
				for (const statement of [...sourcesBackfill, ...sql]) db.exec(statement);
				db.exec("CREATE TABLE IF NOT EXISTS _structure (json TEXT NOT NULL); DELETE FROM _structure");
				db.prepare("INSERT INTO _structure VALUES (?)").run(JSON.stringify(next));
				db.exec("COMMIT");
				return { ok: true };
			} catch (error) {
				return { ok: false, reason: failed(error) };
			} finally {
				if (db?.isOpen) db.close();
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
				const alertsFor = watchBeforeWrite(db, component);
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
				const written = ids.map((id) => read.get(id) as Record<string, Value>);
				const answer = { collection: component.name, class: component.collection.class, rows: written.map((row) => rowOf(visible, row)) };
				try {
					return { ...answer, alerts: alertsFor(written) };
				} catch (error) {
					return { ...answer, alerts: [], alertProblem: failed(error) };
				}
			});
		},
		watch(module, components, request, who) {
			return withRows(module, components, { who, collection: request.collection, op: request.op === "list" ? "read" : "write" }, (db, stored) => {
				const { component } = resolve(stored, components, request.collection);
				const { name, collection } = component;
				if (collection.watch === undefined) throw new DataInputError(`「${name}」没有写 watch，不能设提醒条件`);
				const answer = (output: Watched["output"], op: Op, rows: number): Watched => {
					logAccess(db, who, name, op, rows);
					return { collection: name, class: collection.class, output };
				};
				if (request.op === "list") {
					const conditions = conditionsOf(db, name);
					return answer({ conditions }, "read", conditions.length);
				}
				const id = request.op === "remove" ? request.id : request.watch.id;
				const before = id === undefined ? undefined : conditionsOf(db, name).find((c) => c.id === id);
				if (id !== undefined && before === undefined) throw new DataInputError(`「${name}」没有编号为 ${id} 的提醒条件，现有的用 list 看`);
				if (request.op === "remove") {
					db.prepare("DELETE FROM _conditions WHERE id = ?").run(id!);
					return answer({ condition: before!, receipt: receiptText("已去掉", collection.title, before!) }, "write", 1);
				}
				const parsed = parseWatch(request.watch);
				if (typeof parsed === "string") throw new DataInputError(parsed);
				const { condition: { when, ...params }, key, note } = parsed;
				const kept: SetCondition = { id: before?.id ?? `cnd_${randomUUID()}`, collection: name, key, condition: parsed.condition, ...(note !== undefined && { note }), setAt: new Date().toISOString() };
				db.prepare("INSERT OR REPLACE INTO _conditions VALUES (?, ?, ?, ?, ?, ?, ?)").run(kept.id, name, key, when, JSON.stringify(params), kept.setAt, note ?? null);
				return answer({ condition: kept, receipt: receiptText(before ? "已改" : "已设", collection.title, kept) }, "write", 1);
			});
		},
	};
	return data;
}
