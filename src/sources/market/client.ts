import type { Clock } from "../../kernel/types.ts";
import type { Quote } from "./detect.ts";

export const BASE_URLS = ["https://api.massive.com", "https://api.polygon.io"] as const;

export type Http = (url: string, init: { headers: Record<string, string>; redirect: "error"; signal: AbortSignal }) => Promise<Response>;
export type Priority = "poll" | "lookup";
export type Span = "minute" | "hour" | "day";

export interface Bar {
	t: number;
	o: number;
	h: number;
	l: number;
	c: number;
	v: number;
}

type ErrorKind = "no-key" | "unauthorized" | "forbidden" | "rate-limited" | "network" | "bad-response" | "busy";

/** Messages are fixed Chinese text: never the URL, a header or the response body. */
export class MarketError extends Error {
	readonly kind: ErrorKind;

	constructor(kind: ErrorKind, message: string) {
		super(message);
		this.kind = kind;
	}

	get permanent(): boolean {
		return this.kind === "no-key" || this.kind === "unauthorized" || this.kind === "forbidden";
	}
}

export interface MarketClientOptions {
	key: string | undefined;
	baseURL: string;
	minGapMs: number;
	http?: Http;
	clock?: Clock;
	sleep?: (ms: number) => Promise<void>;
	maxQueuedLookups?: number;
}

interface Job {
	path: string;
	priority: Priority;
	resolve(data: Record<string, any>): void;
	reject(error: unknown): void;
}

const object = (v: unknown): Record<string, any> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

// Massive mixes nanosecond (lastTrade.t, updated) and millisecond (min.t) timestamps.
function epochMs(v: unknown): number | undefined {
	const n = positive(v);
	if (n === undefined) return undefined;
	return Math.floor(n > 1e17 ? n / 1e6 : n > 1e14 ? n / 1e3 : n < 1e11 ? n * 1000 : n);
}

function parseQuote(raw: unknown, delayed: boolean): Quote[] {
	const r = object(raw);
	const trade = object(r.lastTrade), minute = object(r.min), day = object(r.day), prev = object(r.prevDay);
	const price = positive(trade.p) ?? positive(minute.c) ?? positive(day.c);
	const prevClose = positive(prev.c);
	const at = (positive(trade.p) && epochMs(trade.t)) || (positive(minute.c) && epochMs(minute.t)) || epochMs(r.updated);
	if (typeof r.ticker !== "string" || !price || !prevClose || !at) return [];
	return [{
		symbol: r.ticker, price, prevClose, changePct: (price / prevClose - 1) * 100, at, delayed,
		dayVolume: count(day.v), minuteVolume: count(minute.v), prevVolume: count(prev.v),
	}];
}

export class MarketClient {
	readonly #key: string | undefined;
	readonly #o: Required<Omit<MarketClientOptions, "key">>;
	readonly #queue: Job[] = [];
	readonly #abort = new AbortController();
	#pumping = false;
	#nextAt = 0;
	#cooldownUntil = 0;

	constructor({ key, ...options }: MarketClientOptions) {
		this.#key = key;
		this.#o = {
			http: (url, init) => fetch(url, init),
			clock: { now: () => Date.now() },
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
			maxQueuedLookups: 3,
			...options,
		};
	}

	async snapshot(symbols: string[], priority: Priority): Promise<Quote[]> {
		const data = await this.#request(`/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${symbols.map(encodeURIComponent).join(",")}`, priority);
		if (!Array.isArray(data.tickers)) throw new MarketError("bad-response", "行情快照缺少 tickers");
		return data.tickers.flatMap((row: unknown) => parseQuote(row, data.status === "DELAYED"));
	}

	async bars(symbol: string, span: Span, from: string, to: string): Promise<Bar[]> {
		const data = await this.#request(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/${span}/${from}/${to}?adjusted=true&sort=asc&limit=500`, "lookup");
		return (Array.isArray(data.results) ? data.results : []).map((b: any) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
	}

	dispose(): void {
		this.#abort.abort();
	}

	#request(path: string, priority: Priority): Promise<Record<string, any>> {
		if (!this.#key) return Promise.reject(new MarketError("no-key", "未配置行情密钥"));
		if (priority === "lookup" && this.#queue.filter((j) => j.priority === "lookup").length >= this.#o.maxQueuedLookups) {
			return Promise.reject(new MarketError("busy", "行情查询排队已满，请稍后再查"));
		}
		return new Promise((resolve, reject) => {
			this.#queue.push({ path, priority, resolve, reject });
			void this.#pump();
		});
	}

	async #pump(): Promise<void> {
		if (this.#pumping) return;
		this.#pumping = true;
		try {
			while (this.#queue.length) {
				const wait = Math.max(this.#nextAt, this.#cooldownUntil) - this.#o.clock.now();
				if (wait > 0) await this.#o.sleep(wait);
				const poll = this.#queue.findIndex((j) => j.priority === "poll");
				const [job] = this.#queue.splice(poll >= 0 ? poll : 0, 1);
				this.#nextAt = this.#o.clock.now() + this.#o.minGapMs;
				await this.#fetch(job.path).then(job.resolve, job.reject);
			}
		} finally {
			this.#pumping = false;
		}
	}

	async #fetch(path: string): Promise<Record<string, any>> {
		let response: Response;
		try {
			response = await this.#o.http(this.#o.baseURL + path, {
				headers: { Authorization: `Bearer ${this.#key}`, Accept: "application/json" },
				redirect: "error",
				signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(20_000)]),
			});
		} catch {
			throw new MarketError("network", "行情请求超时或网络不可用");
		}
		if (response.status === 429) {
			const header = response.headers.get("Retry-After");
			const seconds = header && /^\d+$/.test(header) ? Number(header) : 60;
			this.#cooldownUntil = this.#o.clock.now() + Math.min(Math.max(seconds, 12), 3600) * 1000;
			throw new MarketError("rate-limited", `行情请求达到频率限制，${seconds} 秒后重试`);
		}
		if (response.status === 401) throw new MarketError("unauthorized", "行情密钥无效或已失效（401）");
		if (response.status === 403) throw new MarketError("forbidden", "行情套餐没有这项数据的权限（403）");
		if (!response.ok) throw new MarketError("bad-response", `行情服务返回 HTTP ${response.status}`);
		let data: Record<string, any>;
		try {
			data = object(await response.json());
		} catch {
			throw new MarketError("bad-response", "行情服务返回的不是 JSON");
		}
		if (data.status !== "OK" && data.status !== "DELAYED") throw new MarketError("bad-response", "行情接口没有返回成功状态");
		return data;
	}
}
