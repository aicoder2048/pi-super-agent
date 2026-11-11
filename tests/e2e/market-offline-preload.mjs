import { FEEDS } from "../../src/sources/feeds.ts";
import { MarketSource, marketFeed } from "../../src/sources/market/source.ts";
import { parseMarketSettings } from "../../src/sources/market/settings.ts";

const offlineClient = { snapshot: async () => [], bars: async () => [], dispose() {} };

FEEDS["e2e-market"] = (input) => {
	const spec = marketFeed({ ...input, env: { MASSIVE_API_KEY: "e2e-offline" } });
	const settings = parseMarketSettings(input.settings, input.override, input.where);
	return { ...spec, create: (ctx) => new MarketSource({ source: input.source, title: input.title, settings, ctx, client: offlineClient }) };
};
