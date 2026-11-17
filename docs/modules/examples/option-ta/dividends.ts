/** The next ex-dividend date from Massive `/v3/reference/dividends` rows: announced, or expected by the spec's rule (「主动提醒的两处细节」). */
import { isTradingDay, shiftDate } from "./market-days.ts";

export type NextDividend =
	| { kind: "announced"; exDate: string; amount: number | null }
	| { kind: "expected"; exDate: string; amount: number | null }
	| { kind: "none"; reason: string };

/** Payments a year Massive's `frequency` may carry for a regular dividend the rule projects. */
const PROJECTED_FREQUENCIES = new Set([1, 2, 4, 12]);
/** `CD`: a regular cash dividend, the only type the rule projects. */
const REGULAR_CASH = "CD";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Row = { exDate: string; frequency: unknown; type: unknown; amount: number | null };

function rowOf(raw: unknown): Row | undefined {
	const r = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	if (typeof r.ex_dividend_date !== "string" || !DATE.test(r.ex_dividend_date)) return undefined;
	const amount = typeof r.cash_amount === "number" && Number.isFinite(r.cash_amount) && r.cash_amount > 0 ? r.cash_amount : null;
	return { exDate: r.ex_dividend_date, frequency: r.frequency, type: r.dividend_type, amount };
}

/** `date` plus `months`, clamped to the last day of the target month. */
function addMonths(date: string, months: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const first = new Date(Date.UTC(y, m - 1 + months, 1));
	const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
	return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay))).toISOString().slice(0, 10);
}

function tradingDayOnOrBefore(date: string): string {
	let day = date;
	while (!isTradingDay(day)) day = shiftDate(day, -1);
	return day;
}

export function nextDividend(rows: readonly unknown[], today: string): NextDividend {
	const parsed = rows.flatMap((raw) => rowOf(raw) ?? []).sort((a, b) => a.exDate.localeCompare(b.exDate));
	const announced = parsed.find((r) => r.exDate >= today);
	if (announced !== undefined) return { kind: "announced", exDate: announced.exDate, amount: announced.amount };
	const latest = parsed.at(-1);
	if (latest === undefined) return { kind: "none", reason: "没有任何除息记录" };
	if (latest.type !== REGULAR_CASH) return { kind: "none", reason: `最近一次除息（${latest.exDate}）不是常规现金股息` };
	if (typeof latest.frequency !== "number" || !PROJECTED_FREQUENCIES.has(latest.frequency)) return { kind: "none", reason: `最近一次除息（${latest.exDate}）没有可用的一年次数` };
	const step = 12 / latest.frequency;
	for (let k = 1; ; k++) {
		const exDate = tradingDayOnOrBefore(addMonths(latest.exDate, k * step));
		if (exDate >= today) return { kind: "expected", exDate, amount: latest.amount };
	}
}
