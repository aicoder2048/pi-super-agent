// node docs/modules/evidence/p2-measure-vixy.ts [dir]
// Picks VIXY's two tiers from two years of daily bars: how often VIXY's intraday high reaches each rise over the previous close,
// next to how often SPY or QQQ reach their first (2%) and second (3%) bands intraday, and how often the two happen the same day.
import { daily, pct, vixyDays } from "./p2-measure-data.ts";

const dir = process.argv[2] ?? "/tmp/p2m";
const vixy = vixyDays(dir);
const days = daily(dir);
const rise = new Map<string, number>();
for (let i = 1; i < vixy.length; i++) rise.set(vixy[i]!.date, (vixy[i]!.high / vixy[i - 1]!.close - 1) * 100);
const closeRise = vixy.slice(1).map((d, i) => (d.close / vixy[i]!.close - 1) * 100);
const indexBand = (band: number) => {
	const dates = new Set<string>();
	for (const symbol of ["SPY", "QQQ"]) {
		const bars = days.get(symbol) ?? [];
		for (let i = 1; i < bars.length; i++) {
			const prev = bars[i - 1]!.close;
			if (Math.max(bars[i]!.high / prev - 1, 1 - bars[i]!.low / prev) * 100 >= band) dates.add(bars[i]!.date);
		}
	}
	return dates;
};
const sessions = rise.size;
const [band1, band2] = [indexBand(2), indexBand(3)];
console.log(`${sessions} sessions of VIXY (${vixy[1]!.date} to ${vixy.at(-1)!.date})`);
console.log(`SPY or QQQ reached 2% intraday on ${band1.size} days (${(band1.size / sessions).toFixed(3)} per session), 3% on ${band2.size} (${(band2.size / sessions).toFixed(3)})`);
console.log(`rise  days(high)  per session  days(close)  same day as an index 2% band`);
for (const t of [5, 6, 8, 10, 12, 15, 20, 25, 30]) {
	const hit = [...rise].filter(([, r]) => r >= t).map(([d]) => d);
	const both = hit.filter((d) => band1.has(d));
	const closes = closeRise.filter((r) => r >= t).length;
	console.log(`${String(t).padStart(3)}%  ${String(hit.length).padStart(9)}  ${(hit.length / sessions).toFixed(3).padStart(11)}  ${String(closes).padStart(11)}  ${String(both.length).padStart(4)} (${pct(both.length, hit.length)} of VIXY days)`);
}
const sorted = [...rise.values()].sort((a, b) => a - b);
console.log(`intraday-high rise percentiles: p90 ${sorted[Math.floor(0.9 * sorted.length)]!.toFixed(1)}%, p95 ${sorted[Math.floor(0.95 * sorted.length)]!.toFixed(1)}%, p98 ${sorted[Math.floor(0.98 * sorted.length)]!.toFixed(1)}%, p99 ${sorted[Math.floor(0.99 * sorted.length)]!.toFixed(1)}%`);
