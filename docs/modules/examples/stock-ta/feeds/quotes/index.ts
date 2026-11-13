import { nyTime, sessionAt } from "../../market-days.ts";
import { snapshot, type Quote } from "../../massive.ts";
import { listedSymbols, type WatchRow } from "../../watchlist.ts";

interface Input {
	settings: { baseUrl: string };
	rows: { watchlist?: WatchRow[] };
	now: string;
}

type Notice = { id: string; thread: string; fields: Record<string, string> };

const BIG_MOVE_PCT = 5;

/** The id carries the trading date and direction, so the kernel's dedupe sends one per symbol, day and direction. */
function bigMove(q: Quote): Notice[] {
	if (Math.abs(q.changePct) < BIG_MOVE_PCT) return [];
	const up = q.changePct > 0;
	const ms = Date.parse(q.at);
	const date = sessionAt(ms).nyDate;
	return [{
		id: `big-move:${q.symbol}:${date}:${up ? "up" : "down"}`,
		thread: `big-move:${q.symbol}:${date}:${up ? "up" : "down"}`,
		fields: { symbol: q.symbol, direction: up ? "涨" : "跌", pct: `${up ? "+" : ""}${q.changePct.toFixed(2)}`, price: q.price.toFixed(2), at: `${date} ${nyTime(ms)}` },
	}];
}

/** In the regular session of the trading day `now` is in: a pre-market trade in the first snapshot, yesterday's quote on a holiday and a trade after an early close are all stale. */
function fresh(q: Quote, today: string): boolean {
	const session = sessionAt(Date.parse(q.at));
	return session.phase === "regular" && session.nyDate === today;
}

export default async function quotes(input: Input) {
	const symbols = listedSymbols(input.rows.watchlist ?? []).sort();
	if (symbols.length === 0) return { records: [] };
	const key = process.env.POLYGON_API_KEY ?? "";
	if (key === "") throw new Error("没有设置 POLYGON_API_KEY，这一轮没去取报价：在宿主的密钥文件里加一行 POLYGON_API_KEY=<你的 Massive/Polygon 密钥>，见 docs/modules/stock-ta.md");
	const today = sessionAt(Date.parse(input.now)).nyDate;
	const quotes = (await snapshot(input.settings.baseUrl, key, symbols)).filter((q) => fresh(q, today));
	return { records: quotes.map((q) => ({ id: `${q.symbol}@${q.at}`, ...q })), notices: quotes.flatMap(bigMove) };
}
