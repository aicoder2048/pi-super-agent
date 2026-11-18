/**
 * When a watchlist symbol's options turn rich, and when the VIX crosses a level or its term structure inverts
 * (knowledge/vol-regime). Pure: series in, the sessions on which each event happened out; feeds/vol-alerts decides which
 * are recent enough to post. Every event is information for the user, not a trade signal.
 */
import { ivPercentile } from "./iv-history.ts";
import type { IvPoint } from "./iv-series.ts";
import { isInverted, VIX_LEVELS, type VixSeries } from "./vix.ts";
import { hv20, RICH_PERCENTILE, RICH_RATIO } from "./vol-regime.ts";

/** A rich spell ends when the percentile falls below this; only after that does a new entry alert again. */
export const REARM_PERCENTILE = 0.7;
/** Days of IV history a percentile needs before it counts as a one-year percentile (tools/vol uses the same floor). */
export const MIN_PERCENTILE_DAYS = 120;
const WINDOW_DAYS = 365;
/**
 * VIX closes reaching these alert; the seller's risk line rings, the other is silent. A line alerts again only after the VIX
 * closed below its `rearm`, so a VIX chopping around 25 does not alert every other day.
 */
export const VIX_ALERT_LEVELS = [{ level: VIX_LEVELS.nervous, ring: false, rearm: VIX_LEVELS.elevated }, { level: VIX_LEVELS.panic, ring: true, rearm: 30 }] as const;

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export type RichEntry = { date: string; percentile: number; ratio: number; iv: number; hv: number; expiry: string; days: number };

/**
 * Sessions on which the symbol entered the rich zone: one-year IV percentile ≥ RICH_PERCENTILE and close IV / HV20 ≥ RICH_RATIO,
 * while armed. Entering disarms; the percentile dropping under REARM_PERCENTILE arms again. Starts armed at the first session
 * with MIN_PERCENTILE_DAYS of history, so the result depends only on the stored series.
 */
export function richEntries(series: readonly IvPoint[], closes: Readonly<Record<string, number>>): RichEntry[] {
	const closeDates = Object.keys(closes).sort();
	const entries: RichEntry[] = [];
	let armed = true;
	for (const [i, point] of series.entries()) {
		const from = addDays(point.date, -WINDOW_DAYS);
		const window = series.slice(0, i + 1).filter((p) => p.date >= from).map((p) => p.iv);
		if (window.length < MIN_PERCENTILE_DAYS) continue;
		const percentile = ivPercentile(point.iv, window)!;
		const hv = hv20(closes as Record<string, number>, closeDates, point.date);
		const ratio = hv === null || hv <= 0 ? null : point.iv / hv;
		if (armed && percentile >= RICH_PERCENTILE && ratio !== null && ratio >= RICH_RATIO) {
			entries.push({ date: point.date, percentile, ratio, iv: point.iv, hv: hv!, expiry: point.expiry, days: window.length });
			armed = false;
		} else if (!armed && percentile < REARM_PERCENTILE) armed = true;
	}
	return entries;
}

export type VixEvent = { kind: "level"; date: string; level: number; ring: boolean; vix: number } | { kind: "inverted"; date: string; vix: number; vix3m: number };

/**
 * Each VIX close that reached an armed alert level (only the highest one when it jumped past two in a day), and each session the
 * term structure turned inverted. The first stored close only sets the state: whether it was a crossing is unknown.
 */
export function vixEvents(s: VixSeries): VixEvent[] {
	const dates = [...s.VIX.keys()].sort();
	const events: VixEvent[] = [];
	const armed = VIX_ALERT_LEVELS.map(({ level }) => dates.length > 0 && s.VIX.get(dates[0]!)! < level);
	for (let i = 1; i < dates.length; i++) {
		const [before, date] = [dates[i - 1]!, dates[i]!];
		const [prev, vix] = [s.VIX.get(before)!, s.VIX.get(date)!];
		const reached = VIX_ALERT_LEVELS.flatMap((line, j) => (armed[j] && vix >= line.level ? [j] : []));
		for (const j of reached) armed[j] = false;
		VIX_ALERT_LEVELS.forEach((line, j) => {
			if (!armed[j] && vix < line.rearm) armed[j] = true;
		});
		const top = reached.at(-1);
		if (top !== undefined) events.push({ kind: "level", date, level: VIX_ALERT_LEVELS[top]!.level, ring: VIX_ALERT_LEVELS[top]!.ring, vix });
		const [prev3m, vix3m] = [s.VIX3M.get(before), s.VIX3M.get(date)];
		if (prev3m !== undefined && vix3m !== undefined && !isInverted(prev, prev3m) && isInverted(vix, vix3m)) events.push({ kind: "inverted", date, vix, vix3m });
	}
	return events;
}
