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

interface ErrorParams {
	status?: number;
	seconds?: number;
}

const MESSAGES = {
	unauthorized: () => "行情密钥无效或已失效（401）",
	forbidden: () => "行情套餐没有这项数据的权限（403）",
	"rate-limited": (p: ErrorParams) => `行情请求达到频率限制，${Math.trunc(p.seconds ?? 60)} 秒后重试`,
	network: () => "行情请求超时或网络不可用",
	"http-error": (p: ErrorParams) => `行情服务返回 HTTP ${Math.trunc(p.status ?? 0)}`,
	"bad-response": () => "行情服务返回的数据不是预期的格式",
	busy: () => "行情查询排队已满，请稍后再查",
};

type ErrorKind = keyof typeof MESSAGES;

export class MarketError extends Error {
	readonly kind: ErrorKind;

	constructor(kind: ErrorKind, params: ErrorParams = {}) {
		super(MESSAGES[kind](params));
		this.kind = kind;
	}

	get permanent(): boolean {
		return this.kind === "unauthorized" || this.kind === "forbidden";
	}
}

export interface MarketClientOptions {
	key: string;
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

function parseQuote(raw: unknown, requested: string[], delayed: boolean): Quote[] {
	const r = object(raw);
	if (!requested.includes(r.ticker)) return [];
	const trade = object(r.lastTrade), minute = object(r.min), day = object(r.day), prev = object(r.prevDay);
	const price = positive(trade.p) ?? positive(minute.c) ?? positive(day.c);
	const prevClose = positive(prev.c);
	const at = (positive(trade.p) && epochMs(trade.t)) || (positive(minute.c) && epochMs(minute.t)) || epochMs(r.updated);
	if (!price || !prevClose || !at) return [];
	return [{
		symbol: r.ticker, price, prevClose, changePct: (price / prevClose - 1) * 100, at, delayed,
		dayVolume: count(day.v), minuteVolume: count(minute.v), prevVolume: count(prev.v),
	}];
}

function parseBar(raw: unknown): Bar[] {
	const b = object(raw);
	const bar = { t: positive(b.t), o: positive(b.o), h: positive(b.h), l: positive(b.l), c: positive(b.c), v: count(b.v) };
	return Object.values(bar).every((n) => n !== undefined) ? [bar as Bar] : [];
}

export class MarketClient {
	readonly #key: string;
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
		if (!Array.isArray(data.tickers)) throw new MarketError("bad-response");
		return data.tickers.flatMap((row: unknown) => parseQuote(row, symbols, data.status === "DELAYED"));
	}

	async bars(symbol: string, span: Span, from: string, to: string): Promise<Bar[]> {
		const data = await this.#request(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/${span}/${from}/${to}?adjusted=true&sort=desc&limit=500`, "lookup");
		return (Array.isArray(data.results) ? data.results : []).flatMap(parseBar).reverse();
	}

	dispose(): void {
		this.#abort.abort();
	}

	#request(path: string, priority: Priority): Promise<Record<string, any>> {
		if (priority === "lookup" && this.#queue.filter((j) => j.priority === "lookup").length >= this.#o.maxQueuedLookups) {
			return Promise.reject(new MarketError("busy"));
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
			throw new MarketError("network");
		}
		if (response.status === 429) {
			const header = response.headers.get("Retry-After");
			const seconds = Math.min(Math.max(header && /^\d+$/.test(header) ? Number(header) : 60, 12), 3600);
			this.#cooldownUntil = this.#o.clock.now() + seconds * 1000;
			throw new MarketError("rate-limited", { seconds });
		}
		if (response.status === 401) throw new MarketError("unauthorized");
		if (response.status === 403) throw new MarketError("forbidden");
		if (!response.ok) throw new MarketError("http-error", { status: response.status });
		let data: Record<string, any>;
		try {
			data = object(await response.json());
		} catch {
			throw new MarketError("bad-response");
		}
		if (data.status !== "OK" && data.status !== "DELAYED") throw new MarketError("bad-response");
		return data;
	}
}
