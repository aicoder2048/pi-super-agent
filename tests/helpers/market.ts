import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Http } from "../../src/sources/market/client.ts";

const NS = 1_000_000;

export function snapshotBody(rows: Record<string, unknown>[], status = "DELAYED") {
	return { status, tickers: rows };
}

export function tickerRow(ticker: string, price: number, prevClose: number, at: number, extra: Record<string, unknown> = {}) {
	return { ticker, lastTrade: { p: price, t: at * NS }, min: { c: price, t: at, v: 1000 }, day: { c: price, v: 5_000_000 }, prevDay: { c: prevClose, v: 39_000_000 }, ...extra };
}

/** The Starter plan has no trades: the snapshot carries only the delayed minute bar. */
export function minuteRow(ticker: string, price: number, prevClose: number, at: number) {
	return { ticker, min: { c: price, t: at, v: 1000 }, day: { c: price, v: 5_000_000 }, prevDay: { c: prevClose, v: 39_000_000 } };
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

/** Answers `/v2/aggs/.../day/{from}/{to}` from closes by NY date the way the API does: newest first, t at NY midnight (EST). */
export function dailyBarsBody(closes: Record<string, number>, url: string) {
	const [from, to] = new URL(url).pathname.split("/").slice(-2) as [string, string];
	const results = Object.entries(closes)
		.filter(([date]) => date >= from && date <= to)
		.sort(([a], [b]) => b.localeCompare(a))
		.map(([date, c]) => ({ t: Date.parse(`${date}T05:00:00Z`), o: c, h: c, l: c, c, v: 1000 }));
	return { status: "OK", results };
}

export type Answer = { status: number; body: unknown };
type Hit = { url: string; auth: string | undefined };

export async function fakeMassive(t: TestContext) {
	const hits: Hit[] = [];
	let answers: Answer[] = [];
	const server = createServer((req, res) => {
		hits.push({ url: req.url ?? "", auth: req.headers.authorization });
		const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
		res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => new Promise((done) => server.close(done)));
	const { port } = server.address() as { port: number };
	return { hits, base: `http://127.0.0.1:${port}`, answer: (...next: Answer[]) => void (answers = next) };
}

export const SNAPSHOT = "/v2/snapshot/locale/us/markets/stocks/tickers";
const STOCK_TA = join(import.meta.dirname, "../../docs/modules/examples/stock-ta");

export function stockTaCopy(t: TestContext, baseUrl: string): string {
	const root = mkdtempSync(join(tmpdir(), "psa-stock-ta-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "stock-ta");
	cpSync(STOCK_TA, pkg, { recursive: true });
	const feedJson = join(pkg, "feeds/quotes/feed.json");
	writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), settings: { baseUrl } }));
	return pkg;
}
