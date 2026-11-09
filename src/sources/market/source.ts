import { WATCHDOG_SOURCE } from "../../watchdog/watchdog.ts";
import type { Feed, FeedContext, FeedInput, FeedSpec } from "../feeds.ts";
import { threadId } from "../generic.ts";
import { MarketClient, MarketError, type Span } from "./client.ts";
import { indicatorReport } from "./indicators.ts";
import { FinnhubClient } from "./finnhub.ts";
import { ConfigError } from "../../config-error.ts";
import { readFinnhubKey, readMarketKey, type LoadedKey } from "./key.ts";
import { detect, toTrigger, type MarketCursor, type Move, type Quote } from "./detect.ts";
import { inPollWindow, MINUTE, nextPollDelay, sessionAt, shiftDate, type Session } from "./session.ts";
import { parseMarketSettings, type MarketSettings } from "./settings.ts";
import { parseSymbol } from "./symbol.ts";

// Finnhub's free tier allows 60 requests a minute.
const FINNHUB_GAP_MS = 1000;
const HOLIDAY_AFTER_OPEN_MS = 30 * MINUTE;
const HOLIDAY_AFTER_POLLS = 5;
const NOTICE_AFTER_MS = 15 * MINUTE;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SPANS: Span[] = ["minute", "hour", "day"];
// Calendar days of bars indicators fetch when the caller gives no from: day covers SMA200 and 52 weeks (252 bars).
const INDICATOR_DAYS: Record<Span, number> = { day: 400, hour: 30, minute: 4 };
// One minute session with extended hours is 960 bars; this keeps several sessions whole.
const INDICATOR_LIMIT = 5000;

const LOOKUP_HELP = `us-market（美股行情）：
- quote { symbols: string[] }：最多 10 只股票的最新报价（price、prevClose、changePct、at 毫秒时间戳、delayed：接口标为延迟或报价比现在晚 10 分钟以上；休市时段的收盘价也会是 true）
- bars { symbol, span: "minute"|"hour"|"day", from: "YYYY-MM-DD", to: "YYYY-MM-DD" }：K 线（t、o、h、l、c、v），按时间正序，超过 500 根时只给离 to 最近的 500 根
- indicators { symbol, span: "day"|"hour"|"minute", from?, to? }：程序算好的技术指标，数字直接引用，不要自己重算。to 默认纽约今天，from 默认往前 400 天（day）、30 天（hour）、4 天（minute）。返回 bars（用到的根数）、lastPrice（最后一根的收盘价）、lastBar { start, end, partial }（最后一根 K 线的开始和应结束时间，毫秒；收盘或整点后 20 分钟内仍算没走完，partial 为 true，此时会带 note：lastPrice 是盘中价，不是收盘价，含这根的指标会变，不要当成收盘数据），以及 sma20/50/200、ema12/26（以前 n 根 SMA 为种子）、macd { line, signal, histogram }（12,26,9）、rsi14 和 atr14（Wilder 平滑）、bollinger { middle, upper, lower }（20 根，2 倍总体标准差）、week52 { high, low }（仅 day，最近 252 根日线）、vwap（仅 minute）{ value, session, note? }：最近一个有常规时段成交的交易日 [9:30, 收盘) 的分钟线，典型价 (h+l+c)/3 按量加权；session 不是今天时 note 会写明（比如今天还没开盘，给的是上一交易日）；没有常规时段成交时是 { unavailable }、swings { resistance, support }（左右各 5 根都更低/更高的摆动高点/低点，取现价上方/下方最近的 3 个，每个含 price 和 t）。根数不够的指标给 { insufficient: { need, have } }
- earnings { symbol }：Finnhub 财报。next 是下次财报 { date, hour: "bmo" 盘前|"amc" 盘后|"dmh" 盘中|"unknown", year, quarter, epsEstimate, revenueEstimate }，没有排期时为 null；quarters 是最近 4 个已公布季度（新到旧）{ year, quarter, period, reportDate, epsActual, epsEstimate, epsSurprisePct, revenueActual, revenueEstimate, revenueSurprisePct }，超预期百分比 = (实际 - 预期) / |预期| × 100，由程序算好；接口没给的字段不出现（Finnhub 免费档的财报日历不给历史，所以通常没有 reportDate 和营收）
- session {}：纽约日期和交易时段（pre、regular、post、closed）`;

export function marketFeed(input: FeedInput): FeedSpec {
	const { source, title } = input;
	const settings = parseMarketSettings(input.settings, input.override, input.where);
	const loaded = readMarketKey(input.env, input.secretsFile);
	const earnings = earningsClient(input);
	input.log(`[${source}] ${title}：${loaded ? `密钥来自 ${loaded.origin}` : "未配置行情密钥，看盘停用"}；自选 ${settings.watchlist.join(" ")}`);
	input.log(`[${source}] ${typeof earnings === "string" ? `earnings 查询不可用：${earnings}` : `Finnhub 密钥来自 ${earnings.origin}`}`);
	return {
		source,
		lookupHelp: LOOKUP_HELP,
		create: (ctx) => loaded
			? new MarketSource({
				source, title, settings, ctx,
				client: new MarketClient({ key: loaded.key, baseURL: settings.baseURL, minGapMs: settings.minGapMs }),
				earnings: typeof earnings === "string" ? earnings : new FinnhubClient({ key: earnings.key, minGapMs: FINNHUB_GAP_MS }),
			})
			: disabledFeed(source, "未配置行情密钥"),
	};
}

// A bad Finnhub key only turns off earnings; the rest of the feed does not depend on it.
function earningsClient(input: FeedInput): LoadedKey | string {
	try {
		return readFinnhubKey(input.env, input.secretsFile) ?? "未配置 FINNHUB_API_KEY";
	} catch (error) {
		if (error instanceof ConfigError) return error.message;
		throw error;
	}
}

function symbolArg(op: string, a: Record<string, unknown>): string {
	const symbol = parseSymbol(a.symbol);
	if (!symbol) throw new Error(`${op} 的 symbol 必须是合法的股票代码`);
	return symbol;
}

function spanArg(op: string, a: Record<string, unknown>): Span {
	if (!SPANS.includes(a.span as Span)) throw new Error(`${op} 的 span 只能是 ${SPANS.join("、")}`);
	return a.span as Span;
}

function dateArg(op: string, a: Record<string, unknown>, field: string, required = true): string | undefined {
	if (a[field] === undefined && !required) return undefined;
	if (typeof a[field] !== "string" || !DATE.test(a[field])) throw new Error(`${op} 的 ${field} 必须是 YYYY-MM-DD`);
	return a[field];
}

function noSessionToday(cursor: MarketCursor | undefined, session: Session, now: number): boolean {
	return cursor?.nyDate === session.nyDate && !cursor.sawFreshQuote && cursor.pollsWithoutFreshQuote >= HOLIDAY_AFTER_POLLS && now >= session.openAt + HOLIDAY_AFTER_OPEN_MS;
}

function disabledFeed(source: string, reason: string): Feed {
	return {
		start() {},
		stop() {},
		problem: () => reason,
		lookup: async () => {
			throw new Error(`${source} 已停用：${reason}`);
		},
	};
}

export interface MarketSourceOptions {
	source: string;
	title: string;
	settings: MarketSettings;
	client: MarketClient;
	/** A string is the reason earnings is off. */
	earnings?: FinnhubClient | string;
	ctx: FeedContext;
}

export class MarketSource implements Feed {
	readonly #o: MarketSourceOptions;
	#disabled: string | undefined;
	#failing: { since: number; error: string; noticed: boolean } | undefined;
	#mood: string | undefined;
	#lastPoll: { at: number; quotes: Quote[] } | undefined;
	#timer: NodeJS.Timeout | undefined;
	#stopped = false;

	constructor(options: MarketSourceOptions) {
		this.#o = options;
	}

	start(): void {
		const loop = async () => {
			await this.tick().catch((error) => this.#o.ctx.log(`[${this.#o.source}] 本轮看盘出错：${String(error)}`));
			if (!this.#stopped && !this.#disabled) this.#timer = setTimeout(loop, nextPollDelay(this.#o.ctx.clock.now(), this.#o.settings.everySeconds)).unref();
		};
		void loop();
	}

	stop(): void {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.#o.client.dispose();
		if (this.#o.earnings instanceof FinnhubClient) this.#o.earnings.dispose();
	}

	problem(): string | undefined {
		return this.#disabled ?? (this.#failing && `暂时取不到行情：${this.#failing.error}`);
	}

	async tick(): Promise<void> {
		const { ctx, settings, client } = this.#o;
		if (this.#disabled) return;
		const now = ctx.clock.now();
		if (!inPollWindow(now)) {
			this.#failing = undefined;
			return this.#feel("resting", "不在交易时段，暂停请求行情");
		}
		const session = sessionAt(now);
		const raw = ctx.readCursor();
		const cursor = raw === undefined ? undefined : (JSON.parse(raw) as MarketCursor);
		if (noSessionToday(cursor, session, now)) return this.#feel("holiday", `${session.nyDate} 开盘半小时仍没有当天的报价，按休市处理，今天不再请求`);
		let quotes;
		try {
			quotes = await client.snapshot(settings.watchlist, "poll");
		} catch (error) {
			return this.#failed(error, now);
		}
		this.#failing = undefined;
		this.#lastPoll = { at: ctx.clock.now(), quotes };
		const result = detect(cursor, quotes, session, settings);
		this.#submitThenSaveCursor(result.moves, result.cursor);
		this.#feel("watching", `开盘中，每 ${settings.everySeconds} 秒看一次自选 ${settings.watchlist.length} 只`);
	}

	#submitThenSaveCursor(moves: Move[], cursor: MarketCursor): void {
		for (const move of moves) this.#o.ctx.submit(toTrigger(this.#o.source, move));
		this.#o.ctx.writeCursor(JSON.stringify(cursor));
	}

	async lookup(op: string, args: unknown): Promise<unknown> {
		if (this.#disabled) throw new Error(`${this.#o.source} 已停用：${this.#disabled}`);
		const a = (args ?? {}) as Record<string, unknown>;
		const only = (...fields: string[]) => {
			const extra = Object.keys(a).find((k) => !fields.includes(k));
			if (extra) throw new Error(`${op} 不接受参数 ${extra}，只接受 ${fields.join("、") || "空对象"}`);
		};
		switch (op) {
			case "quote": {
				only("symbols");
				const symbols = Array.isArray(a.symbols) ? a.symbols.map(parseSymbol) : [];
				if (!symbols.length || symbols.length > 10 || symbols.some((s) => !s)) throw new Error("quote 的 symbols 必须是 1 到 10 个合法的股票代码");
				const quotes = await this.#quotes(symbols as string[]);
				return quotes.map(({ minuteVolume: _m, prevVolume: _p, ...q }) => ({ ...q, changePct: Number(q.changePct.toFixed(2)) }));
			}
			case "bars": {
				only("symbol", "span", "from", "to");
				const [symbol, span] = [symbolArg(op, a), spanArg(op, a)];
				return this.#o.client.bars(symbol, span, dateArg(op, a, "from")!, dateArg(op, a, "to")!);
			}
			case "indicators": {
				only("symbol", "span", "from", "to");
				const [symbol, span] = [symbolArg(op, a), spanArg(op, a)];
				const to = dateArg(op, a, "to", false) ?? sessionAt(this.#o.ctx.clock.now()).nyDate;
				const from = dateArg(op, a, "from", false) ?? shiftDate(to, -INDICATOR_DAYS[span]);
				if (from > to) throw new Error("indicators 的 from 不能晚于 to");
				const bars = await this.#o.client.bars(symbol, span, from, to, INDICATOR_LIMIT);
				if (!bars.length) throw new Error(`${symbol} 在 ${from} 到 ${to} 没有 ${span} K 线`);
				return { symbol, span, from, to, ...indicatorReport(bars, span, this.#o.ctx.clock.now()) };
			}
			case "earnings": {
				only("symbol");
				const symbol = symbolArg(op, a);
				const earnings = this.#o.earnings ?? "未配置 FINNHUB_API_KEY";
				if (typeof earnings === "string") throw new Error(`earnings 不可用：${earnings}`);
				return earnings.earnings(symbol, sessionAt(this.#o.ctx.clock.now()).nyDate);
			}
			case "session": {
				only();
				const { nyDate, phase } = sessionAt(this.#o.ctx.clock.now());
				return { nyDate, phase };
			}
			default:
				throw new Error(`未知操作 ${op}；可用：quote、bars、indicators、earnings、session`);
		}
	}

	async #quotes(symbols: string[]): Promise<Quote[]> {
		const poll = this.#lastPoll;
		const recent = poll && this.#o.ctx.clock.now() - poll.at < this.#o.settings.everySeconds * 1000 ? poll.quotes : [];
		const cached = recent.filter((q) => symbols.includes(q.symbol));
		const missing = symbols.filter((s) => !cached.some((q) => q.symbol === s));
		const fetched = missing.length ? await this.#o.client.snapshot(missing, "lookup") : [];
		return [...cached, ...fetched].sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));
	}

	#failed(error: unknown, now: number): void {
		const { ctx, source } = this.#o;
		const message = error instanceof MarketError ? error.message : String(error);
		if (error instanceof MarketError && error.permanent) {
			this.#disabled = message;
			ctx.log(`[${source}] 停用：${message}`);
			return;
		}
		this.#failing ??= { since: now, error: message, noticed: false };
		this.#failing.error = message;
		this.#feel("failing", `取不到行情：${message}`);
		if (this.#failing.noticed || now - this.#failing.since < NOTICE_AFTER_MS) return;
		this.#failing.noticed = true;
		const minutes = Math.floor((now - this.#failing.since) / MINUTE);
		ctx.submit({
			source: WATCHDOG_SOURCE,
			externalId: `${source}-failing:${this.#failing.since}`,
			threads: [{ id: threadId(WATCHDOG_SOURCE, `problem-${source}`) }],
			sender: source,
			body: `[${this.#o.title}] 已经连续 ${minutes} 分钟取不到行情，最近的错误是「${message}」。请告诉使用者。`,
			occurredAt: now,
		});
	}

	#feel(mood: string, line: string): void {
		if (this.#mood === mood) return;
		this.#mood = mood;
		this.#o.ctx.log(`[${this.#o.source}] ${line}`);
	}
}
