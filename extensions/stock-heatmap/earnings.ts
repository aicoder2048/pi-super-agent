import { MarketClient, MarketError, STOCKS, object, percent, safeError, type DailyBar } from "./core.ts";

export type EarningsHour = "bmo" | "amc" | "dmh" | "unknown";
export type EarningsMode = "eps" | "price";
export type EarningsScope = "all" | "indices" | "watchlist";
export interface EarningsEvent {
  id: string; symbol: string; date: string; hour: EarningsHour; quarter?: number; year?: number;
  epsActual?: number; epsEstimate?: number; revenueActual?: number; revenueEstimate?: number;
}
export interface EarningsRange { from: string; to: string; label: string; relative?: "today" | "tomorrow" | "week" }
export interface CalendarDay { events: EarningsEvent[]; rawCount: number; warnings: string[]; fetchedAt: number }
export interface EarningsPrice { date: string; price: number; change?: number; asOf?: number; kind: "close" | "snapshot"; referenceDate?: string }
export interface EarningsState {
  range: EarningsRange; mode: EarningsMode; scope: EarningsScope; watchlist: string[];
  events: EarningsEvent[]; prices: Map<string, EarningsPrice>; warnings: string[];
  loadingCalendar: boolean; loadingPrices: boolean; calendarError: string; priceError: string;
  calendarAt?: number; priceAt?: number; progress: string; priceProgress: string; revision: number;
}
const DAY = 86400000;
export function newYorkDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "2000-01-01" || value > "2100-12-31") return false;
  const date = new Date(value + "T12:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function shiftDate(value: string, days: number): string { return new Date(new Date(value + "T12:00:00Z").getTime() + days * DAY).toISOString().slice(0, 10); }
export function resolveEarningsRange(input: string, now = new Date()): EarningsRange {
  const value = input.trim().toLowerCase(), today = newYorkDate(now);
  if (["today", "今天", ""].includes(value)) return { from: today, to: today, label: `今天 ${today}`, relative: "today" };
  if (["tomorrow", "明天"].includes(value)) { const date = shiftDate(today, 1); return { from: date, to: date, label: `明天 ${date}`, relative: "tomorrow" }; }
  if (["week", "本周"].includes(value)) {
    const weekday = new Date(today + "T12:00:00Z").getUTCDay();
    const from = shiftDate(today, -(weekday + 6) % 7);
    return { from, to: shiftDate(from, 6), label: `本周 ${from}～${shiftDate(from, 6)}`, relative: "week" };
  }
  if (!validDate(value)) throw new MarketError("日期无效；请使用 today、tomorrow、week 或真实日期 YYYY-MM-DD。");
  return { from: value, to: value, label: value };
}
export function rangeDays(range: EarningsRange): string[] {
  const days: string[] = [];
  for (let date = range.from; date <= range.to && days.length < 7; date = shiftDate(date, 1)) days.push(date);
  return days;
}
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
export function epsSurprise(event: EarningsEvent): number | undefined {
  if (event.epsActual === undefined || event.epsEstimate === undefined || event.epsEstimate === 0) return undefined;
  const n = (event.epsActual - event.epsEstimate) / Math.abs(event.epsEstimate) * 100;
  return Number.isFinite(n) ? n : undefined;
}
export function hasActual(event: EarningsEvent, today: string): boolean {
  return event.date <= today && (event.epsActual !== undefined || event.revenueActual !== undefined);
}
export function eventStatus(event: EarningsEvent, today: string): string {
  if (event.date > today) return "UPCOMING";
  if (event.epsActual === undefined) return event.date < today ? "NO ACTUAL" : "PENDING";
  if (event.epsEstimate === undefined) return "NO EST";
  if (event.epsEstimate === 0) return "ZERO EST";
  return percent(epsSurprise(event));
}
export function visibleEarnings(state: EarningsState): EarningsEvent[] {
  const watchlist = new Set(state.watchlist);
  return state.events.filter(event => state.scope === "all" || (state.scope === "indices" ? STOCKS.has(event.symbol) : watchlist.has(event.symbol)));
}
export function parseCalendarDay(payload: unknown, date: string, fetchedAt = Date.now()): CalendarDay {
  const data = object(payload);
  if (data.error || !Array.isArray(data.earningsCalendar)) throw new MarketError("Finnhub 日历响应无效或账户权限不足（未返回 earningsCalendar）。");
  const events = new Map<string, EarningsEvent>();
  let rejected = 0;
  for (const raw of data.earningsCalendar) {
    const r = object(raw);
    if (r.date !== date || typeof r.symbol !== "string" || !/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,3})?$/.test(r.symbol)) { rejected++; continue; }
    const quarter = Number.isInteger(r.quarter) && r.quarter >= 1 && r.quarter <= 4 ? r.quarter as number : undefined;
    const year = Number.isInteger(r.year) && r.year >= 1900 && r.year <= 2100 ? r.year as number : undefined;
    const id = `${date}:${r.symbol}:${year ?? "?"}:${quarter ?? "?"}`;
    const old = events.get(id);
    const hour = ["bmo", "amc", "dmh"].includes(r.hour) ? r.hour as EarningsHour : old?.hour ?? "unknown";
    events.set(id, { id, symbol: r.symbol, date, hour, quarter, year,
      epsActual: number(r.epsActual) ?? old?.epsActual, epsEstimate: number(r.epsEstimate) ?? old?.epsEstimate,
      revenueActual: number(r.revenueActual) ?? old?.revenueActual, revenueEstimate: number(r.revenueEstimate) ?? old?.revenueEstimate });
  }
  const warnings: string[] = [];
  if (data.earningsCalendar.length >= 1500) warnings.push(`${date} 原始记录≥1500，可能被截断；接口未提供分页契约`);
  if (rejected) warnings.push(`${date} 过滤 ${rejected} 条越界日期或代码异常记录`);
  return { events: [...events.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id)), rawCount: data.earningsCalendar.length, warnings, fetchedAt };
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new MarketError("请求已取消。")); return; }
    const abort = (): void => { clearTimeout(timer); reject(new MarketError("请求已取消。")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export class EarningsCalendarClient {
  private readonly key: string;
  private readonly transport: typeof fetch;
  private readonly gap: number;
  private readonly lifetime = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private next = 0;
  private cooldown = 0;
  private cache = new Map<string, CalendarDay>();
  constructor(key: string, gap = 1100, transport: typeof fetch = fetch) { this.key = key; this.gap = gap; this.transport = transport; }
  get configured(): boolean { return !!this.key; }
  dispose(): void { this.lifetime.abort(); this.cache.clear(); }
  day(date: string, signal: AbortSignal, force = false): Promise<CalendarDay> {
    const run = async (): Promise<CalendarDay> => {
      if (!validDate(date)) throw new MarketError("财报查询日期无效。");
      if (!this.key) throw new MarketError("未配置 FINNHUB_API_KEY；请在 extensions/stock-heatmap/.env 设置后 /reload。");
      const combined = AbortSignal.any([signal, this.lifetime.signal]);
      combined.throwIfAborted();
      const cached = this.cache.get(date);
      if (!force && cached && Date.now() - cached.fetchedAt < 5 * 60000) return cached;
      while (Date.now() < Math.max(this.next, this.cooldown)) await wait(Math.min(60000, Math.max(this.next, this.cooldown) - Date.now()), combined);
      combined.throwIfAborted();
      this.next = Date.now() + this.gap;
      let response: Response;
      try {
        response = await this.transport(`https://finnhub.io/api/v1/calendar/earnings?from=${date}&to=${date}&international=false`, {
          headers: { "X-Finnhub-Token": this.key, Accept: "application/json" }, redirect: "error",
          signal: AbortSignal.any([combined, AbortSignal.timeout(20000)]),
        });
      } catch { throw new MarketError("Finnhub 请求超时、被取消或网络不可用。"); }
      if (response.status === 429) {
        const header = response.headers.get("Retry-After");
        const n = header ? (/^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 60000;
        const retry = Math.max(1000, Number.isFinite(n) ? n : 60000);
        this.cooldown = Date.now() + retry;
        throw new MarketError(`Finnhub 请求限流（429），至少等待 ${Math.ceil(retry / 1000)} 秒。`, retry);
      }
      if (!response.ok) throw new MarketError(response.status === 401 ? "Finnhub API Key 无效（401）。" : response.status === 403 ? "Finnhub 当前账户无财报日历权限（403）。" : `Finnhub 返回 HTTP ${response.status}。`);
      let data: unknown;
      try { data = await response.json(); } catch { throw new MarketError("Finnhub 返回非 JSON 数据。"); }
      const parsed = parseCalendarDay(data, date);
      combined.throwIfAborted();
      this.cache.set(date, parsed);
      while (this.cache.size > 21) this.cache.delete(this.cache.keys().next().value!);
      return parsed;
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => {});
    return result;
  }
}

export class EarningsController {
  readonly state: EarningsState;
  private readonly calendar: EarningsCalendarClient;
  private readonly market: MarketClient;
  private readonly onChange: () => void;
  private readonly clock: () => Date;
  private active = false;
  private stopped = false;
  private calendarAbort?: AbortController;
  private priceAbort?: AbortController;
  private calendarTimer?: ReturnType<typeof setTimeout>;
  private priceTimer?: ReturnType<typeof setTimeout>;
  private calendarVersion = 0;
  private priceVersion = 0;
  private barsCache = new Map<string, Map<string, DailyBar>>();
  constructor(calendar: EarningsCalendarClient, market: MarketClient, onChange: () => void, clock: () => Date = () => new Date()) {
    this.calendar = calendar; this.market = market; this.onChange = onChange; this.clock = clock;
    this.state = { range: resolveEarningsRange("today", clock()), mode: "eps", scope: "all", watchlist: [], events: [], prices: new Map(), warnings: [],
      loadingCalendar: false, loadingPrices: false, calendarError: "", priceError: "", progress: "", priceProgress: "", revision: 0 };
  }
  private changed(): void { if (!this.stopped) { this.state.revision++; this.onChange(); } }
  activate(range: EarningsRange): void {
    if (this.stopped) return;
    const different = range.from !== this.state.range.from || range.to !== this.state.range.to;
    this.state.range = range; this.active = true;
    if (different) { this.state.events = []; this.state.prices.clear(); this.state.calendarAt = undefined; }
    this.refresh();
  }
  deactivate(): void {
    this.active = false; this.calendarVersion++; this.priceVersion++;
    this.calendarAbort?.abort(); this.priceAbort?.abort();
    if (this.calendarTimer) clearTimeout(this.calendarTimer);
    if (this.priceTimer) clearTimeout(this.priceTimer);
    this.state.loadingCalendar = false; this.state.loadingPrices = false;
  }
  setMode(mode: EarningsMode): void {
    this.state.mode = mode; this.stopPrices(); this.changed();
    if (this.active && mode === "price" && !this.state.loadingCalendar) this.loadPrices();
  }
  setScope(scope: EarningsScope): void {
    this.state.scope = scope; this.stopPrices(); this.changed();
    if (this.active && this.state.mode === "price" && !this.state.loadingCalendar) this.loadPrices();
  }
  setWatchlist(symbols: string[]): void {
    this.state.watchlist = [...symbols];
    if (this.state.scope === "watchlist") this.setScope("watchlist");
  }
  refresh(force = false): void {
    if (!this.active || this.stopped) return;
    if (this.state.range.relative) {
      const next = resolveEarningsRange(this.state.range.relative, this.clock());
      if (next.from !== this.state.range.from || next.to !== this.state.range.to) {
        this.state.range = next; this.state.events = []; this.state.prices.clear(); this.state.calendarAt = undefined;
      }
    }
    this.calendarAbort?.abort(); this.stopPrices();
    if (this.calendarTimer) clearTimeout(this.calendarTimer);
    const abort = new AbortController(); this.calendarAbort = abort;
    const version = ++this.calendarVersion, signal = abort.signal;
    this.state.loadingCalendar = true; this.state.calendarError = ""; this.state.warnings = [];
    const range = { ...this.state.range }, days = rangeDays(range);
    const byDay = new Map(days.map(date => [date, this.state.events.filter(event => event.date === date)]));
    this.changed();
    void (async () => {
      let retry = 10 * 60000, failed = false;
      for (let i = 0; i < days.length; i++) {
        if (signal.aborted || version !== this.calendarVersion || !this.active) return;
        const date = days[i];
        this.state.progress = `日历 ${i + 1}/${days.length} · ${date}`; this.changed();
        try {
          const data = await this.calendar.day(date, signal, force);
          if (signal.aborted || version !== this.calendarVersion || !this.active) return;
          byDay.set(date, data.events);
          this.state.events = [...byDay.values()].flat().sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));
          this.state.warnings.push(...data.warnings);
          this.changed();
        } catch (error) {
          if (signal.aborted || version !== this.calendarVersion || !this.active) return;
          failed = true;
          this.state.calendarError = `${date}：${safeError(error)} 已有数据可能不完整或过期。`;
          if (error instanceof MarketError) retry = Math.max(retry, error.retryMs);
          this.changed();
          if (error instanceof MarketError && (/401|403|未配置/.test(error.message) || error.retryMs)) break;
        }
      }
      if (signal.aborted || version !== this.calendarVersion || !this.active) return;
      this.state.loadingCalendar = false;
      if (!failed) this.state.calendarAt = Date.now();
      if (range.from < shiftDate(newYorkDate(this.clock()), -30)) this.state.warnings.push("免费日历历史覆盖约一个月；更早数据可能缺失");
      this.state.progress = ""; this.changed();
      if (this.state.mode === "price") this.loadPrices();
      if (this.calendar.configured && !/401|403/.test(this.state.calendarError)) {
        this.calendarTimer = setTimeout(() => this.refresh(), Math.min(2147483647, retry)); this.calendarTimer.unref();
      }
    })();
  }
  private stopPrices(): void {
    this.priceVersion++; this.priceAbort?.abort();
    if (this.priceTimer) clearTimeout(this.priceTimer);
    this.state.loadingPrices = false;
  }
  private async bars(date: string, signal: AbortSignal): Promise<Map<string, DailyBar>> {
    const cached = this.barsCache.get(date);
    if (cached) return cached;
    const bars = await this.market.dailyBars(date, signal);
    signal.throwIfAborted();
    this.barsCache.set(date, bars);
    while (this.barsCache.size > 16) this.barsCache.delete(this.barsCache.keys().next().value!);
    return bars;
  }
  private loadPrices(): void {
    this.stopPrices();
    if (!this.active || this.stopped || this.state.mode !== "price") return;
    const abort = new AbortController(); this.priceAbort = abort;
    const signal = abort.signal, version = this.priceVersion, today = newYorkDate(this.clock());
    const events = visibleEarnings(this.state).filter(event => hasActual(event, today));
    const dates = [...new Set(events.map(event => event.date))].sort();
    this.state.loadingPrices = true; this.state.priceError = ""; this.changed();
    void (async () => {
      let retry = 60000;
      for (const date of dates) {
        if (signal.aborted || version !== this.priceVersion || !this.active) return;
        this.state.priceProgress = `发布日行情 ${date}（不是财报反应）`; this.changed();
        const group = events.filter(event => event.date === date);
        try {
          if (date === today) {
            const quotes = await this.market.snapshots(group.map(event => event.symbol), signal);
            if (signal.aborted || version !== this.priceVersion || !this.active) return;
            for (const event of group) {
              this.state.prices.delete(event.id);
              const q = quotes.find(quote => quote.symbol === event.symbol);
              const quoteDate = q?.source === "daily" ? q.sessionDate : q?.timestamp ? newYorkDate(new Date(q.timestamp)) : undefined;
              if (q?.price !== undefined && quoteDate === date) this.state.prices.set(event.id, { date, price: q.price, change: q.change, asOf: q.timestamp, kind: q.source === "daily" ? "close" : "snapshot" });
            }
          } else {
            const bars = await this.bars(date, signal);
            let priorDate = date, prior = new Map<string, DailyBar>();
            if (bars.size) for (let attempts = 0; attempts < 6 && !prior.size;) {
              priorDate = shiftDate(priorDate, -1);
              if ([0, 6].includes(new Date(priorDate + "T12:00:00Z").getUTCDay())) continue;
              attempts++; prior = await this.bars(priorDate, signal);
            }
            if (signal.aborted || version !== this.priceVersion || !this.active) return;
            for (const event of group) {
              this.state.prices.delete(event.id);
              const bar = bars.get(event.symbol), previous = prior.get(event.symbol);
              if (bar) this.state.prices.set(event.id, { date, price: bar.close, change: previous ? (bar.close / previous.close - 1) * 100 : undefined,
                asOf: bar.timestamp, kind: "close", referenceDate: previous ? priorDate : undefined });
            }
          }
          this.state.priceAt = Date.now(); this.changed();
        } catch (error) {
          if (signal.aborted || version !== this.priceVersion || !this.active) return;
          this.state.priceError = `${date}：${safeError(error)} 不影响已取得的 EPS。`;
          this.changed();
          if (error instanceof MarketError) retry = Math.max(retry, error.retryMs);
          if (error instanceof MarketError && (/401|403|未配置/.test(error.message) || error.retryMs)) break;
        }
      }
      if (signal.aborted || version !== this.priceVersion || !this.active) return;
      this.state.loadingPrices = false; this.state.priceProgress = ""; this.changed();
      // 历史收盘无需每分钟请求；仅当有今天已返回实际值的事件时更新当前日快照。
      if (dates.includes(today) && !/401|403|未配置/.test(this.state.priceError)) {
        this.priceTimer = setTimeout(() => this.loadPrices(), Math.min(2147483647, retry)); this.priceTimer.unref();
      }
    })();
  }
  dispose(): void { this.deactivate(); this.stopped = true; this.calendar.dispose(); this.barsCache.clear(); }
}
