import type { Bar, Span } from "./client.ts";
import { MINUTE, nyDateOf, sessionAt } from "./session.ts";

export interface Insufficient {
	insufficient: { need: number; have: number };
}
export type Reading<T> = T | Insufficient;
export interface Level {
	price: number;
	t: number;
}

const last = <T>(xs: T[]): T => xs[xs.length - 1]!;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function sma(values: number[], n: number): number | undefined {
	return values.length < n ? undefined : mean(values.slice(-n));
}

function emaSeries(values: number[], n: number): number[] {
	if (values.length < n) return [];
	const k = 2 / (n + 1);
	const out = [mean(values.slice(0, n))];
	for (const x of values.slice(n)) out.push(last(out) + k * (x - last(out)));
	return out;
}

export function ema(values: number[], n: number): number | undefined {
	return emaSeries(values, n).at(-1);
}

export function macd(closes: number[], fast = 12, slow = 26, signalN = 9) {
	const slowLine = emaSeries(closes, slow);
	const fastLine = emaSeries(closes, fast).slice(slow - fast);
	const line = slowLine.map((s, i) => fastLine[i]! - s);
	const signal = ema(line, signalN);
	return signal === undefined ? undefined : { line: last(line), signal, histogram: last(line) - signal };
}

function wilder(values: number[], n: number): number | undefined {
	if (values.length < n) return undefined;
	let avg = mean(values.slice(0, n));
	for (const x of values.slice(n)) avg = (avg * (n - 1) + x) / n;
	return avg;
}

export function rsi(closes: number[], n: number): number | undefined {
	const changes = closes.slice(1).map((c, i) => c - closes[i]!);
	const gain = wilder(changes.map((d) => Math.max(d, 0)), n);
	const loss = wilder(changes.map((d) => Math.max(-d, 0)), n);
	if (gain === undefined || loss === undefined) return undefined;
	return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

export function atr(bars: Bar[], n: number): number | undefined {
	const ranges = bars.slice(1).map((b, i) => Math.max(b.h - b.l, Math.abs(b.h - bars[i]!.c), Math.abs(b.l - bars[i]!.c)));
	return wilder(ranges, n);
}

export function bollinger(closes: number[], n: number, width: number) {
	if (closes.length < n) return undefined;
	const window = closes.slice(-n);
	const middle = mean(window);
	const sd = Math.sqrt(mean(window.map((x) => (x - middle) ** 2)));
	return { middle, upper: middle + width * sd, lower: middle - width * sd };
}

export const WEEK52_BARS = 252;

export function week52(bars: Bar[]) {
	if (bars.length < WEEK52_BARS) return undefined;
	const window = bars.slice(-WEEK52_BARS);
	return { high: Math.max(...window.map((b) => b.h)), low: Math.min(...window.map((b) => b.l)) };
}

const inRegularSession = (t: number) => {
	const { openAt, closeAt } = sessionAt(t);
	return t >= openAt && t < closeAt;
};

export type Vwap = { value: number; session: string; note?: string } | { unavailable: string };

// Anchored at the latest regular session in the bars, so before today's open it reports the previous session and says so.
export function vwap(bars: Bar[], now: number): Vwap {
	const anchor = bars.findLast((b) => inRegularSession(b.t) && b.v > 0);
	if (!anchor) return { unavailable: "这段分钟线里没有常规时段（9:30 开盘后）的成交" };
	const session = nyDateOf(anchor.t);
	const regular = bars.filter((b) => inRegularSession(b.t) && nyDateOf(b.t) === session);
	const volume = regular.reduce((a, b) => a + b.v, 0);
	const value = regular.reduce((a, b) => a + ((b.h + b.l + b.c) / 3) * b.v, 0) / volume;
	const today = sessionAt(now);
	if (session === today.nyDate) return { value, session };
	const note = !today.weekend && now < today.openAt
		? `今天 ${today.nyDate} 的常规时段还没开盘（9:30），这是上一交易日 ${session} 的 VWAP`
		: `这是 ${session} 交易日的 VWAP，不是今天 ${today.nyDate} 的`;
	return { value, session, note };
}

// A pivot high beats the k bars before it strictly and the k bars after it or ties them, so a flat top counts once.
export function swings(bars: Bar[], close: number, k = 5, keep = 3): { resistance: Level[]; support: Level[] } {
	const highs: Level[] = [];
	const lows: Level[] = [];
	for (let i = k; i + k < bars.length; i++) {
		const before = bars.slice(i - k, i);
		const after = bars.slice(i + 1, i + k + 1);
		const b = bars[i]!;
		if (before.every((x) => x.h < b.h) && after.every((x) => x.h <= b.h)) highs.push({ price: b.h, t: b.t });
		if (before.every((x) => x.l > b.l) && after.every((x) => x.l >= b.l)) lows.push({ price: b.l, t: b.t });
	}
	return {
		resistance: highs.filter((p) => p.price > close).sort((a, b) => a.price - b.price).slice(0, keep),
		support: lows.filter((p) => p.price < close).sort((a, b) => b.price - a.price).slice(0, keep),
	};
}

const round = (x: number) => Number(x.toFixed(4));
const roundAll = (v: number | object) => (typeof v === "number" ? round(v) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "number" ? round(x) : x])));

// Delayed plans deliver a bar's last minutes about 15 minutes late, as in session.ts.
const PARTIAL_GRACE_MS = 20 * MINUTE;
const SPAN_MS: Record<Exclude<Span, "day">, number> = { hour: 60 * MINUTE, minute: MINUTE };

export interface LastBar {
	start: number;
	end: number;
	partial: boolean;
}

export function lastBar(bar: Bar, span: Span, now: number): LastBar {
	const end = span === "day" ? sessionAt(bar.t).closeAt : bar.t + SPAN_MS[span];
	return { start: bar.t, end, partial: now < end + PARTIAL_GRACE_MS };
}

// Bars each indicator needs before its first value exists.
const INDICATORS = {
	sma20: { need: 20, of: (b: Bar[], c: number[]) => sma(c, 20) },
	sma50: { need: 50, of: (b: Bar[], c: number[]) => sma(c, 50) },
	sma200: { need: 200, of: (b: Bar[], c: number[]) => sma(c, 200) },
	ema12: { need: 12, of: (b: Bar[], c: number[]) => ema(c, 12) },
	ema26: { need: 26, of: (b: Bar[], c: number[]) => ema(c, 26) },
	macd: { need: 26 + 9 - 1, of: (b: Bar[], c: number[]) => macd(c) },
	rsi14: { need: 15, of: (b: Bar[], c: number[]) => rsi(c, 14) },
	atr14: { need: 15, of: (b: Bar[]) => atr(b, 14) },
	bollinger: { need: 20, of: (b: Bar[], c: number[]) => bollinger(c, 20, 2) },
	week52: { need: WEEK52_BARS, of: (b: Bar[]) => week52(b), only: "day" as Span },
	vwap: { need: 1, of: (b: Bar[], c: number[], now: number) => vwap(b, now), only: "minute" as Span },
};

type Name = keyof typeof INDICATORS;
type Value<N extends Name> = NonNullable<ReturnType<(typeof INDICATORS)[N]["of"]>>;

export type IndicatorReport = { bars: number; lastBar: LastBar; lastPrice: number; note?: string; swings: ReturnType<typeof swings> } & { [N in Name]?: Reading<Value<N>> };

export function indicatorReport(bars: Bar[], span: Span, now: number): IndicatorReport {
	const closes = bars.map((b) => b.c);
	const lastPrice = last(closes);
	const bar = lastBar(last(bars), span, now);
	const report: IndicatorReport = { bars: bars.length, lastBar: bar, lastPrice, swings: swings(bars, lastPrice) };
	if (bar.partial) report.note = "最后一根 K 线还没走完：lastPrice 是盘中价，不是收盘价；含这根的指标会随行情变化";
	for (const [name, spec] of Object.entries(INDICATORS) as [Name, (typeof INDICATORS)[Name]][]) {
		if ("only" in spec && spec.only !== span) continue;
		const value = spec.of(bars, closes, now);
		(report as Record<string, unknown>)[name] = value === undefined ? { insufficient: { need: spec.need, have: bars.length } } : roundAll(value);
	}
	return report;
}
