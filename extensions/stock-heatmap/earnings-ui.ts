import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { STOCKS, amount, percent } from "./core.ts";
import { epsSurprise, eventStatus, hasActual, newYorkDate, visibleEarnings, type EarningsEvent, type EarningsScope, type EarningsState } from "./earnings.ts";
import { color, renderTreemapTiles, swatch, timeLabel, type ChartResult, type TreemapTile } from "./ui.ts";

const HOURS = { bmo: "BMO", amc: "AMC", dmh: "INTRA", unknown: "TBD" };
const HOUR_NAMES = { bmo: "盘前", amc: "盘后", dmh: "盘中", unknown: "时间未定" };
export function scopeLabel(scope: EarningsScope): string { return scope === "all" ? "Finnhub US 日历" : scope === "indices" ? "S&P 500 ∪ Nasdaq 100" : "自选代码"; }
export function earningsTiles(state: EarningsState, now = new Date()): TreemapTile[] {
  const today = newYorkDate(now), week = state.range.from !== state.range.to;
  const watchlist = new Set(state.watchlist);
  const priority = (symbol: string): number => watchlist.has(symbol) ? 0 : STOCKS.has(symbol) ? 1 : 2;
  return visibleEarnings(state).sort((a, b) => a.date.localeCompare(b.date) || priority(a.symbol) - priority(b.symbol) || a.symbol.localeCompare(b.symbol)).map(event => {
    const eligible = hasActual(event, today), price = state.prices.get(event.id);
    const value = !eligible ? undefined : state.mode === "eps" ? epsSurprise(event) : price?.date === event.date ? price.change : undefined;
    const unavailable = event.date > today ? "UPCOMING" : !eligible ? "PENDING" : state.mode === "eps" ? eventStatus(event, today) : "NO PRICE";
    const detail = state.mode === "eps" ? `A:${event.epsActual ?? "-"} E:${event.epsEstimate ?? "-"}` : price ? `$${price.price.toFixed(2)}` : "N/A";
    return { id: event.id, symbol: event.symbol, sector: `${week ? event.date.slice(5) + " " : ""}${HOURS[event.hour]}`, weight: 1, value,
      labelLines: [event.symbol, value === undefined ? unavailable : Math.abs(value) >= 10000 ? `${value >= 0 ? "+" : ""}${value.toExponential(1)}%` : percent(value), `${event.date.slice(5)} ${HOURS[event.hour]}`, detail], detailMinRows: 3 };
  });
}
export function earningsDetails(state: EarningsState, symbols: string[] = [], now = new Date()): string {
  const today = newYorkDate(now), wanted = new Set(symbols);
  const all = visibleEarnings(state).filter(event => !wanted.size || wanted.has(event.symbol));
  const lines = [
    `财报日历：${state.range.label}（按 America/New_York 组织视图）`,
    `范围：${scopeLabel(state.scope)} · ${all.length} 个事件 · 等面积 · 颜色=${state.mode === "eps" ? "EPS 超预期（±100% 色阶）" : "发布日股价涨跌（±10% 色阶）"}`,
    `日历接收时间：${state.calendarAt ? new Date(state.calendarAt).toLocaleString("zh-CN") : "尚未完整取得"}`,
    "来源：Finnhub international=false；不是全美股完整性或上市类型认证，日期可能调整；EPS/营收采用供应商调整口径。",
    "EPS%=（实际−预期）/abs(预期)×100；预期为零不计算百分比，实际为零是有效数据。未来日期、实际值未返回均不着色。",
    "股价=发布日相对上一交易日涨跌，历史为常规收盘，当天可能含可用盘后价；不是公告后的事件收益。盘后财报当天常规收盘可能在公告之前。",
  ];
  if (state.calendarError) lines.push("日历错误：" + state.calendarError);
  if (state.priceError) lines.push("行情错误：" + state.priceError);
  lines.push(...state.warnings.map(warning => "提示：" + warning));
  if (!all.length) lines.push("当前范围本次未返回匹配记录；不等于当天一定没有财报。");
  for (const event of all.slice(0, 100)) {
    const price = state.prices.get(event.id);
    const status = event.date > today ? "未来日期，不着色" : hasActual(event, today) ? "已返回至少一项实际值" : "实际值未返回";
    lines.push(`\n${event.date} ${event.symbol} · ${HOUR_NAMES[event.hour]} · ${event.year ?? "?"} Q${event.quarter ?? "?"} · ${status}`);
    lines.push(`  EPS 实际 ${event.epsActual ?? "—"} / 预期 ${event.epsEstimate ?? "—"} · 超预期 ${event.date <= today ? percent(epsSurprise(event)) : "—"}`);
    lines.push(`  营收 实际 ${amount(event.revenueActual)} / 预期 ${amount(event.revenueEstimate)}`);
    lines.push(price ? `  ${price.date} ${price.kind === "close" ? "常规收盘" : "当日行情"} $${price.price.toFixed(2)} · ${percent(price.change)} · ${timeLabel(price.asOf)}${price.referenceDate ? " · 基准 " + price.referenceDate : ""}` : "  发布日行情未取得/不适用；不会拿其他日期报价替代");
  }
  if (all.length > 100) lines.push(`\n仅列出前 100/${all.length} 个事件；可用 /stock-earnings-details SYMBOL 筛选。`);
  return lines.join("\n");
}

export class EarningsWidget implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly state: () => EarningsState;
  private disposed = false;
  private cache?: { key: string; chart: ChartResult };
  constructor(tui: TUI, theme: Theme, state: () => EarningsState) { this.tui = tui; this.theme = theme; this.state = state; }
  invalidate(): void { this.cache = undefined; }
  redraw(): void { if (!this.disposed) { this.invalidate(); this.tui.requestRender(); } }
  render(width: number): string[] {
    const w = Math.max(0, Math.floor(width)), state = this.state(), now = new Date();
    const budget = Math.max(1, Math.min(28, Math.floor((this.tui.terminal.rows - 10) * 0.55)));
    const mode = state.mode === "eps" ? "EPS 超预期" : "发布日涨跌（非财报反应）";
    if (budget < 8 || w < 40) return [truncateToWidth(` ▦ 财报 ${state.range.label} · ${mode} · /stock-earnings-details 明细`, w, "")];
    const events = visibleEarnings(state), h = budget - 5;
    const counts = (hour: EarningsEvent["hour"]): number => events.filter(event => event.hour === hour).length;
    const mapColor = state.mode === "eps" ? (value?: number): string => color(value === undefined ? undefined : value / 10) : color;
    const key = `${w}:${h}:${state.revision}:${newYorkDate(now)}`;
    if (this.cache?.key !== key) this.cache = { key, chart: renderTreemapTiles(earningsTiles(state, now), w, h, undefined, mapColor, state.loadingCalendar ? " 正在获取财报日历…" : " 本次未返回匹配事件 · 可更换日期或股票池") };
    const chart = this.cache.chart;
    const scale = state.mode === "eps" ? 10 : 1;
    const palette = `${swatch(state.mode === "eps" ? "−100" : "−10", -10)}${swatch(String(-3 * scale), -3)}${swatch("0", 0)}${swatch(String(3 * scale), 3)}${swatch(state.mode === "eps" ? "+100%" : "+10%", 10)} 灰=待公布/缺失/不可算 · +N=合并`;
    let status = state.calendarError || (state.mode === "price" ? state.priceError : "");
    if (!status) status = state.loadingCalendar ? state.progress || "正在获取日历…" : state.mode === "price" && state.loadingPrices ? state.priceProgress : `日历接收 ${state.calendarAt ? new Date(state.calendarAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"} · 实际/预期可能延迟更新`;
    if (state.warnings.length) status += ` · ${state.warnings.length} 项提示，见明细`;
    return [
      this.theme.fg("accent", ` ▦ 财报 ${state.range.label}`) + this.theme.fg("muted", ` · ${mode} · 事件等面积`),
      this.theme.fg("dim", ` ${scopeLabel(state.scope)} · BMO盘前 ${counts("bmo")} / AMC盘后 ${counts("amc")} / INTRA盘中 ${counts("dmh")} / TBD待定 ${counts("unknown")} · 标注 ${chart.named}/${events.length}`),
      ...chart.lines,
      " " + palette,
      this.theme.fg(state.calendarError || state.priceError || state.warnings.length ? "warning" : "dim", " " + status),
      this.theme.fg("muted", " 可继续输入 · /stock-earnings-close 收起 · /stock-earnings-details 明细 · /stock-earnings-mode 切色"),
    ].map(line => truncateToWidth(line, w, ""));
  }
  dispose(): void { this.disposed = true; this.cache = undefined; }
}
