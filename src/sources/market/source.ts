import { WATCHDOG_SOURCE } from "../../watchdog/watchdog.ts";
import type { Feed, FeedContext, FeedInput, FeedSpec, TripwireReply } from "../feeds.ts";
import { threadId } from "../generic.ts";
import { LookupCache, type Cached, type Via } from "./cache.ts";
import { MarketClient, MarketError, type Bar, type Span, type Trace } from "./client.ts";
import { indicatorReport } from "./indicators.ts";
import { FinnhubClient } from "./finnhub.ts";
import { ConfigError } from "../../config-error.ts";
import type { LoadedSecret } from "../../secrets.ts";
import { readFinnhubKey, readMarketKey } from "./key.ts";
import { detect, isFresh, toTrigger, type MarketCursor, type Move, type Quote } from "./detect.ts";
import { inPollWindow, MINUTE, nextPollDelay, nextWeekday, nyDateOf, sessionAt, shiftDate, type Session } from "./session.ts";
import { parseMarketSettings, type MarketSettings } from "./settings.ts";
import { parseSymbol } from "./symbol.ts";
import { alertText, applyEdit, checkIntraday, driftOf, echoText, firingId, parseBook, parseEdit, polledSymbols, receiptText, redact, serializeBook, settleCross, suspectedId, type Book, type Tripwire } from "./tripwires.ts";

// How long a lookup result may be reused. Quotes the poll already holds are reused for one poll interval instead.
const TTL_MS = { quote: 30_000, earnings: 6 * 60 * MINUTE, bars: { day: 10 * MINUTE, hour: 2 * MINUTE, minute: MINUTE } as Record<Span, number> };
const CACHE_ENTRIES = 200;
const VIA_TEXT: Record<Via | "computed", (ageMs: number) => string> = {
	fetch: () => "上游",
	shared: () => "合用进行中的请求",
	cache: (ageMs) => `缓存（${ageMs}ms 前）`,
	computed: () => "现算",
};

interface LookupTrace extends Trace {
	desc: string;
	via: Via | "computed";
	ageMs: number;
}

// Finnhub's free tier allows 60 requests a minute.
const FINNHUB_GAP_MS = 1000;
const HOLIDAY_AFTER_OPEN_MS = 30 * MINUTE;
const HOLIDAY_AFTER_POLLS = 5;
const NOTICE_AFTER_MS = 15 * MINUTE;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SETTLE_AFTER_MS = 45 * MINUTE;
const SPANS: Span[] = ["minute", "hour", "day"];
// Calendar days of bars indicators fetch when the caller gives no from: day covers SMA200 and 52 weeks (252 bars).
const INDICATOR_DAYS: Record<Span, number> = { day: 400, hour: 30, minute: 4 };
// One minute session with extended hours is 960 bars; this keeps several sessions whole.
const INDICATOR_LIMIT = 5000;

const LOOKUP_HELP = `us-market（美股行情）：每个结果都带 fromCache（是否取自缓存）和 cachedAgeMs（数据取到现在多少毫秒），说数字时请一并说明新鲜度。相同查询会合用缓存：quote 30 秒（看盘轮询刚取过的自选股复用一个轮询周期），bars 和 indicators 日线 10 分钟、小时线 2 分钟、分钟线 60 秒，earnings 6 小时。
- quote { symbols: string[] }：{ quotes }，最多 10 只股票的最新报价（price、prevClose、changePct、at 毫秒时间戳、delayed：接口标为延迟或报价比现在晚 10 分钟以上；休市时段的收盘价也会是 true）
- bars { symbol, span: "minute"|"hour"|"day", from: "YYYY-MM-DD", to: "YYYY-MM-DD" }：{ bars }，K 线（t、o、h、l、c、v），按时间正序，超过 500 根时只给离 to 最近的 500 根
- indicators { symbol, span: "day"|"hour"|"minute", from?, to? }：程序算好的技术指标，数字直接引用，不要自己重算。to 默认纽约今天，from 默认往前 400 天（day）、30 天（hour）、4 天（minute）。返回 bars（用到的根数）、lastPrice（最后一根的收盘价）、lastBar { start, end, partial }（最后一根 K 线的开始和应结束时间，毫秒；这一根应结束的时间（日线为当天收盘）之后 20 分钟内仍算没走完，partial 为 true，此时会带 note：lastPrice 是盘中价，不是收盘价，含这根的指标会变，不要当成收盘数据），以及 sma20/50/200、ema12/26（以前 n 根 SMA 为种子）、macd { line, signal, histogram }（12,26,9）、rsi14 和 atr14（Wilder 平滑）、bollinger { middle, upper, lower }（20 根，2 倍总体标准差）、week52 { high, low }（仅 day，最近 252 根日线）、vwap（仅 minute）{ value, session, note? }：最近一个有常规时段成交的交易日 [9:30, 收盘) 的分钟线，典型价 (h+l+c)/3 按量加权；session 不是今天时 note 会写明（比如今天还没开盘，给的是上一交易日）；没有常规时段成交时是 { unavailable }、swings { resistance, support }（左右各 5 根都更低/更高的摆动高点/低点，取现价上方/下方最近的 3 个，每个含 price 和 t）。根数不够的指标给 { insufficient: { need, have } }
- earnings { symbol }：Finnhub 财报。next 是下次财报 { date, hour: "bmo" 盘前|"amc" 盘后|"dmh" 盘中|"unknown", year, quarter, epsEstimate, revenueEstimate }，没有排期时为 null；quarters 是最近 4 个已公布季度（新到旧）{ year, quarter, period, reportDate, epsActual, epsEstimate, epsSurprisePct, revenueActual, revenueEstimate, revenueSurprisePct }，超预期百分比 = (实际 - 预期) / |预期| × 100，由程序算好；接口没给的字段不出现（Finnhub 免费档的财报日历不给历史，所以通常没有 reportDate 和营收）
- session {}：纽约日期和交易时段（pre、regular、post、closed）`;

const TRIPWIRE_HELP = `us-market（美股盯盘条件）：同一只股票每种条件最多一条。成本价和股数不会回给你。宿主在网页对话里贴一行「盯盘条件（只在本机）」，逐字写出存下的条件；网页左栏「关注的来源」也列出全部条件。
- list {}：列出全部条件
- set { symbol, condition }：新增或修改这只股票这一种条件。改已有的条件时只写要改的字段，没写的保持原样。condition 是下面三种之一，dir 是 up、down 或 either（不写就是 either），pct 在 0.1 到 100 之间：
  - { kind: "day", pct, dir? }：相对昨收涨跌超过 pct% 时提醒
  - { kind: "cost", pct, basis, shares?, dir? }：相对成本价 basis 涨跌超过 pct% 时提醒，新加时必须有 basis；shares 是股数，可以不写，写 null 是去掉
  - { kind: "cross", fast?, slow? }：fast 日均线和 slow 日均线金叉、死叉时提醒，不写就是 5 和 20。盘中现价让两条均线翻转时先报一条「疑似」，收盘后大约 60 到 75 分钟按当天收盘价再报「确认」或「没有成立」（撤回疑似）
- remove { symbol, kind? }：去掉这只股票的某一种条件，不写 kind 就全部去掉
自选股加上条件里的股票最多 50 只，均线交叉条件最多 10 只。`;

export function marketFeed(input: FeedInput): FeedSpec {
	const { source, title } = input;
	const settings = parseMarketSettings(input.settings, input.override, input.where);
	const loaded = readMarketKey(input.env, input.secretsFile);
	const status = loaded ? `密钥来自 ${loaded.origin}` : "未配置行情密钥，看盘停用";
	const earnings = earningsClient(input);
	input.log(`[${source}] ${title}：${status}；自选 ${settings.watchlist.join(" ")}`);
	input.log(`[${source}] ${typeof earnings === "string" ? `earnings 查询不可用：${earnings}` : `Finnhub 密钥来自 ${earnings.origin}`}`);
	return {
		source,
		status,
		lookupHelp: LOOKUP_HELP,
		tripwireHelp: TRIPWIRE_HELP,
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
function earningsClient(input: FeedInput): LoadedSecret | string {
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

type CrossTripwire = Tripwire & { condition: { kind: "cross" } };
const crossTripwires = (book: Book) => [...book.values()].filter((t): t is CrossTripwire => t.condition.kind === "cross");

/** pending: the close first seen for today's bar, by symbol. settled: symbols whose cross is settled today. */
interface TripCursor {
	pending: Record<string, number>;
	settled: string[];
}
type SourceCursor = MarketCursor & { trip?: TripCursor };

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
		tripwires: () => {
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
	readonly #cache: LookupCache;
	#disabled: string | undefined;
	#failing: { since: number; error: string; noticed: boolean } | undefined;
	#mood: string | undefined;
	#lastPoll: { at: number; quotes: Quote[] } | undefined;
	#timer: NodeJS.Timeout | undefined;
	#stopped = false;
	#book: { book: Book } | { problem: string };
	// Settled closes before fetchedOn. Memory only: after a restart the poll warms one symbol a tick again.
	readonly #history = new Map<string, { fetchedOn: string; slow: number; settledCloses: number[] }>();

	constructor(options: MarketSourceOptions) {
		this.#o = options;
		this.#cache = new LookupCache(options.ctx.clock, CACHE_ENTRIES);
		this.#book = parseBook(options.ctx.readUserData());
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
		const feed = this.#disabled ?? (this.#failing && `暂时取不到行情：${this.#failing.error}`);
		const book = "problem" in this.#book ? `${this.#book.problem}，没有覆盖它，盯盘条件暂时改不了` : undefined;
		return [feed, book].filter(Boolean).join("；") || undefined;
	}

	tripwires(op: string, args: unknown): TripwireReply {
		if ("problem" in this.#book) throw new Error(`${this.#book.problem}。状态库里的清单没有被覆盖，修好之前改不了盯盘条件`);
		const { ctx, settings } = this.#o;
		const { book } = this.#book;
		const edit = parseEdit(op, args);
		if (edit.op === "list") {
			ctx.post({ kind: "receipt", text: receiptText([], [], book) });
			return { echo: echoText({ ok: true, book, changed: false, before: [], after: [] }), tripwires: redact(book) };
		}
		const applied = applyEdit(book, edit, settings.watchlist, ctx.clock.now());
		if (!applied.ok) throw new Error(echoText(applied));
		if (applied.changed) {
			ctx.writeUserData(serializeBook(applied.book));
			this.#book = { book: applied.book };
		}
		ctx.post({ kind: "receipt", text: receiptText(applied.before, applied.after, applied.book, this.#currentDrift(applied.after[0])) });
		return { echo: echoText(applied), tripwires: redact(applied.book) };
	}

	#currentDrift(t: Tripwire | undefined): number | undefined {
		if (t?.condition.kind !== "cost" || !this.#lastPoll) return undefined;
		const session = sessionAt(this.#o.ctx.clock.now());
		const quote = this.#lastPoll.quotes.find((q) => q.symbol === t.symbol && isFresh(q, session));
		return quote && driftOf(quote.price, t.condition.basis);
	}

	async tick(): Promise<void> {
		const { ctx, settings, client } = this.#o;
		if (this.#disabled) return;
		const now = ctx.clock.now();
		if (!inPollWindow(now)) {
			this.#failing = undefined;
			this.#feel("resting", "不在交易时段，暂停请求行情");
			return this.#settle(now);
		}
		const session = sessionAt(now);
		const raw = ctx.readCursor();
		const cursor = raw === undefined ? undefined : (JSON.parse(raw) as MarketCursor);
		if (noSessionToday(cursor, session, now)) return this.#feel("holiday", `${session.nyDate} 开盘半小时仍没有当天的报价，按休市处理，今天不再请求`);
		const book: Book = "book" in this.#book ? this.#book.book : new Map();
		let quotes;
		try {
			quotes = await client.snapshot(polledSymbols(book, settings.watchlist), "poll");
		} catch (error) {
			return this.#failed(error, now);
		}
		this.#failing = undefined;
		this.#lastPoll = { at: ctx.clock.now(), quotes };
		await this.#warmHistory(book, session.nyDate);
		this.#raise(book, quotes, session);
		const result = detect(cursor, quotes.filter((q) => settings.watchlist.includes(q.symbol)), session, settings);
		this.#submitThenSaveCursor(result.moves, result.cursor);
		this.#feel("watching", `开盘中，每 ${settings.everySeconds} 秒看一次自选 ${settings.watchlist.length} 只`);
	}

	#raise(book: Book, quotes: Quote[], session: Session): void {
		const { ctx, source } = this.#o;
		for (const firing of checkIntraday(book, quotes, session, this.#history)) {
			const quote = quotes.find((q) => q.symbol === firing.symbol)!;
			try {
				ctx.post({ kind: "alert", externalId: firingId(session.nyDate, firing), text: alertText(firing, quote), occurredAt: quote.at });
			} catch (error) {
				ctx.log(`[${source}] 盯盘提醒没贴出去：${String(error)}`);
			}
		}
	}

	#dailyBars(t: CrossTripwire, nyDate: string): Promise<Bar[]> {
		const from = shiftDate(nyDate, -(Math.ceil(1.6 * t.condition.slow) + 10));
		return this.#o.client.bars(t.symbol, "day", from, nyDate, "poll");
	}

	// One request per tick at most, so warming never takes more than one slot from the 5-a-minute budget the poll shares.
	async #warmHistory(book: Book, nyDate: string): Promise<void> {
		const t = crossTripwires(book).find((t) => {
			const h = this.#history.get(t.symbol);
			return h?.fetchedOn !== nyDate || h.slow < t.condition.slow;
		});
		if (!t) return;
		try {
			const bars = await this.#dailyBars(t, nyDate);
			this.#history.set(t.symbol, { fetchedOn: nyDate, slow: t.condition.slow, settledCloses: bars.filter((b) => nyDateOf(b.t) < nyDate).map((b) => b.c) });
		} catch (error) {
			this.#o.ctx.log(`[${this.#o.source}] ${t.symbol} 的日线没取到，均线交叉下一轮再试：${String(error)}`);
		}
	}

	// lastBar().partial only reads the clock, so a day's bar counts as settled when two fetches at least one wake apart agree on its close.
	// Only the close: after-hours trades keep adding to the bar's volume, and the snapshot price after the bell is an after-hours trade.
	async #settle(now: number): Promise<void> {
		const { ctx, source } = this.#o;
		const session = sessionAt(now);
		if (session.weekend || now < session.closeAt + SETTLE_AFTER_MS || !("book" in this.#book)) return;
		const raw = ctx.readCursor();
		const cursor = raw === undefined ? undefined : (JSON.parse(raw) as SourceCursor);
		if (cursor?.nyDate !== session.nyDate || !cursor.sawFreshQuote) return;
		const trip: TripCursor = { pending: { ...cursor.trip?.pending }, settled: [...(cursor.trip?.settled ?? [])] };
		const due = crossTripwires(this.#book.book).filter((t) => !trip.settled.includes(t.symbol));
		if (!due.length) return;
		for (const t of due) {
			let bars;
			try {
				bars = await this.#dailyBars(t, session.nyDate);
			} catch (error) {
				ctx.log(`[${source}] ${t.symbol} 的当天日线没取到，均线交叉下次醒来再结算：${String(error)}`);
				continue;
			}
			const last = bars.at(-1);
			if (!last || nyDateOf(last.t) !== session.nyDate) continue;
			if (trip.pending[t.symbol] !== last.c) {
				trip.pending[t.symbol] = last.c;
				continue;
			}
			const closes = bars.map((b) => b.c);
			const firing = settleCross(t, closes, ctx.raised(suspectedId(session.nyDate, t, closes)));
			if (firing) ctx.post({ kind: "alert", externalId: firingId(session.nyDate, firing), text: alertText(firing, { at: now, delayed: false }), occurredAt: now });
			trip.settled.push(t.symbol);
			this.#history.set(t.symbol, { fetchedOn: nextWeekday(session.nyDate), slow: t.condition.slow, settledCloses: closes });
			ctx.log(`[${source}] ${t.symbol} 均线交叉已结算：今天收盘 ${last.c}，${firing ? firing.stage : "没有交叉"}`);
		}
		ctx.writeCursor(JSON.stringify({ ...cursor, trip }));
	}

	#submitThenSaveCursor(moves: Move[], cursor: MarketCursor): void {
		for (const move of moves) this.#o.ctx.submit(toTrigger(this.#o.source, move));
		this.#o.ctx.writeCursor(JSON.stringify(cursor));
	}

	async lookup(op: string, args: unknown): Promise<unknown> {
		const { clock, log } = this.#o.ctx;
		const started = clock.now();
		const trace: LookupTrace = { queuedMs: 0, desc: "", via: "computed", ageMs: 0 };
		const line = (outcome: string) =>
			log(`[${this.#o.source}] lookup ${op}${trace.desc && ` ${trace.desc}`}：${outcome}，排队 ${trace.queuedMs}ms，总计 ${clock.now() - started}ms`);
		try {
			const result = await this.#lookup(op, args, trace);
			line(VIA_TEXT[trace.via](trace.ageMs));
			return { ...(result as object), fromCache: trace.via === "cache", cachedAgeMs: trace.ageMs };
		} catch (error) {
			line(`失败（${error instanceof Error ? error.message : String(error)}）`);
			throw error;
		}
	}

	#cached<T>(trace: LookupTrace, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
		return this.#cache.get(key, ttlMs, load).then(({ value, via, ageMs }: Cached<T>) => {
			Object.assign(trace, { via, ageMs });
			return value;
		});
	}

	#bars(trace: LookupTrace, symbol: string, span: Span, from: string, to: string, limit: number): Promise<Bar[]> {
		trace.desc = `${symbol} ${span} ${from}～${to}`;
		return this.#cached(trace, `bars:${symbol}:${span}:${from}:${to}:${limit}`, TTL_MS.bars[span], () => this.#o.client.bars(symbol, span, from, to, "lookup", limit, trace));
	}

	async #lookup(op: string, args: unknown, trace: LookupTrace): Promise<unknown> {
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
				trace.desc = symbols.join(",");
				const quotes = await this.#quotes(symbols as string[], trace);
				return { quotes: quotes.map(({ minuteVolume: _m, prevVolume: _p, ...q }) => ({ ...q, changePct: Number(q.changePct.toFixed(2)) })) };
			}
			case "bars": {
				only("symbol", "span", "from", "to");
				const [symbol, span] = [symbolArg(op, a), spanArg(op, a)];
				return { bars: await this.#bars(trace, symbol, span, dateArg(op, a, "from")!, dateArg(op, a, "to")!, 500) };
			}
			case "indicators": {
				only("symbol", "span", "from", "to");
				const [symbol, span] = [symbolArg(op, a), spanArg(op, a)];
				const to = dateArg(op, a, "to", false) ?? sessionAt(this.#o.ctx.clock.now()).nyDate;
				const from = dateArg(op, a, "from", false) ?? shiftDate(to, -INDICATOR_DAYS[span]);
				if (from > to) throw new Error("indicators 的 from 不能晚于 to");
				const bars = await this.#bars(trace, symbol, span, from, to, INDICATOR_LIMIT);
				if (!bars.length) throw new Error(`${symbol} 在 ${from} 到 ${to} 没有 ${span} K 线`);
				return { symbol, span, from, to, ...indicatorReport(bars, span, this.#o.ctx.clock.now()) };
			}
			case "earnings": {
				only("symbol");
				const symbol = symbolArg(op, a);
				trace.desc = symbol;
				const earnings = this.#o.earnings ?? "未配置 FINNHUB_API_KEY";
				if (typeof earnings === "string") throw new Error(`earnings 不可用：${earnings}`);
				const today = sessionAt(this.#o.ctx.clock.now()).nyDate;
				return this.#cached(trace, `earnings:${symbol}:${today}`, TTL_MS.earnings, () => earnings.earnings(symbol, today, trace));
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

	async #quotes(symbols: string[], trace: LookupTrace): Promise<Quote[]> {
		const poll = this.#lastPoll;
		const now = this.#o.ctx.clock.now();
		const recent = poll && now - poll.at < this.#o.settings.everySeconds * 1000 ? poll.quotes : [];
		const cached = recent.filter((q) => symbols.includes(q.symbol));
		const missing = symbols.filter((s) => !cached.some((q) => q.symbol === s));
		const fetched = missing.length ? await this.#cached(trace, `quote:${[...missing].sort().join(",")}`, TTL_MS.quote, () => this.#o.client.snapshot(missing, "lookup", trace)) : [];
		if (cached.length) Object.assign(trace, { via: missing.length && trace.via !== "cache" ? trace.via : "cache", ageMs: Math.max(trace.ageMs, now - poll!.at) });
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
