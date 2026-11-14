/**
 * The watch rules (docs/modules/stock-ta-rules-design.md section 4): one row per rule says where it is computed, its default
 * threshold, how much it tells the user (its level) and which plan a task it opens follows. The feeds act on this table and the
 * user's `rule-levels` rows; they have no branch per rule.
 */
export type Level = 0 | 1 | 2 | 3 | 4 | 5 | 6;
/** The line put in front of the user. Levels 1 to 3 imply it; a level 5 or 6 rule names it. */
export type Line = "none" | "badge" | "silent" | "ring";
/** The skill a task opened by the rule follows: band-move sends three, market-desk one, structure-trend two (structure and trend). */
export type Plan = "band-move" | "market-desk" | "structure-trend";
export type Scope = "stock" | "index" | "vixy";
/** Which way a hit points: bull and bear take part in resonance, a hit without a lean never does. */
export type Lean = "bull" | "bear";

type Reaction = { level: 0 | 1 | 2 | 3 | 4 } | { level: 5 | 6; line: Line };

export type WatchRule = Reaction & {
	id: string;
	title: string;
	/** quotes grades every beat of the session; scan grades the day's complete daily bar and `ta`'s signals after the close. */
	feed: "quotes" | "scan";
	/** Per scope; a rule runs only on the scopes it names. The unit is the rule's own (percent, or times the 20-day volume); 0 where it has none. */
	threshold: Readonly<Partial<Record<Scope, number>>>;
	/** Also on rules below level 5: the task to open when the user raises the rule to 5. */
	plan: Plan;
	/** The same symbol and rule flipping lean WHIPSAW.flips times within WHIPSAW.days drops the hit to level 0. */
	whipsaw?: true;
};

export const WATCH_RULES = [
	{ id: "move-1", title: "第一档", feed: "quotes", threshold: { stock: 5, index: 2 }, level: 5, line: "silent", plan: "band-move" },
	{ id: "move-2", title: "第二档", feed: "quotes", threshold: { stock: 8, index: 3 }, level: 5, line: "ring", plan: "band-move" },
	{ id: "volume", title: "放量", feed: "quotes", threshold: { stock: 3.5 }, level: 2, plan: "band-move" },
	{ id: "high-52w", title: "52 周新高", feed: "quotes", threshold: { stock: 0 }, level: 2, plan: "band-move" },
	{ id: "low-52w", title: "52 周新低", feed: "quotes", threshold: { stock: 0 }, level: 3, plan: "band-move" },
	{ id: "gap", title: "开盘跳空", feed: "quotes", threshold: { stock: 3 }, level: 1, plan: "band-move", whipsaw: true },
	{ id: "reversal", title: "盘中反转", feed: "quotes", threshold: { stock: 3 }, level: 1, plan: "band-move", whipsaw: true },
	{ id: "rel-strength", title: "逆大盘", feed: "quotes", threshold: { stock: 3 }, level: 1, plan: "band-move", whipsaw: true },
	{ id: "vixy-1", title: "VIXY 第一档", feed: "quotes", threshold: { vixy: 10 }, level: 2, plan: "market-desk" },
	{ id: "vixy-2", title: "VIXY 第二档", feed: "quotes", threshold: { vixy: 20 }, level: 5, line: "silent", plan: "market-desk" },
	{ id: "R-MA-2-200", title: "200 日线", feed: "scan", threshold: { stock: 0 }, level: 5, line: "none", plan: "structure-trend" },
	{ id: "R-MA-2-50:down", title: "跌破 50 日线", feed: "scan", threshold: { stock: 0 }, level: 2, plan: "structure-trend" },
	{ id: "R-MA-2-50:up", title: "站上 50 日线", feed: "scan", threshold: { stock: 0 }, level: 0, plan: "structure-trend" },
	{ id: "volume-close", title: "收盘放量", feed: "scan", threshold: { stock: 1.5 }, level: 0, plan: "structure-trend" },
	{ id: "ta-key", title: "ta 重点形态", feed: "scan", threshold: { stock: 0 }, level: 1, plan: "structure-trend" },
	{ id: "ta-other", title: "ta 其余信号", feed: "scan", threshold: { stock: 0 }, level: 0, plan: "structure-trend" },
] as const satisfies readonly WatchRule[];

export type RuleId = (typeof WATCH_RULES)[number]["id"];
/** Pairs whose first tier must stay below the second for every symbol. */
export const TIERS: readonly (readonly [RuleId, RuleId])[] = [["move-1", "move-2"], ["vixy-1", "vixy-2"]];

/** Same symbol, same day, both hits leaning the combo's way. The hit that completes it carries the combo's level and line. */
export type Combo = { id: string; title: string; all: readonly [RuleId, RuleId]; lean: Lean; level: 5; line: Line; plan: Plan };
export const COMBOS = [
	{ id: "volume+high-52w", title: "放量创 52 周新高", all: ["volume", "high-52w"], lean: "bull", level: 5, line: "silent", plan: "band-move" },
	{ id: "volume+low-52w", title: "放量创 52 周新低", all: ["volume", "low-52w"], lean: "bear", level: 5, line: "ring", plan: "band-move" },
	{ id: "volume-close+R-MA-2-50:down", title: "放量跌破 50 日线", all: ["volume-close", "R-MA-2-50:down"], lean: "bear", level: 5, line: "silent", plan: "structure-trend" },
] as const satisfies readonly Combo[];

/** Same symbol, same day, both hits leaning the same way: the second member's line and trigger carry the note and the partner's fact. */
export type Note = { id: string; all: readonly [RuleId, RuleId]; note: string };
export const NOTES = [{ id: "volume-close+R-MA-2-200", all: ["volume-close", "R-MA-2-200"], note: "放量确认" }] as const satisfies readonly Note[];

/** `ta`'s signals with their own row: the rule id, with the side when the two sides differ in level. */
const TA_ROWS = new Set<string>(["R-MA-2-200", "R-MA-2-50:down", "R-MA-2-50:up"]);
/** Patterns, Dow trend ends, TD 13 and MACD divergence: `ta`'s structural signals (design section 5, ta-key). */
const TA_KEY = /^(R-PAT-.+|R-DOW-1-UE|R-DOW-1-DE|R-TD-2|R-MACD-3)$/;
export const sideOf = (direction: string) => (direction === "bullish" ? "up" : direction === "bearish" ? "down" : "flat");
/** The row a `ta` signal is graded by. */
export function taRow(rule: string, direction: string): RuleId {
	const own = [`${rule}:${sideOf(direction)}`, rule].find((id) => TA_ROWS.has(id));
	return (own ?? (TA_KEY.test(rule) ? "ta-key" : "ta-other")) as RuleId;
}

/** Three flips in ten trading days means the rule changed lean about every other day it fired (design section 4.3). */
export const WHIPSAW = { days: 10, flips: 3 } as const;
/** Host-local wall clock; never during the US regular session (design section 4.4). */
export const QUIET = { from: "22:00", to: "07:00" } as const;

export type LevelRow = { id: string; fields: { readonly [field: string]: unknown } };
type Change = { level?: Level; threshold?: number };
/** The user's latest change per rule: the one for all symbols under "", each symbol's under its code. */
export type RuleLevels = ReadonlyMap<string, ReadonlyMap<string, Change>>;

const isLevel = (n: unknown): n is Level => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6;
const known = new Set<string>(WATCH_RULES.map((r) => r.id));
const INDEXES: readonly string[] = ["QQQ", "SPY"];
export const VIXY = "VIXY";
export const ruleOf = (id: RuleId): WatchRule => WATCH_RULES.find((r) => r.id === id)!;

export const scopeOf = (symbol: string): Scope => (symbol === VIXY ? "vixy" : INDEXES.includes(symbol) ? "index" : "stock");
/** The scope a change for all symbols ("") lands on: stocks, or VIXY for its own rules. */
const homeScope = (rule: WatchRule): Scope => (rule.threshold.stock !== undefined ? "stock" : "vixy");

function changeOf(fields: LevelRow["fields"]): Change | undefined {
	const { rule, level, threshold } = fields;
	const ok = typeof rule === "string" && known.has(rule) && (level == null || isLevel(level)) && (threshold == null || (typeof threshold === "number" && threshold > 0 && threshold < 100));
	return ok ? { ...(level != null && { level: level as Level }), ...(threshold != null && { threshold: threshold as number }) } : undefined;
}

/**
 * Only the latest row of a rule and symbol counts: a latest row with `removedAt` goes back to the table unchecked, so a bad row
 * is cleared by retracting it or writing a correct one. `bad` lists latest rows that do not apply, including a threshold change
 * that puts a symbol's first tier at or above its second.
 */
export function parseRuleLevels(rows: readonly LevelRow[]): { levels: RuleLevels; bad: string[] } {
	const latest = new Map<string, Map<string, LevelRow>>();
	for (const row of [...rows].sort((x, y) => Number(x.id) - Number(y.id))) {
		const rule = String(row.fields["rule"]);
		const code = String(row.fields["symbol"] ?? "").trim().toUpperCase();
		latest.set(rule, (latest.get(rule) ?? new Map()).set(code, row));
	}
	const bad: string[] = [];
	const applied = new Map<string, Map<string, { row: LevelRow; change: Change }>>();
	for (const [rule, bySymbol] of latest) {
		for (const [code, row] of bySymbol) {
			if (row.fields["removedAt"]) continue;
			const change = changeOf(row.fields);
			if (change === undefined) bad.push(row.id);
			else applied.set(rule, (applied.get(rule) ?? new Map()).set(code, { row, change }));
		}
	}
	const levelsOf = (): RuleLevels => new Map([...applied].map(([rule, bySymbol]) => [rule, new Map([...bySymbol].map(([code, a]) => [code, a.change]))]));
	const symbols = [...new Set([...applied.values()].flatMap((bySymbol) => [...bySymbol.keys()]))].sort();
	for (const [first, second] of TIERS.map(([a, b]) => [ruleOf(a), ruleOf(b)] as const)) {
		for (const code of symbols) {
			const scope = code === "" ? homeScope(first) : scopeOf(code);
			if (first.threshold[scope] === undefined) continue;
			while (effective(first, code, scope, levelsOf()).threshold! >= effective(second, code, scope, levelsOf()).threshold!) {
				const sources = [first, second].flatMap(({ id }) => {
					const [own, all] = [applied.get(id)?.get(code), scope !== "index" ? applied.get(id)?.get("") : undefined];
					const source = own?.change.threshold != null ? own : all?.change.threshold != null ? all : undefined;
					return source ? [{ id, code: source === own ? code : "", row: source.row }] : [];
				});
				const culprit = sources.reduce((top, s) => (Number(s.row.id) > Number(top.row.id) ? s : top));
				bad.push(culprit.row.id);
				applied.get(culprit.id)!.delete(culprit.code);
			}
		}
	}
	return { levels: levelsOf(), bad: bad.sort((x, y) => Number(x) - Number(y)) };
}

/** `threshold` is undefined when the rule does not run on the symbol's scope. */
export type Effective = { rule: WatchRule; level: Level; line: Line; threshold: number | undefined };

export function lineOf(level: Level, rule: WatchRule): Line {
	if (level === 5 || level === 6) return rule.level === 5 || rule.level === 6 ? rule.line : lineOf(rule.level, rule);
	return ({ 0: "none", 1: "badge", 2: "silent", 3: "ring", 4: "none" } as const)[level];
}

/**
 * The table's default, under the user's change for all symbols, under the change for this symbol. A threshold changed for all
 * symbols moves individual stocks (and VIXY on its own rules) only: SPY and QQQ keep their own unless a row names them.
 */
export function effective(rule: WatchRule, symbol: string, scope: Scope, levels: RuleLevels): Effective {
	const changes = levels.get(rule.id);
	const all = changes?.get("") ?? {};
	const own = changes?.get(symbol) ?? {};
	const level = own.level ?? all.level ?? rule.level;
	const base = rule.threshold[scope];
	const threshold = base === undefined ? undefined : (own.threshold ?? (scope !== "index" ? all.threshold : undefined) ?? base);
	return { rule, level, line: lineOf(level, rule), threshold };
}

/** Only levels 5 and 6 send a trigger; below that the Router is never woken. */
export const opensTask = (e: { level: Level }) => e.level === 5 || e.level === 6;

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
/** `zone` undefined is the host's own time zone. The regular session is exempt, so the caller says whether it is on. */
export function quietAt(ms: number, regular: boolean, zone?: string): boolean {
	if (regular) return false;
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(ms).map((p) => [p.type, p.value]));
	const now = Number(parts["hour"]) * 60 + Number(parts["minute"]);
	const [from, to] = [minutesOf(QUIET.from), minutesOf(QUIET.to)];
	return from <= to ? now >= from && now < to : now >= from || now < to;
}
