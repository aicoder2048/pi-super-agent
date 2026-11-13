import { readFileSync } from "node:fs";
import { snapshot } from "../../massive.ts";
import { nyTime, sessionAt, type Phase } from "../../market-days.ts";
import { argsOf } from "../../ta.ts";

const MAX_SYMBOLS = 10;
// The host stops a tool at 20 s; the request gives up first so the user hears why.
const REQUEST_LIMIT_MS = 15_000;
const LABEL: Record<Phase, string> = { pre: "盘前", regular: "盘中", post: "盘后", closed: "休市" };

export default async function quote(input: unknown) {
	const args = argsOf(input, { symbols: "list", now: "text" });
	const symbols = [...new Set(((args["symbols"] ?? []) as string[]).map((s) => s.toUpperCase()))];
	if (symbols.length === 0) throw new Error("symbols 至少要有 1 个代码，例如 NVDA");
	if (symbols.length > MAX_SYMBOLS) throw new Error(`一次最多 ${MAX_SYMBOLS} 个代码，收到 ${symbols.length} 个，分几次查`);
	const key = process.env["POLYGON_API_KEY"] ?? "";
	if (key === "") throw new Error("没有设置 POLYGON_API_KEY，没去查报价：在宿主的密钥文件里加一行 POLYGON_API_KEY=<你的 Massive/Polygon 密钥>，见 docs/modules/stock-ta.md");
	const now = args["now"] === undefined ? Date.now() : Date.parse(args["now"] as string);
	if (Number.isNaN(now)) throw new Error(`now 要是 ISO 8601 时间，收到 ${JSON.stringify(args["now"])}`);
	// A tool.json has no settings, so the tool borrows the quotes feed's Massive address.
	const { baseUrl } = JSON.parse(readFileSync(new URL("../../feeds/quotes/feed.json", import.meta.url), "utf8")).settings;
	const quotes = await snapshot(baseUrl, key, symbols, AbortSignal.timeout(REQUEST_LIMIT_MS)).catch((error: Error) => {
		throw new Error(oneLine(error));
	});
	const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
	const today = sessionAt(now).nyDate;
	return {
		quotes: symbols.flatMap((symbol) => bySymbol.get(symbol) ?? []).map((q) => {
			const at = Date.parse(q.at);
			const { nyDate, phase } = sessionAt(at);
			// Data from an earlier New York date (a weekend, a holiday, the small hours) is the last session's: the market is closed.
			return { ...q, at: `${nyDate} ${nyTime(at)} 美东`, session: nyDate === today ? LABEL[phase] : LABEL.closed };
		}),
		missing: symbols.filter((s) => !bySymbol.has(s)),
	};
}

/** fetch rejects in English (fetch failed for a refused connection or a redirect, a parse error for a non-JSON body). */
function oneLine(error: Error): string {
	if (error.name === "TimeoutError") return `行情服务 ${REQUEST_LIMIT_MS / 1000} 秒没有应答，稍后再查`;
	if (error.name === "SyntaxError") return "行情服务的应答不是 JSON，稍后再查";
	if (error.name === "TypeError") return "连不上行情服务，稍后再查";
	return error.message;
}
