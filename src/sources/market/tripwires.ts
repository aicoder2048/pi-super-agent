import { parseSymbol } from "./symbol.ts";

export type Sym = string & { readonly __sym: unique symbol };
export const parseSym = (raw: unknown): Sym | undefined => parseSymbol(raw) as Sym | undefined;

export type Direction = "up" | "down" | "either";
export type Side = "up" | "down";
export type CrossShape = "golden" | "death";

export type Condition =
	| { kind: "day"; pct: number; dir: Direction }
	| { kind: "cost"; pct: number; dir: Direction; basis: number; shares?: number }
	| { kind: "cross"; fast: number; slow: number };
export type ConditionKind = Condition["kind"];

export interface Tripwire {
	symbol: Sym;
	condition: Condition;
	setAt: number;
}

export type TripwireKey = `${string}:${ConditionKind}`;
export const keyOf = (t: { symbol: Sym; condition: { kind: ConditionKind } }): TripwireKey => `${t.symbol}:${t.condition.kind}`;

export type Book = ReadonlyMap<TripwireKey, Tripwire>;

export const LIMITS = {
	// Same cap as MAX_WATCHLIST, so one snapshot request still covers every polled symbol.
	polledSymbols: 50,
	crossSymbols: 10,
	pct: { min: 0.1, max: 100 },
	basis: { min: 0.0001, max: 1_000_000 },
	shares: { min: 0, max: 1_000_000_000 },
	sma: { min: 2, max: 200 },
	crossDefault: { fast: 5, slow: 20 },
} as const;

export type ConditionPatch =
	| { kind: "day"; pct?: number; dir?: Direction }
	| { kind: "cost"; pct?: number; dir?: Direction; basis?: number; shares?: number | null }
	| { kind: "cross"; fast?: number; slow?: number };

export type TripwireEdit = { op: "list" } | { op: "set"; symbol: Sym; patch: ConditionPatch } | { op: "remove"; symbol: Sym; kind?: ConditionKind };

export type Applied = { ok: true; book: Book; changed: boolean; before: Tripwire[]; after: Tripwire[] } | { ok: false; reason: string };

const KINDS: readonly ConditionKind[] = ["day", "cost", "cross"];
const DIRECTIONS: readonly Direction[] = ["up", "down", "either"];
const PATCH_FIELDS: Record<ConditionKind, readonly string[]> = {
	day: ["kind", "pct", "dir"],
	cost: ["kind", "pct", "dir", "basis", "shares"],
	cross: ["kind", "fast", "slow"],
};

type Fields = Record<string, unknown>;
const isFields = (x: unknown): x is Fields => typeof x === "object" && x !== null && !Array.isArray(x);
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function only(where: string, a: Fields, fields: readonly string[], prefix = "") {
	const extra = Object.keys(a).find((k) => !fields.includes(k));
	if (extra) throw new Error(`${where} 不接受 ${prefix}${extra}，只接受 ${fields.map((f) => prefix + f).join("、") || "空对象"}`);
}

function numberField(where: string, a: Fields, field: string, range: { min: number; max: number }, integer = false): number | undefined {
	const v = a[field];
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v) || v < range.min || v > range.max || (integer && !Number.isInteger(v))) {
		throw new Error(`${where} 的 condition.${field} 必须是 ${range.min} 到 ${range.max} 之间的${integer ? "整数" : "数"}`);
	}
	return v;
}

function parsePatch(where: string, raw: unknown): ConditionPatch {
	if (!isFields(raw)) throw new Error(`${where} 的 condition 必须是对象，kind 为 ${KINDS.join("、")} 之一`);
	const kind = raw.kind as ConditionKind;
	if (!KINDS.includes(kind)) throw new Error(`${where} 的 condition.kind 只能是 ${KINDS.join("、")}`);
	only(where, raw, PATCH_FIELDS[kind], "condition.");
	const pct = numberField(where, raw, "pct", LIMITS.pct);
	if (raw.dir !== undefined && !DIRECTIONS.includes(raw.dir as Direction)) throw new Error(`${where} 的 condition.dir 只能是 ${DIRECTIONS.join("、")}`);
	const dir = raw.dir as Direction | undefined;
	switch (kind) {
		case "day":
			return defined({ kind, pct, dir });
		case "cost": {
			const basis = numberField(where, raw, "basis", LIMITS.basis);
			const shares = raw.shares === null ? null : numberField(where, raw, "shares", LIMITS.shares);
			return defined({ kind, pct, dir, basis, shares });
		}
		case "cross": {
			const fast = numberField(where, raw, "fast", LIMITS.sma, true);
			const slow = numberField(where, raw, "slow", LIMITS.sma, true);
			if (fast !== undefined && slow !== undefined && fast >= slow) throw new Error(`${where} 的 condition.fast（${fast}）必须小于 condition.slow（${slow}）`);
			return defined({ kind, fast, slow });
		}
	}
}

function symbolField(where: string, a: Fields): Sym {
	const symbol = parseSym(a.symbol);
	if (!symbol) throw new Error(`${where} 的 symbol 必须是合法的股票代码`);
	return symbol;
}

export function parseEdit(op: string, args: unknown): TripwireEdit {
	const a = args ?? {};
	if (!isFields(a)) throw new Error(`${op} 的参数必须是对象`);
	switch (op) {
		case "list":
			only(op, a, []);
			return { op };
		case "set":
			only(op, a, ["symbol", "condition"]);
			return { op, symbol: symbolField(op, a), patch: parsePatch(op, a.condition) };
		case "remove": {
			only(op, a, ["symbol", "kind"]);
			const symbol = symbolField(op, a);
			if (a.kind === undefined) return { op, symbol };
			if (!KINDS.includes(a.kind as ConditionKind)) throw new Error(`remove 的 kind 只能是 ${KINDS.join("、")}，不给就去掉这只股票的全部条件`);
			return { op, symbol, kind: a.kind as ConditionKind };
		}
		default:
			throw new Error(`未知操作 ${op}；可用：list、set、remove`);
	}
}

/** A string is the reason the merged condition is refused. */
function merge(existing: Condition | undefined, patch: ConditionPatch): Condition | string {
	const missing = (...fields: [string, unknown][]) => {
		const names = fields.filter(([, v]) => v === undefined).map(([f]) => f);
		return names.length ? `新的 ${patch.kind} 条件缺少 ${names.join("、")}` : undefined;
	};
	switch (patch.kind) {
		case "day": {
			const base = existing as Extract<Condition, { kind: "day" }> | undefined;
			const pct = patch.pct ?? base?.pct;
			return missing(["pct", pct]) ?? { kind: "day", pct: pct!, dir: patch.dir ?? base?.dir ?? "either" };
		}
		case "cost": {
			const base = existing as Extract<Condition, { kind: "cost" }> | undefined;
			const pct = patch.pct ?? base?.pct;
			const basis = patch.basis ?? base?.basis;
			const shares = patch.shares === null ? undefined : (patch.shares ?? base?.shares);
			return missing(["pct", pct], ["basis", basis]) ?? defined({ kind: "cost" as const, pct: pct!, dir: patch.dir ?? base?.dir ?? "either", basis: basis!, shares });
		}
		case "cross": {
			const base = existing as Extract<Condition, { kind: "cross" }> | undefined;
			const fast = patch.fast ?? base?.fast ?? LIMITS.crossDefault.fast;
			const slow = patch.slow ?? base?.slow ?? LIMITS.crossDefault.slow;
			return fast < slow ? { kind: "cross", fast, slow } : `fast（${fast}）必须小于 slow（${slow}）`;
		}
	}
}

const sameCondition = (a: Condition, b: Condition) => JSON.stringify(a) === JSON.stringify(b);

export function polledSymbols(book: Book, watchlist: readonly string[]): string[] {
	return [...new Set([...watchlist, ...[...book.values()].map((t) => t.symbol)])];
}

const crossCount = (book: Book) => [...book.values()].filter((t) => t.condition.kind === "cross").length;

/** A cap only refuses an edit that grows past it, so a config watchlist that grew on its own never blocks a threshold change. */
function overCap(before: Book, after: Book, watchlist: readonly string[]): string | undefined {
	const polled = polledSymbols(after, watchlist).length;
	if (polled > LIMITS.polledSymbols && polled > polledSymbols(before, watchlist).length) return `盯的股票（watchlist 加盯盘条件）最多 ${LIMITS.polledSymbols} 只，这次会变成 ${polled} 只`;
	const crosses = crossCount(after);
	if (crosses > LIMITS.crossSymbols && crosses > crossCount(before)) return `均线交叉条件最多 ${LIMITS.crossSymbols} 只股票`;
	return undefined;
}

export function applyEdit(book: Book, edit: Exclude<TripwireEdit, { op: "list" }>, watchlist: readonly string[], now: number): Applied {
	if (edit.op === "remove") {
		const removed = [...book.values()].filter((t) => t.symbol === edit.symbol && (edit.kind === undefined || t.condition.kind === edit.kind));
		if (!removed.length) return { ok: true, book, changed: false, before: [], after: [] };
		const next = new Map(book);
		for (const t of removed) next.delete(keyOf(t));
		return { ok: true, book: next, changed: true, before: removed, after: [] };
	}
	const key = keyOf({ symbol: edit.symbol, condition: edit.patch });
	const existing = book.get(key);
	const condition = merge(existing?.condition, edit.patch);
	if (typeof condition === "string") return { ok: false, reason: `${edit.symbol}：${condition}` };
	if (existing && sameCondition(existing.condition, condition)) return { ok: true, book, changed: false, before: [existing], after: [existing] };
	const after: Tripwire = { symbol: edit.symbol, condition, setAt: now };
	const next = new Map(book).set(key, after);
	const over = overCap(book, next, watchlist);
	if (over) return { ok: false, reason: over };
	return { ok: true, book: next, changed: true, before: existing ? [existing] : [], after: [after] };
}

const BOOK_VERSION = 1;

export function serializeBook(book: Book): string {
	return JSON.stringify({ version: BOOK_VERSION, tripwires: [...book.values()] });
}

/** Unreadable data is a problem, never an empty book: an empty book would overwrite the user's list on the next edit. */
export function parseBook(raw: string | undefined): { book: Book } | { problem: string } {
	if (raw === undefined) return { book: new Map() };
	try {
		const data: unknown = JSON.parse(raw);
		if (!isFields(data) || data.version !== BOOK_VERSION || !Array.isArray(data.tripwires)) throw new Error(`不是第 ${BOOK_VERSION} 版的格式`);
		const book = new Map<TripwireKey, Tripwire>();
		data.tripwires.forEach((t: unknown, i: number) => {
			const where = `第 ${i + 1} 条`;
			if (!isFields(t)) throw new Error(`${where}不是对象`);
			only(where, t, ["symbol", "condition", "setAt"]);
			const symbol = symbolField(where, t);
			if (symbol !== t.symbol) throw new Error(`${where} 的 symbol 不是规范写法`);
			const condition = merge(undefined, parsePatch(where, t.condition));
			if (typeof condition === "string") throw new Error(`${where}：${condition}`);
			if (typeof t.setAt !== "number" || !Number.isFinite(t.setAt)) throw new Error(`${where} 的 setAt 不是时间`);
			const key = keyOf({ symbol, condition });
			if (book.has(key)) throw new Error(`${where}和前面的 ${key} 重复`);
			book.set(key, { symbol, condition, setAt: t.setAt });
		});
		return { book };
	} catch (error) {
		return { problem: `盯盘条件清单读不出来：${(error as Error).message}` };
	}
}
