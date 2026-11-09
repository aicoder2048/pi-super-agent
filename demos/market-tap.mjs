// Preloaded into the demo host (node --import). Records each request the host's own market client
// makes, with what came back, so the demo can show polls without calling the market API itself.
// Never touches request headers, so the key never reaches the log.
import { appendFileSync } from "node:fs";

const OUT = process.env.PSA_MARKET_TAP;
const HOST = "api.massive.com";
const realFetch = globalThis.fetch;

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const ms = (v) => {
	const n = num(v);
	if (n === undefined) return undefined;
	return Math.floor(n > 1e17 ? n / 1e6 : n > 1e14 ? n / 1e3 : n < 1e11 ? n * 1000 : n);
};

function quoteOf(row) {
	const price = num(row.lastTrade?.p) ?? num(row.min?.c) ?? num(row.day?.c);
	const prev = num(row.prevDay?.c);
	const at = (num(row.lastTrade?.p) && ms(row.lastTrade?.t)) || (num(row.min?.c) && ms(row.min?.t)) || ms(row.updated);
	return { s: row.ticker, pct: price && prev ? Number(((price / prev - 1) * 100).toFixed(2)) : null, at: at ?? null };
}

if (OUT) {
	globalThis.fetch = async (input, init) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		if (url.hostname !== HOST) return realFetch(input, init);
		const entry = { at: Date.now(), kind: url.pathname.startsWith("/v2/snapshot") ? "snapshot" : url.pathname.startsWith("/v2/aggs") ? "bars" : "other", path: url.pathname, tickers: url.searchParams.get("tickers") };
		try {
			const res = await realFetch(input, init);
			entry.status = res.status;
			try {
				const body = await res.clone().json();
				entry.apiStatus = body.status;
				if (Array.isArray(body.tickers)) entry.quotes = body.tickers.map(quoteOf);
				if (Array.isArray(body.results)) entry.bars = body.results.length;
			} catch {}
			return res;
		} catch (error) {
			entry.error = String(error?.name ?? error);
			throw error;
		} finally {
			appendFileSync(OUT, `${JSON.stringify(entry)}\n`);
		}
	};
}
