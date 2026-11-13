import { readFileSync } from "node:fs";
import { getJson, object, oneLine, REQUEST_LIMIT_MS } from "../../massive.ts";
import { isTradingDay, sessionAt, shiftDate } from "../../market-days.ts";
import { argsOf } from "../../ta.ts";

const AHEAD_DAYS = 120;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMES: Record<string, Time> = { bmo: "盘前", amc: "盘后", dmh: "盘中" };
const MISSING_KEY = "没有设置 FINNHUB_API_KEY，没去查财报日：在宿主的密钥文件里加一行 FINNHUB_API_KEY=<你的 Finnhub 密钥>，见 docs/modules/stock-ta.md";

type Time = "盘前" | "盘后" | "盘中" | "时间未公布";
/** One calendar row as far as this tool cares: estimates and actuals stay at the boundary, only whether it has reported crosses. */
type Row = { date: string; time: Time; reported: boolean };
type Found = { symbol: string; today: string; date: string; time: Time; tradingDays: number };
type None = { symbol: string; today: string; note: string };

const finnhubBase = (): string => JSON.parse(readFileSync(new URL("./finnhub.json", import.meta.url), "utf8")).baseUrl;

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

async function calendar(symbol: string, today: string, key: string): Promise<Record<string, any>> {
	const url = `${finnhubBase()}/calendar/earnings?from=${today}&to=${shiftDate(today, AHEAD_DAYS)}&symbol=${encodeURIComponent(symbol)}`;
	return getJson(url, { "X-Finnhub-Token": key }, AbortSignal.timeout(REQUEST_LIMIT_MS), "Finnhub").catch((error: Error) => {
		throw new Error(oneLine(error, "Finnhub"));
	});
}

export default async function earningsDate(input: unknown): Promise<Found | None> {
	const args = argsOf(input, { symbol: "text", now: "text" });
	const symbol = String(args["symbol"] ?? "").toUpperCase();
	if (symbol === "") throw new Error("symbol 要填一个美股代码，例如 NVDA");
	const now = args["now"] === undefined ? Date.now() : Date.parse(args["now"] as string);
	if (Number.isNaN(now)) throw new Error(`now 要是 ISO 8601 时间，收到 ${JSON.stringify(args["now"])}`);
	const key = process.env["FINNHUB_API_KEY"] ?? "";
	if (key === "") throw new Error(MISSING_KEY);
	const today = sessionAt(now).nyDate;
	return nextEarnings(symbol, today, parseCalendar(await calendar(symbol, today, key), symbol));
}
