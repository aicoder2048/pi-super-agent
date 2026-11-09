import { WATCHDOG_SOURCE } from "../../watchdog/watchdog.ts";
import type { Feed, FeedContext, FeedInput, FeedSpec } from "../feeds.ts";
import { threadId } from "../generic.ts";
import { MarketClient, MarketError, type Span } from "./client.ts";
import { indicatorReport } from "./indicators.ts";
import { readMarketKey } from "./key.ts";
import { detect, toTrigger, type MarketCursor, type Move, type Quote } from "./detect.ts";
import { inPollWindow, MINUTE, nextPollDelay, sessionAt, type Session } from "./session.ts";
import { parseMarketSettings, type MarketSettings } from "./settings.ts";
import { parseSymbol } from "./symbol.ts";

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
- indicators { symbol, span: "day"|"hour"|"minute", from?, to? }：程序算好的技术指标，数字直接引用，不要自己重算。to 默认纽约今天，from 默认往前 400 天（day）、30 天（hour）、4 天（minute）。返回 at（最后一根 K 线的开始时间，毫秒）、close、bars（用到的根数），以及 sma20/50/200、ema12/26（以前 n 根 SMA 为种子）、macd { line, signal, histogram }（12,26,9）、rsi14 和 atr14（Wilder 平滑）、bollinger { middle, upper, lower }（20 根，2 倍总体标准差）、week52 { high, low }（仅 day，最近 252 根日线）、vwap（仅 minute，最后一根所在交易日 9:30 起的常规时段，典型价 (h+l+c)/3 按量加权）、swings { resistance, support }（左右各 5 根都更低/更高的摆动高点/低点，取现价上方/下方最近的 3 个，每个含 price 和 t）。根数不够的指标给 { insufficient: { need, have } }
- session {}：纽约日期和交易时段（pre、regular、post、closed）`;

export function marketFeed(input: FeedInput): FeedSpec {
	const { source, title } = input;
	const settings = parseMarketSettings(input.settings, input.override, input.where);
	const loaded = readMarketKey(input.env, input.secretsFile);
	input.log(`[${source}] ${title}：${loaded ? `密钥来自 ${loaded.origin}` : "未配置行情密钥，看盘停用"}；自选 ${settings.watchlist.join(" ")}`);
	return {
		source,
		lookupHelp: LOOKUP_HELP,
		create: (ctx) => loaded
			? new MarketSource({ source, title, settings, ctx, client: new MarketClient({ key: loaded.key, baseURL: settings.baseURL, minGapMs: settings.minGapMs }) })
			: disabledFeed(source, "未配置行情密钥"),
	};
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

function shiftDate(date: string, days: number): string {
	return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
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
				return { symbol, span, from, to, ...indicatorReport(bars, span) };
			}
			case "session": {
				only();
				const { nyDate, phase } = sessionAt(this.#o.ctx.clock.now());
				return { nyDate, phase };
			}
			default:
				throw new Error(`未知操作 ${op}；可用：quote、bars、indicators、session`);
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
