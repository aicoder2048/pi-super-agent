// node docs/modules/evidence/p2-measure-volume.ts [dir]
// Picks the intraday volume threshold: replays each day's minute bars (the snapshot's day.v is the day aggregate, pre-market
// included) and counts, per candidate threshold, intraday hits and how many of them the full day did not confirm
// (day volume under 1.5 times the 20-day average).
import { daily, minutes, OPEN, pct, STOCKS } from "./p2-measure-data.ts";

const dir = process.argv[2] ?? "/tmp/p2m";
const CONFIRM = 1.5;
const KS = [1.5, 2, 2.5, 3, 3.25, 3.5, 3.75, 4];
const STARTS = [10 * 60, 10 * 60 + 30, 11 * 60];
const fmt = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

type DayRun = { cum: Float64Array; full: number; avg: number; profile: Float64Array | null };
const runs: DayRun[] = [];
let sumAll = 0, sumDaily = 0, sumRegular = 0;
const days = daily(dir);
const sessions = new Set<string>();
for (const symbol of STOCKS) {
	const bars = days.get(symbol) ?? [];
	const byDate = minutes(dir, symbol);
	const history: Float64Array[] = [];
	for (let i = 20; i < bars.length; i++) {
		const day = bars[i]!;
		const mins = byDate.get(day.date);
		if (mins === undefined) continue;
		sessions.add(day.date);
		const cum = new Float64Array(16 * 60 + 1);
		let run = 0, j = 0;
		for (let m = 0; m <= 16 * 60; m++) {
			while (j < mins.length && mins[j]!.minute <= m) run += mins[j++]!.v;
			cum[m] = run;
		}
		const all = mins.reduce((s, b) => s + b.v, 0);
		// Minute aggregates leave out trades the day aggregate counts; scale so the day ends at the snapshot's day.v.
		for (let m = 0; m < cum.length; m++) cum[m] = (cum[m]! * day.volume) / all;
		sumAll += all;
		sumRegular += mins.filter((b) => b.minute >= OPEN && b.minute < 16 * 60).reduce((s, b) => s + b.v, 0);
		sumDaily += day.volume;
		const avg = bars.slice(i - 20, i).reduce((s, b) => s + b.volume, 0) / 20;
		const profile = history.length >= 20 ? history.slice(-20).reduce((acc, h) => acc.map((v, m) => v + h[m]! / 20), new Float64Array(cum.length)) : null;
		runs.push({ cum, full: day.volume, avg, profile });
		history.push(cum);
	}
}
const sessionCount = sessions.size;
console.log(`minute bars summed over all minutes / day aggregate volume: ${(sumAll / sumDaily).toFixed(3)}; regular session only: ${(sumRegular / sumDaily).toFixed(3)}`);
console.log(`${runs.length} stock-days, ${sessionCount} sessions, 8 stocks; confirmed means day volume >= ${CONFIRM} x 20-day average`);
const confirmedDays = runs.filter((r) => r.full >= CONFIRM * r.avg).length;
console.log(`days the full day confirms: ${confirmedDays} (${(confirmedDays / sessionCount).toFixed(2)} per session)`);

function table(name: string, hitAt: (r: DayRun, k: number, start: number) => boolean) {
	console.log(`\n${name}`);
	console.log(`start  k     hits/session  unconfirmed  confirmed days caught`);
	for (const start of STARTS) for (const k of KS) {
		const hits = runs.filter((r) => hitAt(r, k, start));
		const bad = hits.filter((r) => r.full < CONFIRM * r.avg).length;
		const caught = hits.length - bad;
		console.log(`${fmt(start)}  ${k.toFixed(2)}  ${(hits.length / sessionCount).toFixed(2)}          ${pct(bad, hits.length).padEnd(11)}  ${pct(caught, confirmedDays)}`);
	}
}

table("linear: cumulative volume >= k x 20-day average x elapsed regular-session fraction", (r, k, start) => {
	for (let m = start; m < 16 * 60; m++) if (r.cum[m]! >= k * r.avg * ((m - OPEN) / 390)) return true;
	return false;
});
table("profile: cumulative volume >= k x the past 20 days' average cumulative volume at the same minute", (r, k, start) => {
	if (r.profile === null) return false;
	for (let m = start; m < 16 * 60; m++) if (r.cum[m]! >= k * r.profile[m]!) return true;
	return false;
});
