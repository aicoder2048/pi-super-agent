import type { Bar, Span } from "./client.ts";
import { sessionAt } from "./session.ts";

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

export function vwap(bars: Bar[]): number | undefined {
	const { openAt, closeAt } = sessionAt(last(bars).t);
	const session = bars.filter((b) => b.t >= openAt && b.t < closeAt);
	const volume = session.reduce((a, b) => a + b.v, 0);
	return volume > 0 ? session.reduce((a, b) => a + ((b.h + b.l + b.c) / 3) * b.v, 0) / volume : undefined;
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
const roundAll = (v: number | Record<string, number>) => (typeof v === "number" ? round(v) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])));

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
	vwap: { need: 1, of: (b: Bar[]) => vwap(b), only: "minute" as Span },
};

type Name = keyof typeof INDICATORS;
type Value<N extends Name> = NonNullable<ReturnType<(typeof INDICATORS)[N]["of"]>>;

export type IndicatorReport = { bars: number; at: number; close: number; swings: ReturnType<typeof swings> } & { [N in Name]?: Reading<Value<N>> };

export function indicatorReport(bars: Bar[], span: Span): IndicatorReport {
	const closes = bars.map((b) => b.c);
	const close = last(closes);
	const report: IndicatorReport = { bars: bars.length, at: last(bars).t, close, swings: swings(bars, close) };
	for (const [name, spec] of Object.entries(INDICATORS) as [Name, (typeof INDICATORS)[Name]][]) {
		if ("only" in spec && spec.only !== span) continue;
		const value = spec.of(bars, closes);
		(report as Record<string, unknown>)[name] = value === undefined ? { insufficient: { need: spec.need, have: bars.length } } : roundAll(value);
	}
	return report;
}
