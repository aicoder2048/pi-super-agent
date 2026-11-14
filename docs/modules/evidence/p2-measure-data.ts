/**
 * Loads the inputs of the phase-2 measurements (docs/modules/stock-ta-rules-design.md, appendix).
 *   daily.csv  symbol,session_date,open,high,low,close,volume: the module's own daily bars, exported read-only from the host's
 *              files/ta/ta.sqlite (`select symbol,session_date,open,high,low,close,volume from bars where timeframe='1d' and complete=1`).
 *   min/<SYM>-minute-<from>-<to>.json, min/VIXY-day-<from>-<to>.json  Massive aggregates, unadjusted, [t, o, h, l, c, v] rows,
 *              fetched by p2-measure-fetch.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Day = { date: string; open: number; high: number; low: number; close: number; volume: number };
export type Minute = { t: number; minute: number; o: number; h: number; l: number; c: number; v: number };

const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
export function nyParts(ms: number): { date: string; minute: number } {
	const p = Object.fromEntries(NY.formatToParts(ms).map((x) => [x.type, x.value]));
	return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

export function daily(dir: string): Map<string, Day[]> {
	const out = new Map<string, Day[]>();
	for (const line of readFileSync(join(dir, "daily.csv"), "utf8").trim().split("\n")) {
		const [symbol, date, ...n] = line.split(",");
		const [open, high, low, close, volume] = n.map(Number) as [number, number, number, number, number];
		out.set(symbol!, [...(out.get(symbol!) ?? []), { date: date!, open, high, low, close, volume }]);
	}
	return out;
}

/** Minute bars per New York date, oldest first. */
export function minutes(dir: string, symbol: string): Map<string, Minute[]> {
	const out = new Map<string, Minute[]>();
	for (const file of readdirSync(join(dir, "min")).filter((f) => f.startsWith(`${symbol}-minute-`))) {
		for (const [t, o, h, l, c, v] of JSON.parse(readFileSync(join(dir, "min", file), "utf8")) as number[][]) {
			const { date, minute } = nyParts(t!);
			out.set(date, [...(out.get(date) ?? []), { t: t!, minute, o: o!, h: h!, l: l!, c: c!, v: v! }]);
		}
	}
	for (const bars of out.values()) bars.sort((a, b) => a.t - b.t);
	return out;
}

export function vixyDays(dir: string): Day[] {
	const file = readdirSync(join(dir, "min")).find((f) => f.startsWith("VIXY-day-"));
	if (file === undefined) throw new Error("no VIXY-day-*.json: run p2-measure-fetch.ts first");
	return (JSON.parse(readFileSync(join(dir, "min", file), "utf8")) as number[][]).map(([t, o, h, l, c, v]) => ({ date: nyParts(t!).date, open: o!, high: h!, low: l!, close: c!, volume: v! }));
}

export const STOCKS = ["AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "SPCX", "TSLA"];
export const OPEN = 9 * 60 + 30;
export const pct = (n: number, d: number) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(0)}%`);
