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

function pollOncePerQuoteFile(options, ctx, dir) {
	let quotes = [];
	const client = { snapshot: async (symbols) => quotes.filter((q) => symbols.includes(q.symbol)), bars: async () => [], dispose() {} };
	const source = new MarketSource({ ...options, client, ctx: { ...ctx, clock: { now: () => WED_10AM_ET } } });
	const seen = new Set();
	let timer;
	const scan = async () => {
		for (const name of readdirSync(dir).filter((n) => !n.endsWith(".ticked") && !seen.has(n))) {
			seen.add(name);
			const { symbol, price, prevClose } = JSON.parse(readFileSync(join(dir, name), "utf8"));
			quotes = [{ symbol, price, prevClose, changePct: ((price - prevClose) / prevClose) * 100, at: WED_10AM_ET - 60_000, delayed: false }];
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
	};
}
