import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
export interface StockInfo {
  symbol: string; name: string; sector: string; industry: string;
  sp500: boolean; nasdaq100: boolean;
}
export interface Universe {
  retrievedAt: string; sources: string[]; note: string; stocks: StockInfo[];
}
export const UNIVERSE = JSON.parse(readFileSync(join(EXTENSION_DIR, "universe.json"), "utf8")) as Universe;
export const STOCKS = new Map(UNIVERSE.stocks.map(stock => [stock.symbol, stock]));
export const DEFAULT_WATCHLIST = ["META", "TSLA", "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL"];
export const INDEX_ETFS = ["SPY", "QQQ", "DIA", "IWM"];
export const CATEGORIES = [
  "自选", "S&P 500", "Nasdaq 100", "Tech Services", "Electronic Tech", "Finance",
  "Health Services", "Consumer Durables", "Retail Trade", "Consumer Services",
  "Health Technology", "Energy Minerals", "Utilities", "Producer Manufacturing",
  "Consumer Non-Durables", "Process Industries", "Transportation", "Communications",
  "Real Estate", "Commercial Services", "Non-Energy Minerals", "其他",
] as const;
export type Category = typeof CATEGORIES[number];

// 这是扩展自己的板块映射，不冒充交易所或 TradingView 的精确行业分类。
export function sectorOf(stock: StockInfo): Category {
  const i = stock.industry.toLowerCase();
  if (/semiconductor|hardware|electronic|communications equipment|technology distributors/.test(i)) return "Electronic Tech";
  if (/health care providers|health care services|managed health|health care facilities/.test(i)) return "Health Services";
  if (/pharmaceutical|biotechnology|health care equipment|life sciences|health care supplies/.test(i)) return "Health Technology";
  if (/automobile|automotive|homebuilding|household appliances|leisure products|consumer electronics/.test(i)) return "Consumer Durables";
  if (/interactive media|entertainment|restaurant|hotel|leisure facilities|broadcasting|publishing|cable/.test(i)) return "Consumer Services";
  if (/professional services|research & consulting|human resource|transaction|data processing/.test(i)) return "Commercial Services";
  if (/steel|copper|gold|aluminum|metals/.test(i)) return "Non-Energy Minerals";
  switch (stock.sector) {
    case "Information Technology": return "Tech Services";
    case "Financials": return "Finance";
    case "Health Care": return "Health Technology";
    case "Consumer Staples": return /retail|distribut/.test(i) ? "Retail Trade" : "Consumer Non-Durables";
    case "Consumer Discretionary": return /retail|distribut/.test(i) ? "Retail Trade" : "Consumer Services";
    case "Energy": return "Energy Minerals";
    case "Utilities": return "Utilities";
    case "Industrials": return /transport|airline|rail|cargo|trucking/.test(i) ? "Transportation" : "Producer Manufacturing";
    case "Materials": return "Process Industries";
    case "Communication Services": return /telecom/.test(i) ? "Communications" : "Consumer Services";
    case "Real Estate": return "Real Estate";
    default: return "其他";
  }
}
export function infoFor(symbol: string): StockInfo {
  return STOCKS.get(symbol) ?? { symbol, name: symbol, sector: "其他", industry: "", sp500: false, nasdaq100: false };
}
export function symbolsFor(category: Category, watchlist: string[]): string[] {
  if (category === "自选") return [...watchlist];
  return UNIVERSE.stocks.filter(s => category === "S&P 500" ? s.sp500 : category === "Nasdaq 100" ? s.nasdaq100 : sectorOf(s) === category).map(s => s.symbol);
}
export function resolveCategory(input: string): Category | undefined {
  const normalized = input.trim().replace(/^["']|["']$/g, "").toLowerCase().replace(/[\s&_-]/g, "");
  if (["watchlist", "自选股"].includes(normalized)) return "自选";
  if (["sp500", "标普500"].includes(normalized)) return "S&P 500";
  if (["ndx", "nasdaq", "纳指100"].includes(normalized)) return "Nasdaq 100";
  return CATEGORIES.find(s => s.toLowerCase().replace(/[\s&_-]/g, "") === normalized);
}
export function parseSymbols(input: string): string[] {
  const tokens = input.trim().toUpperCase().split(/[\s,，、;；|]+/u).filter(Boolean);
  if (!tokens.length) throw new Error("请提供股票代码，例如 META,TSLA,NVDA。");
  const invalid = tokens.filter(s => !/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,3})?$/.test(s));
  if (invalid.length) throw new Error("股票代码格式无效；仅支持美股普通股/ETF 代码，例如 AAPL、BRK.B。");
  return [...new Set(tokens.map(s => s.replace(/-([A-Z])$/, ".$1")))];
}

export interface Preferences { version: 1; symbols: string[]; usage: Record<string, number>; ticker: boolean }
export class PreferencesStore {
  readonly path: string;
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; this.path = join(directory, "watchlist.json"); }
  async read(): Promise<Preferences> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.path, "utf8")); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, symbols: [...DEFAULT_WATCHLIST], usage: {}, ticker: true };
      throw new Error("无法读取自选股文件，请检查 JSON 格式和权限；原文件未覆盖。");
    }
    const p = object(raw);
    if (p.version !== 1 || !Array.isArray(p.symbols) || !p.symbols.every(s => typeof s === "string" && /^[A-Z][A-Z0-9.\-]{0,13}$/.test(s))) {
      throw new Error("自选股文件格式无效；原文件未覆盖。");
    }
    return { version: 1, symbols: [...new Set(p.symbols as string[])], usage: Object.fromEntries(Object.entries(object(p.usage)).filter(([k, v]) => CATEGORIES.includes(k as Category) && typeof v === "number" && Number.isFinite(v) && v >= 0)), ticker: p.ticker !== false } as Preferences;
  }
  async update(mutator: (p: Preferences) => void): Promise<Preferences> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = this.path + ".lock";
    const deadline = Date.now() + 4_000;
    while (true) {
      try { await mkdir(lock); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("无法锁定自选股文件，请检查目录权限。");
        if (Date.now() >= deadline) throw new Error("另一进程正在修改自选股；请稍后再试。如进程异常退出，请手动删除 watchlist.json.lock 目录。");
        await new Promise(resolve => setTimeout(resolve, 60));
      }
    }
    try {
      const prefs = await this.read();
      mutator(prefs);
      if (prefs.symbols.length > 1000) throw new Error("自选股最多支持 1000 个代码。");
      await atomicJSON(this.path, prefs);
      return prefs;
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
}
export async function atomicJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export function orderedCategories(usage: Record<string, number>): Category[] {
  // 三个固定常用入口置顶，其余按使用次数排序。
  return [...CATEGORIES.slice(0, 3), ...CATEGORIES.slice(3).sort((a, b) => (usage[b] ?? 0) - (usage[a] ?? 0))];
}
export interface Config { apiKey: string; baseURL: string; refreshMs: number; requestGapMs: number; ticker: boolean; finnhubAPIKey?: string; earningsRequestGapMs?: number }
export async function loadConfig(): Promise<Config> {
  let env: Record<string, string | undefined> = {};
  try { env = parseEnv(await readFile(join(EXTENSION_DIR, ".env"), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("无法读取扩展目录的 .env，请检查权限和格式。"); }
  const get = (name: string): string | undefined => process.env[name] ?? env[name];
  const key = get("STOCK_HEATMAP_API_KEY") || get("MASSIVE_API_KEY") || get("POLYGON_API_KEY") || "";
  const baseURL = get("MASSIVE_BASE_URL") || get("POLYGON_BASE_URL") || "https://api.massive.com";
  if (!["https://api.massive.com", "https://api.polygon.io"].includes(baseURL.replace(/\/$/, ""))) throw new Error("行情地址仅允许 https://api.massive.com 或 https://api.polygon.io。");
  const number = (name: string, fallback: number, min: number, max: number): number => {
    const raw = get(name); const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} 配置无效，允许范围 ${min}–${max}。`);
    return n;
  };
  if (key && !/^[\x21-\x7e]+$/.test(key)) throw new Error("API Key 格式无效，请检查 .env。");
  const finnhubAPIKey = get("FINNHUB_API_KEY") || "";
  if (finnhubAPIKey && !/^[\x21-\x7e]+$/.test(finnhubAPIKey)) throw new Error("Finnhub API Key 格式无效，请检查 .env。");
  return { apiKey: key, baseURL: baseURL.replace(/\/$/, ""), refreshMs: number("STOCK_HEATMAP_REFRESH_SECONDS", 60, 15, 3600) * 1000, requestGapMs: number("STOCK_HEATMAP_REQUEST_GAP_MS", 12000, 0, 60000), ticker: get("STOCK_HEATMAP_TICKER") !== "false", finnhubAPIKey, earningsRequestGapMs: number("STOCK_EARNINGS_REQUEST_GAP_MS", 1100, 0, 60000) };
}
export function object(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function finite(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function positive(value: unknown): number | undefined { const n = finite(value); return n !== undefined && n > 0 ? n : undefined; }
export interface Quote {
  symbol: string; price?: number; change?: number; volume?: number; turnover?: number;
  timestamp?: number; delayed: boolean; source?: "snapshot" | "daily"; sessionDate?: string;
}
export function timestampMs(value: unknown): number | undefined {
  const n = positive(value);
  if (n === undefined) return undefined;
  const ms = n > 1e17 ? n / 1e6 : n > 1e14 ? n / 1e3 : n < 1e11 ? n * 1000 : n;
  return ms > 946684800000 && ms <= Date.now() + 86400000 ? Math.floor(ms) : undefined;
}
export function parseSnapshot(payload: unknown): Quote[] {
  const data = object(payload);
  if (!Array.isArray(data.tickers)) throw new Error("快照响应缺少 tickers，无法解析。");
  return data.tickers.flatMap((raw: unknown) => {
    const r = object(raw); if (typeof r.ticker !== "string" || !/^[A-Z][A-Z0-9.\-]{0,13}$/.test(r.ticker)) return [];
    const day = object(r.day), trade = object(r.lastTrade), minute = object(r.min), previous = object(r.prevDay);
    // 盘后 day.c 可能仍是常规时段收盘价，不能和盘后 todaysChangePerc 混用。
    // 优先显示最新成交/分钟价，并使用同一个价格和昨收计算涨跌幅。
    const tradePrice = positive(trade.p), minutePrice = positive(minute.c);
    const price = tradePrice ?? minutePrice ?? positive(day.c);
    const priorClose = positive(previous.c);
    const volume = finite(day.v);
    const vwap = positive(day.vw) ?? positive(day.c);
    const change = price === undefined ? undefined : priorClose ? (price / priorClose - 1) * 100 : finite(r.todaysChangePerc);
    const timestamp = tradePrice ? timestampMs(trade.t) : minutePrice ? timestampMs(minute.t) : undefined;
    return [{ symbol: r.ticker, price, change, volume,
      turnover: volume !== undefined && volume > 0 && vwap ? volume * vwap : undefined,
      timestamp: timestamp ?? timestampMs(r.updated), delayed: data.status === "DELAYED" }];
  });
}
export class MarketError extends Error {
  readonly retryMs: number;
  constructor(message: string, retryMs = 0) { super(message); this.retryMs = retryMs; }
}
export function safeError(error: unknown): string {
  return error instanceof MarketError ? error.message : "请求失败，请检查网络、API Key 和行情权限后重试。";
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("已取消")); return; }
    const abort = (): void => { clearTimeout(timer); reject(new Error("已取消")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export interface DailyBar { symbol: string; close: number; volume?: number; vwap?: number; timestamp?: number }
export class MarketClient {
  private tail: Promise<unknown> = Promise.resolve();
  private nextRequest = 0;
  private cooldown = 0;
  private dailyCache?: { day: string; at: number; quotes: Quote[] };
  private readonly controller = new AbortController();
  readonly config: Config;
  private readonly transport: typeof fetch;
  constructor(config: Config, transport: typeof fetch = fetch) { this.config = config; this.transport = transport; }
  dispose(): void { this.controller.abort(); }
  request(path: string, signal?: AbortSignal): Promise<Record<string, any>> {
    const run = async (): Promise<Record<string, any>> => {
      if (!this.config.apiKey) throw new MarketError("未配置 API Key：请在 extensions/stock-heatmap/.env 设置 POLYGON_API_KEY 或 MASSIVE_API_KEY，然后 /reload。");
      const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
      combined.throwIfAborted();
      await wait(Math.max(0, this.nextRequest - Date.now(), this.cooldown - Date.now()), combined);
      this.nextRequest = Date.now() + this.config.requestGapMs;
      let response: Response;
      try {
        response = await this.transport(this.config.baseURL + path, {
          headers: { Authorization: `Bearer ${this.config.apiKey}`, Accept: "application/json" },
          redirect: "error", signal: AbortSignal.any([combined, AbortSignal.timeout(20000)]),
        });
      } catch { throw new MarketError("行情请求超时、被取消或网络不可用。"); }
      if (response.status === 429) {
        const header = response.headers.get("Retry-After");
        const retry = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 60000;
        const ms = Math.max(12000, Math.min(3600000, Number.isFinite(retry) ? retry : 60000));
        this.cooldown = Date.now() + ms;
        throw new MarketError(`请求达到频率限制，约 ${Math.ceil(ms / 1000)} 秒后重试。`, ms);
      }
      if (!response.ok) throw new MarketError(response.status === 401 ? "API Key 无效或已失效（401）。" : response.status === 403 ? "当前套餐无此行情权限（403），请检查股票快照/指数权限。" : `行情服务返回 HTTP ${response.status}。`);
      let data: Record<string, any>;
      try { data = object(await response.json()); } catch { throw new MarketError("行情服务返回非 JSON 数据。"); }
      if (!["OK", "DELAYED"].includes(data.status)) throw new MarketError("行情接口未返回成功状态，请检查数据权限。");
      return data;
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => {});
    return result;
  }
  async snapshots(symbols: string[], signal?: AbortSignal): Promise<Quote[]> {
    const list = [...new Set(symbols)]; if (!list.length) return [];
    // 大股票池一次请求全市场，避免长 URL 和数百次单股请求；仅保留实际所需股票。
    // include_otc 默认即为 false；保留文档中的逗号形式，避免不同查询串命中不同快照缓存。
    const query = list.length > 150 ? "" : `?tickers=${list.map(s => encodeURIComponent(s)).join(",")}`;
    const data = await this.request(`/v2/snapshot/locale/us/markets/stocks/tickers${query}`, signal);
    const wanted = new Set(list);
    let quotes = parseSnapshot(data).filter(q => wanted.has(q.symbol));
    // 每日重置时会返回代码存在但 OHLC 全零的占位；回退到两个真实交易日的日线，绝不推测涨跌。
    if (quotes.length > 0 && quotes.every(q => q.price === undefined)) {
      try {
        const recovered = (await this.previousSession(signal)).filter(q => wanted.has(q.symbol));
        if (recovered.some(q => q.price !== undefined)) quotes = recovered;
      } catch (error) {
        if (signal?.aborted || this.controller.signal.aborted || (error instanceof MarketError && error.retryMs)) throw error;
        // 无日线权限时返回原始快照，上层提示无有效报价，不用零值充数。
      }
    }
    return quotes;
  }
  private async previousSession(signal?: AbortSignal): Promise<Quote[]> {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (this.dailyCache?.day === day && Date.now() - this.dailyCache.at < 30 * 60000) return this.dailyCache.quotes;
    const date = new Date(day + "T12:00:00Z");
    const sessions: { date: string; bars: Record<string, any>[] }[] = [];
    // 不硬编码美国节假日：跳过周末，对假日空结果继续向前寻找，最多请求六个工作日。
    for (let attempts = 0; attempts < 6 && sessions.length < 2;) {
      date.setUTCDate(date.getUTCDate() - 1);
      if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
      attempts++;
      const label = date.toISOString().slice(0, 10);
      const data = await this.request(`/v2/aggs/grouped/locale/us/market/stocks/${label}?adjusted=true`, signal);
      if (data.results === undefined && data.resultsCount === 0) continue;
      if (!Array.isArray(data.results)) throw new MarketError("日线回退响应格式无效。");
      const bars = data.results.map(object).filter((r: Record<string, any>) => typeof r.T === "string" && /^[A-Z][A-Z0-9.\-]{0,13}$/.test(r.T) && positive(r.c));
      if (bars.length) sessions.push({ date: label, bars });
    }
    if (!sessions.length) return [];
    const previous = new Map<string, Record<string, any>>((sessions[1]?.bars ?? []).map(r => [r.T, r]));
    const quotes: Quote[] = sessions[0].bars.map(r => {
      const prior = positive(previous.get(r.T)?.c), price = positive(r.c)!;
      const volume = finite(r.v), vwap = positive(r.vw) ?? price;
      return { symbol: r.T, price, change: prior ? (price / prior - 1) * 100 : undefined, volume,
        turnover: volume !== undefined && volume > 0 ? volume * vwap : undefined,
        timestamp: timestampMs(r.t), delayed: true, source: "daily", sessionDate: sessions[0].date };
    });
    this.dailyCache = { day, at: Date.now(), quotes };
    return quotes;
  }
  async vix(signal?: AbortSignal): Promise<Quote | undefined> {
    const data = await this.request("/v3/snapshot/indices?ticker.any_of=I%3AVIX", signal);
    if (!Array.isArray(data.results)) throw new MarketError("VIX 指数响应格式无效。");
    const r = data.results.find((r: unknown) => object(r).ticker === "I:VIX");
    if (!r) return undefined;
    const s = object(object(r).session);
    const price = positive(object(r).value);
    return { symbol: "VIX", price, change: price === undefined ? undefined : finite(s.change_percent), timestamp: timestampMs(object(r).last_updated), delayed: data.status === "DELAYED" || object(r).timeframe === "DELAYED" };
  }
  async dailyBars(date: string, signal?: AbortSignal): Promise<Map<string, DailyBar>> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new MarketError("日线日期格式无效。");
    const data = await this.request(`/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true`, signal);
    if (data.results === undefined && data.resultsCount === 0) return new Map();
    if (!Array.isArray(data.results)) throw new MarketError("日线响应格式无效。");
    const bars = new Map<string, DailyBar>();
    for (const raw of data.results) {
      const r = object(raw), close = positive(r.c);
      if (typeof r.T !== "string" || !/^[A-Z][A-Z0-9.\-]{0,13}$/.test(r.T) || close === undefined) continue;
      bars.set(r.T, { symbol: r.T, close, volume: finite(r.v), vwap: positive(r.vw), timestamp: timestampMs(r.t) });
    }
    return bars;
  }
  async marketCap(symbol: string, signal?: AbortSignal): Promise<number | undefined> {
    const data = await this.request(`/v3/reference/tickers/${encodeURIComponent(symbol)}`, signal);
    return positive(object(data.results).market_cap);
  }
}
export interface CapEntry { value: number; at: number }
export class CapCache {
  values: Record<string, CapEntry> = {};
  private readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  async load(): Promise<void> {
    try {
      const data = object(JSON.parse(await readFile(join(this.directory, "market-caps.json"), "utf8")));
      for (const [symbol, raw] of Object.entries(data)) {
        const r = object(raw);
        if (/^[A-Z][A-Z0-9.\-]{0,13}$/.test(symbol) && positive(r.value) && positive(r.at) && Date.now() - r.at < 7 * 86400000) this.values[symbol] = { value: r.value, at: r.at };
      }
    } catch { /* 缓存可丢弃；不覆盖自选股。 */ }
  }
  get(symbol: string): number | undefined { return this.values[symbol]?.value; }
  async put(symbol: string, value: number): Promise<void> {
    this.values[symbol] = { value, at: Date.now() };
    await atomicJSON(join(this.directory, "market-caps.json"), this.values);
  }
}
export function percent(value?: number): string { return value === undefined ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`; }
export function amount(value?: number): string {
  if (value === undefined) return "—";
  return value >= 1e12 ? `${(value / 1e12).toFixed(2)}T` : value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value.toFixed(2);
}
