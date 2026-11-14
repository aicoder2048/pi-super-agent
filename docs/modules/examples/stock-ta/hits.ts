/**
 * The day's hits, one file per New York date and feed: files/hits/<date>/<feed>.json. Each file has a single writer (its feed),
 * which rewrites it whole from its cursor every beat, through a fixed temporary name and a rename, so a reader never sees half
 * a file and a crash mid-write is repaired by the next beat.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTradingDay, shiftDate } from "./market-days.ts";
import { COMBOS, opensTask, type Lean, type Level } from "./watch-rules.ts";

export type Hit = {
	/** `<rule>:<symbol>:<date>`, plus `:<side>` for the two move rules, which fire once per side; `ta`'s signals graded by a shared row use `<ta rule>:<side>` for `<rule>`. */
	id: string;
	rule: string;
	symbol: string;
	date: string;
	/** The quote's time. */
	at: string;
	lean: Lean | null;
	/** The fact in a few words, for other lines' 同日 list, e.g. 「放量 3.8 倍」. */
	fact: string;
	level: Level;
	/** The line as sent, or as it would have been when held back or below level 2. */
	text: string;
	bumped?: true;
	/** Flips counted when the whipsaw rule dropped it to level 0. */
	whipsaw?: number;
	/** Its line went out as part of this combo's line. */
	combo?: string;
	/** Quiet hours kept its line or trigger back (the close-of-day digest sends it). */
	held?: true;
	/** `ta`'s rule id, for a hit graded from one of `ta`'s signals. */
	signal?: string;
};

export type Feed = "quotes" | "scan";
export type HitFile = { feed: Feed; date: string; hits: Hit[] };

export const hitsRoot = (dataDir: string) => join(dataDir, "files", "hits");

export function writeHits(dataDir: string, feed: Feed, date: string, hits: readonly Hit[]): void {
	const dir = join(hitsRoot(dataDir), date);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${feed}.json`);
	writeFileSync(`${file}.tmp`, JSON.stringify({ feed, date, hits } satisfies HitFile));
	renameSync(`${file}.tmp`, file);
}

/** Every feed's hits on one date, or one feed's; a file that does not parse counts as none (its writer repairs it on its next beat). */
export function readHits(dataDir: string, date: string, feed?: Feed): Hit[] {
	const dir = join(hitsRoot(dataDir), date);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => (feed === undefined ? name.endsWith(".json") : name === `${feed}.json`)).sort().flatMap((name) => {
		try {
			const hits = (JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<HitFile>).hits;
			return Array.isArray(hits) ? hits : [];
		} catch {
			return [];
		}
	});
}

/** The `count` trading days before `today`, newest first. */
export function tradingDaysBefore(today: string, count: number): string[] {
	const days: string[] = [];
	for (let date = shiftDate(today, -1); days.length < count; date = shiftDate(date, -1)) if (isTradingDay(date)) days.push(date);
	return days;
}

/** Leans of the given rules' hits on the trading days before today inside a window of `days` trading days, oldest first. */
export function pastLeans(dataDir: string, today: string, days: number, rules: readonly string[]): Record<string, Lean[]> {
	const out: Record<string, Lean[]> = {};
	for (const date of tradingDaysBefore(today, days - 1).reverse()) {
		for (const hit of readHits(dataDir, date)) {
			if (!rules.includes(hit.rule) || hit.lean === null || hit.lean === undefined) continue;
			(out[`${hit.rule}:${hit.symbol}`] ??= []).push(hit.lean);
		}
	}
	return out;
}

/** A task is open on the symbol today: a hit at level 5 or 6 whose trigger went out. */
export const opened = (h: Hit) => opensTask(h) && !h.held;

/**
 * Counts the symbol's hits today that point a way and are not demoted (level 0); a combo's line is left out because its two
 * members already count, and a band counts once per side (crossing 5% and 8% is one move). Same-lean hits, this one included, must
 * be at least two and more than the opposite ones to escalate; otherwise an opposite lean that ties or outnumbers them means
 * 多空分歧. Only levels 1 and 2 move up: level 3 is the highest level that still has a line below the task levels. `mayBump`
 * false still counts and still says 多空分歧, for a hit that may not escalate (a `ta` signal `ta` did not grade key).
 */
export function resonate(hits: readonly Hit[], hit: Hit, mayBump = true): { level: Level; why?: string; bumped?: true } {
	if (hit.lean === null || hit.level < 1 || hit.level > 3) return { level: hit.level };
	const bands = new Set<Lean>();
	const counted = hits.filter((h) => h.symbol === hit.symbol && h.lean !== null && h.level >= 1 && !COMBOS.some((c) => c.id === h.rule))
		.filter((h) => !h.rule.startsWith("move-") || (!bands.has(h.lean!) && bands.add(h.lean!)));
	const same = counted.filter((h) => h.lean === hit.lean).length + 1;
	const opposite = counted.length + 1 - same;
	const tally = `（看多 ${hit.lean === "bull" ? same : opposite} 条，看空 ${hit.lean === "bear" ? same : opposite} 条）`;
	if (opposite >= same) return { level: hit.level, why: `多空分歧${tally}` };
	const taskOpen = hits.some((h) => h.symbol === hit.symbol && opened(h));
	const bumpedToday = hits.some((h) => h.symbol === hit.symbol && h.bumped);
	if (!mayBump || same < 2 || hit.level > 2 || taskOpen || bumpedToday) return { level: hit.level };
	return { level: (hit.level + 1) as Level, bumped: true, why: `同向升一层${tally}` };
}
