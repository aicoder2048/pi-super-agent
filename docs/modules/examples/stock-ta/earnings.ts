/** Finnhub's earnings calendar, read by the earnings-date tool and by the scan feed's 财报临近 rule. */
import { getJson, object, oneLine, REQUEST_LIMIT_MS } from "./massive.ts";
import { isTradingDay, shiftDate } from "./market-days.ts";

export const AHEAD_DAYS = 120;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMES: Record<string, Time> = { bmo: "盘前", amc: "盘后", dmh: "盘中" };

export type Time = "盘前" | "盘后" | "盘中" | "时间未公布";
type Row = { date: string; time: Time; reported: boolean };
export type Found = { symbol: string; today: string; date: string; time: Time; tradingDays: number };
export type None = { symbol: string; today: string; note: string };

function parseCalendar(body: Record<string, any>, symbol: string): Row[] {
	const rows = body.earningsCalendar;
	if (!Array.isArray(rows)) throw new Error("Finnhub 的应答里没有财报日历，稍后再查");
	return rows.flatMap((raw): Row[] => {
		const r = object(raw);
		if (r.symbol !== symbol || typeof r.date !== "string" || !DATE.test(r.date)) return [];
		return [{ date: r.date, time: TIMES[String(r.hour)] ?? "时间未公布", reported: typeof r.epsActual === "number" }];
	});
}

function tradingDaysBetween(today: string, date: string): number {
	let count = 0;
	for (let d = shiftDate(today, 1); d <= date; d = shiftDate(d, 1)) if (isTradingDay(d)) count++;
	return count;
}

function nextEarnings(symbol: string, today: string, rows: readonly Row[]): Found | None {
	const next = rows.filter((r) => r.date >= today && !r.reported).sort((a, b) => a.date.localeCompare(b.date))[0];
	if (next === undefined) return { symbol, today, note: `${AHEAD_DAYS} 天内没有已公布的财报日` };
	return { symbol, today, date: next.date, time: next.time, tradingDays: tradingDaysBetween(today, next.date) };
}

/** The next unreported earnings date of `symbol` from `today` (a New York date) on, within AHEAD_DAYS. */
export async function nextEarningsOf(baseUrl: string, key: string, symbol: string, today: string): Promise<Found | None> {
	const url = `${baseUrl}/calendar/earnings?from=${today}&to=${shiftDate(today, AHEAD_DAYS)}&symbol=${encodeURIComponent(symbol)}`;
	const body = await getJson(url, { "X-Finnhub-Token": key }, AbortSignal.timeout(REQUEST_LIMIT_MS), "Finnhub").catch((error: Error) => {
		throw new Error(oneLine(error, "Finnhub"));
	});
	return nextEarnings(symbol, today, parseCalendar(body, symbol));
}
