/**
 * Read-only access to the module's daily bars (files/ta/ta.sqlite, written only by the scan feed). The scan renames a finished
 * copy into place, so a reader sees a whole database. Bars are unadjusted; `ta` adjusts for dividends when it reads them.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { History } from "./feeds/quotes/watch.ts";
import type { DailyBar } from "./feeds/scan/close.ts";
import { peakKey, type Holding } from "./holdings.ts";

const YEAR = 252;
const VOLUME_DAYS = 20;

export const taDatabase = (dataDir: string) => join(dataDir, "files", "ta", "ta.sqlite");

/** Per symbol, from complete daily bars dated before `today`. Undefined when the database does not exist yet. */
export function readHistory(dataDir: string, symbols: readonly string[], today: string): Record<string, History | null> | undefined {
	const file = taDatabase(dataDir);
	if (!existsSync(file)) return undefined;
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const query = db.prepare("SELECT high, low, volume FROM bars WHERE symbol = ? AND timeframe = '1d' AND complete = 1 AND session_date < ? ORDER BY start_ms DESC LIMIT ?");
		return Object.fromEntries(symbols.map((symbol) => {
			const rows = query.all(symbol.replaceAll("-", "."), today, YEAR) as { high: number; low: number; volume: number }[];
			if (rows.length === 0) return [symbol, null];
			const year = rows.length >= YEAR;
			const recent = rows.slice(0, VOLUME_DAYS);
			return [symbol, {
				high52: year ? Math.max(...rows.map((r) => r.high)) : null,
				low52: year ? Math.min(...rows.map((r) => r.low)) : null,
				avgVolume20: recent.length >= VOLUME_DAYS ? recent.reduce((sum, r) => sum + r.volume, 0) / VOLUME_DAYS : null,
			}];
		}));
	} finally {
		db.close();
	}
}

/** Per symbol, the newest `count` complete daily bars up to and including `through`, oldest first. Undefined when the database does not exist yet. */
export function readDaily(dataDir: string, symbols: readonly string[], through: string, count: number): Record<string, DailyBar[]> | undefined {
	const file = taDatabase(dataDir);
	if (!existsSync(file)) return undefined;
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const query = db.prepare("SELECT session_date AS date, close, high, volume FROM bars WHERE symbol = ? AND timeframe = '1d' AND complete = 1 AND session_date <= ? ORDER BY start_ms DESC LIMIT ?");
		return Object.fromEntries(symbols.map((symbol) => [symbol, (query.all(symbol.replaceAll("-", "."), through, count) as DailyBar[]).reverse()]));
	} finally {
		db.close();
	}
}

/**
 * Per holding, under `peakKey`, the highest daily high it measures from, through the day before `today`: since `boughtAt`
 * (inclusive), or over the last year of bars without it (fewer when that is all there is); null without a bar. Undefined when the
 * database does not exist yet.
 */
export function readPeaks(dataDir: string, holdings: readonly Pick<Holding, "symbol" | "boughtAt">[], today: string): Record<string, number | null> | undefined {
	const file = taDatabase(dataDir);
	if (!existsSync(file)) return undefined;
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const since = db.prepare("SELECT max(high) AS peak FROM bars WHERE symbol = ? AND timeframe = '1d' AND complete = 1 AND session_date >= ? AND session_date < ?");
		const year = db.prepare("SELECT max(high) AS peak FROM (SELECT high FROM bars WHERE symbol = ? AND timeframe = '1d' AND complete = 1 AND session_date < ? ORDER BY start_ms DESC LIMIT ?)");
		return Object.fromEntries(holdings.map((h) => {
			const symbol = h.symbol.replaceAll("-", ".");
			const row = (h.boughtAt !== undefined ? since.get(symbol, h.boughtAt, today) : year.get(symbol, today, YEAR)) as { peak: number | null };
			return [peakKey(h), row.peak];
		}));
	} finally {
		db.close();
	}
}
