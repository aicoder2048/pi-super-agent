import { isFresh, type Quote } from "./detect.ts";
import { sma } from "./indicators.ts";
import { nyTime, type Session } from "./session.ts";
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

/** Deliberately no basis and no shares: alert text is built from a Firing, so no code path can send them off the machine. */
export type Firing =
	| { kind: "day"; symbol: Sym; side: Side; pct: number; changePct: number; price: number; prevClose: number }
	| { kind: "cost"; symbol: Sym; side: Side; pct: number; driftPct: number; price: number }
	| { kind: "cross"; symbol: Sym; fast: number; slow: number; shape: CrossShape; stage: CrossStage; price: number; fastSma: number; slowSma: number };
export type CrossStage = "suspected" | "confirmed" | "withdrawn";

/** Settled daily closes before `nyDate`, oldest first, per symbol, fetched on `nyDate`. */
export type History = ReadonlyMap<string, { nyDate: string; closes: readonly number[] }>;

// Prices are cents, so a real move of exactly a threshold can compute a hair below it.
const EPSILON = 1e-9;
const sideOf = (pct: number): Side => (pct >= 0 ? "up" : "down");
const admits = (dir: Direction, side: Side) => dir === "either" || dir === side;
const beyond = (move: number, pct: number, side: Side) => (side === "up" ? move : -move) >= pct - EPSILON;
const driftOf = (price: number, basis: number) => ((price - basis) / basis) * 100;

/** Stateless: returns every firing that holds now. The host dedupes by firingId, so re-posting is a no-op. */
export function checkIntraday(book: Book, quotes: readonly Quote[], session: Session, history: History): Firing[] {
	const fresh = new Map(quotes.filter((q) => isFresh(q, session)).map((q) => [q.symbol, q]));
	return [...book.values()].flatMap((t) => {
		const q = fresh.get(t.symbol);
		return q ? check(t, q, session.nyDate, history) : [];
	});
}

function check({ symbol, condition: c }: Tripwire, q: Quote, nyDate: string, history: History): Firing[] {
	switch (c.kind) {
		case "day": {
			const side = sideOf(q.changePct);
			return admits(c.dir, side) && beyond(q.changePct, c.pct, side) ? [{ kind: "day", symbol, side, pct: c.pct, changePct: q.changePct, price: q.price, prevClose: q.prevClose }] : [];
		}
		case "cost": {
			const driftPct = driftOf(q.price, c.basis);
			const side = sideOf(driftPct);
			// Only the crossing day alerts, so a position that stays past its line does not ring every day.
			const crossedToday = beyond(driftPct, c.pct, side) && !beyond(driftOf(q.prevClose, c.basis), c.pct, side);
			return admits(c.dir, side) && crossedToday ? [{ kind: "cost", symbol, side, pct: c.pct, driftPct, price: q.price }] : [];
		}
		case "cross": {
			const h = history.get(symbol);
			const crossed = h?.nyDate === nyDate ? crossShape(h.closes, q.price, c.fast, c.slow) : null;
			return crossed ? [{ kind: "cross", symbol, fast: c.fast, slow: c.slow, stage: "suspected", price: q.price, ...crossed }] : [];
		}
	}
}

const smaOf = (closes: readonly number[], n: number) => sma([...closes], n)!;

export function crossShape(settledBeforeToday: readonly number[], todayClose: number, fast: number, slow: number): { shape: CrossShape; fastSma: number; slowSma: number } | null {
	if (settledBeforeToday.length < slow + 1) return null;
	const before = smaOf(settledBeforeToday, fast) - smaOf(settledBeforeToday, slow);
	const today = [...settledBeforeToday, todayClose];
	const fastSma = smaOf(today, fast);
	const slowSma = smaOf(today, slow);
	if (before <= 0 && fastSma > slowSma) return { shape: "golden", fastSma, slowSma };
	if (before >= 0 && fastSma < slowSma) return { shape: "death", fastSma, slowSma };
	return null;
}

/** Confirms a flip on today's settled close, suspected or not. Withdraws a suspicion that did not hold; yesterday's relation says which shape it could have been. */
export function settleCross(t: Tripwire & { condition: { kind: "cross" } }, closesThroughToday: readonly number[], suspectedRaised: boolean): Firing | null {
	const { fast, slow } = t.condition;
	const before = closesThroughToday.slice(0, -1);
	const close = closesThroughToday.at(-1);
	if (close === undefined || before.length < slow + 1) return null;
	const base = { kind: "cross" as const, symbol: t.symbol, fast, slow, price: close };
	const crossed = crossShape(before, close, fast, slow);
	if (crossed) return { ...base, stage: "confirmed", ...crossed };
	if (!suspectedRaised) return null;
	const shape: CrossShape = smaOf(before, fast) <= smaOf(before, slow) ? "golden" : "death";
	return { ...base, shape, stage: "withdrawn", fastSma: smaOf(closesThroughToday, fast), slowSma: smaOf(closesThroughToday, slow) };
}

/** Symbol, NY trading day and signal with the threshold inside, so editing a threshold re-arms it and repeating an edit does not. */
export function firingId(nyDate: string, f: Firing): string {
	const signal = f.kind === "cross" ? `cross-${f.fast}-${f.slow}-${f.shape}-${f.stage}` : `${f.kind}-${f.side}-${f.pct}`;
	return `${f.symbol}:${nyDate}:${signal}`;
}

const money = (n: number) => n.toFixed(2);
const signed = (n: number, digits = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
const lineOf = (side: Side, pct: number) => `${side === "up" ? "+" : "-"}${pct}%`;
const SHAPES: Record<CrossShape, { name: string; verb: string }> = { golden: { name: "金叉", verb: "上穿" }, death: { name: "死叉", verb: "下穿" } };
const DIR_WORDS: Record<Direction, string> = { up: "涨", down: "跌", either: "涨跌" };

export function alertText(f: Firing, quote: { at: number; delayed: boolean }): string {
	const head = `【盯盘提醒】${f.symbol} `;
	const at = `报价时间 ${nyTime(quote.at)} ET${quote.delayed ? "（延迟行情）" : ""}。`;
	switch (f.kind) {
		case "day":
			return `${head}${f.side === "up" ? "涨" : "跌"} ${signed(f.changePct)}，到了你设的 ${lineOf(f.side, f.pct)} 提醒线。现价 ${money(f.price)}，昨收 ${money(f.prevClose)}。${at}`;
		case "cost":
			return `${head}相对成本价 ${signed(f.driftPct)}，到了你设的 ${lineOf(f.side, f.pct)} 提醒线。现价 ${money(f.price)}。${at}`;
		case "cross": {
			const { name, verb } = SHAPES[f.shape];
			const fast = `${f.fast} 日均线 ${money(f.fastSma)}`;
			const slow = `${f.slow} 日均线 ${money(f.slowSma)}`;
			if (f.stage === "suspected") return `${head}疑似${name}：把现价 ${money(f.price)} 当作今天收盘，${fast} ${verb} ${slow}。收盘后确认。${at}`;
			if (f.stage === "confirmed") return `${head}${name}确认：今天收盘 ${money(f.price)}，${fast} ${verb} ${slow}。`;
			return `${head}${name}没有成立：今天收盘 ${money(f.price)}，${fast}，${slow}。早前的疑似${name}提醒作废。`;
		}
	}
}

/** `local` text carries the cost basis and shares and must never leave the machine. */
function describe({ symbol, condition: c }: Tripwire, local: boolean): string {
	switch (c.kind) {
		case "day":
			return `${symbol} 相对昨收${DIR_WORDS[c.dir]}超过 ${c.pct}% 时提醒`;
		case "cost": {
			const rule = `相对成本价${DIR_WORDS[c.dir]}超过 ${c.pct}% 时提醒`;
			if (!local) return `${symbol} ${rule}（成本价和股数只在网页显示）`;
			return `${symbol} 成本价 ${c.basis}${c.shares === undefined ? "" : `、${c.shares} 股`}，${rule}`;
		}
		case "cross":
			return `${symbol} ${c.fast} 日均线和 ${c.slow} 日均线金叉、死叉时提醒`;
	}
}

function summary(before: readonly Tripwire[], after: readonly Tripwire[], local: boolean): string | undefined {
	const listed = (ts: readonly Tripwire[]) => ts.map((t) => describe(t, local)).join("；");
	if (after.length && before.length && sameCondition(before[0]!.condition, after[0]!.condition)) return `没有变化：${listed(after)}。`;
	if (after.length && before.length) return `已改：${listed(after)}，原来是 ${listed(before)}。`;
	if (after.length) return `已添加：${listed(after)}。`;
	if (before.length) return `已去掉：${listed(before)}。`;
	return undefined;
}

function alreadyPast(after: readonly Tripwire[], currentDrift: number | undefined): string | undefined {
	const c = after[0]?.condition;
	if (c?.kind !== "cost" || currentDrift === undefined) return undefined;
	const side = sideOf(currentDrift);
	return admits(c.dir, side) && beyond(currentDrift, c.pct, side) ? `现在已在 ${signed(currentDrift, 1)}，回到线内后再越过才提醒。` : undefined;
}

/** Local only (web and terminal): one condition per line, cost basis and shares included. */
export function receiptText(before: readonly Tripwire[], after: readonly Tripwire[], book: Book, currentDrift?: number): string {
	const lines = [summary(before, after, true), alreadyPast(after, currentDrift), `现在共 ${book.size} 条${book.size ? "：" : "。"}`, ...[...book.values()].map((t) => describe(t, true))];
	return lines.filter((l) => l !== undefined).join("\n");
}

/** What the Worker gets back, and so what may reach a Router reply and Telegram: no cost basis, no shares. */
export function echoText(applied: Applied): string {
	if (!applied.ok) return `没改成：${applied.reason}`;
	return `${summary(applied.before, applied.after, false) ?? ""}现在共 ${applied.book.size} 条。`;
}

export type RedactedTripwire = { symbol: Sym } & (
	| { kind: "day"; pct: number; dir: Direction }
	| { kind: "cost"; pct: number; dir: Direction; hasShares: boolean }
	| { kind: "cross"; fast: number; slow: number }
);

export function redact(book: Book): RedactedTripwire[] {
	return [...book.values()].map(({ symbol, condition: c }) => (c.kind === "cost" ? { symbol, kind: c.kind, pct: c.pct, dir: c.dir, hasShares: c.shares !== undefined } : { symbol, ...c }));
}
