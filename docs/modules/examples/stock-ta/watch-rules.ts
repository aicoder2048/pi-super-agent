/**
 * The watch rules (docs/modules/stock-ta-rules-design.md section 4): one row per rule says where it is computed, its default
 * threshold, how much it tells the user (its level) and which plan a task it opens follows. The feeds act on this table and the
 * user's `rule-levels` rows; they have no branch per rule.
 */
export type Level = 0 | 1 | 2 | 3 | 4 | 5 | 6;
/** The line put in front of the user. Levels 1 to 3 imply it; a level 5 or 6 rule names it. */
export type Line = "none" | "badge" | "silent" | "ring";
/** The skill a task opened by the rule follows. */
export type Plan = "band-move";
export type Scope = "stock" | "index";

type Reaction = { level: 0 | 1 | 2 | 3 | 4 } | { level: 5 | 6; line: Line };

export type WatchRule = Reaction & {
	id: string;
	title: string;
	feed: "quotes";
	/** Per scope. For a move rule: the day's move against the previous close, in percent. */
	threshold: Readonly<Record<Scope, number>>;
	/** Also on rules below level 5: the task to open when the user raises the rule to 5. */
	plan: Plan;
};

export const WATCH_RULES = [
	{ id: "move-1", title: "第一档", feed: "quotes", threshold: { stock: 5, index: 2 }, level: 5, line: "silent", plan: "band-move" },
	{ id: "move-2", title: "第二档", feed: "quotes", threshold: { stock: 8, index: 3 }, level: 5, line: "ring", plan: "band-move" },
] as const satisfies readonly WatchRule[];

export type LevelRow = { id: string; fields: { readonly [field: string]: unknown } };
type Change = { level?: Level; threshold?: number };
/** The user's latest change per rule: the one for all symbols under "", each symbol's under its code. */
export type RuleLevels = ReadonlyMap<string, ReadonlyMap<string, Change>>;

const isLevel = (n: unknown): n is Level => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6;
const known = new Set<string>(WATCH_RULES.map((r) => r.id));
const INDEXES: readonly string[] = ["QQQ", "SPY"];

export const scopeOf = (symbol: string): Scope => (INDEXES.includes(symbol) ? "index" : "stock");

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
	const [first, second] = WATCH_RULES;
	const symbols = [...new Set([...applied.values()].flatMap((bySymbol) => [...bySymbol.keys()]))].sort();
	for (const code of symbols) {
		const scope = code === "" ? "stock" : scopeOf(code);
		while (effective(first, code, scope, levelsOf()).threshold >= effective(second, code, scope, levelsOf()).threshold) {
			const sources = [first, second].flatMap(({ id }) => {
				const [own, all] = [applied.get(id)?.get(code), scope === "stock" ? applied.get(id)?.get("") : undefined];
				const source = own?.change.threshold != null ? own : all?.change.threshold != null ? all : undefined;
				return source ? [{ id, code: source === own ? code : "", row: source.row }] : [];
			});
			const culprit = sources.reduce((top, s) => (Number(s.row.id) > Number(top.row.id) ? s : top));
			bad.push(culprit.row.id);
			applied.get(culprit.id)!.delete(culprit.code);
		}
	}
	return { levels: levelsOf(), bad: bad.sort((x, y) => Number(x) - Number(y)) };
}

export type Effective = { rule: WatchRule; level: Level; line: Line; threshold: number };

function lineOf(level: Level, rule: WatchRule): Line {
	if (level === 5 || level === 6) return rule.level === 5 || rule.level === 6 ? rule.line : lineOf(rule.level, rule);
	return ({ 0: "none", 1: "badge", 2: "silent", 3: "ring", 4: "none" } as const)[level];
}

/**
 * The table's default, under the user's change for all symbols, under the change for this symbol. A threshold changed for all
 * symbols moves individual stocks only: SPY and QQQ keep their own unless a row names them.
 */
export function effective(rule: WatchRule, symbol: string, scope: Scope, levels: RuleLevels): Effective {
	const changes = levels.get(rule.id);
	const all = changes?.get("") ?? {};
	const own = changes?.get(symbol) ?? {};
	const level = own.level ?? all.level ?? rule.level;
	const threshold = own.threshold ?? (scope === "stock" ? all.threshold : undefined) ?? rule.threshold[scope];
	return { rule, level, line: lineOf(level, rule), threshold };
}

/** Only levels 5 and 6 send a trigger; below that the Router is never woken. */
export const opensTask = (e: Effective) => e.level === 5 || e.level === 6;
