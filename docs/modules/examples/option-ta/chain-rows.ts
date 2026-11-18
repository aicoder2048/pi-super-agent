/**
 * One Massive option-chain snapshot row, parsed into what the chain and vol tools report. A missing IV or greek stays
 * null with its source, never 0 (spec「行情取数规则」); a missing IV is solved from a two-sided quote's midpoint.
 */
import { impliedVolCall, impliedVolPut } from "./iv.ts";
import { normalCdf } from "./options-math.ts";
import { object } from "./massive.ts";
import { isTradingDay, sessionAt } from "./market-days.ts";
import { occRoot } from "./symbols.ts";

export type Source = "供应方" | "自算" | "无数据";
export type Right = "put" | "call";

export type ChainRow = {
	contract: string;
	right: Right;
	strike: number;
	expiry: string;
	/** Calendar days to 16:00 New York on the expiry date, ACT/365, two decimals. */
	dte: number;
	bid: number;
	ask: number;
	/** Null without a two-sided quote. */
	mid: number | null;
	quote_at: string | null;
	open_interest: number | null;
	/** Contracts traded in the session so far (the last session when closed); null when Massive gave none. */
	volume: number | null;
	iv: number | null;
	iv_source: Source;
	delta: number | null;
	gamma: number | null;
	theta: number | null;
	vega: number | null;
	greeks_source: Source;
	break_even: number | null;
};

export type Underlying = { price: number; at: string; delay: string };
export type Market = "盘中" | "休市";

/** `skippedBinary`: Massive's binary options; `skippedAdjusted`: contracts adjusted to another deliverable than 100 shares. */
export type ParsedChain = { rows: ChainRow[]; skippedBinary: number; skippedAdjusted: number; underlying: Underlying | null; market: Market };

export const MARKET_NOTE = "休市：期权报价停在上一个交易时段收盘；供应方的 IV 和希腊值按盘前盘后的正股价和更短的剩余时间重算，不是收盘 IV";
export const UNITS =
	"价格、行权价、盈亏平衡是每股美元；IV 是小数（0.2163 是 21.63%）；delta、gamma 按每股；theta 是每天每股美元；vega 是 IV 变 1 个百分点每股美元；open_interest、volume 是张；dte 是到到期日美东 16:00 的日历天数；正股价的延迟见 underlying.delay，期权报价实时";

const r4 = (n: number | null) => (n === null ? null : Math.round(n * 10000) / 10000);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nsToMs = (v: unknown): number | null => {
	const n = finite(v);
	return n === null || n <= 0 ? null : Math.floor(n > 1e17 ? n / 1e6 : n);
};

const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });

export function nyParts(ms: number): { date: string; time: string; weekday: string } {
	const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
	return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday! };
}

export const nyStamp = (ms: number) => {
	const { date, time } = nyParts(ms);
	return `${date} ${time} 美东`;
};

/** 16:00 New York on `date`, as epoch ms. */
export function expiryCloseMs(date: string): number {
	const guess = Date.parse(`${date}T16:00:00Z`);
	const seen = nyParts(guess);
	return guess - (Date.parse(`${seen.date}T${seen.time}:00Z`) - guess);
}

export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Open only in a trading day's regular session (the module calendar: holidays and 13:00 early closes) with option quotes from today. */
export function marketAt(nowMs: number, latestQuoteMs: number | null): Market {
	const session = sessionAt(nowMs);
	const fresh = latestQuoteMs !== null && sessionAt(latestQuoteMs).nyDate === session.nyDate;
	return isTradingDay(session.nyDate) && session.phase === "regular" && fresh ? "盘中" : "休市";
}

type Greeks = { delta: number; gamma: number; theta: number; vega: number };

/** Black-Scholes greeks under options-math's assumptions (rate 0, no dividends); theta per day, vega per IV point. */
export function bsGreeks(right: Right, spot: number, strike: number, iv: number, dteDays: number): Greeks {
	const t = dteDays / 365;
	const volT = iv * Math.sqrt(t);
	const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * t) / volT;
	const density = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
	return {
		delta: right === "call" ? normalCdf(d1) : normalCdf(d1) - 1,
		gamma: density / (spot * volT),
		theta: -(spot * density * iv) / (2 * Math.sqrt(t)) / 365,
		vega: (spot * density * Math.sqrt(t)) / 100,
	};
}

const OCC_SUFFIX = /^\d{6}[CP]\d{8}$/;

/**
 * Massive mixes binary options (`O:B1…`, european, no IV) into the chain: only the underlying's own American contracts
 * stay. Of those, a contract adjusted after a split or merger has a suffixed root and another deliverable than 100 shares.
 */
function kindOf(symbol: string, ticker: string, details: Record<string, any>): "standard" | "binary" | "adjusted" {
	const root = occRoot(symbol);
	if (!ticker.startsWith(`O:${root}`) || details.exercise_style !== "american") return "binary";
	return OCC_SUFFIX.test(ticker.slice(2 + root.length)) && details.shares_per_contract === 100 ? "standard" : "adjusted";
}

export function parseChain(symbol: string, raw: readonly unknown[], nowMs: number): ParsedChain {
	const rows: ChainRow[] = [];
	let skippedBinary = 0;
	let skippedAdjusted = 0;
	let underlying: Underlying | null = null;
	let latestQuoteMs: number | null = null;
	for (const item of raw) {
		const r = object(item);
		const details = object(r.details);
		const ticker = typeof details.ticker === "string" ? details.ticker : "";
		const kind = kindOf(symbol, ticker, details);
		if (kind !== "standard") {
			if (kind === "binary") skippedBinary += 1;
			else skippedAdjusted += 1;
			continue;
		}
		const right = details.contract_type === "put" || details.contract_type === "call" ? (details.contract_type as Right) : null;
		const strike = finite(details.strike_price);
		const expiry = typeof details.expiration_date === "string" ? details.expiration_date : null;
		if (right === null || strike === null || expiry === null) continue;
		const asset = object(r.underlying_asset);
		const spot = finite(asset.price);
		const spotMs = nsToMs(asset.last_updated);
		if (underlying === null && spot !== null && spotMs !== null) underlying = { price: spot, at: nyStamp(spotMs), delay: asset.timeframe === "DELAYED" ? "延迟 15 分钟" : "实时" };
		const quote = object(r.last_quote);
		const quoteMs = nsToMs(quote.last_updated);
		if (quoteMs !== null && (latestQuoteMs === null || quoteMs > latestQuoteMs)) latestQuoteMs = quoteMs;
		const bid = finite(quote.bid) ?? 0;
		const ask = finite(quote.ask) ?? 0;
		const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
		const dte = (expiryCloseMs(expiry) - nowMs) / 86_400_000;
		rows.push({
			contract: ticker,
			right,
			strike,
			expiry,
			dte: Math.round(dte * 100) / 100,
			bid,
			ask,
			mid: r4(mid),
			quote_at: quoteMs === null ? null : nyStamp(quoteMs),
			open_interest: finite(r.open_interest),
			volume: finite(object(r.day).volume),
			...volatility(r, right, spot, strike, mid, dte),
			break_even: finite(r.break_even_price),
		});
	}
	rows.sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.right.localeCompare(b.right));
	return { rows, skippedBinary, skippedAdjusted, underlying, market: marketAt(nowMs, latestQuoteMs) };
}

type Vol = Pick<ChainRow, "iv" | "iv_source" | "delta" | "gamma" | "theta" | "vega" | "greeks_source">;

const NO_GREEKS = { delta: null, gamma: null, theta: null, vega: null };

function volatility(r: Record<string, any>, right: Right, spot: number | null, strike: number, mid: number | null, dte: number): Vol {
	const given = finite(r.implied_volatility);
	const solved = given === null && mid !== null && spot !== null && dte > 0 ? (right === "put" ? impliedVolPut : impliedVolCall)(mid, spot, strike, dte) : null;
	const iv = given ?? solved;
	const ivSource: Source = given !== null ? "供应方" : solved !== null ? "自算" : "无数据";
	const g = object(r.greeks);
	const provided = [g.delta, g.gamma, g.theta, g.vega].map(finite);
	if (provided.every((v) => v !== null)) {
		const [delta, gamma, theta, vega] = provided as number[];
		return { iv: r4(iv), iv_source: ivSource, delta: r4(delta!), gamma: r4(gamma!), theta: r4(theta!), vega: r4(vega!), greeks_source: "供应方" };
	}
	if (iv === null || spot === null || dte <= 0) return { iv: r4(iv), iv_source: ivSource, ...NO_GREEKS, greeks_source: "无数据" };
	const own = bsGreeks(right, spot, strike, iv, dte);
	return { iv: r4(iv), iv_source: ivSource, delta: r4(own.delta), gamma: r4(own.gamma), theta: r4(own.theta), vega: r4(own.vega), greeks_source: "自算" };
}
