import { bars, massiveBase, MISSING_KEY, oneLine, REQUEST_LIMIT_MS, type Bar, type Span } from "../../massive.ts";
import { nyTime, sessionAt } from "../../market-days.ts";
import { argsOf } from "../../ta.ts";

const SPANS: readonly Span[] = ["minute", "hour"];
const MAX_BARS = 500;
const LOOKBACK_DAYS = 4;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

// Holidays count as trading days here: the cap only bounds how much a member asks for.
const weekday = (date: string) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
function lastWeekday(date: string): string {
	while (!weekday(date)) date = shift(date, -1);
	return date;
}

export default async function intraday(input: unknown) {
	const args = argsOf(input, { symbol: "text", span: "text", from: "text", to: "text", limit: "number", now: "text" });
	const symbol = String(args["symbol"] ?? "").toUpperCase();
	if (symbol === "") throw new Error("symbol 要填一个美股或 ETF 代码，例如 NVDA");
	const span = args["span"] as Span;
	if (!SPANS.includes(span)) throw new Error(`span 只有 minute 或 hour，收到 ${JSON.stringify(args["span"] ?? "")}；日线用 prices 或 structure`);
	const limit = (args["limit"] ?? MAX_BARS) as number;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BARS) throw new Error(`limit 最多 ${MAX_BARS} 根，收到 ${limit}`);
	const now = args["now"] === undefined ? Date.now() : Date.parse(args["now"] as string);
	if (Number.isNaN(now)) throw new Error(`now 要是 ISO 8601 时间，收到 ${JSON.stringify(args["now"])}`);
	const today = lastWeekday(sessionAt(now).nyDate);
	const to = (args["to"] ?? today) as string;
	const from = (args["from"] ?? to) as string;
	for (const date of [from, to]) if (!DATE.test(date)) throw new Error(`日期写成 2026-11-12 这样的纽约日期，收到 ${JSON.stringify(date)}`);
	if (from > to) throw new Error(`from 不能晚于 to，收到 ${from} 到 ${to}`);
	let earliest = today;
	for (let n = 1; n < LOOKBACK_DAYS; n++) earliest = lastWeekday(shift(earliest, -1));
	if (from < earliest) throw new Error(`最多回看 ${LOOKBACK_DAYS} 个交易日，from 最早 ${earliest}，收到 ${from}`);
	const key = process.env["POLYGON_API_KEY"] ?? "";
	if (key === "") throw new Error(MISSING_KEY);
	const got = await bars(massiveBase(), key, symbol, span, from, to, limit, AbortSignal.timeout(REQUEST_LIMIT_MS)).catch((error: Error) => {
		throw new Error(oneLine(error));
	});
	return {
		symbol,
		span,
		from,
		to,
		columns: ["at", "open", "high", "low", "close", "volume", "vwap"],
		bars: got.map(([t, ...rest]) => [`${sessionAt(t).nyDate} ${nyTime(t)}`, ...rest]),
		dayVwap: dayVwap(got),
		truncated: got.length >= limit,
		timeZone: "美东，行情延迟 15 分钟",
	};
}

/** Volume-weighted average over the newest New York date's bars, from the first of them on. */
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
