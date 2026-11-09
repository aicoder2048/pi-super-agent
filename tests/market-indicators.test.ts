import assert from "node:assert/strict";
import test from "node:test";
import type { Bar } from "../src/sources/market/client.ts";
import { atr, bollinger, ema, indicatorReport, macd, rsi, sma, swings, vwap, week52 } from "../src/sources/market/indicators.ts";

const T = (iso: string) => Date.parse(iso);
const DAY = 86_400_000;
const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
const range = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const dayBars = (closes: number[], start = T("2025-01-02T05:00:00Z")): Bar[] =>
	closes.map((c, i) => ({ t: start + i * DAY, o: c, h: c + 1, l: c - 1, c, v: 1000 }));

test("SMA n = 最近 n 根收盘价的算术平均：1..20 的 SMA20 是 10.5，不足 n 根时给 undefined", () => {
	assert.equal(sma(range(20), 20), 10.5);
	assert.equal(sma(range(25), 20), 15.5);
	assert.equal(sma(range(19), 20), undefined);
});

test("EMA n 以前 n 根的 SMA 为种子，k = 2/(n+1)：EMA3 of 1,2,3,4,5 = 4", () => {
	assert.equal(ema([1, 2, 3, 4, 5], 3), 4);
	assert.equal(ema([1, 2], 3), undefined);
});

test("EMA n 对等差序列（SMA 种子）稳定滞后 (n-1)/2：1..40 的 EMA12 = 34.5，EMA26 = 27.5", () => {
	near(ema(range(40), 12), 34.5);
	near(ema(range(40), 26), 27.5);
});

test("MACD(12,26,9)：线 = EMA12 - EMA26，信号 = MACD 线的 EMA9（SMA 种子），柱 = 线 - 信号；等差 1..40 得 7/7/0，少于 34 根不算", () => {
	const m = macd(range(40))!;
	near(m.line, 7);
	near(m.signal, 7);
	near(m.histogram, 0);
	assert.equal(macd(range(33)), undefined);
	assert.ok(macd(range(34)));
});

test("RSI（Wilder）：首个平均涨跌 = 前 n 个变动的简单平均，之后 avg = (prev*(n-1) + cur)/n；1,2,3,2 的 RSI2 = 50", () => {
	assert.equal(rsi([1, 2, 3, 2], 2), 50);
	assert.equal(rsi(range(15), 14), 100);
	assert.equal(rsi(range(14), 14), undefined);
});

test("ATR（Wilder）：TR = max(h-l, |h-前收|, |l-前收|)，首个 ATR = 前 n 个 TR 的平均，之后 Wilder 平滑；手算样例 ATR2 = 3", () => {
	const bars: Bar[] = [
		{ t: 1, o: 9, h: 10, l: 8, c: 9, v: 1 },
		{ t: 2, o: 10, h: 11, l: 9, c: 10, v: 1 },
		{ t: 3, o: 11, h: 12, l: 10, c: 11, v: 1 },
		{ t: 4, o: 12, h: 15, l: 11, c: 14, v: 1 },
	];
	assert.equal(atr(bars, 2), 3);
	assert.equal(atr(bars.slice(0, 2), 2), undefined);
});

test("Bollinger(20, 2σ) 用总体标准差：1..20 的中轨 10.5，σ = √33.25", () => {
	const b = bollinger(range(20), 20, 2)!;
	assert.equal(b.middle, 10.5);
	assert.ok(Math.abs(b.upper - (10.5 + 2 * Math.sqrt(33.25))) < 1e-12);
	assert.ok(Math.abs(b.lower - (10.5 - 2 * Math.sqrt(33.25))) < 1e-12);
	assert.equal(bollinger(range(19), 20, 2), undefined);
});

test("52 周高低 = 最近 252 根日线的最高 h 和最低 l，更早的不算；不足 252 根时 undefined", () => {
	const closes = range(260, 100);
	closes[3] = 1000;
	closes[5] = 5;
	closes[200] = 900;
	closes[150] = 50;
	const bars = dayBars(closes);
	assert.deepEqual(week52(bars), { high: 901, low: 49 });
	assert.equal(week52(bars.slice(0, 251)), undefined);
});

test("VWAP = Σ(典型价 (h+l+c)/3 × v) / Σv，只算最后一根所在纽约日期的常规时段（9:30 起）分钟线", () => {
	const bar = (iso: string, h: number, l: number, c: number, v: number): Bar => ({ t: T(iso), o: c, h, l, c, v });
	const bars = [
		bar("2026-11-06T20:59:00Z", 500, 500, 500, 999),
		bar("2026-11-09T14:29:00Z", 300, 300, 300, 999),
		bar("2026-11-09T14:30:00Z", 12, 9, 9, 100),
		bar("2026-11-09T14:31:00Z", 13, 10, 13, 300),
	];
	assert.equal(vwap(bars), (10 * 100 + 12 * 300) / 400);
	assert.equal(vwap(bars.slice(0, 2)), undefined);
});

test("摆动支撑阻力：左右各 k 根都更低的高点是阻力（右侧允许相等），取现价上方最近的 3 个；低点同理给支撑", () => {
	const highs = [5, 6, 9, 6, 5, 6, 12, 7, 6, 7, 8, 7, 6, 6, 4, 3, 4, 5, 4, 5, 6];
	const bars: Bar[] = highs.map((h, i) => ({ t: i, o: h - 1, h, l: h - 2, c: h - 1, v: 1 }));
	const s = swings(bars, 7.5, 2);
	assert.deepEqual(s.resistance, [{ price: 8, t: 10 }, { price: 9, t: 2 }, { price: 12, t: 6 }]);
	assert.deepEqual(s.support, [{ price: 4, t: 8 }, { price: 3, t: 4 }, { price: 1, t: 15 }]);
});

test("报告：给出最后一根的时间和收盘价、用到的根数；不足的指标写 insufficient 并说明需要几根", () => {
	const bars = dayBars(range(60, 100));
	const r = indicatorReport(bars, "day");
	assert.equal(r.bars, 60);
	assert.equal(r.at, bars.at(-1)!.t);
	assert.equal(r.close, 159);
	assert.equal(r.sma20, 149.5);
	assert.equal(r.sma50, 134.5);
	assert.deepEqual(r.sma200, { insufficient: { need: 200, have: 60 } });
	assert.deepEqual(r.week52, { insufficient: { need: 252, have: 60 } });
	assert.deepEqual(r.macd, { line: 7, signal: 7, histogram: 0 });
	assert.equal(r.rsi14, 100);
	assert.equal(r.atr14, 2);
	assert.equal("vwap" in r, false);
});

test("报告：VWAP 只出现在分钟线，52 周只出现在日线；数值保留 4 位小数", () => {
	const start = T("2026-11-09T14:30:00Z");
	const bars: Bar[] = range(30).map((i) => ({ t: start + i * 60_000, o: 10, h: 10 + i / 3, l: 10, c: 10, v: 7 }));
	const r = indicatorReport(bars, "minute");
	assert.equal("week52" in r, false);
	assert.equal(typeof r.vwap, "number");
	assert.equal(r.vwap, Number((r.vwap as number).toFixed(4)));
	assert.equal(r.vwap, 11.7222);
	assert.equal("vwap" in indicatorReport(bars, "hour"), false);
});
