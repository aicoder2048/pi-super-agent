/**
 * The day's hits, one file per New York date and feed: files/hits/<date>/<feed>.json. Each file has a single writer (its feed),
 * which rewrites it whole from its cursor every beat, through a fixed temporary name and a rename, so a reader never sees half
 * a file and a crash mid-write is repaired by the next beat.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hit } from "./feeds/quotes/watch.ts";
import { isTradingDay, shiftDate } from "./market-days.ts";
import type { Lean } from "./watch-rules.ts";

export type Feed = "quotes";
export type HitFile = { feed: Feed; date: string; hits: Hit[] };

export const hitsRoot = (dataDir: string) => join(dataDir, "files", "hits");

export function writeHits(dataDir: string, feed: Feed, date: string, hits: readonly Hit[]): void {
	const dir = join(hitsRoot(dataDir), date);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${feed}.json`);
	writeFileSync(`${file}.tmp`, JSON.stringify({ feed, date, hits } satisfies HitFile));
	renameSync(`${file}.tmp`, file);
}

/** Every feed's hits on one date; a file that does not parse counts as none (its writer repairs it on its next beat). */
export function readHits(dataDir: string, date: string): Hit[] {
	const dir = join(hitsRoot(dataDir), date);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.endsWith(".json")).sort().flatMap((name) => {
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
