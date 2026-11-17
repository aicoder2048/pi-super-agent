/**
 * Checks the open option positions recorded in `fills` against the first version's alert thresholds (build plan「已定的第一版范围」)
 * during the regular session. Every alert has an id the host posts only once, so a condition that holds on every beat alerts once.
 */
import { exDivCallVerdict, extrinsicGauge } from "../../assignment-risk.ts";
import { nextDividend, type NextDividend } from "../../dividends.ts";
import { epochMs, failedRequest, finnhubJson, FinnhubError, positive, requestSignal } from "../../feed-fetch.ts";
import { getJson, object } from "../../massive.ts";
import { isTradingDay, nyTime, sessionAt, shiftDate } from "../../market-days.ts";
import { pinRiskCheck } from "../../pin-risk-check.ts";
import { openPositions, type FeedRow, type Position } from "./positions.ts";

export const EXPIRY_SILENT_TRADING_DAYS = 5;
/** The delayed underlying price read at 09:30 is still pre-market; the first check from 09:45 on reads the opening price. */
export const EXPIRY_OPEN_CHECK_AFTER = "09:45";
/** Short options only. The expiry day's 3% is pin-risk-check.ts's NEAR_PCT. */
export const NEAR_STRIKE = 0.02;
export const PROFIT_SILENT = 0.5;
export const PROFIT_BELL = 0.8;
export const EARNINGS_LEAD_TRADING_DAYS = 2;
export const DIVIDEND_LEAD_TRADING_DAYS = 2;
const EARNINGS_AHEAD_DAYS = 120;
const FAILURES_BEFORE_PROBLEM = 3;

interface Input {
	settings: { baseUrl: string; finnhubBaseUrl: string };
	cursor: string | null;
	rows: { fills?: FeedRow[] };
	now: string;
}

type Alert = { id: string; text: string; at: string; push?: "silent" };
/** Prices of this beat, each only when it is from today's regular session: the underlying (15 minutes delayed) and the option's quote mid. */
type Quote = { spot: number | null; mid: number | null };
/** `earnings`: the next earnings date, null when none is announced, absent when not yet known today. */
type Events = { earnings?: string | null; dividend?: NextDividend };
/** The session's state: expiry-day positions already checked from 09:45 on, the day's events by underlying, beats in a row with a failed request. */
type Cursor = { date: string; decided: string[]; events: Record<string, Events>; failures: number };

type Check = { position: Position; quote: Quote; events: Events; today: string; firstOpenCheck: boolean };
type Rule = (c: Check) => Omit<Alert, "at"> | undefined;

const GUIDE = "docs/modules/examples/option-ta/README.md";
type Problem = { id: string; text: string };
const NO_POLYGON: Problem = { id: "no-key", text: `没有设置 POLYGON_API_KEY，仓位提醒没有取行情，到期、行权价、权利金和除息提醒都不会响：用 just module secret option-ta POLYGON_API_KEY 写进 modules-data/option-ta/.env，见 ${GUIDE}` };
const NO_FINNHUB: Problem = { id: "no-finnhub-key", text: `没有设置 FINNHUB_API_KEY，仓位提醒查不到财报日，财报提醒不会响，其余照常：用 just module secret option-ta FINNHUB_API_KEY 写进 modules-data/option-ta/.env，见 ${GUIDE}` };
const failing = (reason: string): Problem => ({ id: "data-down", text: `连着 ${FAILURES_BEFORE_PROBLEM} 轮有行情或财报取不到（最近一次：${reason}），缺数据的仓位这几轮没有检查；恢复后自动接着查` });

/** Trading days after `today` up to and including `date`. */
function tradingDaysUntil(today: string, date: string): number {
	let n = 0;
	for (let d = shiftDate(today, 1); d <= date; d = shiftDate(d, 1)) if (isTradingDay(d)) n++;
	return n;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const label = (p: Position) => `${p.underlying} ${p.expiry} ${p.strike} ${p.right} ${p.side === "short" ? "卖出" : "买入"} ${p.qty} 张（账户 ${p.account}）`;
const inTheMoney = (p: Position, spot: number) => (p.right === "put" ? spot < p.strike : spot > p.strike);

const RULES: Rule[] = [
	function expiryNear({ position: p, today }) {
		const left = tradingDaysUntil(today, p.expiry);
		if (left > EXPIRY_SILENT_TRADING_DAYS) return undefined;
		return { id: `expiry-near:${p.key}`, text: `${label(p)}：离到期还有 ${left} 个交易日`, push: "silent" };
	},
	function expiryOpen({ position: p, quote, firstOpenCheck }) {
		if (!firstOpenCheck || quote.spot === null) return undefined;
		const pin = pinRiskCheck({ spot: quote.spot, short_strike: p.strike, side: p.right, dte: 0, oi_at_strike: null });
		if (!pin.pin_risk) return undefined;
		return { id: `expiry-open:${p.key}`, text: `${label(p)}：今天到期，开盘后正股 ${money(quote.spot)} 离行权价 ${pct(pin.distance_pct)}，不到 3%` };
	},
	function strike({ position: p, quote, today }) {
		if (p.side !== "short" || quote.spot === null) return undefined;
		if (inTheMoney(p, quote.spot)) return { id: `strike-crossed:${p.key}:${today}`, text: `${label(p)}：正股 ${money(quote.spot)} 已穿过行权价，进入价内` };
		const distance = Math.abs(quote.spot - p.strike) / quote.spot;
		if (distance >= NEAR_STRIKE) return undefined;
		return { id: `strike-near:${p.key}:${today}`, text: `${label(p)}：正股 ${money(quote.spot)} 离行权价 ${pct(distance)}，不到 2%`, push: "silent" };
	},
	function profit({ position: p, quote }) {
		if (p.side !== "short" || quote.mid === null || !(p.openPrice > 0)) return undefined;
		const earned = (p.openPrice - quote.mid) / p.openPrice;
		const text = `${label(p)}：开仓权利金 ${money(p.openPrice)}，现在中间价 ${money(quote.mid)}，赚到 ${pct(earned)}`;
		if (earned >= PROFIT_BELL) return { id: `profit-80:${p.key}`, text };
		if (earned >= PROFIT_SILENT) return { id: `profit-50:${p.key}`, text, push: "silent" };
		return undefined;
	},
	function earnings({ position: p, events, today }) {
		const date = events.earnings;
		if (typeof date !== "string" || date < today || date > p.expiry) return undefined;
		const left = tradingDaysUntil(today, date);
		if (left <= EARNINGS_LEAD_TRADING_DAYS) return { id: `earnings-soon:${p.key}:${date}`, text: `${label(p)}：${date} 发财报，在到期前，还有 ${left} 个交易日` };
		return { id: `earnings:${p.key}:${date}`, text: `${label(p)}：到期前有财报（${date}）`, push: "silent" };
	},
	function dividend({ position: p, quote, events, today }) {
		const next = events.dividend;
		if (p.side !== "short" || p.right !== "call" || quote.spot === null || next === undefined || next.kind === "none") return undefined;
		if (next.exDate < today || tradingDaysUntil(today, next.exDate) > DIVIDEND_LEAD_TRADING_DAYS || !inTheMoney(p, quote.spot)) return undefined;
		const extrinsic = extrinsicGauge("call", quote.spot, p.strike, quote.mid)?.extrinsic ?? null;
		const verdict = exDivCallVerdict({ expiration: p.expiry, exDate: next.exDate, dividendPerShare: next.amount, extrinsic });
		if (verdict.verdict === "clear") return undefined;
		const why = verdict.verdict === "high" ? `，股息 ${money(next.amount!)} 高于剩余时间价值 ${money(extrinsic!)}，持有人提前行权划算` : verdict.verdict === "watch" ? `，股息 ${money(next.amount!)} 不高于剩余时间价值 ${money(extrinsic!)}` : "";
		const head = `${label(p)}：价内，${next.exDate} 除息在到期前`;
		if (next.kind === "announced") return { id: `ex-div:${p.key}:${next.exDate}`, text: `${head}${why}，有提前指派的风险` };
		return { id: `ex-div-expected:${p.key}:${next.exDate}`, text: `${head}（预计、未宣布）${why}，有提前指派的风险`, push: "silent" };
	},
];

function fresh(ms: number | undefined, today: string): boolean {
	if (ms === undefined) return false;
	const s = sessionAt(ms);
	return s.phase === "regular" && s.nyDate === today;
}

async function quoteOf(baseUrl: string, key: string, p: Position, today: string): Promise<Quote> {
	const body = await getJson(`${baseUrl}/v3/snapshot/options/${encodeURIComponent(p.underlying)}/O:${p.occ}`, key, requestSignal());
	const r = object(body.results);
	const asset = object(r.underlying_asset);
	const quote = object(r.last_quote);
	const price = positive(asset.price);
	const bid = positive(quote.bid);
	const ask = positive(quote.ask);
	const spot = price !== undefined && fresh(epochMs(asset.last_updated), today) ? price : null;
	const mid = bid !== undefined && ask !== undefined && fresh(epochMs(quote.last_updated), today) ? (positive(quote.midpoint) ?? (bid + ask) / 2) : null;
	return { spot, mid };
}

async function dividendOf(baseUrl: string, key: string, symbol: string, today: string): Promise<NextDividend> {
	const body = await getJson(`${baseUrl}/v3/reference/dividends?ticker=${encodeURIComponent(symbol)}&limit=10`, key, requestSignal());
	return nextDividend(Array.isArray(body.results) ? body.results : [], today);
}

/** The next unreported earnings date on Finnhub's calendar, read the way stock-ta's earnings.ts reads it; null when none is announced. */
async function earningsOf(baseUrl: string, key: string, symbol: string, today: string): Promise<string | null> {
	const url = `${baseUrl}/calendar/earnings?from=${today}&to=${shiftDate(today, EARNINGS_AHEAD_DAYS)}&symbol=${encodeURIComponent(symbol)}`;
	const rows = (await finnhubJson(url, key)).earningsCalendar;
	if (!Array.isArray(rows)) throw new FinnhubError("Finnhub 的应答里没有财报日历");
	const dates = rows.map(object).filter((r) => r.symbol === symbol && typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date >= today && typeof r.epsActual !== "number");
	return dates.map((r) => r.date as string).sort()[0] ?? null;
}

function readCursor(text: string | null, today: string): Cursor {
	let saved: Partial<Cursor> | undefined;
	try {
		saved = text === null ? undefined : (JSON.parse(text) as Partial<Cursor>);
	} catch {
		saved = undefined;
	}
	const failures = typeof saved?.failures === "number" ? saved.failures : 0;
	if (saved?.date !== today) return { date: today, decided: [], events: {}, failures };
	return { date: today, decided: saved.decided ?? [], events: saved.events ?? {}, failures };
}

export default async function watch(input: Input) {
	const nowMs = Date.parse(input.now);
	const session = sessionAt(nowMs);
	const today = session.nyDate;
	const live = openPositions(input.rows.fills ?? []).positions.filter((p) => p.expiry >= today);
	if (live.length === 0 || !isTradingDay(today) || session.phase !== "regular") return { records: [] };
	const polygon = process.env.POLYGON_API_KEY ?? "";
	if (polygon === "") return { records: [], problem: NO_POLYGON };
	const finnhub = process.env.FINNHUB_API_KEY ?? "";
	const cursor = readCursor(input.cursor, today);
	const errors: string[] = [];
	const settle = async <T>(work: Promise<T>): Promise<T | undefined> => {
		try {
			return await work;
		} catch (error) {
			if (!failedRequest(error)) throw error;
			errors.push(error.message);
			return undefined;
		}
	};

	await Promise.all([...new Set(live.map((p) => p.underlying))].map(async (symbol) => {
		const events = (cursor.events[symbol] ??= {});
		const [dividend, earnings] = await Promise.all([
			events.dividend ?? settle(dividendOf(input.settings.baseUrl, polygon, symbol, today)),
			events.earnings !== undefined || finnhub === "" ? events.earnings : settle(earningsOf(input.settings.finnhubBaseUrl, finnhub, symbol, today)),
		]);
		if (dividend !== undefined) events.dividend = dividend;
		if (earnings !== undefined) events.earnings = earnings;
	}));
	const quotes = await Promise.all(live.map((p) => settle(quoteOf(input.settings.baseUrl, polygon, p, today))));

	const at = new Date(nowMs).toISOString();
	const openCheck = nyTime(nowMs) >= EXPIRY_OPEN_CHECK_AFTER;
	const alerts: Alert[] = live.flatMap((position, i) => {
		const quote = quotes[i] ?? { spot: null, mid: null };
		const firstOpenCheck = position.expiry === today && openCheck && quote.spot !== null && !cursor.decided.includes(position.key);
		if (firstOpenCheck) cursor.decided.push(position.key);
		const check = { position, quote, events: cursor.events[position.underlying] ?? {}, today, firstOpenCheck };
		return RULES.flatMap((rule) => rule(check) ?? []).map((alert) => ({ ...alert, at }));
	});

	cursor.failures = errors.length > 0 ? cursor.failures + 1 : 0;
	const problem = cursor.failures >= FAILURES_BEFORE_PROBLEM ? failing(errors[0]!) : finnhub === "" ? NO_FINNHUB : undefined;
	return { records: [], alerts, cursor: JSON.stringify(cursor satisfies Cursor), ...(problem && { problem }) };
}
