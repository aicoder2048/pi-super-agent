/** Parsing mirrors src/sources/market/client.ts: module code cannot import the host's. */
import { readFileSync } from "node:fs";

// The host stops a tool at 20 s; the request gives up first so the user hears why.
export const REQUEST_LIMIT_MS = 15_000;

export type Quote = { symbol: string; price: number; prevClose: number; changePct: number; volume: number | null; at: string };

const object = (v: unknown): Record<string, any> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

// Massive mixes nanosecond (lastTrade.t, updated) and millisecond (min.t) timestamps.
function epochMs(v: unknown): number | undefined {
	const n = positive(v);
	if (n === undefined) return undefined;
	return Math.floor(n > 1e17 ? n / 1e6 : n > 1e14 ? n / 1e3 : n < 1e11 ? n * 1000 : n);
}

export function parseQuote(raw: unknown): Quote | undefined {
	const r = object(raw);
	const trade = object(r.lastTrade), minute = object(r.min), day = object(r.day), prev = object(r.prevDay);
	const price = positive(trade.p) ?? positive(minute.c) ?? positive(day.c);
	const prevClose = positive(prev.c);
	const ms = (positive(trade.p) && epochMs(trade.t)) || (positive(minute.c) && epochMs(minute.t)) || epochMs(r.updated);
	if (typeof r.ticker !== "string" || !price || !prevClose || !ms) return undefined;
	const changePct = Math.round((price / prevClose - 1) * 10_000) / 100;
	return { symbol: r.ticker, price, prevClose, changePct, volume: typeof day.v === "number" ? day.v : null, at: new Date(ms).toISOString() };
}

export async function snapshot(baseUrl: string, key: string, symbols: readonly string[], signal?: AbortSignal): Promise<Quote[]> {
	const url = `${baseUrl}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${symbols.map(encodeURIComponent).join(",")}`;
	const tickers = (await get(url, key, signal)).tickers;
	if (!Array.isArray(tickers)) throw new Error("行情服务的应答里没有 tickers");
	return tickers.flatMap((row) => {
		const quote = parseQuote(row);
		return quote && symbols.includes(quote.symbol) ? [quote] : [];
	});
}

/** A tool.json has no settings, so tools borrow the quotes feed's Massive address. */
export function massiveBase(): string {
	return JSON.parse(readFileSync(new URL("./feeds/quotes/feed.json", import.meta.url), "utf8")).settings.baseUrl;
}

export type Span = "minute" | "hour";
/** [epoch ms, open, high, low, close, volume, VWAP of the bar] */
export type Bar = [t: number, o: number, h: number, l: number, c: number, v: number, vw: number];

/** Newest `limit` bars from `from` to `to` (New York dates), oldest first, as the host's MarketClient.bars asks. */
export async function bars(baseUrl: string, key: string, symbol: string, span: Span, from: string, to: string, limit: number, signal?: AbortSignal): Promise<Bar[]> {
	const url = `${baseUrl}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/${span}/${from}/${to}?adjusted=true&sort=desc&limit=${limit}`;
	const results = (await get(url, key, signal)).results;
	return (Array.isArray(results) ? results : []).flatMap((raw): Bar[] => {
		const b = object(raw);
		const bar = [positive(b.t), positive(b.o), positive(b.h), positive(b.l), positive(b.c), typeof b.v === "number" ? b.v : undefined, positive(b.vw)];
		return bar.every((n) => n !== undefined) ? [bar as Bar] : [];
	}).reverse();
}

async function get(url: string, key: string, signal?: AbortSignal): Promise<Record<string, any>> {
	const reply = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${key}` }, redirect: "error", signal });
	if (reply.status === 429) throw new Error("行情服务回 HTTP 429，请求太多，稍后再查");
	if (!reply.ok) throw new Error(`行情服务返回 HTTP ${reply.status}`);
	return object(await reply.json());
}

/** fetch rejects in English (fetch failed for a refused connection or a redirect, a parse error for a non-JSON body). */
export function oneLine(error: Error): string {
	if (error.name === "TimeoutError") return `行情服务 ${REQUEST_LIMIT_MS / 1000} 秒没有应答，稍后再查`;
	if (error.name === "SyntaxError") return "行情服务的应答不是 JSON，稍后再查";
	if (error.name === "TypeError") return "连不上行情服务，稍后再查";
	return error.message;
}

export const MISSING_KEY = "没有设置 POLYGON_API_KEY，没去查行情：在宿主的密钥文件里加一行 POLYGON_API_KEY=<你的 Massive/Polygon 密钥>，见 docs/modules/stock-ta.md";
