/** Massive's stock snapshot, shared by the quotes feed and the quote tool. Parsing mirrors src/sources/market/client.ts: module code cannot import the host's. */

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

/** One request for all `symbols`; quotes come back only for the symbols asked, in Massive's order. */
export async function snapshot(baseUrl: string, key: string, symbols: readonly string[], signal?: AbortSignal): Promise<Quote[]> {
	const url = `${baseUrl}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${symbols.map(encodeURIComponent).join(",")}`;
	const reply = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${key}` }, redirect: "error", signal });
	if (!reply.ok) throw new Error(`行情服务返回 HTTP ${reply.status}`);
	const tickers = object(await reply.json()).tickers;
	if (!Array.isArray(tickers)) throw new Error("行情服务的应答里没有 tickers");
	return tickers.flatMap((row) => {
		const quote = parseQuote(row);
		return quote && symbols.includes(quote.symbol) ? [quote] : [];
	});
}
