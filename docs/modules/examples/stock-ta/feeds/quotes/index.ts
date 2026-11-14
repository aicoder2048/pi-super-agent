import { isTradingDay, nyTime, sessionAt } from "../../market-days.ts";
import { oneLine, snapshot, type Quote } from "../../massive.ts";
import { listedSymbols, type WatchRow } from "../../watchlist.ts";

type Side = "up" | "down";
type Bands = { default: number[]; bySymbol: Record<string, number[]> };

interface Input {
	settings: { baseUrl: string; bands: Bands };
	rows: { watchlist?: WatchRow[] };
	cursor: string | null;
	now: string;
}

/** `fired` holds the highest band per symbol and side: bands only climb, so a fall back and a second rise stay quiet. */
type Cursor = { date: string; fired: Record<string, Partial<Record<Side, number>>>; failures: number; lastQuote: { quotedAt: string | null; seenAt: string } };

type Problem = { id: "no-key" | "massive-down" | "stale"; text: string };
const GUIDE = "docs/modules/stock-ta.md";
const FAILURES_BEFORE_PROBLEM = 5;
const STALE_MS = 20 * 60_000;
const NO_KEY: Problem = { id: "no-key", text: `没有设置 POLYGON_API_KEY，报价没去取，到档提醒和你设的条件都不会响：在宿主的密钥文件里加一行 POLYGON_API_KEY=<你的 Massive/Polygon 密钥>，见 ${GUIDE}` };
const STALE: Problem = { id: "stale", text: `交易时段里 ${STALE_MS / 60_000} 分钟没有新的报价（行情本来就延迟 15 分钟，这是在那之外），到档提醒和你设的条件可能停了；Massive 可能在维护，或者套餐变了` };

const KEY_REJECTED = /HTTP 40[13]\b/;

function massiveDown(error: Error): Problem {
	const reason = oneLine(error);
	const advice = KEY_REJECTED.test(reason) ? "密钥失效或套餐到期，不会自己好：检查宿主密钥文件里的 POLYGON_API_KEY" : "恢复后自动接着取";
	return { id: "massive-down", text: `连着 ${FAILURES_BEFORE_PROBLEM} 轮取不到报价（最近一次：${reason}），到档提醒和你设的条件都停了；${advice}，见 ${GUIDE}` };
}

const INDEXES = ["QQQ", "SPY"];
// Prices are cents, so a move of exactly a band can compute a hair below it (609 / 600 → 1.4999…%).
const EPSILON = 1e-9;

/** Stale: a pre-market trade in the first snapshot, yesterday's quote on a holiday, a trade after an early close. */
function fresh(q: Quote, today: string): boolean {
	const session = sessionAt(Date.parse(q.at));
	return session.phase === "regular" && session.nyDate === today;
}

function cursorFor(raw: string | null, today: string, now: string): Cursor {
	const saved = raw === null ? undefined : (JSON.parse(raw) as Partial<Cursor>);
	const fresh: Cursor = { date: today, fired: {}, failures: 0, lastQuote: { quotedAt: null, seenAt: now } };
	return saved?.date === today ? { ...fresh, ...saved } : fresh;
}

function lastQuote(cursor: Cursor, quotes: readonly Quote[], now: string): Cursor["lastQuote"] {
	const newest = quotes.reduce<string | null>((max, q) => (max === null || q.at > max ? q.at : max), cursor.lastQuote.quotedAt);
	return newest === cursor.lastQuote.quotedAt ? cursor.lastQuote : { quotedAt: newest, seenAt: now };
}

/** Unrounded, so 4.996% stays under the 5% band. */
function bandMove(q: Quote, bands: Bands, cursor: Cursor) {
	const move = (q.price / q.prevClose - 1) * 100;
	const side: Side = move >= 0 ? "up" : "down";
	const band = Math.max(0, ...(bands.bySymbol[q.symbol] ?? bands.default).filter((b) => Math.abs(move) >= b - EPSILON));
	if (band <= (cursor.fired[q.symbol]?.[side] ?? 0)) return [];
	cursor.fired[q.symbol] = { ...cursor.fired[q.symbol], [side]: band };
	const sign = side === "up" ? "+" : "-";
	const id = `band:${q.symbol}:${cursor.date}:${side}${band}`;
	const line = `${q.symbol} ${side === "up" ? "涨" : "跌"} ${move >= 0 ? "+" : ""}${move.toFixed(2)}%，到达 ${sign}${band}% 档。现价 ${q.price.toFixed(2)}，昨收 ${q.prevClose.toFixed(2)}。报价时间 ${nyTime(Date.parse(q.at))} ET（延迟行情）。`;
	return [{ id, line, at: q.at, side }];
}

export default async function quotes(input: Input) {
	const symbols = [...new Set([...listedSymbols(input.rows.watchlist ?? []), ...INDEXES])].sort();
	const key = process.env.POLYGON_API_KEY ?? "";
	if (key === "") return { records: [], problem: NO_KEY };
	const nowMs = Date.parse(input.now);
	const session = sessionAt(nowMs);
	const today = session.nyDate;
	const cursor = cursorFor(input.cursor, today, input.now);
	let snapped: Quote[];
	try {
		snapped = await snapshot(input.settings.baseUrl, key, symbols);
	} catch (error) {
		const failures = cursor.failures + 1;
		return { records: [], cursor: JSON.stringify({ ...cursor, failures }), ...(failures >= FAILURES_BEFORE_PROBLEM && { problem: massiveDown(error as Error) }) };
	}
	const quotes = snapped.filter((q) => fresh(q, today));
	cursor.failures = 0;
	cursor.lastQuote = lastQuote(cursor, quotes, input.now);
	const stale = session.phase === "regular" && isTradingDay(today) && nowMs - Date.parse(cursor.lastQuote.seenAt) >= STALE_MS;
	const moves = quotes.flatMap((q) => bandMove(q, input.settings.bands, cursor).map((m) => ({ ...m, symbol: q.symbol })));
	return {
		records: quotes.map((q) => ({ id: `${q.symbol}@${q.at}`, ...q })),
		alerts: moves.map((m) => ({ id: m.id, text: m.line, at: m.at, fold: { key: m.symbol, side: m.side } })),
		notices: moves.map((m) => ({ id: m.id, thread: `${m.symbol}:${today}`, fields: { line: m.line } })),
		cursor: JSON.stringify(cursor),
		...(stale && { problem: STALE }),
	};
}
