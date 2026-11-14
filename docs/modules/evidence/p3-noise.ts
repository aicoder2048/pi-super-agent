// node docs/modules/evidence/p3-noise.ts <p2 dir> <signals.csv>
// The phase-3 noise budget: what reaches the user per trading day before phase 3 (the phase-2 quotes feed plus today's scan,
// which sends a trigger for every 50-day break below and opens a task for it, in its own thread) and after it (the quotes feed
// plus the scan graded by feeds/scan/close.ts, sharing the symbol's thread). The quotes side replays every regular-session minute
// of the year of minute bars through feeds/quotes/watch.ts, as p2-noise.ts does; the scan side feeds each session's `ta` daily
// signals, exported read-only from the host's ta.sqlite with their stored attention, and the module's daily bars to close().
//   signals.csv  sqlite3 -readonly -header -csv ta.sqlite "select symbol, rule_id, kind, direction, data_start_ms, data_end_ms,
//                price, \"values\" as vals, attention from signals where timeframe='1d' order by data_end_ms, id"
// Sessions without minute bars (the first year) count the scan side alone. Earnings dates are not in the export, so 财报临近
// (level 1, no line) is left out; the digest is built by feeds/scan/digest.ts from the day's hits of both feeds.
import { readFileSync } from "node:fs";
import { daily, minutes, OPEN, STOCKS, vixyDays, type Day, type Minute } from "./p2-measure-data.ts";
import { close, type DailyBar, type TaSignal } from "../examples/stock-ta/feeds/scan/close.ts";
import { digest } from "../examples/stock-ta/feeds/scan/digest.ts";
import { newDay, watch, type History } from "../examples/stock-ta/feeds/quotes/watch.ts";
import type { Hit } from "../examples/stock-ta/hits.ts";
import type { Quote } from "../examples/stock-ta/massive.ts";
import { parseRuleLevels, WATCH_RULES, WHIPSAW, type Lean } from "../examples/stock-ta/watch-rules.ts";

const [dir = "/tmp/p2m", signalsFile = "/tmp/p3m/signals.csv"] = process.argv.slice(2);
const SYMBOLS = [...STOCKS, "SPY", "QQQ", "VIXY"];
const days = daily(dir);
days.set("VIXY", vixyDays(dir));
const byMinute = new Map(SYMBOLS.map((s) => [s, minutes(dir, s)]));
const levels = parseRuleLevels([]).levels;
const whipsawRules = new Set(WATCH_RULES.filter((r) => "whipsaw" in r).map((r) => r.id as string));
const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function csv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [], cell = "", quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') (cell += '"', i++);
			else if (ch === '"') quoted = false;
			else cell += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") (row.push(cell), (cell = ""));
		else if (ch === "\n") (row.push(cell), rows.push(row), (row = []), (cell = ""));
		else if (ch !== "\r") cell += ch;
	}
	if (cell !== "" || row.length > 0) (row.push(cell), rows.push(row));
	return rows;
}

const signalsByDate = new Map<string, TaSignal[]>();
for (const [symbol, rule_id, kind, direction, , end, price, vals, attention] of csv(readFileSync(signalsFile, "utf8")).slice(1)) {
	const date = NY.format(new Date(Number(end)));
	signalsByDate.set(date, [...(signalsByDate.get(date) ?? []), { symbol: symbol!, rule_id: rule_id!, kind: kind!, direction: direction!, price: Number(price), attention: attention || null, values: JSON.parse(vals!) }]);
}

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

const quoteAt = (symbol: string, k: Track, day: Day, prevClose: number, m: number): Quote | undefined =>
	k.t[m] === 0 || k.price[m] === 0 ? undefined : { symbol, price: k.price[m]!, prevClose, changePct: 0, volume: k.volume[m]!, at: new Date(k.t[m]!).toISOString(), dayClose: k.price[m]!, dayOpen: day.open, dayHigh: k.high[m]!, dayLow: k.low[m]! };

type Pushes = { ring: number; silent: number; threads: Set<string> };
const blank = (): Pushes => ({ ring: 0, silent: 0, threads: new Set() });
const leans = new Map<string, { date: string; lean: Lean }[]>();
const quoteSessions = [...(byMinute.get("SPY") ?? new Map()).keys()].sort();

/** The quotes feed's day: its hits and what it pushed. */
function quotesDay(date: string): { hits: Hit[]; pushes: Pushes } {
	const day = newDay(date);
	const pushes = blank();
	const history: Record<string, History | null> = {};
	const ctxDays: Record<string, { day: Day; prevClose: number; k: Track }> = {};
	for (const symbol of SYMBOLS) {
		const bars = days.get(symbol) ?? [];
		const i = bars.findIndex((b) => b.date === date);
		const mins = byMinute.get(symbol)?.get(date);
		if (i < 1 || mins === undefined) continue;
		history[symbol] = historyOf(bars, i);
		ctxDays[symbol] = { day: bars[i]!, prevClose: bars[i - 1]!.close, k: track(mins, bars[i]!.volume / mins.reduce((s, b) => s + b.v, 0)) };
	}
	const past: Record<string, Lean[]> = {};
	const window = quoteSessions.slice(Math.max(0, quoteSessions.indexOf(date) - (WHIPSAW.days - 1)), quoteSessions.indexOf(date));
	for (const [key, list] of leans) past[key] = list.filter((x) => window.includes(x.date)).map((x) => x.lean);
	for (let m = OPEN; m < 16 * 60; m++) {
		const quotes = Object.entries(ctxDays).flatMap(([symbol, c]) => quoteAt(symbol, c.k, c.day, c.prevClose, m) ?? []);
		const beat = watch(day, quotes, { levels, history, past, quiet: false });
		for (const a of beat.alerts) a.push === "silent" ? pushes.silent++ : pushes.ring++;
		for (const n of beat.notices) pushes.threads.add(n.thread);
	}
	for (const h of day.hits) if (whipsawRules.has(h.rule) && h.lean !== null) leans.set(`${h.rule}:${h.symbol}`, [...(leans.get(`${h.rule}:${h.symbol}`) ?? []), { date, lean: h.lean }]);
	return { hits: day.hits, pushes };
}

const barsThrough = (symbol: string, date: string): DailyBar[] | undefined => {
	const bars = days.get(symbol) ?? [];
	const i = bars.findIndex((b) => b.date === date);
	return i < 0 ? undefined : bars.slice(Math.max(0, i - 259), i + 1).map((b) => ({ date: b.date, close: b.close, volume: b.volume }));
};

type Tally = { sessions: number; ring: number; silent: number; tasks: number; scanTasks: number; scanSilent: number; scanRing: number; digestDays: number; byRule: Map<string, number>; levels: number[]; bumped: number; divergent: number; noise: number; taskDays: Map<number, number> };
const tally = (): Tally => ({ sessions: 0, ring: 0, silent: 0, tasks: 0, scanTasks: 0, scanSilent: 0, scanRing: 0, digestDays: 0, byRule: new Map(), levels: [0, 0, 0, 0, 0, 0, 0], bumped: 0, divergent: 0, noise: 0, taskDays: new Map() });
const windows = { "two years, scan side (quotes where minute bars exist)": { before: tally(), after: tally() }, "the year with minute bars, both feeds": { before: tally(), after: tally() } };
const add = (m: Map<string | number, number>, k: string | number, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const digests: { date: string; length: number; text: string }[] = [];

const sessions = (days.get("SPY") ?? []).filter((_, i) => i >= 21).map((b) => b.date).filter((d) => signalsByDate.has(d) || quoteSessions.includes(d));
for (const date of sessions) {
	const quotes = quoteSessions.includes(date) ? quotesDay(date) : { hits: [], pushes: blank() };
	const signals = signalsByDate.get(date) ?? [];
	const oldTriggers = signals.filter((s) => STOCKS.includes(s.symbol) && s.rule_id === "R-MA-2-50" && s.direction === "bearish");
	const graded = close({ date, at: `${date}T21:00:00.000Z`, symbols: STOCKS, signals, bars: Object.fromEntries(STOCKS.map((s) => [s, barsThrough(s, date)])), earlier: quotes.hits, levels, quiet: false });
	const line = digest(date, [...quotes.hits, ...graded.hits], [], false);
	if (line !== undefined && quoteSessions.includes(date)) digests.push({ date, length: [...line].length, text: line });
	const afterThreads = new Set([...quotes.pushes.threads, ...graded.notices.map((n) => n.thread)]);
	const beforeThreads = quotes.pushes.threads.size + new Set(oldTriggers.map((s) => s.symbol)).size;
	for (const [name, w] of Object.entries(windows)) {
		if (name.startsWith("the year") && !quoteSessions.includes(date)) continue;
		w.before.sessions++, w.after.sessions++;
		w.before.ring += quotes.pushes.ring, w.before.silent += quotes.pushes.silent, w.before.tasks += beforeThreads, w.before.scanTasks += new Set(oldTriggers.map((s) => s.symbol)).size;
		w.after.ring += quotes.pushes.ring + graded.alerts.filter((a) => a.push !== "silent").length;
		w.after.silent += quotes.pushes.silent + graded.alerts.filter((a) => a.push === "silent").length;
		w.after.scanSilent += graded.alerts.filter((a) => a.push === "silent").length, w.after.scanRing += graded.alerts.filter((a) => a.push !== "silent").length;
		w.after.tasks += afterThreads.size, w.after.scanTasks += graded.notices.length;
		add(w.after.taskDays, afterThreads.size);
		if ([...quotes.hits, ...graded.hits].some((h) => h.level >= 1)) w.after.digestDays++;
		for (const h of graded.hits) {
			add(w.after.byRule, `${h.rule}@${h.level}`);
			w.after.levels[h.level]!++;
			if (h.bumped) w.after.bumped++;
			if (h.text.includes("多空分歧")) w.after.divergent++;
			if (h.signal !== undefined && h.level === 0 && h.text.includes("ta 判为噪音")) w.after.noise++;
		}
	}
}

const per = (x: number, t: Tally) => (x / t.sessions).toFixed(2);
for (const [name, { before, after }] of Object.entries(windows)) {
	console.log(`\n${name}: ${after.sessions} sessions (${sessions.find((d) => !name.startsWith("the year") || quoteSessions.includes(d))} to ${sessions.at(-1)}), 8 stocks, table defaults`);
	console.log(`  before phase 3: ring ${per(before.ring, before)}, silent ${per(before.silent, before)}, tasks ${per(before.tasks, before)} (scan's 50-day tasks ${per(before.scanTasks, before)})`);
	console.log(`  after phase 3:  ring ${per(after.ring, after)}, silent ${per(after.silent, after)} + digest ${per(after.digestDays, after)}, tasks ${per(after.tasks, after)} (scan triggers ${per(after.scanTasks, after)}; scan silent ${per(after.scanSilent, after)}, scan ring ${per(after.scanRing, after)})`);
	console.log(`  scan hits per session by level: ${after.levels.map((n, i) => `${i}:${per(n, after)}`).join(" ")}; ta noise demotions ${after.noise}, same-lean bumps ${after.bumped}, 多空分歧 ${after.divergent} in total`);
	console.log(`  scan hits per session by rule@level: ${[...after.byRule].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${per(v, after)}`).join(", ")}`);
	console.log(`  tasks per day histogram after: ${[...after.taskDays].sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}:${v}`).join(" ")}`);
}

const lengths = digests.map((d) => d.length).sort((a, b) => a - b);
const longest = digests.reduce((a, b) => (b.length > a.length ? b : a), digests[0]!);
console.log(`\ndigests in the year with minute bars: ${digests.length}, length median ${lengths[Math.floor(lengths.length / 2)]}, 90th percentile ${lengths[Math.floor(lengths.length * 0.9)]}, longest ${longest.length} (${longest.date}), folded into 另有 n 条 on ${digests.filter((d) => d.text.includes("另有")).length} days`);
console.log(`longest: ${longest.text}`);
const median = digests.find((d) => d.length === lengths[Math.floor(lengths.length / 2)])!;
console.log(`a median day (${median.date}): ${median.text}`);
