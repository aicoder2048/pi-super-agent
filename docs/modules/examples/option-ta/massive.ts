/** Massive (Polygon) requests for the chain and vol tools; the request style follows stock-ta's massive.ts, which module code cannot import. */

export const MASSIVE_BASE = "https://api.massive.com";
/** The host stops a tool at 20 s; every request of one call shares this deadline so the user hears why. */
export const REQUEST_LIMIT_MS = 15_000;
/** A full SPY weekly chain is about 3 pages of 250; past this the result says it is truncated. */
export const MAX_PAGES = 5;
export const PAGE_SIZE = 250;

export const MISSING_KEY = "没有设置 POLYGON_API_KEY，没去查行情。补 key：just module secret option-ta POLYGON_API_KEY";

export type Failure = { status: "NO_KEY" | "RATE_LIMITED" | "UPSTREAM_ERROR" | "INVALID_INPUT" | "NO_DATA"; reason: string };

/** Thrown inside the tools and turned into a `Failure` reply at the tool boundary. */
export class MarketError extends Error {
	readonly failure: Failure;
	constructor(failure: Failure) {
		super(failure.reason);
		this.failure = failure;
	}
}

export const fail = (status: Failure["status"], reason: string): never => {
	throw new MarketError({ status, reason });
};

export const object = (v: unknown): Record<string, any> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});

const oneLine = (text: unknown) => String(text ?? "没说原因").replace(/\s+/g, " ").slice(0, 200);

export async function getJson(url: string, key: string, signal: AbortSignal): Promise<Record<string, any>> {
	let reply: Response;
	try {
		reply = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${key}` }, redirect: "error", signal });
	} catch (error) {
		const name = (error as Error).name;
		return fail("UPSTREAM_ERROR", name === "TimeoutError" ? `行情服务 ${REQUEST_LIMIT_MS / 1000} 秒没有应答，稍后再查` : "连不上行情服务，稍后再查");
	}
	if (reply.status === 429) {
		const wait = reply.headers.get("retry-after");
		return fail("RATE_LIMITED", `行情服务回 HTTP 429，请求太多，${wait ? `${wait} 秒后` : "稍后"}再查`);
	}
	if (!reply.ok) return fail("UPSTREAM_ERROR", `行情服务返回 HTTP ${reply.status}，稍后再查`);
	const body = object(await reply.json().catch(() => fail("UPSTREAM_ERROR", "行情服务的应答不是 JSON，稍后再查")));
	if (body.status === "ERROR") return fail("UPSTREAM_ERROR", `行情服务回了错误：${oneLine(body.error ?? body.message)}`);
	return body;
}

export type Pages = { rows: unknown[]; pages: number; truncated: boolean };

/** Follows `next_url` (whose cursor carries the query but not the key) up to MAX_PAGES. */
export async function snapshotPages(query: string, key: string, signal: AbortSignal): Promise<Pages> {
	const rows: unknown[] = [];
	let url: string | undefined = `${MASSIVE_BASE}/v3/snapshot/options/${query}`;
	let pages = 0;
	while (url !== undefined && pages < MAX_PAGES) {
		const body: Record<string, any> = await getJson(url, key, signal);
		pages += 1;
		if (Array.isArray(body.results)) rows.push(...body.results);
		url = typeof body.next_url === "string" && body.next_url !== "" ? body.next_url : undefined;
	}
	return { rows, pages, truncated: url !== undefined };
}

/** The underlying's previous regular-session close, used only to centre the strike filters. */
export async function prevClose(symbol: string, key: string, signal: AbortSignal): Promise<number> {
	const body = await getJson(`${MASSIVE_BASE}/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`, key, signal);
	const close = object(Array.isArray(body.results) ? body.results[0] : undefined).c;
	return typeof close === "number" && close > 0 ? close : fail("NO_DATA", `行情服务没有 ${symbol} 上一交易日的收盘价，可能不是美股代码`);
}

/** Query string in a fixed order, so a replay fixture can match the address exactly. */
export function query(symbol: string, params: readonly (readonly [string, string | number | undefined])[]): string {
	const pairs = [...params, ["limit", PAGE_SIZE] as const].filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
	return `${encodeURIComponent(symbol)}?${pairs.join("&")}`;
}

export const SYMBOL = /^[A-Z][A-Z.]{0,5}$/;
