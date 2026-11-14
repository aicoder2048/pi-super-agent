import { readFileSync } from "node:fs";
import { nextEarningsOf, type Found, type None } from "../../earnings.ts";
import { sessionAt } from "../../market-days.ts";
import { argsOf } from "../../ta.ts";

const MISSING_KEY = "没有设置 FINNHUB_API_KEY，没去查财报日：在宿主的密钥文件里加一行 FINNHUB_API_KEY=<你的 Finnhub 密钥>，见 docs/modules/stock-ta.md";

const finnhubBase = (): string => JSON.parse(readFileSync(new URL("./finnhub.json", import.meta.url), "utf8")).baseUrl;

export default async function earningsDate(input: unknown): Promise<Found | None> {
	const args = argsOf(input, { symbol: "text", now: "text" });
	const symbol = String(args["symbol"] ?? "").toUpperCase();
	if (symbol === "") throw new Error("symbol 要填一个美股代码，例如 NVDA");
	const now = args["now"] === undefined ? Date.now() : Date.parse(args["now"] as string);
	if (Number.isNaN(now)) throw new Error(`now 要是 ISO 8601 时间，收到 ${JSON.stringify(args["now"])}`);
	const key = process.env["FINNHUB_API_KEY"] ?? "";
	if (key === "") throw new Error(MISSING_KEY);
	const today = sessionAt(now).nyDate;
	return nextEarningsOf(finnhubBase(), key, symbol, today);
}
