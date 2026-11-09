import type { Clock } from "../../kernel/types.ts";
import type { Http, Trace } from "./client.ts";
import { shiftDate } from "./session.ts";

export const FINNHUB_URL = "https://finnhub.io/api/v1";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HOURS = ["bmo", "amc", "dmh"] as const;
const CALENDAR_BACK_DAYS = 400;
const CALENDAR_AHEAD_DAYS = 120;

interface ErrorParams {
	status?: number;
	seconds?: number;
}

const MESSAGES = {
	unauthorized: () => "Finnhub 密钥无效或已失效（401）",
	forbidden: () => "Finnhub 套餐没有这项数据的权限（403）",
	"rate-limited": (p: ErrorParams) => `Finnhub 请求达到频率限制，${Math.trunc(p.seconds ?? 60)} 秒后重试`,
	network: () => "Finnhub 请求超时或网络不可用",
	"http-error": (p: ErrorParams) => `Finnhub 返回 HTTP ${Math.trunc(p.status ?? 0)}`,
	"bad-response": () => "Finnhub 返回的数据不是预期的格式",
	busy: () => "Finnhub 查询排队已满，请稍后再查",
};

export class FinnhubError extends Error {
	readonly kind: keyof typeof MESSAGES;

	constructor(kind: keyof typeof MESSAGES, params: ErrorParams = {}) {
		super(MESSAGES[kind](params));
		this.kind = kind;
	}
}

export type EarningsHour = (typeof HOURS)[number] | "unknown";

export interface NextEarnings {
	date: string;
	hour: EarningsHour;
	year?: number;
	quarter?: number;
	epsEstimate?: number;
	revenueEstimate?: number;
}

export interface EarningsQuarter {
	year: number;
	quarter: number;
	period?: string;
	reportDate?: string;
	epsActual?: number;
	epsEstimate?: number;
	epsSurprisePct?: number;
	revenueActual?: number;
	revenueEstimate?: number;
	revenueSurprisePct?: number;
}

export interface EarningsReport {
	symbol: string;
	next: NextEarnings | null;
	quarters: EarningsQuarter[];
}

const object = (v: unknown): Record<string, any> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const date = (v: unknown): string | undefined => (typeof v === "string" && DATE.test(v) ? v : undefined);
const year = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 1990 && (v as number) <= 2100 ? (v as number) : undefined);
const quarter = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 4 ? (v as number) : undefined);
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function surprisePct(actual: number | undefined, estimate: number | undefined): number | undefined {
	if (actual === undefined || estimate === undefined || estimate === 0) return undefined;
	return Number((((actual - estimate) / Math.abs(estimate)) * 100).toFixed(2));
}

interface CalendarRow {
	date: string;
	hour: EarningsHour;
	year?: number;
	quarter?: number;
	epsActual?: number;
	epsEstimate?: number;
	revenueActual?: number;
	revenueEstimate?: number;
}

function parseCalendar(data: Record<string, any>, symbol: string): CalendarRow[] {
	if (!Array.isArray(data.earningsCalendar)) throw new FinnhubError("bad-response");
	return data.earningsCalendar.flatMap((raw: unknown) => {
		const r = object(raw);
		const day = date(r.date);
		if (r.symbol !== symbol || !day) return [];
		return [{
			date: day, hour: HOURS.includes(r.hour) ? r.hour : "unknown", year: year(r.year), quarter: quarter(r.quarter),
			epsActual: finite(r.epsActual), epsEstimate: finite(r.epsEstimate), revenueActual: finite(r.revenueActual), revenueEstimate: finite(r.revenueEstimate),
		}];
	});
}

function parseHistory(data: unknown, symbol: string): EarningsQuarter[] {
	if (!Array.isArray(data)) throw new FinnhubError("bad-response");
	return data.flatMap((raw: unknown) => {
		const r = object(raw);
		const y = year(r.year), q = quarter(r.quarter);
		if (r.symbol !== symbol || !y || !q) return [];
		return [{ year: y, quarter: q, period: date(r.period), epsActual: finite(r.actual), epsEstimate: finite(r.estimate) }];
	});
}

export function earningsReport(symbol: string, today: string, calendar: CalendarRow[], history: EarningsQuarter[]): EarningsReport {
	const upcoming = calendar.filter((r) => r.date >= today && r.epsActual === undefined).sort((a, b) => a.date.localeCompare(b.date))[0];
	const byQuarter = new Map<string, EarningsQuarter>();
	for (const h of history) byQuarter.set(`${h.year}Q${h.quarter}`, { ...h });
	for (const r of calendar) {
		if (r.date > today || r.epsActual === undefined || !r.year || !r.quarter) continue;
		const key = `${r.year}Q${r.quarter}`;
		const q = byQuarter.get(key) ?? { year: r.year, quarter: r.quarter, epsActual: r.epsActual, epsEstimate: r.epsEstimate };
		byQuarter.set(key, { ...q, reportDate: r.date, revenueActual: r.revenueActual, revenueEstimate: r.revenueEstimate });
	}
	const quarters = [...byQuarter.values()]
		.sort((a, b) => b.year - a.year || b.quarter - a.quarter)
		.slice(0, 4)
		.map((q) => defined({
			year: q.year, quarter: q.quarter, period: q.period, reportDate: q.reportDate,
			epsActual: q.epsActual, epsEstimate: q.epsEstimate, epsSurprisePct: surprisePct(q.epsActual, q.epsEstimate),
			revenueActual: q.revenueActual, revenueEstimate: q.revenueEstimate, revenueSurprisePct: surprisePct(q.revenueActual, q.revenueEstimate),
		}));
	const next = upcoming ? defined({ date: upcoming.date, hour: upcoming.hour, year: upcoming.year, quarter: upcoming.quarter, epsEstimate: upcoming.epsEstimate, revenueEstimate: upcoming.revenueEstimate }) : null;
	return { symbol, next, quarters };
}

export interface FinnhubClientOptions {
	key: string;
	minGapMs: number;
	baseURL?: string;
	http?: Http;
	clock?: Clock;
	sleep?: (ms: number) => Promise<void>;
	maxQueued?: number;
}

export class FinnhubClient {
	readonly #key: string;
	readonly #o: Required<Omit<FinnhubClientOptions, "key">>;
	readonly #abort = new AbortController();
	#tail: Promise<unknown> = Promise.resolve();
	#queued = 0;
	#nextAt = 0;
	#cooldownUntil = 0;

	constructor({ key, ...options }: FinnhubClientOptions) {
		this.#key = key;
		this.#o = {
			baseURL: FINNHUB_URL,
			http: (url, init) => fetch(url, init),
			clock: { now: () => Date.now() },
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
			maxQueued: 6,
			...options,
		};
	}

	async earnings(symbol: string, today: string, trace?: Trace): Promise<EarningsReport> {
		const s = encodeURIComponent(symbol);
		const [calendar, history] = await Promise.all([
			this.#get(`/calendar/earnings?from=${shiftDate(today, -CALENDAR_BACK_DAYS)}&to=${shiftDate(today, CALENDAR_AHEAD_DAYS)}&symbol=${s}`, trace),
			this.#get(`/stock/earnings?symbol=${s}`, trace),
		]);
		return earningsReport(symbol, today, parseCalendar(object(calendar), symbol), parseHistory(history, symbol));
	}

	dispose(): void {
		this.#abort.abort();
	}

	#get(path: string, trace?: Trace): Promise<unknown> {
		if (this.#queued >= this.#o.maxQueued) return Promise.reject(new FinnhubError("busy"));
		this.#queued++;
		const enqueuedAt = this.#o.clock.now();
		const run = this.#tail.then(async () => {
			const wait = Math.max(this.#nextAt, this.#cooldownUntil) - this.#o.clock.now();
			if (wait > 0) await this.#o.sleep(wait);
			if (trace) trace.queuedMs += this.#o.clock.now() - enqueuedAt;
			this.#nextAt = this.#o.clock.now() + this.#o.minGapMs;
			return this.#fetch(path);
		});
		this.#tail = run.catch(() => {});
		return run.finally(() => this.#queued--);
	}

	async #fetch(path: string): Promise<unknown> {
		let response: Response;
		try {
			response = await this.#o.http(this.#o.baseURL + path, {
				headers: { "X-Finnhub-Token": this.#key, Accept: "application/json" },
				redirect: "error",
				signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(20_000)]),
			});
		} catch {
			throw new FinnhubError("network");
		}
		if (response.status === 429) {
			const header = response.headers.get("Retry-After");
			const seconds = Math.min(Math.max(header && /^\d+$/.test(header) ? Number(header) : 60, 1), 3600);
			this.#cooldownUntil = this.#o.clock.now() + seconds * 1000;
			throw new FinnhubError("rate-limited", { seconds });
		}
		if (response.status === 401) throw new FinnhubError("unauthorized");
		if (response.status === 403) throw new FinnhubError("forbidden");
		if (!response.ok) throw new FinnhubError("http-error", { status: response.status });
		try {
			return await response.json();
		} catch {
			throw new FinnhubError("bad-response");
		}
	}
}
