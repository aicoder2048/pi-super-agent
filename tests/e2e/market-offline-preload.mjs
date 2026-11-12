import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FEEDS } from "../../src/sources/feeds.ts";
import { MarketSource, marketFeed } from "../../src/sources/market/source.ts";
import { parseMarketSettings } from "../../src/sources/market/settings.ts";

const offlineClient = { snapshot: async () => [], bars: async () => [], dispose() {} };
const quotesDir = process.env.PSA_E2E_QUOTES_DIR;
const WED_10AM_ET = Date.parse("2026-11-11T15:00:00Z");

FEEDS["e2e-market"] = (input) => {
	const spec = marketFeed({ ...input, env: { MASSIVE_API_KEY: "e2e-offline" } });
	const settings = parseMarketSettings(input.settings, input.override, input.where);
	const options = { source: input.source, title: input.title, settings };
	return { ...spec, create: (ctx) => (quotesDir ? pollOncePerQuoteFile(options, ctx, quotesDir) : new MarketSource({ ...options, ctx, client: offlineClient })) };
};

// Each file is one tick: { now?: ISO time (default Wed 10:00 ET), symbol?, price?, prevClose?, quotes?: [{ symbol, price, prevClose }], closes?: { SYM: { "YYYY-MM-DD": close } } }.
// closes accumulate across files and answer daily bars requests the way the API does.
function pollOncePerQuoteFile(options, ctx, dir) {
	let quotes = [];
	let now = WED_10AM_ET;
	const closes = {};
	const bars = async (symbol, _span, from, to) =>
		Object.entries(closes[symbol] ?? {})
			.filter(([date]) => date >= from && date <= to)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, c]) => ({ t: Date.parse(`${date}T05:00:00Z`), o: c, h: c, l: c, c, v: 1000 }));
	const client = { snapshot: async (symbols) => quotes.filter((q) => symbols.includes(q.symbol)), bars, dispose() {} };
	const source = new MarketSource({ ...options, client, ctx: { ...ctx, clock: { now: () => now } } });
	const seen = new Set();
	let timer;
	const scan = async () => {
		for (const name of readdirSync(dir).filter((n) => !n.endsWith(".ticked") && !seen.has(n))) {
			seen.add(name);
			const tick = JSON.parse(readFileSync(join(dir, name), "utf8"));
			now = tick.now ? Date.parse(tick.now) : WED_10AM_ET;
			for (const [symbol, byDate] of Object.entries(tick.closes ?? {})) closes[symbol] = { ...closes[symbol], ...byDate };
			quotes = [...(tick.symbol ? [tick] : []), ...(tick.quotes ?? [])].map(({ symbol, price, prevClose }) => ({ symbol, price, prevClose, changePct: ((price - prevClose) / prevClose) * 100, at: now - 60_000, delayed: false }));
			await source.tick();
			writeFileSync(join(dir, `${name}.ticked`), "");
		}
	};
	return {
		start() {
			timer = setInterval(() => void scan(), 100);
		},
		stop() {
			clearInterval(timer);
			source.stop();
		},
		problem: () => source.problem(),
		lookup: (op, args) => source.lookup(op, args),
		tripwires: (op, args) => source.tripwires(op, args),
		panel: () => source.panel(),
	};
}
