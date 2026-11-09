import { loadConfig, loadModules } from "../host/config.ts";
import { MarketClient } from "../sources/market/client.ts";
import { readMarketKey } from "../sources/market/key.ts";
import { nyDateOf, nyTime, sessionAt } from "../sources/market/session.ts";
import { parseMarketSettings } from "../sources/market/settings.ts";

const SOURCE = "us-market";

async function main(): Promise<void> {
	const config = loadConfig();
	const filter = loadModules(config).modules.flatMap((m) => m.manifest.sources ?? []).find((s) => s.name === SOURCE);
	if (!filter?.feed) throw new Error(`没有找到声明了 feed 的来源 ${SOURCE}`);
	const settings = parseMarketSettings(filter.feed.settings, config.sources[SOURCE], `sources.${SOURCE}`);
	const loaded = readMarketKey(process.env, config.secretsFile);
	if (!loaded) throw new Error("未配置行情密钥：设置 MASSIVE_API_KEY，或在 config.json 里用 secretsFile 指向 .env");
	const session = sessionAt(Date.now());
	console.log(`密钥来自 ${loaded.origin}；${settings.baseURL}；纽约 ${session.nyDate} ${session.phase}`);
	const client = new MarketClient({ key: loaded.key, baseURL: settings.baseURL, minGapMs: 0 });
	const quotes = await client.snapshot(settings.watchlist, "poll");
	console.log(["代码", "现价", "昨收", "涨跌%", "报价时间(ET)", "延迟"].join("\t"));
	for (const q of quotes) console.log([q.symbol, q.price, q.prevClose, q.changePct.toFixed(2), `${nyDateOf(q.at)} ${nyTime(q.at)}`, q.delayed ? "是" : "否"].join("\t"));
	const missing = settings.watchlist.filter((s) => !quotes.some((q) => q.symbol === s));
	if (missing.length) console.log(`没有报价：${missing.join(" ")}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
