/** Parsing mirrors src/sources/market/client.ts: module code cannot import the host's. */
import { listedSymbols, type WatchRow } from "../../watchlist.ts";

interface Input {
	settings: { baseUrl: string };
	rows: { watchlist?: WatchRow[] };
}

type Quote = { id: string; symbol: string; price: number; changePct: number; volume: number | null; at: string };
type Notice = { id: string; thread: string; fields: Record<string, string> };

const BIG_MOVE_PCT = 5;

const object = (v: unknown): Record<string, any> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

// Massive mixes nanosecond (lastTrade.t, updated) and millisecond (min.t) timestamps.
function epochMs(v: unknown): number | undefined {
	const n = positive(v);
	if (n === undefined) return undefined;
	return Math.floor(n > 1e17 ? n / 1e6 : n > 1e14 ? n / 1e3 : n < 1e11 ? n * 1000 : n);
}

function parseQuote(raw: unknown, symbols: readonly string[]): Quote[] {
	const r = object(raw);
	if (!symbols.includes(r.ticker)) return [];
	const trade = object(r.lastTrade), minute = object(r.min), day = object(r.day), prev = object(r.prevDay);
	const price = positive(trade.p) ?? positive(minute.c) ?? positive(day.c);
	const prevClose = positive(prev.c);
	const ms = (positive(trade.p) && epochMs(trade.t)) || (positive(minute.c) && epochMs(minute.t)) || epochMs(r.updated);
	if (!price || !prevClose || !ms) return [];
	const at = new Date(ms).toISOString();
	const changePct = Math.round((price / prevClose - 1) * 10_000) / 100;
	return [{ id: `${r.ticker}@${at}`, symbol: r.ticker, price, changePct, volume: typeof day.v === "number" ? day.v : null, at }];
}

function newYork(iso: string): { date: string; minute: string } {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
			.formatToParts(new Date(iso))
			.map((p) => [p.type, p.value]),
	);
	const date = `${parts.year}-${parts.month}-${parts.day}`;
	return { date, minute: `${date} ${parts.hour}:${parts.minute}` };
}

/** The id carries the trading date and direction, so the kernel's dedupe sends one per symbol, day and direction. */
function bigMove(q: Quote): Notice[] {
	if (Math.abs(q.changePct) < BIG_MOVE_PCT) return [];
	const up = q.changePct > 0;
	const { date, minute } = newYork(q.at);
	return [{
		id: `big-move:${q.symbol}:${date}:${up ? "up" : "down"}`,
		thread: `big-move:${q.symbol}:${date}:${up ? "up" : "down"}`,
		fields: { symbol: q.symbol, direction: up ? "涨" : "跌", pct: `${up ? "+" : ""}${q.changePct.toFixed(2)}`, price: q.price.toFixed(2), at: minute },
	}];
}

export default async function quotes(input: Input) {
	const symbols = listedSymbols(input.rows.watchlist ?? []).sort();
	if (symbols.length === 0) return { records: [] };
	const key = process.env.POLYGON_API_KEY ?? "";
	if (key === "") throw new Error("没有设置 POLYGON_API_KEY，这一轮没去取报价：在宿主的密钥文件里加一行 POLYGON_API_KEY=<你的 Massive/Polygon 密钥>，见 docs/modules/stock-ta.md");
	const url = `${input.settings.baseUrl}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${symbols.map(encodeURIComponent).join(",")}`;
	const reply = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${key}` }, redirect: "error" });
	if (!reply.ok) throw new Error(`行情服务返回 HTTP ${reply.status}`);
	const tickers = object(await reply.json()).tickers;
	if (!Array.isArray(tickers)) throw new Error("行情服务的应答里没有 tickers");
	const records = tickers.flatMap((row) => parseQuote(row, symbols));
	return { records, notices: records.flatMap(bigMove) };
}
