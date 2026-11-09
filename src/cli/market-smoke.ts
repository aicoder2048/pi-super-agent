import { loadConfig, memberProviders } from "../host/config.ts";
import { Modules } from "../modules.ts";
import { MarketClient } from "../sources/market/client.ts";
import { FinnhubClient } from "../sources/market/finnhub.ts";
import { indicatorReport } from "../sources/market/indicators.ts";
import { readFinnhubKey, readMarketKey } from "../sources/market/key.ts";
import { nyDateOf, nyTime, sessionAt, shiftDate } from "../sources/market/session.ts";
import { parseMarketSettings } from "../sources/market/settings.ts";

const SOURCE = "us-market";
// The clients' default sleep is unref'd for the host; a one-shot CLI would exit mid rate-limit gap.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
	const config = loadConfig();
	const filter = Modules.load(config.modulesDirs, { allowedProviders: memberProviders(config) }).modules.flatMap((m) => m.manifest.sources ?? []).find((s) => s.name === SOURCE);
	if (!filter?.feed) throw new Error(`没有找到声明了 feed 的来源 ${SOURCE}`);
	const settings = parseMarketSettings(filter.feed.settings, config.sources[SOURCE], `sources.${SOURCE}`);
	const loaded = readMarketKey(process.env, config.secretsFile);
	if (!loaded) throw new Error("未配置行情密钥：设置 MASSIVE_API_KEY，或在 config.json 里用 secretsFile 指向 .env");
	const session = sessionAt(Date.now());
	console.log(`密钥来自 ${loaded.origin}；${settings.baseURL}；纽约 ${session.nyDate} ${session.phase}`);
	const client = new MarketClient({ key: loaded.key, baseURL: settings.baseURL, minGapMs: settings.minGapMs, sleep });
	const quotes = await client.snapshot(settings.watchlist, "poll");
	console.log(["代码", "现价", "昨收", "涨跌%", "报价时间(ET)", "延迟"].join("\t"));
	for (const q of quotes) console.log([q.symbol, q.price, q.prevClose, q.changePct.toFixed(2), `${nyDateOf(q.at)} ${nyTime(q.at)}`, q.delayed ? "是" : "否"].join("\t"));
	const missing = settings.watchlist.filter((s) => !quotes.some((q) => q.symbol === s));
	if (missing.length) console.log(`没有报价：${missing.join(" ")}`);

	const symbol = settings.watchlist[0]!;
	const from = shiftDate(session.nyDate, -400);
	const bars = await client.bars(symbol, "day", from, session.nyDate, 5000);
	console.log(`指标 ${symbol} 日线 ${from}～${session.nyDate}：${bars.length ? JSON.stringify(indicatorReport(bars, "day", Date.now())) : "没有 K 线"}`);

	const finnhub = readFinnhubKey(process.env, config.secretsFile);
	if (!finnhub) return console.log("财报：未配置 FINNHUB_API_KEY，跳过");
	const earnings = new FinnhubClient({ key: finnhub.key, minGapMs: 1000, sleep });
	console.log(`财报 ${symbol}（Finnhub 密钥来自 ${finnhub.origin}）：${JSON.stringify(await earnings.earnings(symbol, session.nyDate))}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
