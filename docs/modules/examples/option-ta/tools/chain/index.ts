import { MARKET_NOTE, nyParts, nyStamp, parseChain, UNITS, type ChainRow, type Right } from "../../chain-rows.ts";
import { fail, MarketError, MISSING_KEY, query, REQUEST_LIMIT_MS, snapshotPages, SYMBOL } from "../../massive.ts";

/** Rows nearest the underlying price kept when a wide strike range returns more; the expert reads a compact result. */
const MAX_ROWS = 60;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPERATIONS = ["snapshot", "oi", "gex", "max-pain", "unusual-volume"] as const;

type Request = { symbol: string; expiry?: string; from?: string; to?: string; right?: Right; strikeMin?: number; strikeMax?: number; nowMs: number };

export default async function chain(input: Record<string, unknown>) {
	try {
		const operation = input["operation"] ?? "snapshot";
		if (!OPERATIONS.includes(operation as never)) fail("INVALID_INPUT", `operation 只能是 ${OPERATIONS.join("、")}`);
		if (operation !== "snapshot") return { status: "NOT_IMPLEMENTED", reason: "OI 墙、GEX、最大痛点和异常成交还没做；现在只回期权链快照（operation 写 snapshot）。" };
		const request = parse(input);
		const key = process.env["POLYGON_API_KEY"] ?? "";
		if (key === "") fail("NO_KEY", MISSING_KEY);
		const fetched = await snapshotPages(query(request.symbol, [
			["contract_type", request.right],
			["expiration_date", request.expiry],
			["expiration_date.gte", request.from],
			["expiration_date.lte", request.to],
			["strike_price.gte", request.strikeMin],
			["strike_price.lte", request.strikeMax],
		]), key, AbortSignal.timeout(REQUEST_LIMIT_MS));
		const parsed = parseChain(request.symbol, fetched.rows, request.nowMs);
		if (parsed.rows.length === 0) fail("NO_DATA", `没有符合条件的 ${request.symbol} 标准期权合约（滤掉了 ${parsed.skippedBinary} 行二元期权），换个到期日或行权价范围再查`);
		const contracts = compact(parsed.rows, parsed.underlying?.price ?? null);
		return {
			status: "OK",
			symbol: request.symbol,
			fetched_at: nyStamp(request.nowMs),
			market: parsed.market,
			...(parsed.market === "休市" && { market_note: MARKET_NOTE }),
			underlying: parsed.underlying,
			contracts,
			rows_dropped: parsed.rows.length - contracts.length,
			skipped_binary: parsed.skippedBinary,
			pages: fetched.pages,
			truncated: fetched.truncated,
			units: UNITS,
		};
	} catch (error) {
		if (error instanceof MarketError) return error.failure;
		throw error;
	}
}

function compact(rows: ChainRow[], spot: number | null): ChainRow[] {
	if (rows.length <= MAX_ROWS || spot === null) return rows;
	const keep = new Set([...rows].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, MAX_ROWS));
	return rows.filter((row) => keep.has(row));
}

function parse(input: Record<string, unknown>): Request {
	const symbol = typeof input["symbol"] === "string" ? input["symbol"].trim().toUpperCase() : "";
	if (!SYMBOL.test(symbol)) fail("INVALID_INPUT", "symbol 要是美股或 ETF 代码，例如 SPY");
	const date = (name: string) => {
		const v = input[name];
		if (v === undefined || v === "") return undefined;
		return typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : fail("INVALID_INPUT", `${name} 要是 YYYY-MM-DD 日期`);
	};
	const number = (name: string) => {
		const v = input[name];
		if (v === undefined || v === "") return undefined;
		return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fail("INVALID_INPUT", `${name} 要是正数，单位美元`);
	};
	const expiry = date("expiry"), from = date("expiry_from"), to = date("expiry_to");
	if (expiry === undefined && (from === undefined || to === undefined)) fail("INVALID_INPUT", "要给 expiry（到期日），或同时给 expiry_from 和 expiry_to（到期日范围）");
	if (expiry !== undefined && (from !== undefined || to !== undefined)) fail("INVALID_INPUT", "expiry 和 expiry_from、expiry_to 只给一种");
	if (from !== undefined && to !== undefined && from > to) fail("INVALID_INPUT", "expiry_from 不能晚于 expiry_to");
	const right = input["right"];
	if (right !== undefined && right !== "" && right !== "put" && right !== "call") fail("INVALID_INPUT", "right 只能是 put 或 call，不填就两边都取");
	const strikeMin = number("strike_min"), strikeMax = number("strike_max");
	if (strikeMin !== undefined && strikeMax !== undefined && strikeMin > strikeMax) fail("INVALID_INPUT", "strike_min 不能大于 strike_max");
	const nowMs = input["now"] === undefined ? Date.now() : Date.parse(String(input["now"]));
	if (Number.isNaN(nowMs)) fail("INVALID_INPUT", "now 要是 ISO 8601 时间，只在回放时填");
	const today = nyParts(nowMs).date;
	if ((expiry ?? to!) < today) fail("INVALID_INPUT", `到期日已经过了（美东今天是 ${today}）；已到期合约没有快照`);
	return { symbol, expiry, from, to, right: right === "put" || right === "call" ? right : undefined, strikeMin, strikeMax, nowMs };
}
