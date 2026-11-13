import { cpSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HEAD = resolve(import.meta.dirname, "../../..");
const MINUTE = 60_000;
const BASE = "https://api.massive.com";
const SNAPSHOT = `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers`;

export type Step = { at: string; now?: string; prices: Record<string, number> };
export type Scenario = { title: string; quoteDate?: string; days: { date: string; prevClose: Record<string, number>; steps: Step[] }[] };
export type Tick = { day: string; now: number; at: number; prices: Record<string, number>; prevClose: Record<string, number> };
export type Posted = { minute: string; externalId: string; text: string };
export type Watched = { key: string; condition: Record<string, unknown>; id?: string };

export const scenario = (name: string): Scenario => JSON.parse(readFileSync(join(HEAD, "tests/fixtures/us-market-day", `${name}.json`), "utf8"));
// Scenario days are all in November after daylight saving ended.
export const ny = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00-05:00`);
export const nyMinute = (ms: number) => new Date(ms - 5 * 60 * MINUTE).toISOString().slice(5, 16).replace("T", " ");

export function ticks(s: Scenario): Tick[] {
	return s.days.flatMap(({ date, prevClose, steps }) => steps.map((step) => {
		const at = ny(s.quoteDate ?? date, step.at);
		return { day: date, at, now: step.now === undefined ? at + 15 * MINUTE : ny(date, step.now), prices: step.prices, prevClose };
	}));
}

const tickerRow = (ticker: string, price: number, prevClose: number, at: number) => ({ ticker, lastTrade: { p: price, t: at * 1_000_000 }, min: { c: price, t: at, v: 1000 }, day: { c: price, v: 5_000_000 }, prevDay: { c: prevClose, v: 39_000_000 } });

export async function stockTaDay(tree: string, state: string, watchlist: readonly string[]) {
	const { Modules } = await import(join(tree, "src/modules.ts"));
	const { servedAsHost } = await import(join(tree, "tests/helpers/fakes.ts"));
	const { instanceData } = await import(join(tree, "src/modules/instance-data.ts"));
	const { runFeed } = await import(join(tree, "src/modules/feed-runner.ts"));
	const { Kernel } = await import(join(tree, "src/kernel/kernel.ts"));
	const { openStore } = await import(join(tree, "src/kernel/store.ts"));
	const { listedSymbols } = await import(join(tree, "docs/modules/examples/stock-ta/watchlist.ts"));
	cpSync(join(tree, "docs/modules/examples/stock-ta"), join(state, "modules", "stock-ta"), { recursive: true });
	const clock = { now: 0 };
	const posted: Posted[] = [];
	const open = () => {
		const entry = servedAsHost(Modules.load([join(state, "modules")])).feeds().find((e: { source: string }) => e.source === "stock-ta/quotes");
		if (entry === undefined) throw new Error(`${tree}: stock-ta has no quotes feed`);
		const db = openStore(join(state, "state.db"));
		const kernel = new Kernel({ db, clock: { now: () => clock.now }, sourcePolicy: () => "candidate" });
		return { entry, db, kernel, data: instanceData(state) };
	};
	let host = open();
	if (watchlist.length > 0) host.data.write("stock-ta", host.entry.components, "watchlist", watchlist.map((symbol) => ({ symbol })), "使用者口述", "replay");
	const listed = () => listedSymbols(host.data.query("stock-ta", host.entry.components, "watchlist", { limit: 500 }, "replay").rows).sort();
	return {
		posted,
		watch(w: Watched) {
			return host.data.watch("stock-ta", host.entry.components, { kind: "watch", collection: "quotes", op: "set", watch: w }, "page").output;
		},
		conditions: () => host.data.watch("stock-ta", host.entry.components, { kind: "watch", collection: "quotes", op: "list" }, "page").output.conditions,
		restart() {
			host.db.close();
			host = open();
		},
		async round(tick: Tick): Promise<{ ok: boolean; records: number; notices: string[]; alerts: Posted[]; ms: number }> {
			clock.now = tick.now;
			const tickers = Object.entries(tick.prices).map(([symbol, price]) => tickerRow(symbol, price, tick.prevClose[symbol]!, tick.at));
			const fixture = { name: "replay", input: { now: new Date(tick.now).toISOString() }, responses: { [`${SNAPSHOT}?tickers=${listed().join(",")}`]: { status: "DELAYED", tickers } } };
			const notices: string[] = [];
			const fresh: Posted[] = [];
			const started = performance.now();
			const run = await runFeed(host.entry, [], {
				data: host.data,
				submit: (n: { id: string }) => void notices.push(n.id),
				alert: (_: string, a: { externalId: string; text: string; at: string }) => {
					const { duplicate } = host.kernel.postHostLine("module:stock-ta", { kind: "alert", externalId: a.externalId, text: a.text, occurredAt: Date.parse(a.at), module: { title: "股票技术分析", private: false } });
					if (!duplicate) fresh.push({ minute: nyMinute(Date.parse(a.at)), externalId: a.externalId, text: a.text });
				},
				secret: () => undefined,
				problem: () => {},
				now: () => clock.now,
			}, fixture);
			const ms = performance.now() - started;
			if (!run.ok) throw new Error(`${tree} feed round at ${nyMinute(tick.now)}: ${run.note}`);
			posted.push(...fresh);
			return { ok: run.ok, records: run.records, notices, alerts: fresh, ms };
		},
		rows: (symbol: string) => host.data.query("stock-ta", host.entry.components, "quotes", { where: { symbol }, limit: 500 }, "replay").rows.length,
		close: () => host.db.close(),
	};
}

export async function replay(tree: string, state: string, s: Scenario, watchlist: readonly string[], conditions: readonly Watched[], restartAfter?: number): Promise<{ posted: Posted[]; rows: number; notices: string[] }> {
	const day = await stockTaDay(tree, state, watchlist);
	for (const c of conditions) day.watch(c);
	const notices: string[] = [];
	for (const [i, tick] of ticks(s).entries()) {
		if (i === restartAfter) day.restart();
		notices.push(...(await day.round(tick)).notices);
	}
	const rows = watchlist.reduce((n, symbol) => n + day.rows(symbol), 0);
	day.close();
	return { posted: day.posted, rows, notices };
}

export async function oldTripwire(tree: string, s: Scenario, wire: { symbol: string; condition: Record<string, unknown> }): Promise<Posted[]> {
	const { checkIntraday, firingId, alertText } = await import(join(tree, "src/sources/market/tripwires.ts"));
	const { parseQuote } = await import(join(tree, "src/sources/market/client.ts"));
	const { sessionAt } = await import(join(tree, "src/sources/market/session.ts"));
	const book = new Map([[`${wire.symbol}:${wire.condition["kind"]}`, { ...wire, setAt: 0 }]]);
	const seen = new Set<string>();
	const fired: Posted[] = [];
	for (const tick of ticks(s)) {
		const session = sessionAt(tick.now);
		const quotes = Object.entries(tick.prices).flatMap(([symbol, price]) => parseQuote(tickerRow(symbol, price, tick.prevClose[symbol]!, tick.at), [symbol], true, tick.now));
		for (const f of checkIntraday(book, quotes, session, new Map())) {
			const id = firingId(session.nyDate, f);
			if (seen.has(id)) continue;
			seen.add(id);
			fired.push({ minute: nyMinute(tick.at), externalId: id, text: alertText(f, quotes.find((q: { symbol: string }) => q.symbol === f.symbol)!) });
		}
	}
	return fired;
}
