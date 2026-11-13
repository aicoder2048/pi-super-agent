import { nyTime, sessionAt } from "../../market-days.ts";
import { snapshot, type Quote } from "../../massive.ts";
import { listedSymbols, type WatchRow } from "../../watchlist.ts";

type Side = "up" | "down";
type Bands = { default: number[]; bySymbol: Record<string, number[]> };

interface Input {
	settings: { baseUrl: string; bands: Bands };
	rows: { watchlist?: WatchRow[] };
	cursor: string | null;
	now: string;
}

/** The highest band each symbol reached today in each direction. Bands only climb, so a fall back and a second rise stay quiet. */
type Cursor = { date: string; fired: Record<string, Partial<Record<Side, number>>> };

const INDEXES = ["QQQ", "SPY"];
// Prices are cents, so a move of exactly a band can compute a hair below it (609 / 600 → 1.4999…%).
const EPSILON = 1e-9;

/** Stale: a pre-market trade in the first snapshot, yesterday's quote on a holiday, a trade after an early close. */
function fresh(q: Quote, today: string): boolean {
	const session = sessionAt(Date.parse(q.at));
	return session.phase === "regular" && session.nyDate === today;
}

function cursorFor(raw: string | null, today: string): Cursor {
	const saved = raw === null ? undefined : (JSON.parse(raw) as Cursor);
	return saved?.date === today ? saved : { date: today, fired: {} };
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
	if (key === "") throw new Error("没有设置 POLYGON_API_KEY，这一轮没去取报价：在宿主的密钥文件里加一行 POLYGON_API_KEY=<你的 Massive/Polygon 密钥>，见 docs/modules/stock-ta.md");
	const today = sessionAt(Date.parse(input.now)).nyDate;
	const quotes = (await snapshot(input.settings.baseUrl, key, symbols)).filter((q) => fresh(q, today));
	const cursor = cursorFor(input.cursor, today);
	const moves = quotes.flatMap((q) => bandMove(q, input.settings.bands, cursor).map((m) => ({ ...m, symbol: q.symbol })));
	return {
		records: quotes.map((q) => ({ id: `${q.symbol}@${q.at}`, ...q })),
		alerts: moves.map((m) => ({ id: m.id, text: m.line, at: m.at, fold: { key: m.symbol, side: m.side } })),
		notices: moves.map((m) => ({ id: m.id, thread: `${m.symbol}:${today}`, fields: { line: m.line } })),
		cursor: JSON.stringify(cursor),
	};
}
