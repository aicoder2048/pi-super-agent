import { WATCHDOG_SOURCE } from "../../watchdog/watchdog.ts";
import type { Feed, FeedContext, FeedInput, FeedSpec } from "../feeds.ts";
import { threadId } from "../generic.ts";
import { MarketClient, MarketError, type Span } from "./client.ts";
import { loadMarketKey } from "./key.ts";
import { detect, toTrigger, type MarketCursor } from "./detect.ts";
import { inPollWindow, MINUTE, nextPollDelay, sessionAt } from "./session.ts";
import { parseMarketSettings, parseSymbol, type MarketSettings } from "./settings.ts";

const HOLIDAY_AFTER_OPEN_MS = 30 * MINUTE;
const NOTICE_AFTER_MS = 15 * MINUTE;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SPANS: Span[] = ["minute", "hour", "day"];

const LOOKUP_HELP = `us-market（美股行情）：
- quote { symbols: string[] }：最多 10 只股票的最新报价（price、prevClose、changePct、at 毫秒时间戳、delayed）
- bars { symbol, span: "minute"|"hour"|"day", from: "YYYY-MM-DD", to: "YYYY-MM-DD" }：K 线（t、o、h、l、c、v），最多 500 根
- session {}：纽约日期和交易时段（pre、regular、post、closed）`;

export function marketFeed(input: FeedInput): FeedSpec {
	const { source, title } = input;
	const settings = parseMarketSettings(input.settings, input.override, input.where);
	const loaded = loadMarketKey(input.env, input.secretsFile);
	input.log(`[${source}] ${title}：${loaded ? `密钥来自 ${loaded.origin}` : "未配置行情密钥，看盘停用"}；自选 ${settings.watchlist.join(" ")}`);
	return {
		source,
		lookupHelp: LOOKUP_HELP,
		create: (ctx) => new MarketSource({ source, title, settings, ctx, client: new MarketClient({ key: loaded?.key, baseURL: settings.baseURL, minGapMs: settings.minGapMs }) }),
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
	#timer: NodeJS.Timeout | undefined;
	#stopped = false;

	constructor(options: MarketSourceOptions) {
		this.#o = options;
		if (!options.client.hasKey) this.#disabled = "未配置行情密钥";
	}

	start(): void {
		const loop = async () => {
			await this.tick().catch((error) => this.#o.ctx.log(`[${this.#o.source}] 本轮看盘出错：${String(error)}`));
			if (!this.#stopped) this.#timer = setTimeout(loop, nextPollDelay(this.#o.ctx.clock.now(), this.#o.settings.everySeconds)).unref();
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
		const { ctx, settings, client, source } = this.#o;
		if (this.#disabled) return;
		const now = ctx.clock.now();
		const session = sessionAt(now);
		const raw = ctx.readCursor();
		const cursor = raw === undefined ? undefined : (JSON.parse(raw) as MarketCursor);
		if (!inPollWindow(now)) return this.#feel("resting", "不在交易时段，暂停请求行情");
		if (cursor?.nyDate === session.nyDate && cursor.holiday) return this.#feel("holiday", `${session.nyDate} 开盘半小时仍没有当天的报价，按休市处理，今天不再请求`);
		let quotes;
		try {
			quotes = await client.snapshot(settings.watchlist, "poll");
		} catch (error) {
			return this.#failed(error, now);
		}
		this.#failing = undefined;
		const result = detect(cursor, quotes, session, settings);
		if (Object.keys(result.cursor.fired).length === 0 && now >= session.openAt + HOLIDAY_AFTER_OPEN_MS) result.cursor.holiday = true;
		for (const move of result.moves) ctx.submit(toTrigger(source, move));
		ctx.writeCursor(JSON.stringify(result.cursor));
		this.#feel("watching", `开盘中，每 ${settings.everySeconds} 秒看一次自选 ${settings.watchlist.length} 只`);
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
				const quotes = await this.#o.client.snapshot(symbols as string[], "lookup");
				return quotes.map(({ minuteVolume: _m, prevVolume: _p, ...q }) => ({ ...q, changePct: Number(q.changePct.toFixed(2)) }));
			}
			case "bars": {
				only("symbol", "span", "from", "to");
				const symbol = parseSymbol(a.symbol);
				if (!symbol) throw new Error("bars 的 symbol 必须是合法的股票代码");
				if (!SPANS.includes(a.span as Span)) throw new Error(`bars 的 span 只能是 ${SPANS.join("、")}`);
				for (const field of ["from", "to"]) if (typeof a[field] !== "string" || !DATE.test(a[field] as string)) throw new Error(`bars 的 ${field} 必须是 YYYY-MM-DD`);
				return this.#o.client.bars(symbol, a.span as Span, a.from as string, a.to as string);
			}
			case "session": {
				only();
				const { nyDate, phase } = sessionAt(this.#o.ctx.clock.now());
				return { nyDate, phase };
			}
			default:
				throw new Error(`未知操作 ${op}；可用：quote、bars、session`);
		}
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
