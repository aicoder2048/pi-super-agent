import type { Http } from "../../src/sources/market/client.ts";

const NS = 1_000_000;

export function snapshotBody(rows: Record<string, unknown>[], status = "DELAYED") {
	return { status, tickers: rows };
}

export function tickerRow(ticker: string, price: number, prevClose: number, at: number, extra: Record<string, unknown> = {}) {
	return { ticker, lastTrade: { p: price, t: at * NS }, min: { c: price, t: at, v: 1000 }, day: { c: price, v: 5_000_000 }, prevDay: { c: prevClose, v: 39_000_000 }, ...extra };
}

export function fakeHttp(respond: (url: string, now: number) => Response | Promise<Response>, start = 0) {
	const clock = { t: start, now() { return this.t; } };
	const calls: { url: string; headers: Record<string, string>; at: number }[] = [];
	const http: Http = async (url, init) => {
		calls.push({ url, headers: init.headers, at: clock.t });
		return respond(url, clock.t);
	};
	const sleep = async (ms: number) => { clock.t += ms; };
	return { clock, calls, http, sleep };
}
