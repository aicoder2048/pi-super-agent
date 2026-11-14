// node docs/modules/evidence/p2-noise.ts [dir]
// The noise budget: replays every regular-session minute of the year of minute bars through the quotes feed's own grading
// (feeds/quotes/watch.ts) with the table's defaults, one beat per minute for the eight stocks, SPY, QQQ and VIXY, and counts
// what reaches the user per trading day. History (52-week high and low, 20-day volume) comes from the module's daily bars up
// to the day before, as bars.ts reads it; whipsaw leans carry over from the replay's own earlier days.
// P2_BASELINE=1 replays what runs today instead: the two move bands only (no history, no day open/high/low, no VIXY, 逆大盘 off).
import { daily, minutes, OPEN, STOCKS, vixyDays, type Day, type Minute } from "./p2-measure-data.ts";
import { newDay, watch, type History } from "../examples/stock-ta/feeds/quotes/watch.ts";
import type { Hit } from "../examples/stock-ta/hits.ts";
import type { Quote } from "../examples/stock-ta/massive.ts";
import { parseRuleLevels, WATCH_RULES, WHIPSAW, type Lean } from "../examples/stock-ta/watch-rules.ts";

const dir = process.argv[2] ?? "/tmp/p2m";
const SYMBOLS = [...STOCKS, "SPY", "QQQ", ...(process.env["P2_BASELINE"] === "1" ? [] : ["VIXY"])];
const days = daily(dir);
days.set("VIXY", vixyDays(dir));
const byMinute = new Map(SYMBOLS.map((s) => [s, minutes(dir, s)]));
const BASELINE = process.env["P2_BASELINE"] === "1";
const levels = parseRuleLevels(BASELINE ? [{ id: "1", fields: { rule: "rel-strength", level: 0 } }] : []).levels;
const whipsawRules = new Set(WATCH_RULES.filter((r) => "whipsaw" in r).map((r) => r.id as string));

function historyOf(bars: readonly Day[], i: number): History | null {
	const before = bars.slice(Math.max(0, i - 252), i);
	if (before.length === 0) return null;
	const recent = before.slice(-20);
	return {
		high52: before.length >= 252 ? Math.max(...before.map((b) => b.high)) : null,
		low52: before.length >= 252 ? Math.min(...before.map((b) => b.low)) : null,
		avgVolume20: recent.length >= 20 ? recent.reduce((s, b) => s + b.volume, 0) / 20 : null,
	};
}

type Track = { t: Float64Array; price: Float64Array; volume: Float64Array; high: Float64Array; low: Float64Array };
/** Per minute of the day: the last trade, the day bar so far (pre-market included) and volume scaled to the day aggregate. */
function track(mins: readonly Minute[], scale: number): Track {
	const size = 16 * 60;
	const out: Track = { t: new Float64Array(size), price: new Float64Array(size), volume: new Float64Array(size), high: new Float64Array(size), low: new Float64Array(size) };
	let j = 0, t = 0, price = 0, volume = 0, high = 0, low = Infinity;
	for (let m = 0; m < size; m++) {
		while (j < mins.length && mins[j]!.minute <= m) {
			const b = mins[j++]!;
			[t, price, volume, high, low] = [b.t, b.c, volume + b.v * scale, Math.max(high, b.h), Math.min(low, b.l)];
		}
		[out.t[m], out.price[m], out.volume[m], out.high[m], out.low[m]] = [t, price, volume, high, low];
	}
	return out;
}

function quoteAt(symbol: string, k: Track, day: Day, prevClose: number, m: number): Quote | undefined {
	const at = k.t[m]!;
	if (at === 0 || k.price[m] === 0) return undefined;
	return { symbol, price: k.price[m]!, prevClose, changePct: 0, volume: k.volume[m]!, at: new Date(at).toISOString(), dayClose: k.price[m]!, ...(BASELINE ? { dayOpen: null, dayHigh: null, dayLow: null } : { dayOpen: day.open, dayHigh: k.high[m]!, dayLow: k.low[m]! }) };
}

const sessions = [...(byMinute.get("SPY") ?? new Map()).keys()].filter((d) => (days.get("SPY") ?? []).some((b, i) => b.date === d && i >= 252)).sort();
const leans = new Map<string, { date: string; lean: Lean }[]>();
const tally = { ownTasks: 0, silent: 0, ring: 0, tasks: 0, triggers: 0, levelZero: 0, levelOne: 0, bumped: 0, divergent: 0, whipsaw: 0, combos: 0, merged: 0, ruleSilent: new Map<string, number>(), ruleRing: new Map<string, number>(), ruleHits: new Map<string, number>(), taskDays: new Map<number, number>() };
const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

for (const date of sessions) {
	const day = newDay(date);
	const history: Record<string, History | null> = {};
	const ctxDays: Record<string, { day: Day; prevClose: number; k: Track }> = {};
	for (const symbol of SYMBOLS) {
		const bars = days.get(symbol) ?? [];
		const i = bars.findIndex((b) => b.date === date);
		const mins = byMinute.get(symbol)?.get(date);
		if (i < 1 || mins === undefined) continue;
		history[symbol] = BASELINE ? null : historyOf(bars, i);
		ctxDays[symbol] = { day: bars[i]!, prevClose: bars[i - 1]!.close, k: track(mins, bars[i]!.volume / mins.reduce((s, b) => s + b.v, 0)) };
	}
	const past: Record<string, Lean[]> = {};
	const window = sessions.slice(Math.max(0, sessions.indexOf(date) - (WHIPSAW.days - 1)), sessions.indexOf(date));
	for (const [key, list] of leans) past[key] = list.filter((x) => window.includes(x.date)).map((x) => x.lean);
	const threads = new Set<string>();
	const ownThreads = new Set<string>();
	for (let m = OPEN; m < 16 * 60; m++) {
		const quotes = Object.entries(ctxDays).flatMap(([symbol, c]) => quoteAt(symbol, c.k, c.day, c.prevClose, m) ?? []);
		const beat = watch(day, quotes, { levels, history, past, quiet: false });
		for (const a of beat.alerts) {
			const rule = day.hits.find((h) => h.id === a.id)?.rule ?? (a.id.startsWith("band:") ? "move" : a.id.split(":")[0]!);
			if (a.push === "silent") (tally.silent++, add(tally.ruleSilent, rule));
			else (tally.ring++, add(tally.ruleRing, rule));
		}
		for (const n of beat.notices) {
			tally.triggers++;
			threads.add(n.thread);
			ownThreads.add(`${n.id.split(":")[1]}:${date}`);
			if (n.fields.line.includes("大盘日")) tally.merged++;
		}
	}
	tally.tasks += threads.size;
	tally.ownTasks += ownThreads.size;
	tally.taskDays.set(threads.size, (tally.taskDays.get(threads.size) ?? 0) + 1);
	for (const h of day.hits as Hit[]) {
		add(tally.ruleHits, h.rule);
		if (h.level === 0) tally.levelZero++;
		if (h.level === 1) tally.levelOne++;
		if (h.bumped) tally.bumped++;
		if (h.text.includes("多空分歧")) tally.divergent++;
		if (h.whipsaw) tally.whipsaw++;
		if (h.rule.includes("+")) tally.combos++;
		if (whipsawRules.has(h.rule) && h.lean !== null) leans.set(`${h.rule}:${h.symbol}`, [...(leans.get(`${h.rule}:${h.symbol}`) ?? []), { date, lean: h.lean }]);
	}
}

const n = sessions.length;
const per = (x: number) => (x / n).toFixed(2);
const rows = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${per(v)}`).join(", ");
console.log(`${n} sessions (${sessions[0]} to ${sessions.at(-1)}), 8 stocks + SPY + QQQ${BASELINE ? ", baseline: move bands only" : " + VIXY, table defaults"}, one beat per regular-session minute`);
console.log(`ringing lines per session: ${per(tally.ring)}  (${rows(tally.ruleRing)})`);
console.log(`silent lines per session:  ${per(tally.silent)}  (${rows(tally.ruleSilent)})`);
console.log(`tasks per session (distinct threads): ${per(tally.tasks)}, ${per(tally.ownTasks)} without the broad-market merge; triggers ${per(tally.triggers)}; band triggers folded into an index task ${tally.merged} in total`);
console.log(`tasks per day histogram: ${[...tally.taskDays].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(" ")}`);
console.log(`record only per session: level 0 ${per(tally.levelZero)}, level 1 ${per(tally.levelOne)}`);
console.log(`modifiers in total: same-lean bumps ${tally.bumped}, 多空分歧 notes ${tally.divergent}, whipsaw demotions ${tally.whipsaw}, combos ${tally.combos}`);
console.log(`hits per session by rule: ${rows(tally.ruleHits)}`);

const flipsAt = (list: readonly { date: string; lean: Lean }[], i: number, window: number) => {
	const from = sessions[Math.max(0, sessions.indexOf(list[i]!.date) - (window - 1))]!;
	const seq = list.slice(0, i + 1).filter((x) => x.date >= from).map((x) => x.lean);
	return seq.slice(1).filter((l, j) => l !== seq[j]).length;
};
for (const window of [5, 10, 15, 20]) {
	const demoted = new Map<string, number>();
	let total = 0;
	for (const [key, list] of leans) list.forEach((_, i) => flipsAt(list, i, window) >= WHIPSAW.flips && add(demoted, key.split(":")[0]!));
	for (const list of leans.values()) total += list.length;
	console.log(`whipsaw window ${window} trading days, ${WHIPSAW.flips} flips: ${[...demoted.values()].reduce((a, b) => a + b, 0)} of ${total} leaning hits demoted (${rows(demoted)})`);
}
