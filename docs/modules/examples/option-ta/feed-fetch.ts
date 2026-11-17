/** HTTP for the iv and watch feeds. Keys go in headers, never in the URL, so a fixture's URL is the real one. */

/** The feed's own deadline for one request, well under its `limit`. */
export const REQUEST_LIMIT_MS = 15_000;

export const object = (v: unknown): Record<string, any> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
export const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

const NEW_YORK = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export const newYorkDate = (ms: number): string => NEW_YORK.format(new Date(ms));

/** Massive mixes nanosecond and millisecond timestamps. */
export function epochMs(v: unknown): number | undefined {
	const n = positive(v);
	if (n === undefined) return undefined;
	return Math.floor(n > 1e17 ? n / 1e6 : n > 1e14 ? n / 1e3 : n < 1e11 ? n * 1000 : n);
}

export const massiveHeaders = (key: string) => ({ Authorization: `Bearer ${key}` });
export const finnhubHeaders = (key: string) => ({ "X-Finnhub-Token": key });

/** Any reply the feed cannot use: HTTP 429 or 5xx, a body with `status: "ERROR"`, a timeout, no connection. */
export class FetchError extends Error {}

export async function getJson(url: string, headers: Record<string, string>, service: string): Promise<Record<string, any>> {
	let reply: Response;
	try {
		reply = await fetch(url, { headers: { Accept: "application/json", ...headers }, redirect: "error", signal: AbortSignal.timeout(REQUEST_LIMIT_MS) });
	} catch (error) {
		const name = (error as Error).name;
		throw new FetchError(name === "TimeoutError" ? `${service} ${REQUEST_LIMIT_MS / 1000} 秒没有应答` : `连不上${service}`);
	}
	if (reply.status === 429) throw new FetchError(`${service}回 HTTP 429，请求太多`);
	if (!reply.ok) throw new FetchError(`${service}返回 HTTP ${reply.status}`);
	let body: Record<string, any>;
	try {
		body = object(await reply.json());
	} catch {
		throw new FetchError(`${service}的应答不是 JSON`);
	}
	if (body.status === "ERROR") throw new FetchError(`${service}回了错误：${String(body.error ?? body.message ?? "没说原因").replace(/\s+/g, " ").slice(0, 200)}`);
	return body;
}
