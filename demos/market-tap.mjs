// Preloaded into the demo host (node --import). Records each request the host's own market client
// makes, with what came back, so the demo can show polls without calling the market API itself.
// Never touches request headers, so the key never reaches the log.
import { appendFileSync } from "node:fs";
import { parseQuote } from "../src/sources/market/client.ts";

const OUT = process.env.PSA_MARKET_TAP;
const HOST = "api.massive.com";
const realFetch = globalThis.fetch;

/** The host's own quote parser, so the tap shows exactly what the market source saw. */
const quotesOf = (rows, tickers) => rows.flatMap((row) => parseQuote(row, tickers, false, Date.now())).map((q) => ({ s: q.symbol, pct: Number(q.changePct.toFixed(2)), at: q.at }));

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
				if (Array.isArray(body.tickers)) entry.quotes = quotesOf(body.tickers, (entry.tickers ?? "").split(","));
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
