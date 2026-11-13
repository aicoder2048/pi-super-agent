import { bars, massiveBase, MISSING_KEY, oneLine, REQUEST_LIMIT_MS, type Bar, type Span } from "../../massive.ts";
import { nyTime, sessionAt } from "../../market-days.ts";
import { argsOf } from "../../ta.ts";

const SPANS: readonly Span[] = ["minute", "hour"];
const SPAN_MS: Record<Span, number> = { minute: 60_000, hour: 3_600_000 };
const MAX_BARS = 500;
// Massive's limit caps the minute aggregates behind the bars, so a small one silently drops the morning; 4 days of minutes fit.
const MASSIVE_LIMIT = 50_000;
const LOOKBACK_DAYS = 4;
const WHEN = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?$/;
const DAY_MS = 86_400_000;
// NYSE full-day closures as published on nyse.com/markets/hours-calendars, the same horizon as market-days.ts's early closes.
const HOLIDAYS = new Set([
	"2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
	"2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
	"2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
	"2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);

// Holidays count as trading days for the lookback: the cap only bounds how much a member asks for.
const weekday = (date: string) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
function lastWeekday(date: string): string {
	while (!weekday(date)) date = shift(date, -1);
	return date;
}
function tradingDayBefore(date: string): string {
	do date = shift(date, -1);
	while (!weekday(date) || HOLIDAYS.has(date));
	return date;
}
function anyTradingDay(from: string, to: string): boolean {
	for (let date = from; date <= to; date = shift(date, 1)) if (weekday(date) && !HOLIDAYS.has(date)) return true;
	return false;
}

/** A New York date with an optional time of day; `at` is the bound in the bars' own "YYYY-MM-DD HH:MM" form. */
function when(given: string, end: "start" | "end") {
	const m = WHEN.exec(given);
	if (m === null) throw new Error(`from、to 写成 2026-11-12 或 2026-11-12 09:30 这样的纽约日期和时刻，收到 ${JSON.stringify(given)}`);
	return { date: m[1]!, at: `${m[1]} ${m[2] ?? (end === "start" ? "00:00" : "23:59")}` };
}

export default async function intraday(input: unknown) {
	const args = argsOf(input, { symbol: "text", span: "text", from: "text", to: "text", limit: "number", now: "text" });
	const symbol = String(args["symbol"] ?? "").toUpperCase();
	if (symbol === "") throw new Error("symbol 要填一个美股或 ETF 代码，例如 NVDA");
	const span = args["span"] as Span;
	if (!SPANS.includes(span)) throw new Error(`span 只有 minute 或 hour，收到 ${JSON.stringify(args["span"] ?? "")}；日线用 prices 或 structure`);
	const limit = (args["limit"] ?? MAX_BARS) as number;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BARS) throw new Error(`limit 最多 ${MAX_BARS} 根，收到 ${limit}`);
	const replay = args["now"] !== undefined;
	const now = replay ? Date.parse(args["now"] as string) : Date.now();
	if (Number.isNaN(now)) throw new Error(`now 要是 ISO 8601 时间，收到 ${JSON.stringify(args["now"])}`);
	const calendarToday = sessionAt(now).nyDate;
	const today = lastWeekday(calendarToday);
	const toText = (args["to"] ?? today) as string;
	const to = when(toText, "end");
	const fromText = (args["from"] ?? to.date) as string;
	const from = when(fromText, "start");
	if (from.at > to.at) throw new Error(`from 不能晚于 to，收到 ${fromText} 到 ${toText}`);
	if (to.date > calendarToday) throw new Error(`to 不能晚于今天（纽约 ${calendarToday}），收到 ${toText}`);
	let earliest = today;
	for (let n = 1; n < LOOKBACK_DAYS; n++) earliest = lastWeekday(shift(earliest, -1));
	if (from.date < earliest) throw new Error(`最多回看 ${LOOKBACK_DAYS} 个交易日，from 最早 ${earliest}，收到 ${fromText}`);
	const key = process.env["POLYGON_API_KEY"] ?? "";
	if (key === "") throw new Error(MISSING_KEY);
	const got = await bars(massiveBase(), key, symbol, span, from.date, to.date, MASSIVE_LIMIT, AbortSignal.timeout(REQUEST_LIMIT_MS)).catch((error: Error) => {
		throw new Error(oneLine(error));
	});
	const atOf = (t: number) => `${sessionAt(t).nyDate} ${nyTime(t)}`;
	// A replay sees only bars that had finished by `now`; live, Massive's 15-minute delay already rules out later ones.
	const inWindow = got.filter(([t]) => atOf(t) >= from.at && atOf(t) <= to.at && (!replay || t + SPAN_MS[span] <= now));
	const kept = inWindow.slice(-limit);
	const note = kept.length > 0 ? undefined : emptyNote({ symbol, from, to, fromText, toText, calendarToday, now, fetched: got.length });
	return {
		symbol,
		span,
		from: fromText,
		to: toText,
		columns: ["at", "open", "high", "low", "close", "volume", "vwap"],
		bars: kept.map(([t, ...rest]) => [atOf(t), ...rest]),
		dayVwap: dayVwap(kept),
		truncated: inWindow.length > kept.length,
		timeZone: "美东，行情延迟 15 分钟",
		...(note !== undefined && { note }),
	};
}

type Bound = { date: string; at: string };
function emptyNote(q: { symbol: string; from: Bound; to: Bound; fromText: string; toText: string; calendarToday: string; now: number; fetched: number }): string {
	if (q.to.date === q.calendarToday && nyTime(q.now) < "04:00") return `纽约现在 ${nyTime(q.now)}，今天盘前 04:00 才有第一根 K 线；要看上一个交易日，把 from、to 改成 ${tradingDayBefore(q.calendarToday)}`;
	if (!anyTradingDay(q.from.date, q.to.date)) return `${q.from.date} 到 ${q.to.date} 没有 K 线，那几天休市（周末或节假日），把 from、to 改成上一个交易日 ${tradingDayBefore(q.from.date)} 再查`;
	if (q.fetched > 0) return `${q.fromText} 到 ${q.toText} 这段没有 K 线（盘前 04:00 到盘后 20:00 才有），把时刻放宽再查`;
	return `${q.from.date} 到 ${q.to.date} 是交易日，却没有 ${q.symbol} 的 K 线，代码可能不对，先用 quote 核对代码`;
}

function dayVwap(got: readonly Bar[]) {
	const last = got.at(-1);
	if (last === undefined) return null;
	const date = sessionAt(last[0]).nyDate;
	const day = got.filter(([t]) => sessionAt(t).nyDate === date);
	const volume = day.reduce((sum, b) => sum + b[5], 0);
	if (volume === 0) return null;
	const vwap = day.reduce((sum, b) => sum + b[6] * b[5], 0) / volume;
	return { date, vwap: Math.round(vwap * 100) / 100, since: nyTime(day[0]![0]) };
}
