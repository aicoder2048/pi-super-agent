/**
 * What the iv and watch feeds share beyond massive.ts: Finnhub requests, timestamps and the one check for a failed request.
 * Keys go in headers, never in the URL, so a fixture's URL is the real one.
 */
import { shiftDate } from "./market-days.ts";
import { MarketError, object, REQUEST_LIMIT_MS } from "./massive.ts";

export const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

const NEW_YORK = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export const newYorkDate = (ms: number): string => NEW_YORK.format(new Date(ms));

/** Massive mixes nanosecond and millisecond timestamps. */
export function epochMs(v: unknown): number | undefined {
	const n = positive(v);
	if (n === undefined) return undefined;
	return Math.floor(n > 1e17 ? n / 1e6 : n > 1e14 ? n / 1e3 : n < 1e11 ? n * 1000 : n);
}

export const requestSignal = () => AbortSignal.timeout(REQUEST_LIMIT_MS);

/** A Finnhub reply the feed cannot use: HTTP 429 or 5xx, a timeout, no connection, no JSON. */
export class FinnhubError extends Error {}

/** A failed request to either service: the feed counts it and tries again next beat. Anything else is a bug and throws. */
export const failedRequest = (error: unknown): error is Error => error instanceof MarketError || error instanceof FinnhubError;

export async function finnhubJson(url: string, key: string): Promise<Record<string, any>> {
	let reply: Response;
	try {
		reply = await fetch(url, { headers: { Accept: "application/json", "X-Finnhub-Token": key }, redirect: "error", signal: requestSignal() });
	} catch (error) {
		throw new FinnhubError((error as Error).name === "TimeoutError" ? `Finnhub ${REQUEST_LIMIT_MS / 1000} 秒没有应答` : "连不上 Finnhub");
	}
	if (reply.status === 429) throw new FinnhubError("Finnhub 回 HTTP 429，请求太多");
	if (!reply.ok) throw new FinnhubError(`Finnhub 返回 HTTP ${reply.status}`);
	try {
		return object(await reply.json());
	} catch {
		throw new FinnhubError("Finnhub 的应答不是 JSON");
	}
}

/** How far ahead the earnings calendar is asked. */
const EARNINGS_AHEAD_DAYS = 120;

/**
 * The next unreported earnings date on Finnhub's calendar from `today` on, read the way stock-ta's earnings.ts reads it; null
 * when none is announced. `includeReported` keeps reports already out (vol-alerts asks from a past session, whose report may be in).
 */
export async function earningsOf(baseUrl: string, key: string, symbol: string, today: string, includeReported = false): Promise<string | null> {
	const url = `${baseUrl}/calendar/earnings?from=${today}&to=${shiftDate(today, EARNINGS_AHEAD_DAYS)}&symbol=${encodeURIComponent(symbol)}`;
	const rows = (await finnhubJson(url, key)).earningsCalendar;
	if (!Array.isArray(rows)) throw new FinnhubError("Finnhub 的应答里没有财报日历");
	const dates = rows.map(object).filter((r) => r.symbol === symbol && typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date >= today && (includeReported || typeof r.epsActual !== "number"));
	return dates.map((r) => r.date as string).sort()[0] ?? null;
}
