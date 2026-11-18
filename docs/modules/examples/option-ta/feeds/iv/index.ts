/**
 * Stores one row of IV raw inputs per watchlist symbol per session (spec「IV 历史」): the contract selectAtmContract picks, its
 * daily close and the underlying's daily close. A symbol new to the watchlist is backfilled a year, a bounded batch per beat;
 * after that each session is stored once after the close. The cursor holds each symbol's last stored session, so a session is
 * never stored twice and a gap (the host was off) is filled the same way as a backfill. A symbol listed less than a year ago
 * starts at its listing date, and at the first session it has a contract to pick.
 */
import { epochMs, failedRequest, newYorkDate, positive, requestSignal } from "../../feed-fetch.ts";
import { getJson, MarketError, object } from "../../massive.ts";
import { impliedVolPut } from "../../iv.ts";
import { dteOn, IV_SERIES_TENOR, selectAtmContract, type ContractData } from "../../iv-history.ts";
import { isTradingDay, regularCloseAt, shiftDate } from "../../market-days.ts";
import { isTicker, occRoot } from "../../symbols.ts";

/** When a session's daily bars are taken as final. Not measured yet (P1 left the after-close samples open); to be confirmed. */
export const IV_AFTER_CLOSE_MS = 30 * 60_000;
export const BACKFILL_CALENDAR_DAYS = 365;
/** Strikes asked for around the underlying's close; selectAtmContract then picks the nearest one that traded. */
export const STRIKE_BAND = 0.05;
/**
 * Contracts tried per session: the nearest strikes of each of the nearest expirations, nearest expiration first; the first
 * one that traded that day is the pick. A whole expiration without a trade near the spot moves on to the next expiration.
 */
export const PROBE_EXPIRATIONS = 3;
export const PROBE_STRIKES = 2;
/** The most requests one session can take: the contract list, the probes, one quote snapshot. */
const SESSION_REQUESTS = 1 + PROBE_EXPIRATIONS * PROBE_STRIKES + 1;
/** Until this long after the close, a session without its underlying bar or any traded contract is tried again, not stored as no-data; past it, a missing underlying bar is reported. */
const READY_DEADLINE_MS = 3 * 60 * 60_000;
/** No new session starts past this: a session's 8 requests of up to 15 s each still end inside the feed's 5-minute limit. */
const BEAT_MS = 150_000;
const FAILURES_BEFORE_PROBLEM = 3;
const SOURCE = "Massive";

type WatchRow = { id: string; fields: { symbol?: unknown; removed_at?: unknown } };
interface Input {
	/** `methodology`: changing the contract choice, the price field or the formula is a new one, stored again from scratch; tools/vol reads only its own. */
	settings: { baseUrl: string; requestsPerTick: number; methodology: string };
	cursor: string | null;
	rows: { watchlist?: WatchRow[] };
	now: string;
}
/**
 * `done`: each symbol's last stored session. Removed symbols keep theirs, so adding one back resumes where it stopped.
 * `from`: where a symbol's history starts before its first row: its listing date, moved past sessions with no contract to pick.
 */
type Cursor = { methodology: string; done: Record<string, string>; from: Record<string, string>; failures: number };
type Row = { id: string; symbol: string; trade_date: string; underlying_close: number; fetched_at: string; source: string; methodology: string; data_status: "ok" | "no-data"; reason?: string; option_symbol?: string; strike?: number; expiry?: string; contract_close?: number; quote_midpoint?: number; quote_at?: string };
type Problem = { id: string; text: string };

const GUIDE = "docs/modules/examples/option-ta/README.md";
const NO_KEY: Problem = { id: "no-key", text: `没有设置 POLYGON_API_KEY，IV 原始输入没有采集，一年回填也没做：用 just module secret option-ta POLYGON_API_KEY 写进 modules-data/option-ta/.env，见 ${GUIDE}` };
const failing = (reason: string): Problem => ({ id: "data-down", text: `连着 ${FAILURES_BEFORE_PROBLEM} 轮 IV 采集取不到行情（最近一次：${reason}），已存的不受影响，恢复后从停下的交易日接着存` });
const unknownSymbol = (symbol: string): Problem => ({ id: "unknown-symbol", text: `行情服务查不到期权自选里的 ${symbol}，没存；代码可能写错了` });
const noBars = (symbol: string): Problem => ({ id: "no-bars", text: `期权自选里的 ${symbol} 在要存的日子里一根正股日线都没有，没存；代码可能写错了，或者它停牌、退市了` });
const notReady = (date: string): Problem => ({ id: "not-ready", text: `${date} 收盘 3 小时后正股日线还没有，IV 原始输入还没存；行情服务恢复后自动补上` });

/** In the order symbols were first added; a symbol's latest row says whether it is removed. */
function listed(rows: readonly WatchRow[]): string[] {
	const removed = new Map<string, boolean>();
	for (const row of [...rows].sort((a, b) => Number(a.id) - Number(b.id))) {
		const symbol = String(row.fields.symbol ?? "").trim().toUpperCase();
		if (isTicker(symbol)) removed.set(symbol, Boolean(row.fields.removed_at));
	}
	return [...removed].filter(([, out]) => !out).map(([symbol]) => symbol);
}

const closeOf = (date: string) => regularCloseAt(Date.parse(`${date}T17:00:00Z`));

/** The latest session whose close is IV_AFTER_CLOSE_MS behind `tickMs`. */
function lastSession(tickMs: number): string {
	for (let date = newYorkDate(tickMs), back = 0; back < 10; date = shiftDate(date, -1), back++) {
		if (isTradingDay(date) && closeOf(date) + IV_AFTER_CLOSE_MS <= tickMs) return date;
	}
	throw new Error("往前 10 天都没找到收盘过的交易日");
}

/** Sessions still to store for a symbol, oldest first: after its last stored one (else from its `from`), within the backfill year, up to `target`. */
function pending(done: string | undefined, from: string | undefined, target: string): string[] {
	const floor = shiftDate(target, -BACKFILL_CALENDAR_DAYS);
	const first = done !== undefined && done >= floor ? shiftDate(done, 1) : from !== undefined && from > floor ? from : floor;
	const days: string[] = [];
	for (let d = first; d <= target; d = shiftDate(d, 1)) if (isTradingDay(d)) days.push(d);
	return days;
}

function readCursor(text: string | null, methodology: string): Cursor {
	try {
		const saved = text === null ? undefined : (JSON.parse(text) as Partial<Cursor>);
		if (saved?.methodology === methodology) return { methodology, done: saved.done ?? {}, from: saved.from ?? {}, failures: saved.failures ?? 0 };
		return { methodology, done: {}, from: {}, failures: saved?.failures ?? 0 };
	} catch {
		return { methodology, done: {}, from: {}, failures: 0 };
	}
}

export default async function iv(input: Input) {
	const tickMs = Date.parse(input.now);
	const today = newYorkDate(tickMs);
	const target = lastSession(tickMs);
	const METHODOLOGY = input.settings.methodology;
	const cursor = readCursor(input.cursor, METHODOLOGY);
	const work = listed(input.rows.watchlist ?? [])
		.map((symbol) => ({ symbol, days: pending(cursor.done[symbol], cursor.from[symbol], target) }))
		.filter((w) => w.days.length > 0)
		.sort((a, b) => a.days.length - b.days.length);
	if (work.length === 0) return { records: [], cursor: JSON.stringify(cursor satisfies Cursor) };
	const key = process.env.POLYGON_API_KEY ?? "";
	if (key === "") return { records: [], problem: NO_KEY };

	let left = input.settings.requestsPerTick;
	const deadline = Date.now() + BEAT_MS;
	const get = (url: string) => {
		left--;
		return getJson(url, key, requestSignal());
	};
	const base = input.settings.baseUrl;
	const fetchedAt = new Date(tickMs).toISOString();
	const records: Row[] = [];
	let problem: Problem | undefined;
	const noData = (symbol: string, date: string, reason: string, spot?: number) => ({ id: `${symbol}:${date}:${METHODOLOGY}`, symbol, trade_date: date, ...(spot !== undefined && { underlying_close: spot }), fetched_at: fetchedAt, source: SOURCE, methodology: METHODOLOGY, data_status: "no-data", reason }) as Row;

	/** The ticker's listing date, null when Massive does not know the ticker. A ticker taken over by a new listing (SPCX was an ETF before SpaceX) has the new one's date. */
	async function listingDate(symbol: string): Promise<string | undefined | null> {
		try {
			const date = object((await get(`${base}/v3/reference/tickers/${symbol}`)).results).list_date;
			return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
		} catch (error) {
			if (error instanceof MarketError && error.failure.status === "NO_DATA") return null;
			throw error;
		}
	}

	/**
	 * One session's row; `daily` also keeps the closing quote's mid for comparison, never for the series. Null while `waiting`
	 * (the session just closed) and no contract shows a trade yet: its option bars may not be out, so the session is tried again.
	 * "unlisted" when no contract in the tenor and strike band was listed that day.
	 */
	async function rowOf(symbol: string, date: string, spot: number, daily: boolean, waiting: boolean): Promise<Row | "unlisted" | null> {
		const row: Row = { id: `${symbol}:${date}:${METHODOLOGY}`, symbol, trade_date: date, underlying_close: spot, fetched_at: fetchedAt, source: SOURCE, methodology: METHODOLOGY, data_status: "no-data" };
		const [lo, hi] = [shiftDate(date, IV_SERIES_TENOR.min), shiftDate(date, IV_SERIES_TENOR.max)];
		const standard = new RegExp(`^O:${occRoot(symbol)}\\d{6}P\\d{8}$`);
		// Without as_of the list also holds contracts listed after `date` (daily expirations list about two weeks out), which cannot have traded that day.
		const url = `${base}/v3/reference/options/contracts?underlying_ticker=${symbol}&contract_type=put&expiration_date.gte=${lo}&expiration_date.lte=${hi}&strike_price.gte=${(spot * (1 - STRIKE_BAND)).toFixed(2)}&strike_price.lte=${(spot * (1 + STRIKE_BAND)).toFixed(2)}&as_of=${date}&sort=expiration_date&order=asc&limit=250`;
		const candidates: ContractData[] = [];
		for (const raw of (await get(url)).results ?? []) {
			const c = object(raw);
			// Binary options share the listing; spec「行情取数规则」keeps only the underlying's own American contracts.
			// Adjusted contracts after a split carry another deliverable and a suffixed root; only standard 100-share contracts count.
			if (typeof c.ticker !== "string" || !standard.test(c.ticker) || c.shares_per_contract !== 100 || c.exercise_style !== "american" || positive(c.strike_price) === undefined || typeof c.expiration_date !== "string") continue;
			const dte = dteOn(date, c.expiration_date);
			if (dte >= IV_SERIES_TENOR.min && dte <= IV_SERIES_TENOR.max) candidates.push({ ticker: c.ticker, strike: c.strike_price, expiration: c.expiration_date, bars: {} });
		}
		if (candidates.length === 0) return "unlisted";
		const expirations = [...new Set(candidates.map((c) => c.expiration))].sort().slice(0, PROBE_EXPIRATIONS);
		const nearest = (a: ContractData, b: ContractData) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.strike - b.strike;
		const probes = expirations.flatMap((exp) => candidates.filter((c) => c.expiration === exp).sort(nearest).slice(0, PROBE_STRIKES));
		const probed: ContractData[] = [];
		for (const c of probes) {
			const bar = object(((await get(`${base}/v2/aggs/ticker/${c.ticker}/range/1/day/${date}/${date}?adjusted=false`)).results ?? [])[0]);
			const close = positive(bar.c);
			probed.push({ ...c, bars: close === undefined ? {} : { [date]: close } });
			if (close !== undefined) break;
		}
		const pick = selectAtmContract(probed, date, spot);
		if (pick === null && waiting) return null;
		if (pick === null) return { ...row, reason: `最近 ${expirations.length} 个到期日离正股收盘价最近的 ${probed.length} 张合约那天都没有成交` };
		const close = pick.bars[date]!;
		const picked = { ...row, option_symbol: pick.ticker, strike: pick.strike, expiry: pick.expiration, contract_close: close };
		if (impliedVolPut(close, spot, pick.strike, dteOn(date, pick.expiration)) === null) return { ...picked, reason: "合约收盘价没有时间价值，反解不出 IV" };
		if (!daily) return { ...picked, data_status: "ok" };
		try {
			const quote = object(object((await get(`${base}/v3/snapshot/options/${symbol}/${pick.ticker}`)).results).last_quote);
			const [bid, ask, at] = [positive(quote.bid), positive(quote.ask), epochMs(quote.last_updated)];
			const mid = positive(quote.midpoint);
			if (bid === undefined || ask === undefined || at === undefined || mid === undefined || newYorkDate(at) !== date) return { ...picked, data_status: "ok" };
			return { ...picked, data_status: "ok", quote_midpoint: mid, quote_at: new Date(at).toISOString() };
		} catch (error) {
			if (!failedRequest(error)) throw error;
			return { ...picked, data_status: "ok" };
		}
	}

	try {
		outer: for (const { symbol, days: due } of work) {
			let days = due;
			if (cursor.done[symbol] === undefined && cursor.from[symbol] === undefined) {
				if (left < 2 + SESSION_REQUESTS) break;
				const listedOn = await listingDate(symbol);
				if (listedOn === null) {
					problem = unknownSymbol(symbol);
					continue;
				}
				cursor.from[symbol] = listedOn ?? days[0]!;
				days = days.filter((d) => d >= cursor.from[symbol]!);
				if (days.length === 0) continue;
			}
			if (left < 1 + SESSION_REQUESTS) break;
			const bars = (await get(`${base}/v2/aggs/ticker/${symbol}/range/1/day/${days[0]}/${days.at(-1)}?adjusted=false&sort=asc&limit=50000`)).results;
			const closes = new Map((Array.isArray(bars) ? bars : []).map(object).flatMap((b) => (positive(b.t) && positive(b.c) ? [[newYorkDate(b.t), b.c as number] as const] : [])));
			if (closes.size === 0 && days[0] !== target) {
				problem = noBars(symbol);
				continue;
			}
			for (const date of days) {
				if (left < SESSION_REQUESTS || Date.now() > deadline) break outer;
				const spot = closes.get(date);
				const waiting = date === target && tickMs <= closeOf(date) + READY_DEADLINE_MS;
				if (spot === undefined && date === target) {
					if (!waiting) problem = notReady(date);
					break;
				}
				const row = spot === undefined ? noData(symbol, date, "正股那天没有日线") : await rowOf(symbol, date, spot, date === target && today === target, waiting);
				if (row === null) break;
				if (row === "unlisted" && cursor.done[symbol] === undefined) {
					// Options list some days after the stock: the history starts at the first session with a contract to pick.
					cursor.from[symbol] = shiftDate(date, 1);
					continue;
				}
				records.push(row === "unlisted" ? noData(symbol, date, `期限 ${IV_SERIES_TENOR.min} 到 ${IV_SERIES_TENOR.max} 天、行权价在正股收盘价上下 ${STRIKE_BAND * 100}% 里，那天没有挂牌的合约`, spot) : row);
				cursor.done[symbol] = date;
			}
		}
		cursor.failures = 0;
	} catch (error) {
		if (!failedRequest(error)) throw error;
		cursor.failures++;
		if (cursor.failures >= FAILURES_BEFORE_PROBLEM) problem = failing(error.message);
	}
	return { records, cursor: JSON.stringify(cursor satisfies Cursor), ...(problem && { problem }) };
}
