import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  CapCache, CATEGORIES, DEFAULT_WATCHLIST, INDEX_ETFS, MarketClient, MarketError,
  PreferencesStore, loadConfig, parseSymbols, percent, resolveCategory, safeError, symbolsFor,
  type Category, type Config, type Preferences,
} from "./core.ts";
import { CategoryPicker, HeatmapWidget, HeatmapView, MarketTicker, timeLabel, type HeatmapState, type TickerState, type WeightMode } from "./ui.ts";

import { EarningsCalendarClient, EarningsController, resolveEarningsRange, newYorkDate, type EarningsMode, type EarningsScope } from "./earnings.ts";
import { EarningsWidget, earningsDetails } from "./earnings-ui.ts";

const WIDGET_KEY = "stock-heatmap:market-ticker";
const HEATMAP_KEY = "stock-heatmap:heatmap";
const HELP = [
  "/stock-heatmap [类别]  在输入框上方展示热图；无参数搜索选择类别",
  "/stock-heatmap-close  收起热图，不影响大盘行情条",
  "/stock-heatmap-focus  专注大图；Esc 返回输入框",
  "/stock-heatmap-mode 市值|成交额|等权  切换面积口径",
  "/stock-heatmap-refresh  请求刷新",
  "/stock-earnings [today|tomorrow|week|YYYY-MM-DD]  财报日热图",
  "/stock-earnings-mode eps|price  EPS超预期 / 发布日股价涨跌",
  "/stock-earnings-scope all|indices|watchlist  财报范围",
  "/stock-earnings-details [SYMBOL]  数据与状态明细",
  "/stock-earnings-refresh  刷新财报；/stock-earnings-close 收起",
  "/stock-add META,TSLA,NVDA  批量添加自选股",
  "/stock-remove META TSLA  批量删除自选股",
  "/stock-watchlist list|add|remove|set|clear  查看/编辑自选股",
  "/stock-ticker on|off|status  开关底部行情/查看数据状态",
  "自选股跨项目保存；支持逗号、中文逗号、空格、换行、分号、顿号、竖线。",
].join("\n");

class StockRuntime {
  private config?: Config;
  private prefs: Preferences = { version: 1, symbols: [...DEFAULT_WATCHLIST], usage: {}, ticker: true };
  private readonly store = new PreferencesStore(join(getAgentDir(), "stock-heatmap"));
  private readonly caps = new CapCache(this.store.directory);
  private client?: MarketClient;
  private initialized?: Promise<void>;
  private readonly preferenceWrites = new Set<Promise<Preferences>>();
  private readonly capWrites = new Set<Promise<void>>();
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private ticker?: MarketTicker;
  private view?: HeatmapView;
  private heatmap?: HeatmapWidget;
  private slot?: "stocks" | "earnings";
  private earnings?: EarningsController;
  private earningsWidget?: EarningsWidget;
  private focusOpen = false;
  private focusDone?: () => void;
  private pickerDone?: () => void;
  private refreshQueued = false;
  private version = 0;
  private nextVix = 0;
  private capController?: AbortController;
  private readonly lifetime = new AbortController();
  private initializationError = "";
  readonly state: HeatmapState = {
    category: "S&P 500", symbols: [], quotes: new Map(), caps: this.caps.values, usage: {}, loading: false,
    error: "", capStatus: "按需逐只读取市值；受套餐速率限制，首次加载可能较慢。", weight: "turnover",
  };
  readonly market: TickerState = { quotes: this.state.quotes, error: "", vixError: "" };
  private readonly ctx: ExtensionContext;
  constructor(ctx: ExtensionContext) { this.ctx = ctx; }
  private ensure(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        this.prefs = await this.store.read();
        this.state.usage = this.prefs.usage;
        this.config = await loadConfig();
        this.client = new MarketClient(this.config);
        this.earnings = new EarningsController(new EarningsCalendarClient(this.config.finnhubAPIKey ?? "", this.config.earningsRequestGapMs), this.client, () => this.earningsWidget?.redraw());
        this.earnings.setWatchlist(this.prefs.symbols);
        await this.caps.load();
        this.state.caps = this.caps.values;
        this.state.symbols = symbolsFor(this.state.category, this.prefs.symbols);
      } catch (e) {
        // 此处仅处理本地配置/持久化错误；不显示 HTTP 原始异常或响应内容。
        this.initializationError = e instanceof Error ? e.message : "扩展配置读取失败。";
        this.state.error = this.initializationError;
        this.market.error = this.initializationError;
      }
    })();
    return this.initialized;
  }
  async start(): Promise<void> {
    await this.ensure();
    if (this.stopped) return;
    this.attachTicker();
    if (this.tickerEnabled()) void this.refresh();
  }
  private persist(mutator: (prefs: Preferences) => void): Promise<Preferences> {
    const pending = this.store.update(mutator);
    this.preferenceWrites.add(pending);
    void pending.then(() => this.preferenceWrites.delete(pending), () => this.preferenceWrites.delete(pending));
    return pending;
  }
  private heatmapNeeded(): boolean { return this.slot === "stocks" || this.focusOpen; }
  private redraw(): void {
    if (this.stopped) return;
    this.state.revision = (this.state.revision ?? 0) + 1;
    this.heatmap?.redraw(); this.view?.redraw(); this.ticker?.redraw();
  }
  private attachHeatmap(): void {
    if (this.stopped || this.slot !== "stocks") return;
    this.ctx.ui.setWidget(HEATMAP_KEY, (tui, theme) => {
      const heatmap = new HeatmapWidget(tui, theme, () => this.state);
      this.heatmap = heatmap;
      return heatmap;
    }, { placement: "aboveEditor" });
  }
  private tickerEnabled(): boolean { return this.prefs.ticker && this.config?.ticker !== false; }
  private attachTicker(): void {
    this.ticker?.dispose(); this.ticker = undefined;
    if (this.stopped) return;
    if (!this.tickerEnabled()) { this.ctx.ui.setWidget(WIDGET_KEY, undefined); return; }
    // setFooter 是整体替换；命名 belowEditor widget 保留内置/其他扩展的 Footer。
    this.ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      const ticker = new MarketTicker(tui, theme, () => this.market);
      this.ticker = ticker;
      return ticker;
    }, { placement: "belowEditor" });
  }
  private schedule(delay?: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || (!this.heatmapNeeded() && !this.tickerEnabled()) || !this.client || !this.config?.apiKey) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, delay ?? this.config.refreshMs);
    this.timer.unref();
  }
  refresh(): Promise<void> {
    if (this.pending) { this.refreshQueued = true; return this.pending; }
    if (this.timer) clearTimeout(this.timer);
    this.pending = this.doRefresh().finally(() => {
      this.pending = undefined;
      if (this.refreshQueued && !this.stopped) { this.refreshQueued = false; this.schedule(0); }
    });
    return this.pending;
  }
  private async doRefresh(): Promise<void> {
    await this.ensure();
    if (this.stopped || (!this.heatmapNeeded() && !this.tickerEnabled())) return;
    if (!this.client) { this.redraw(); return; }
    this.state.loading = true; this.redraw();
    const version = this.version;
    const requested = [...new Set([...(this.heatmapNeeded() ? this.state.symbols : []), ...(this.tickerEnabled() ? INDEX_ETFS : [])])];
    let delay = this.config?.refreshMs ?? 60000;
    try {
      const quotes = await this.client.snapshots(requested, this.lifetime.signal);
      if (this.stopped) return;
      const at = Date.now();
      const priced = quotes.filter(q => q.price !== undefined).length;
      const reset = requested.length > 0 && priced === 0;
      // 快照每日会清零。整批无有效报价时保留旧图和原行情时间，并醒目标记，绝不伪装成新报价。
      if (!reset) {
        for (const symbol of requested) this.state.quotes.delete(symbol);
        for (const quote of quotes) this.state.quotes.set(quote.symbol, quote);
      }
      this.market.fetchedAt = at;
      this.market.error = reset ? "本次快照无有效报价：可能处于每日重置窗口；如显示旧图，其行情时间保持不变" : quotes.some(q => q.source === "daily") ? `快照重置/无报价，回退至 ${quotes.find(q => q.source === "daily")?.sessionDate} 日线收盘，非实时行情` : "";
      if (version === this.version) {
        this.state.fetchedAt = at;
        this.state.error = this.market.error;
      }
      this.redraw();
      if (this.tickerEnabled() && at >= this.nextVix) {
        this.nextVix = at + 5 * 60000;
        try {
          const vix = await this.client.vix(this.lifetime.signal);
          if (this.stopped) return;
          this.market.vix = vix;
          this.market.vixError = vix?.price !== undefined ? "" : "指数数据不可用";
        } catch (e) {
          if (this.stopped) return;
          this.market.vixError = safeError(e);
          // VIX 的权限独立；失败不影响 ETF/股票。旧值保留其原时间戳。
          if (e instanceof MarketError && /403|401/.test(e.message)) this.nextVix = Infinity;
        }
      }
      if (version !== this.version) delay = 0;
    } catch (e) {
      if (this.stopped) return;
      const message = safeError(e);
      this.state.error = message; this.market.error = message;
      delay = Math.max(delay, e instanceof MarketError ? e.retryMs : 60000);
    } finally {
      this.state.loading = false;
      if (!this.stopped) { this.redraw(); this.schedule(delay); }
    }
  }
  private choose(category: Category): void {
    this.version++;
    this.state.category = category;
    this.state.symbols = symbolsFor(category, this.prefs.symbols);
    this.state.error = this.initializationError;
    this.capController?.abort();
    void this.persist(p => { p.usage[category] = (p.usage[category] ?? 0) + 1; }).then(p => {
      if (!this.stopped) { this.prefs = p; this.state.usage = p.usage; this.redraw(); }
    }).catch(() => { if (!this.stopped) { this.state.error = "无法保存类别使用频率；行情仍可使用。"; this.redraw(); } });
    void this.refresh();
    if (this.state.weight === "cap") this.loadCaps();
  }
  private weight(mode: WeightMode): void {
    this.state.weight = mode;
    this.capController?.abort();
    if (mode === "cap") this.loadCaps();
    this.redraw();
  }
  private loadCaps(): void {
    if (!this.client || !this.heatmapNeeded() || this.stopped) return;
    const controller = new AbortController();
    this.capController = controller;
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const symbols = [...this.state.symbols].sort((a, b) => (this.state.quotes.get(b)?.turnover ?? 0) - (this.state.quotes.get(a)?.turnover ?? 0));
    void (async () => {
      const missing = symbols.filter(s => this.caps.get(s) === undefined);
      let attempted = 0;
      for (const symbol of missing) {
        if (signal.aborted || this.stopped) return;
        this.state.capStatus = `市值加载 ${attempted}/${missing.length}，当前 ${symbol}；默认 5 请求/分钟，可在 .env 调整。无市值股票暂不分配面积。`;
        this.redraw();
        try {
          const value = await this.client!.marketCap(symbol, signal);
          if (signal.aborted || this.stopped) return;
          if (value !== undefined) {
            const write = this.caps.put(symbol, value); this.capWrites.add(write);
            try { await write; } finally { this.capWrites.delete(write); }
          }
          attempted++;
        } catch (e) {
          if (signal.aborted || this.stopped) return;
          this.state.capStatus = safeError(e) + "；市值加载已暂停，可用 /stock-heatmap-mode 市值 重试。";
          this.redraw(); return;
        }
      }
      if (!signal.aborted && !this.stopped) {
        this.state.capStatus = `市值缓存 ${symbols.filter(s => this.caps.get(s) !== undefined).length}/${symbols.length}；缺失值不分配面积，可切换等权查看。`;
        this.redraw();
      }
    })();
  }
  async open(args: string, commandCtx: ExtensionCommandContext): Promise<void> {
    await this.ensure();
    if (this.stopped) return;
    let category: Category | undefined;
    if (args.trim()) category = resolveCategory(args);
    else {
      try {
        category = await commandCtx.ui.custom<Category | undefined>((tui, theme, _keys, done) => {
          this.pickerDone = () => done(undefined);
          return new CategoryPicker(tui, theme, this.state.usage, done);
        });
      } finally { this.pickerDone = undefined; }
      if (category === undefined || this.stopped) return;
    }
    if (!category) { commandCtx.ui.notify("未知类别；使用 /stock-heatmap 搜索选择，或 Tab 补全。", "warning"); return; }
    const wasVisible = this.slot === "stocks";
    this.earnings?.deactivate(); this.earningsWidget?.dispose(); this.earningsWidget = undefined;
    this.slot = "stocks";
    this.choose(category);
    if (!wasVisible) this.attachHeatmap();
    this.redraw();
  }
  close(): void {
    if (this.slot !== "stocks") return;
    this.slot = undefined;
    this.heatmap?.dispose(); this.heatmap = undefined;
    this.ctx.ui.setWidget(HEATMAP_KEY, undefined);
    if (!this.focusOpen) this.capController?.abort();
    if (!this.heatmapNeeded() && !this.tickerEnabled() && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }
  async focus(args: string, commandCtx: ExtensionCommandContext): Promise<void> {
    await this.ensure();
    if (this.stopped || this.focusOpen) return;
    const category = args.trim() ? resolveCategory(args) : this.state.category;
    if (!category) { commandCtx.ui.notify("未知类别；使用 /stock-heatmap 搜索选择。", "warning"); return; }
    this.focusOpen = true;
    this.choose(category);
    try {
      await commandCtx.ui.custom<void>((tui, theme, _keys, done) => {
        this.focusDone = () => done(undefined);
        const view = new HeatmapView(tui, theme, () => this.state, c => this.choose(c), () => { void this.refresh(); }, mode => this.weight(mode), () => done(undefined));
        this.view = view;
        return view;
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 } });
    } finally {
      this.view?.dispose(); this.view = undefined; this.focusDone = undefined; this.focusOpen = false;
      if (this.slot !== "stocks") this.capController?.abort();
      if (!this.stopped) { this.redraw(); this.schedule(); }
    }
  }
  async setMode(args: string, commandCtx: ExtensionCommandContext): Promise<void> {
    await this.ensure();
    const input = args.trim() || await commandCtx.ui.select("选择热图面积口径", ["成交额", "市值", "等权"], { signal: this.lifetime.signal });
    if (!input || this.stopped) return;
    const modes: Record<string, WeightMode> = { "成交额": "turnover", turnover: "turnover", "市值": "cap", cap: "cap", "等权": "equal", equal: "equal" };
    const mode = modes[input.toLowerCase()];
    if (!mode) { commandCtx.ui.notify("用法：/stock-heatmap-mode 市值|成交额|等权", "info"); return; }
    this.weight(mode);
    if (!this.heatmapNeeded()) commandCtx.ui.notify("面积口径已切换；/stock-heatmap 打开热图。", "info");
  }
  async requestRefresh(commandCtx: ExtensionCommandContext): Promise<void> {
    await this.ensure();
    if (!this.heatmapNeeded() && !this.tickerEnabled() && this.slot !== "earnings") { commandCtx.ui.notify("热图与行情条均已关闭；请先打开需要的视图。", "info"); return; }
    if (this.slot === "earnings") this.earnings?.refresh(true);
    void this.refresh();
    commandCtx.ui.notify("已请求刷新，完成后原位更新，不占用输入框。", "info");
  }
  async editWatchlist(action: string, input: string, commandCtx: ExtensionCommandContext): Promise<void> {
    await this.ensure();
    if (this.initializationError) { commandCtx.ui.notify(this.initializationError, "error"); return; }
    const verb = action.toLowerCase();
    if (!verb || verb === "list") {
      const prefs = await this.store.read();
      this.prefs = prefs; this.earnings?.setWatchlist(prefs.symbols);
      commandCtx.ui.notify(`自选股（${prefs.symbols.length}）\n${prefs.symbols.join(", ") || "（空）"}\n保存于 ${this.store.path}`, "info"); return;
    }
    if (!["add", "remove", "set", "clear"].includes(verb)) { commandCtx.ui.notify(HELP, "info"); return; }
    if (verb === "clear" && !(await commandCtx.ui.confirm("清空自选股", "确定删除全部自选股票？"))) return;
    const symbols = verb === "clear" ? [] : parseSymbols(input);
    this.prefs = await this.persist(p => {
      p.symbols = verb === "clear" ? [] : verb === "set" ? symbols : verb === "add" ? [...new Set([...p.symbols, ...symbols])] : p.symbols.filter(s => !symbols.includes(s));
    });
    if (this.stopped) return;
    this.earnings?.setWatchlist(this.prefs.symbols);
    if (this.state.category === "自选") {
      this.version++; this.state.symbols = [...this.prefs.symbols]; this.redraw();
      if (this.heatmapNeeded()) { void this.refresh(); if (this.state.weight === "cap") { this.capController?.abort(); this.loadCaps(); } }
    }
    commandCtx.ui.notify(`自选股已保存（${this.prefs.symbols.length}）：${this.prefs.symbols.join(", ") || "（空）"}\n代码格式已校验；是否有行情由 Massive 返回结果决定。`, "info");
  }
  async openEarnings(args: string, commandCtx: ExtensionCommandContext): Promise<void> {
    await this.ensure();
    if (this.stopped) return;
    if (!this.earnings) { commandCtx.ui.notify(this.initializationError || "财报数据初始化失败。", "error"); return; }
    let input = args.trim();
    if (!input) {
      const picked = await commandCtx.ui.select("财报日期（按美东组织视图）", ["今天", "明天", "本周", "指定日期…"], { signal: this.lifetime.signal });
      if (!picked || this.stopped) return;
      input = picked === "指定日期…" ? (await commandCtx.ui.input("输入财报日期 YYYY-MM-DD", newYorkDate(), { signal: this.lifetime.signal }))?.trim() ?? "" : picked;
      if (!input || this.stopped) return;
    }
    const range = resolveEarningsRange(input);
    this.heatmap?.dispose(); this.heatmap = undefined;
    if (!this.focusOpen) this.capController?.abort();
    this.slot = "earnings";
    if (!this.focusOpen && !this.tickerEnabled() && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.earnings.setWatchlist(this.prefs.symbols);
    this.earnings.activate(range);
    this.ctx.ui.setWidget(HEATMAP_KEY, (tui, theme) => {
      const widget = new EarningsWidget(tui, theme, () => this.earnings!.state);
      this.earningsWidget = widget;
      return widget;
    }, { placement: "aboveEditor" });
  }
  closeEarnings(): void {
    if (this.slot !== "earnings") return;
    this.slot = undefined; this.earnings?.deactivate();
    this.earningsWidget?.dispose(); this.earningsWidget = undefined;
    this.ctx.ui.setWidget(HEATMAP_KEY, undefined);
  }
  async earningsMode(args: string, commandCtx: ExtensionCommandContext): Promise<void> {
    await this.ensure();
    const value = args.trim().toLowerCase() || await commandCtx.ui.select("财报颜色口径", ["eps", "price"], { signal: this.lifetime.signal });
    if (!value || this.stopped) return;
    const modes: Record<string, EarningsMode> = { eps: "eps", price: "price", "超预期": "eps", "涨跌幅": "price" };
    if (!modes[value]) { commandCtx.ui.notify("用法：/stock-earnings-mode eps|price（price 不是财报后反应）。", "info"); return; }
    this.earnings?.setMode(modes[value]);
    if (this.slot !== "earnings") commandCtx.ui.notify("口径已切换；/stock-earnings 打开财报热图。", "info");
  }
  async earningsScope(args: string, commandCtx: ExtensionCommandContext): Promise<void> {
    await this.ensure();
    const value = args.trim().toLowerCase() || await commandCtx.ui.select("财报股票池", ["all", "indices", "watchlist"], { signal: this.lifetime.signal });
    if (!value || this.stopped) return;
    const scopes: Record<string, EarningsScope> = { all: "all", indices: "indices", watchlist: "watchlist", "全部": "all", "指数": "indices", "自选": "watchlist" };
    if (!scopes[value]) { commandCtx.ui.notify("用法：/stock-earnings-scope all|indices|watchlist", "info"); return; }
    this.earnings?.setScope(scopes[value]);
    if (this.slot !== "earnings") commandCtx.ui.notify("股票池已切换；/stock-earnings 打开财报热图。", "info");
  }
  async refreshEarnings(commandCtx: ExtensionCommandContext): Promise<void> {
    await this.ensure();
    if (this.slot !== "earnings") { commandCtx.ui.notify("请先用 /stock-earnings 打开财报热图。", "info"); return; }
    this.earnings?.refresh(true);
    commandCtx.ui.notify("已请求刷新财报日历；完成后原位更新，不占用输入框。", "info");
  }
  async detailsEarnings(args: string, commandCtx: ExtensionCommandContext): Promise<void> {
    await this.ensure();
    if (!this.earnings) { commandCtx.ui.notify(this.initializationError || "财报数据未初始化。", "error"); return; }
    const symbols = args.trim() ? parseSymbols(args) : [];
    commandCtx.ui.notify(earningsDetails(this.earnings.state, symbols), "info");
  }
  async toggleTicker(args: string, commandCtx: ExtensionCommandContext): Promise<void> {
    await this.ensure();
    const action = args.trim().toLowerCase();
    if (action === "status") {
      const rows = [...INDEX_ETFS, "VIX"].map(symbol => {
        const q = symbol === "VIX" ? this.market.vix : this.market.quotes.get(symbol);
        return `${symbol} ${q?.price?.toFixed(2) ?? "—"} ${percent(q?.change)} · ${q?.source === "daily" ? q.sessionDate + " 日线收盘（非实时）" : timeLabel(q?.timestamp)}`;
      });
      commandCtx.ui.notify(`大盘行情：${this.tickerEnabled() ? "已开启" : "已关闭"}\n${rows.join("\n")}\n${this.market.error || "股票行情接口正常"}\nVIX：${this.market.vixError || (this.market.vix ? "已有指数数据" : "等待行情")}\nSPY / QQQ / DIA / IWM 为 ETF 报价，VIX 为独立指数；实时性取决于套餐。`, "info");
      return;
    }
    if (!["on", "off", ""].includes(action)) { commandCtx.ui.notify("用法：/stock-ticker on|off|status", "info"); return; }
    this.prefs = await this.persist(p => { p.ticker = action ? action === "on" : !p.ticker; });
    if (this.stopped) return;
    this.attachTicker();
    if (this.tickerEnabled()) void this.refresh(); else if (!this.heatmapNeeded() && this.timer) clearTimeout(this.timer);
    commandCtx.ui.notify(this.tickerEnabled() ? "底部滚动行情已开启（独立 widget，不覆盖原 Footer）。" : "底部滚动行情已关闭。", "info");
  }
  async dispose(): Promise<void> {
    if (this.stopped) { await Promise.allSettled([...this.preferenceWrites, ...this.capWrites]); return; }
    this.stopped = true;
    this.lifetime.abort(); this.earnings?.dispose(); this.earningsWidget?.dispose(); this.client?.dispose(); this.capController?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.pickerDone?.(); this.focusDone?.();
    this.view?.dispose(); this.heatmap?.dispose(); this.ticker?.dispose();
    this.ctx.ui.setWidget(HEATMAP_KEY, undefined);
    this.ctx.ui.setWidget(WIDGET_KEY, undefined);
    await Promise.allSettled([...this.preferenceWrites, ...this.capWrites]);
  }
}

export default function stockHeatmap(pi: ExtensionAPI): void {
  let runtime: StockRuntime | undefined;
  const getRuntime = (ctx: ExtensionContext): StockRuntime => runtime ??= new StockRuntime(ctx);
  const guard = (handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>) => async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      const message = "股票热力图需要 Pi 交互式终端。\n" + HELP;
      if (ctx.hasUI) ctx.ui.notify(message, "info"); else process.stderr.write(message + "\n");
      return;
    }
    try { await handler(args, ctx); }
    catch (e) { ctx.ui.notify(e instanceof Error && !(e instanceof MarketError) ? e.message : safeError(e), "error"); }
  };
  pi.registerCommand("stock-heatmap", {
    description: "在输入框上方展示热图，不抢焦点；无参数搜索选择类别",
    getArgumentCompletions: prefix => CATEGORIES.filter(c => c.toLowerCase().includes(prefix.toLowerCase())).map(c => ({ value: c, label: c, description: c === "自选" ? "你的股票列表" : "股票池/板块" })),
    handler: guard(async (args, ctx) => { if (["help", "--help"].includes(args.trim())) ctx.ui.notify(HELP, "info"); else await getRuntime(ctx).open(args, ctx); }),
  });
  pi.registerCommand("stock-heatmap-close", { description: "收起热图，保留独立大盘行情条", handler: guard(async (_args, ctx) => getRuntime(ctx).close()) });
  pi.registerCommand("stock-heatmap-focus", { description: "专注大图（临时接管键盘，Esc 返回输入框）", handler: guard((args, ctx) => getRuntime(ctx).focus(args, ctx)) });
  pi.registerCommand("stock-heatmap-mode", {
    description: "热图面积：成交额 / 市值 / 等权",
    getArgumentCompletions: prefix => ["成交额", "市值", "等权"].filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s })),
    handler: guard((args, ctx) => getRuntime(ctx).setMode(args, ctx)),
  });
  pi.registerCommand("stock-heatmap-refresh", { description: "请求刷新热图/大盘，不阻塞输入", handler: guard(async (_args, ctx) => getRuntime(ctx).requestRefresh(ctx)) });
  pi.registerCommand("stock-earnings", {
    description: "财报日热图：today / tomorrow / week / YYYY-MM-DD；不抢输入焦点",
    getArgumentCompletions: prefix => ["today", "tomorrow", "week"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: guard((args, ctx) => getRuntime(ctx).openEarnings(args, ctx)),
  });
  pi.registerCommand("stock-earnings-close", { description: "收起财报热图，保留 ticker", handler: guard(async (_args, ctx) => getRuntime(ctx).closeEarnings()) });
  pi.registerCommand("stock-earnings-mode", {
    description: "财报颜色：eps 超预期 / price 发布日涨跌（非财报反应）",
    getArgumentCompletions: prefix => ["eps", "price"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: guard((args, ctx) => getRuntime(ctx).earningsMode(args, ctx)),
  });
  pi.registerCommand("stock-earnings-scope", {
    description: "财报范围：all Finnhub美股日历 / indices 指数成分 / watchlist 自选",
    getArgumentCompletions: prefix => ["all", "indices", "watchlist"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: guard((args, ctx) => getRuntime(ctx).earningsScope(args, ctx)),
  });
  pi.registerCommand("stock-earnings-refresh", { description: "强制刷新当前财报日历", handler: guard(async (_args, ctx) => getRuntime(ctx).refreshEarnings(ctx)) });
  pi.registerCommand("stock-earnings-details", { description: "财报明细和覆盖状态，可指定 SYMBOL", handler: guard((args, ctx) => getRuntime(ctx).detailsEarnings(args, ctx)) });
  pi.registerCommand("stock-add", { description: "批量添加自选股，如 META,TSLA,NVDA", handler: guard((args, ctx) => getRuntime(ctx).editWatchlist("add", args, ctx)) });
  pi.registerCommand("stock-remove", { description: "批量删除自选股，如 META TSLA", handler: guard((args, ctx) => getRuntime(ctx).editWatchlist("remove", args, ctx)) });
  pi.registerCommand("stock-watchlist", {
    description: "自选股 list / add / remove / set / clear",
    getArgumentCompletions: prefix => ["list", "add", "remove", "set", "clear"].filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s })),
    handler: guard(async (args, ctx) => { const match = /^\s*(\S+)?\s*([\s\S]*)$/.exec(args)!; await getRuntime(ctx).editWatchlist(match[1] ?? "list", match[2], ctx); }),
  });
  pi.registerCommand("stock-ticker", {
    description: "开关底部 SPY / QQQ / DIA / IWM / VIX 滚动行情",
    getArgumentCompletions: prefix => ["on", "off", "status"].filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s })),
    handler: guard((args, ctx) => getRuntime(ctx).toggleTicker(args, ctx)),
  });
  pi.on("session_start", async (_event, ctx) => {
    await runtime?.dispose(); runtime = undefined;
    if (ctx.mode === "tui") await getRuntime(ctx).start();
  });
  pi.on("session_shutdown", async () => { await runtime?.dispose(); runtime = undefined; });
}
