import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, sliceByColumn, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { amount, infoFor, orderedCategories, percent, sectorOf, type Category, type Quote } from "./core.ts";

export type WeightMode = "turnover" | "cap" | "equal";
export interface HeatmapState {
  category: Category; symbols: string[]; quotes: Map<string, Quote>;
  caps: Record<string, { value: number; at: number }>;
  usage: Record<string, number>; loading: boolean; error: string;
  fetchedAt?: number; capStatus: string; weight: WeightMode; revision?: number;
}
export interface Rect<T> { x: number; y: number; w: number; h: number; item: T }
interface Weighted { weight: number }
export interface TreemapTile extends Weighted { symbol: string; sector: string; quote?: Quote; members?: number; id?: string; value?: number; labelLines?: string[]; detailMinRows?: number }
type Tile = TreemapTile;
interface Group extends Weighted { name: string; children: Tile[] }
interface FloatRect { x: number; y: number; w: number; h: number }

// Squarified treemap 在物理尺寸上布局，再映射为终端字符格（行高约为列宽的两倍）。
export function squarify<T extends Weighted>(items: T[], width: number, height: number, x = 0, y = 0): Rect<T>[] {
  const valid = items.filter(i => Number.isFinite(i.weight) && i.weight > 0).sort((a, b) => b.weight - a.weight);
  if (!valid.length || width < 1 || height < 1) return [];
  const total = valid.reduce((sum, item) => sum + item.weight, 0);
  let box: FloatRect = { x, y: y * 2, w: width, h: height * 2 };
  const nodes = valid.map(item => ({ item, area: item.weight / total * width * height * 2 }));
  type Node = typeof nodes[number];
  let row: Node[] = [];
  const out: Rect<T>[] = [];
  const worst = (r: Node[], side: number): number => {
    if (!r.length || side <= 0) return Infinity;
    const sum = r.reduce((n, a) => n + a.area, 0);
    return Math.max(side * side * Math.max(...r.map(n => n.area)) / (sum * sum), sum * sum / (side * side * Math.min(...r.map(n => n.area))));
  };
  const place = (r: Node[], last: boolean): void => {
    const sum = r.reduce((n, a) => n + a.area, 0);
    const vertical = box.w >= box.h;
    const strip = vertical ? (last ? box.w : sum / box.h) : (last ? box.h : sum / box.w);
    let offset = vertical ? box.y : box.x;
    for (let i = 0; i < r.length; i++) {
      const node = r[i];
      const length = i === r.length - 1 ? (vertical ? box.y + box.h : box.x + box.w) - offset : node.area / strip;
      const a = vertical ? { x: box.x, y: offset, w: strip, h: length } : { x: offset, y: box.y, w: length, h: strip };
      const x0 = Math.round(a.x), x1 = Math.round(a.x + a.w), y0 = Math.round(a.y / 2), y1 = Math.round((a.y + a.h) / 2);
      if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, item: node.item });
      offset += length;
    }
    box = vertical ? { ...box, x: box.x + strip, w: Math.max(0, box.w - strip) } : { ...box, y: box.y + strip, h: Math.max(0, box.h - strip) };
  };
  for (const node of nodes) {
    const side = Math.min(box.w, box.h);
    if (row.length && worst([...row, node], side) > worst(row, side)) { place(row, false); row = []; }
    row.push(node);
  }
  if (row.length) place(row, true);
  return out;
}
export function fit(text: string, width: number): string {
  const trimmed = truncateToWidth(text, Math.max(0, width), "");
  return trimmed + " ".repeat(Math.max(0, width - visibleWidth(trimmed)));
}
// 固定 ±10% 连续色阶；低涨跌幅也有细腻变化，±3% 以上不再全部挤成同一种颜色。
const COLOR_STOPS = [0, 0.25, 0.7, 1.5, 3, 6, 10];
const UP = ["#29333d", "#254b42", "#23654d", "#21825b", "#209c67", "#29b87c", "#42cc94"];
const DOWN = ["#29333d", "#56323c", "#773743", "#a53745", "#cc3f50", "#e45a65", "#f5787d"];
export const CHART_BACKGROUND = "#101722";
export function color(change?: number): string {
  if (change === undefined || !Number.isFinite(change)) return "#424753";
  const n = Math.min(10, Math.abs(change));
  const palette = change < 0 ? DOWN : UP;
  let index = 1;
  while (index < COLOR_STOPS.length - 1 && n > COLOR_STOPS[index]) index++;
  const t = (n - COLOR_STOPS[index - 1]) / (COLOR_STOPS[index] - COLOR_STOPS[index - 1]);
  const a = Number.parseInt(palette[index - 1].slice(1), 16), b = Number.parseInt(palette[index].slice(1), 16);
  const channel = (shift: number): string => Math.round((a >> shift & 255) * (1 - t) + (b >> shift & 255) * t).toString(16).padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}
function background(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[48;2;${n >> 16};${n >> 8 & 255};${n & 255}m`;
}
function foreground(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${n >> 16};${n >> 8 & 255};${n & 255}m`;
}
function contrast(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const linear = (c: number): number => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const luminance = linear(n >> 16) * 0.2126 + linear(n >> 8 & 255) * 0.7152 + linear(n & 255) * 0.0722;
  return luminance > 0.25 ? "#10251f" : "#f5f8ff";
}
export function swatch(text: string, change: number): string {
  const bg = color(change);
  return `${background(bg)}${foreground(contrast(bg))} ${text} \x1b[0m`;
}
export function timeLabel(timestamp?: number): string {
  return timestamp === undefined ? "时间未知" : new Date(timestamp).toLocaleString("zh-CN", { timeZone: "America/New_York", hour12: false }) + " ET";
}
function tilesFor(state: HeatmapState, sector?: string): Tile[] {
  return state.symbols.map(symbol => {
    const quote = state.quotes.get(symbol);
    const weight = state.weight === "equal" ? 1 : state.weight === "cap" ? state.caps[symbol]?.value ?? 0 : quote?.turnover ?? 0;
    return { symbol, sector: sectorOf(infoFor(symbol)), weight, quote, value: quote?.change, detailMinRows: 5 };
  }).filter(t => !sector || t.sector === sector).sort((a, b) => b.weight - a.weight || a.symbol.localeCompare(b.symbol));
}
function modeLabel(mode: WeightMode): string { return mode === "cap" ? "市值 USD" : mode === "equal" ? "等权" : "成交额（非市值）"; }
function legend(): string {
  return `${swatch("−10", -10)}${swatch("−3", -3)}${swatch("−1", -1)}${swatch("0", 0)}${swatch("+1", 1)}${swatch("+3", 3)}${swatch("+10%", 10)} 灰=无数据 · +N=合并小格`;
}
function statusLine(state: HeatmapState): string {
  const daily = state.symbols.map(symbol => state.quotes.get(symbol)).find(q => q?.source === "daily");
  if (state.error && !state.error.startsWith("快照重置/无报价")) return state.error;
  if (daily) return `${daily.sessionDate} 日线收盘 · 非实时${state.loading ? " · 更新中" : ""}`;
  const stamps = state.symbols.flatMap(symbol => { const t = state.quotes.get(symbol)?.timestamp; return t ? [t] : []; });
  const latest = stamps.length ? Math.max(...stamps) : undefined;
  return `${state.loading ? "更新中 · " : ""}${timeLabel(latest)} · ${latest && Date.now() - latest > 20 * 60000 ? "较旧/可能已休市" : "实时或延迟依套餐"}`;
}

export interface ChartResult { lines: string[]; stocks: Rect<Tile>[]; named: number; total: number }
// 所有股票格都预留右侧一列、底部一行分隔；小到无法容纳标签的尾部合并，面积总权重保持不变。
function packTiles(tiles: Tile[], width: number, height: number, x: number, y: number): Rect<Tile>[] {
  let count = tiles.length;
  while (count >= 0) {
    const omitted = tiles.length - count;
    const packed = tiles.slice(0, count);
    if (omitted) packed.push({ symbol: `+${omitted}`, sector: tiles[0].sector, weight: tiles.slice(count).reduce((sum, t) => sum + t.weight, 0), members: omitted });
    const rects = squarify(packed, width, height, x, y);
    if (packed.length <= 1 || (rects.length === packed.length && rects.every(r => {
      const valueLabel = r.item.labelLines?.[1] ?? percent(r.item.value).replace("—", "N/A");
      return r.w >= Math.max(7, Math.min(16, Math.max(r.item.symbol.length, valueLabel.length) + 1)) && r.h >= 3;
    }))) return rects;
    count--;
  }
  return [];
}
export function renderTreemap(state: HeatmapState, width: number, height: number, selected?: string, sector?: string): ChartResult {
  return renderTreemapTiles(tilesFor(state, sector), width, height, selected);
}
export function renderTreemapTiles(input: TreemapTile[], width: number, height: number, selected?: string, mapColor: (value?: number) => string = color, emptyMessage = " 暂无数据 · 等待行情或改用等权模式"): ChartResult {
  const tiles = input.filter(t => Number.isFinite(t.weight) && t.weight > 0);
  const empty = (): string[] => Array.from({ length: height }, (_, row) => `${background(CHART_BACKGROUND)}${foreground("#91a1b8")}${fit(row === Math.floor(height / 2) ? emptyMessage : "", width)}\x1b[0m`);
  if (!tiles.length || width < 2 || height < 2) return { lines: empty(), stocks: [], named: 0, total: tiles.length };
  const chars = Array.from({ length: height }, () => Array<string>(width).fill(" "));
  const bgs = Array.from({ length: height }, () => Array<string>(width).fill(CHART_BACKGROUND));
  const fgs = Array.from({ length: height }, () => Array<string>(width).fill("#f5f8ff"));
  const stocks: Rect<Tile>[] = [];
  const paint = (r: { x: number; y: number; w: number; h: number }, bg: string): void => {
    for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.h); y++) for (let x = Math.max(0, r.x); x < Math.min(width, r.x + r.w); x++) bgs[y][x] = bg;
  };
  const text = (x: number, y: number, value: string, max: number, fg: string): void => {
    if (y < 0 || y >= height) return;
    // 标签为 ASCII / 单列框线；中文说明由外层 visibleWidth 安全裁剪。
    const label = value.slice(0, Math.max(0, max));
    for (let i = 0; i < label.length && x + i < width; i++) if (x + i >= 0) { chars[y][x + i] = label[i]; fgs[y][x + i] = fg; }
  };
  const grouped = new Map<string, Tile[]>();
  for (const tile of tiles) { const group = grouped.get(tile.sector) ?? []; group.push(tile); grouped.set(tile.sector, group); }
  const groups: Group[] = [...grouped].map(([name, children]) => ({ name, children, weight: children.reduce((sum, tile) => sum + tile.weight, 0) }));
  for (const group of squarify(groups, width, height)) {
    const header = groups.length > 1 && group.h >= 5 && group.w >= 12 ? 1 : 0;
    if (header) {
      paint({ ...group, w: group.w - 1, h: 1 }, "#223044");
      text(group.x + 1, group.y, group.item.name.toUpperCase(), group.w - 2, "#b7cde3");
    }
    for (const tile of packTiles(group.item.children, group.w, group.h - header, group.x, group.y + header)) {
      const tw = Math.max(0, tile.w - 1), th = Math.max(0, tile.h - 1);
      if (tw < 1 || th < 1) continue;
      const aggregate = tile.item.members !== undefined;
      const bg = aggregate ? "#293342" : mapColor(tile.item.value);
      const fg = contrast(bg);
      paint({ ...tile, w: tw, h: th }, bg);
      const outlined = !aggregate && tile.item.symbol === selected && tw >= 5 && th >= 3;
      if (outlined) {
        const edge = "#9de7ff";
        text(tile.x, tile.y, "┌" + "─".repeat(tw - 2) + "┐", tw, edge);
        text(tile.x, tile.y + th - 1, "└" + "─".repeat(tw - 2) + "┘", tw, edge);
        for (let y = tile.y + 1; y < tile.y + th - 1; y++) { text(tile.x, y, "│", 1, edge); text(tile.x + tw - 1, y, "│", 1, edge); }
      }
      const pad = outlined ? 1 : 0, innerWidth = tw - pad * 2, innerHeight = th - pad * 2;
      const labels = tile.item.labelLines ?? [tile.item.symbol, percent(tile.item.value).replace("—", "N/A"), tile.item.quote?.price === undefined ? "N/A" : `$${tile.item.quote.price.toFixed(2)}`];
      const lines = [tile.item.symbol];
      if (!aggregate && innerHeight >= 2 && innerWidth >= 6 && labels[1]) lines.push(labels[1]);
      if (!aggregate && innerHeight >= (tile.item.detailMinRows ?? 3) && innerWidth >= 8) lines.push(...labels.slice(2, Math.min(labels.length, innerHeight)));
      const firstY = tile.y + pad + Math.max(0, Math.floor((innerHeight - lines.length) / 2));
      for (let i = 0; i < lines.length; i++) {
        const label = lines[i];
        if (label.length <= innerWidth && firstY + i < tile.y + th - pad) text(tile.x + pad + Math.floor((innerWidth - label.length) / 2), firstY + i, label, innerWidth, tile.item.symbol === selected ? "#b8efff" : fg);
      }
      if (!aggregate && innerWidth >= tile.item.symbol.length) stocks.push(tile);
    }
  }
  const lines = chars.map((row, y) => {
    let output = "", lastBG = "", lastFG = "";
    for (let x = 0; x < width; x++) {
      const bg = bgs[y][x], fg = fgs[y][x];
      if (bg !== lastBG) { output += background(bg); lastBG = bg; }
      if (fg !== lastFG) { output += foreground(fg); lastFG = fg; }
      output += row[x];
    }
    return output + "\x1b[0m";
  });
  return { lines, stocks, named: stocks.length, total: tiles.length };
}

/** 正常展示不实现 handleInput，也不画选股标记，焦点始终留在 Pi 编辑器。 */
export class HeatmapWidget implements Component {
  private disposed = false;
  private cache?: { key: string; chart: ChartResult };
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly state: () => HeatmapState;
  constructor(tui: TUI, theme: Theme, state: () => HeatmapState) { this.tui = tui; this.theme = theme; this.state = state; }
  invalidate(): void { this.cache = undefined; }
  redraw(): void { if (!this.disposed) { this.invalidate(); this.tui.requestRender(); } }
  render(width: number): string[] {
    const w = Math.max(0, Math.floor(width)), rows = this.tui.terminal.rows, s = this.state();
    // 总行数只用约半屏；保守预留对话、编辑器、多行输入及其他扩展的空间。
    const budget = Math.max(1, Math.min(28, Math.floor((rows - 10) * 0.55)));
    if (budget < 7 || w < 40) return [truncateToWidth(` ▦ ${s.category} · ${statusLine(s)} · /stock-heatmap-focus 放大`, w, "")];
    const h = budget - 4;
    const key = `${w}:${h}:${s.revision ?? s.fetchedAt}:${s.category}:${s.weight}:${s.symbols.length}:${Object.keys(s.caps).length}`;
    if (this.cache?.key !== key) this.cache = { key, chart: renderTreemap(s, w, h) };
    const chart = this.cache.chart;
    const lines = [
      this.theme.fg("accent", ` ▦ ${s.category}`) + this.theme.fg("muted", `  · 面积=${modeLabel(s.weight)} · 具名 ${chart.named}/${s.symbols.length}`),
      ...chart.lines,
      " " + legend(),
      this.theme.fg(s.error ? "warning" : "dim", ` ${statusLine(s)}${s.weight === "cap" ? " · " + s.capStatus : ""}`),
      this.theme.fg("muted", " 可继续在下方输入 · /stock-heatmap-close 收起 · /stock-heatmap 换类别 · /stock-heatmap-focus 大图"),
    ];
    return lines.map(line => truncateToWidth(line, w, ""));
  }
  dispose(): void { this.disposed = true; this.cache = undefined; }
}

/** 使用 Pi 原生 Input，正确传播焦点与 IME 光标；选择完成后由宿主恢复编辑器焦点。 */
export class CategoryPicker implements Component, Focusable {
  private readonly input = new Input({ prompt: " 搜索 › ", placeholder: "输入类别名称（也可直接上下选择）" });
  private cursor = 0;
  private _focused = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly categories: Category[];
  private readonly done: (value: Category | undefined) => void;
  constructor(tui: TUI, theme: Theme, usage: Record<string, number>, done: (value: Category | undefined) => void) {
    this.tui = tui; this.theme = theme; this.categories = orderedCategories(usage); this.done = done;
    this.input.onSubmit = () => { const option = this.options()[this.cursor]; if (option) this.done(option); };
    this.input.onEscape = () => this.done(undefined);
  }
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }
  private options(): Category[] { return this.categories.filter(c => c.toLowerCase().includes(this.input.getValue().toLowerCase())); }
  invalidate(): void { this.input.invalidate(); }
  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.down)) this.cursor = Math.min(this.options().length - 1, this.cursor + 1);
    else { const previous = this.input.getValue(); this.input.handleInput(data); if (previous !== this.input.getValue()) this.cursor = 0; }
    this.tui.requestRender();
  }
  render(width: number): string[] {
    const options = this.options();
    this.cursor = Math.max(0, Math.min(this.cursor, options.length - 1));
    const count = Math.max(1, Math.min(8, this.tui.terminal.rows - 7));
    const start = Math.max(0, Math.min(this.cursor - Math.floor(count / 2), options.length - count));
    const lines = [this.theme.fg("accent", " 选择热图类别 · 确认后回到命令输入框"), ...this.input.render(width)];
    for (let i = start; i < Math.min(options.length, start + count); i++) {
      const line = ` ${i === this.cursor ? "›" : " "} ${options[i]}`;
      lines.push(this.theme.fg(i === this.cursor ? "accent" : "muted", line));
    }
    if (!options.length) lines.push(this.theme.fg("dim", " 无匹配类别"));
    lines.push(this.theme.fg("dim", ` ↑↓ 选择 · Enter 确认 · Esc 取消 · ${options.length} 项`));
    return lines.slice(0, Math.max(1, this.tui.terminal.rows - 1)).map(line => truncateToWidth(line, Math.max(0, width), ""));
  }
}

/** 专注模式才接管按键；选中项用明确的框线，不再使用类似输入光标的 > 标记。 */
export class HeatmapView implements Component, Focusable {
  private disposed = false;
  private _focused = false;
  private picker?: CategoryPicker;
  private selected?: string;
  private sector?: string;
  private chart?: ChartResult;
  private cacheKey = "";
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly state: () => HeatmapState;
  private readonly choose: (category: Category) => void;
  private readonly refresh: () => void;
  private readonly setWeight: (mode: WeightMode) => void;
  private readonly done: () => void;
  constructor(tui: TUI, theme: Theme, state: () => HeatmapState, choose: (category: Category) => void,
    refresh: () => void, setWeight: (mode: WeightMode) => void, done: () => void) {
    this.tui = tui; this.theme = theme; this.state = state; this.choose = choose; this.refresh = refresh; this.setWeight = setWeight; this.done = done;
  }
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; if (this.picker) this.picker.focused = value; }
  invalidate(): void { this.cacheKey = ""; this.picker?.invalidate(); }
  redraw(): void { if (!this.disposed) { this.invalidate(); this.tui.requestRender(); } }
  handleInput(data: string): void {
    if (this.picker) { this.picker.handleInput(data); return; }
    if (matchesKey(data, Key.escape) || data === "q") { this.done(); return; }
    if (data === "c" || matchesKey(data, Key.tab)) {
      this.picker = new CategoryPicker(this.tui, this.theme, this.state().usage, value => {
        this.picker = undefined;
        if (value) { this.choose(value); this.selected = undefined; this.sector = undefined; }
        this.redraw();
      });
      this.picker.focused = this.focused;
    } else if (data === "r") this.refresh();
    else if (data === "m" || data === "v" || data === "e") { this.setWeight(data === "m" ? "cap" : data === "v" ? "turnover" : "equal"); this.selected = undefined; }
    else if (matchesKey(data, Key.enter) && this.selected) { this.sector = sectorOf(infoFor(this.selected)); this.selected = undefined; }
    else if (matchesKey(data, Key.backspace)) { this.sector = undefined; this.selected = undefined; }
    else {
      const direction = matchesKey(data, Key.left) ? [-1, 0] : matchesKey(data, Key.right) ? [1, 0] : matchesKey(data, Key.up) ? [0, -1] : matchesKey(data, Key.down) ? [0, 1] : undefined;
      if (direction) this.move(direction[0], direction[1]);
    }
    this.redraw();
  }
  private move(dx: number, dy: number): void {
    const stocks = this.chart?.stocks ?? [];
    const current = stocks.find(r => r.item.symbol === this.selected);
    if (!current) { this.selected = stocks[0]?.item.symbol; return; }
    const cx = current.x + current.w / 2, cy = (current.y + current.h / 2) * 2;
    const next = stocks.filter(r => r !== current).map(r => {
      const x = r.x + r.w / 2 - cx, y = (r.y + r.h / 2) * 2 - cy;
      const forward = x * dx + y * dy;
      const sideways = Math.abs(x * dy - y * dx);
      return { rect: r, score: forward > 0 ? Math.hypot(x, y) + sideways * 2 : Infinity };
    }).sort((a, b) => a.score - b.score)[0];
    if (next && Number.isFinite(next.score)) this.selected = next.rect.item.symbol;
  }
  render(width: number): string[] {
    const w = Math.max(0, Math.floor(width)), rows = Math.max(1, this.tui.terminal.rows - 2);
    if (this.picker) return this.picker.render(w);
    if (w < 40 || rows < 10) return [truncateToWidth("终端较小 · Esc 返回输入框", w, "")];
    const s = this.state(), h = rows - 5;
    const key = `${w}:${h}:${s.revision ?? s.fetchedAt}:${s.category}:${s.weight}:${s.symbols.length}:${Object.keys(s.caps).length}:${this.selected}:${this.sector}`;
    if (!this.chart || this.cacheKey !== key) { this.chart = renderTreemap(s, w, h, this.selected, this.sector); this.cacheKey = key; }
    const active = this.selected ? s.quotes.get(this.selected) : undefined;
    const detail = this.selected ? ` 已选 ${this.selected} · ${infoFor(this.selected).name} · $${active?.price?.toFixed(2) ?? "—"} · ${percent(active?.change)} · 市值 ${amount(s.caps[this.selected]?.value)}` : ` 方向键选择股票（蓝框/蓝字标识） · 具名 ${this.chart.named}/${this.chart.total} · Enter 板块下钻`;
    return [
      this.theme.fg("accent", ` ▦ ${s.category}${this.sector ? " / " + this.sector : ""} · 专注模式`) + this.theme.fg("muted", ` · 面积=${modeLabel(s.weight)} · Esc 返回输入框`),
      ...this.chart.lines,
      " " + legend(),
      this.theme.fg("muted", detail),
      this.theme.fg(s.error ? "warning" : "dim", ` ${statusLine(s)}${s.weight === "cap" ? " · " + s.capStatus : ""}`),
      this.theme.fg("accent", " Esc 返回输入框 · c 换类别 · r 刷新 · v 成交额 / m 市值 / e 等权 · ⌫ 返回全部板块"),
    ].map(line => truncateToWidth(line, w, ""));
  }
  dispose(): void { this.disposed = true; this.picker = undefined; this.chart = undefined; }
}
export interface TickerState { quotes: Map<string, Quote>; vix?: Quote; error: string; vixError: string; fetchedAt?: number }
export class MarketTicker implements Component {
  private offset = 0;
  private scrolling = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly state: () => TickerState;
  constructor(tui: TUI, theme: Theme, state: () => TickerState) {
    this.tui = tui; this.theme = theme; this.state = state;
    this.timer = setInterval(() => { if (!this.disposed && this.scrolling) { this.offset++; this.tui.requestRender(); } }, 350);
    this.timer.unref();
  }
  invalidate(): void {}
  redraw(): void { if (!this.disposed) this.tui.requestRender(); }
  render(width: number): string[] {
    if (width <= 0) return [""];
    const state = this.state();
    const quoteText = (symbol: string, q?: Quote): string => {
      const label = `${symbol} ${q?.price?.toFixed(2) ?? "—"} ${percent(q?.change)}`;
      return this.theme.fg(q?.change === undefined ? "muted" : q.change > 0 ? "success" : q.change < 0 ? "error" : "muted", label);
    };
    const parts = ["SPY", "QQQ", "DIA", "IWM"].map(symbol => quoteText(symbol, state.quotes.get(symbol)));
    const vixAge = state.vix?.timestamp === undefined ? "（时间未知）" : Date.now() - state.vix.timestamp > 20 * 60000 ? "（旧）" : "";
    parts.push(state.vix?.price !== undefined ? quoteText("VIX", state.vix) + this.theme.fg("dim", vixAge) : this.theme.fg("muted", /403|401/.test(state.vixError) ? "VIX —（无指数权限）" : "VIX —"));
    const daily = ["SPY", "QQQ", "DIA", "IWM"].map(symbol => state.quotes.get(symbol)).find(q => q?.source === "daily");
    const stamps = ["SPY", "QQQ", "DIA", "IWM"].flatMap(s => { const t = state.quotes.get(s)?.timestamp; return t ? [t] : []; });
    const latest = stamps.length ? Math.max(...stamps) : undefined;
    parts.push(this.theme.fg("dim", daily ? `ETF ${daily.sessionDate} 收盘 · 非实时` : `ETF 最新 ${timeLabel(latest)} · 实时/延迟依套餐`));
    if (state.error && !state.error.startsWith("快照重置/无报价")) parts.push(this.theme.fg("warning", "更新异常 · /stock-ticker status 查看"));
    const prefix = this.theme.fg("accent", " 大盘 › ");
    const prefixWidth = visibleWidth(prefix), available = Math.max(0, width - prefixWidth);
    if (available < 1) { this.scrolling = false; return [fit(prefix, width)]; }
    const content = parts.join(this.theme.fg("dim", "   │   "));
    if (visibleWidth(content) <= available) {
      this.scrolling = false;
      return [prefix + fit(content, available) + "\x1b[0m"];
    }
    this.scrolling = true;
    const source = content + "        ";
    const period = visibleWidth(source), start = this.offset % period;
    const copies = Math.ceil((start + available) / period) + 1;
    return [prefix + fit(sliceByColumn(source.repeat(copies), start, available, true), available) + "\x1b[0m"];
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; clearInterval(this.timer); }
}
