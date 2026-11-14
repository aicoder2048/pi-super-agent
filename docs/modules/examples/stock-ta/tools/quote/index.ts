import { changePct, massiveBase, MISSING_KEY, oneLine, REQUEST_LIMIT_MS, snapshot } from "../../massive.ts";
import { nyTime, regularCloseAt, sessionAt, type Phase } from "../../market-days.ts";
import { argsOf } from "../../ta.ts";

const MAX_SYMBOLS = 10;
const LABEL: Record<Phase, string> = { pre: "盘前", regular: "盘中", post: "盘后", closed: "休市" };
// The quotes run 15 minutes late, so the day bar is the official close only once the late feed has passed the close and its closing prints.
const CLOSE_SETTLES_MS = 20 * 60_000;

export default async function quote(input: unknown) {
	const args = argsOf(input, { symbols: "list", now: "text" });
	const symbols = [...new Set(((args["symbols"] ?? []) as string[]).map((s) => s.toUpperCase()))];
	if (symbols.length === 0) throw new Error("symbols 至少要有 1 个代码，例如 NVDA");
	if (symbols.length > MAX_SYMBOLS) throw new Error(`一次最多 ${MAX_SYMBOLS} 个代码，收到 ${symbols.length} 个，分几次查`);
	const key = process.env["POLYGON_API_KEY"] ?? "";
	if (key === "") throw new Error(MISSING_KEY);
	const now = args["now"] === undefined ? Date.now() : Date.parse(args["now"] as string);
	if (Number.isNaN(now)) throw new Error(`now 要是 ISO 8601 时间，收到 ${JSON.stringify(args["now"])}`);
	const quotes = await snapshot(massiveBase(), key, symbols, AbortSignal.timeout(REQUEST_LIMIT_MS)).catch((error: Error) => {
		throw new Error(oneLine(error));
	});
	const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
	const today = sessionAt(now).nyDate;
	const endedToday = now >= regularCloseAt(now) + CLOSE_SETTLES_MS;
	return {
		quotes: symbols.flatMap((symbol) => bySymbol.get(symbol) ?? []).map(({ dayClose, ...q }) => {
			const at = Date.parse(q.at);
			const { nyDate, phase } = sessionAt(at);
			// Data from an earlier New York date (a weekend, a holiday, the small hours) is the last session's: the market is closed.
			const earlier = nyDate !== today;
			// The clock decides whether today's session is over: a ticker with no after-hours trades keeps its 15:59 bar all evening.
			const ended = earlier || endedToday;
			const session = earlier ? "closed" : ended ? "post" : phase;
			// After the regular session the day bar keeps the official close while the minute bar follows after-hours trades.
			return {
				...q,
				at: `${nyDate} ${nyTime(at)} 美东`,
				session: LABEL[session],
				...(ended && dayClose !== null && { close: dayClose, closeDate: nyDate, closeChangePct: changePct(dayClose, q.prevClose) }),
			};
		}),
		missing: symbols.filter((s) => !bySymbol.has(s)),
	};
}

