const NS = 1_000_000;

export function snapshotBody(rows: Record<string, unknown>[], status = "DELAYED") {
	return { status, tickers: rows };
}

export function tickerRow(ticker: string, price: number, prevClose: number, at: number, extra: Record<string, unknown> = {}) {
	return { ticker, lastTrade: { p: price, t: at * NS }, min: { c: price, t: at, v: 1000 }, day: { c: price, v: 5_000_000 }, prevDay: { c: prevClose, v: 39_000_000 }, ...extra };
}
