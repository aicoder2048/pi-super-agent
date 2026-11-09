import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import "./pi-runtime.mjs";
const { default: stockExtension } = await import("../extensions/stock-heatmap/index.ts");
const {
  CATEGORIES, UNIVERSE, MarketClient, MarketError, PreferencesStore, CapCache,
  parseSymbols, symbolsFor, resolveCategory, parseSnapshot, timestampMs, orderedCategories,
} = await import("../extensions/stock-heatmap/core.ts");
const { CategoryPicker, HeatmapWidget, HeatmapView, MarketTicker, squarify, renderTreemap, color, CHART_BACKGROUND } = await import("../extensions/stock-heatmap/ui.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

const theme = { fg: (_token, text) => text };
const config = { apiKey: "fake-test-key", baseURL: "https://api.massive.com", refreshMs: 60000, requestGapMs: 0, ticker: true };
const payload = { status: "OK", tickers: [{ ticker: "NVDA", todaysChangePerc: 2.35, day: { c: 185, v: 100000, vw: 180 }, updated: Date.now() * 1e6 }] };
const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

function setup(extension = stockExtension) {
  const commands = new Map(), events = new Map();
  extension({ registerCommand: (name, options) => commands.set(name, options), on: (name, fn) => events.set(name, fn) });
  return { commands, events };
}
function makeState(symbols = ["NVDA", "META", "JPM", "TSLA"]) {
  return { category: "自选", symbols, quotes: new Map(symbols.map((symbol, i) => [symbol, {
    symbol, price: 120 + i, change: i % 2 ? -2.1 : 1.4, turnover: 1e9 / (i + 1), timestamp: Date.now(), delayed: false,
  }])), caps: {}, usage: {}, loading: false, error: "", fetchedAt: Date.now(), capStatus: "", weight: "turnover" };
}

for (const input of ["META,TSLA,NVDA", "META TSLA NVDA", "meta，tsla；nvda", "META、TSLA|NVDA", "META\nTSLA\tNVDA"]) {
  test(`自选代码多分隔符：${JSON.stringify(input)}`, () => assert.deepEqual(parseSymbols(input), ["META", "TSLA", "NVDA"]));
}
test("去重、股类别和非法输入", () => {
  assert.deepEqual(parseSymbols("brk-b BRK.B aapl AAPL"), ["BRK.B", "AAPL"]);
  for (const input of ["", "AAPL<script>", "../.env", "I:VIX", "AAPL🚀"]) assert.throws(() => parseSymbols(input));
});
test("股票池完整、类别解析和常用顺序", () => {
  const sp = symbolsFor("S&P 500", []), nq = symbolsFor("Nasdaq 100", []);
  assert.ok(sp.length >= 500); assert.ok(nq.length >= 100);
  assert.equal(new Set(sp).size, sp.length); assert.equal(new Set(nq).size, nq.length);
  for (const symbol of ["AAPL", "NVDA", "MSFT"]) { assert.ok(sp.includes(symbol)); assert.ok(nq.includes(symbol)); }
  assert.deepEqual(symbolsFor("自选", []), []);
  for (const [input, expected] of [["S&P 500", "S&P 500"], ["sp500", "S&P 500"], ["nasdaq100", "Nasdaq 100"], ["Tech Services", "Tech Services"], ["watchlist", "自选"]]) assert.equal(resolveCategory(input), expected);
  assert.equal(resolveCategory("不存在"), undefined);
  assert.ok(symbolsFor("Electronic Tech", []).includes("NVDA"));
  assert.deepEqual(orderedCategories({ Finance: 9 }).slice(0, 4), ["自选", "S&P 500", "Nasdaq 100", "Finance"]);
  assert.equal(UNIVERSE.sources.length, 2);
});

test("偏好文件：默认列表、并发增删和文件权限", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-store-"));
  try {
    const a = new PreferencesStore(directory), b = new PreferencesStore(directory);
    await a.update(p => { p.symbols = []; });
    await Promise.all([a.update(p => p.symbols.push("META")), b.update(p => p.symbols.push("TSLA")), a.update(p => p.symbols.push("NVDA"))]);
    assert.deepEqual((await a.read()).symbols.sort(), ["META", "NVDA", "TSLA"]);
    await a.update(p => { p.symbols = p.symbols.filter(s => s !== "TSLA"); });
    assert.deepEqual((await b.read()).symbols.sort(), ["META", "NVDA"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("损坏的自选股文件不会被覆盖", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-corrupt-"));
  try {
    const store = new PreferencesStore(directory);
    await writeFile(store.path, "not-json");
    await assert.rejects(store.update(p => { p.symbols = []; }), /原文件未覆盖/);
    assert.equal(await readFile(store.path, "utf8"), "not-json");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("市值缓存原子保存及过期过滤", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-caps-"));
  try {
    const caps = new CapCache(directory); await caps.put("NVDA", 4e12);
    const next = new CapCache(directory); await next.load(); assert.equal(next.get("NVDA"), 4e12);
    await writeFile(join(directory, "market-caps.json"), JSON.stringify({ OLD: { value: 1, at: Date.now() - 9 * 86400000 }, BAD: { value: -5, at: Date.now() } }));
    const expired = new CapCache(directory); await expired.load(); assert.deepEqual(expired.values, {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("快照解析：真实涨跌、缺失和纳秒时间戳", () => {
  const [quote] = parseSnapshot(payload);
  assert.equal(quote.price, 185); assert.equal(quote.change, 2.35); assert.equal(quote.turnover, 18e6);
  assert.ok(Math.abs(quote.timestamp - Date.now()) < 2000);
  const [missing] = parseSnapshot({ status: "DELAYED", tickers: [{ ticker: "AAPL", todaysChangePerc: 0, day: {} }] });
  assert.equal(missing.price, undefined); assert.equal(missing.change, undefined); assert.equal(missing.delayed, true);
  assert.throws(() => parseSnapshot({}));
  assert.equal(timestampMs(0), undefined); assert.equal(timestampMs(Infinity), undefined);
});
test("盘后价格、昨收涨跌与行情时间保持同一口径", () => {
  const at = Date.now() - 60000;
  const [quote] = parseSnapshot({ status: "OK", tickers: [{ ticker: "NVDA", day: { c: 180, v: 100, vw: 178 }, min: { c: 190, t: at }, prevDay: { c: 175 }, todaysChangePerc: 99, updated: Date.now() * 1e6 }] });
  assert.equal(quote.price, 190); assert.ok(Math.abs(quote.change - (190 / 175 - 1) * 100) < 1e-10);
  assert.equal(quote.timestamp, at); assert.equal(quote.turnover, 17800);
});
test("每日重置零占位：真实日线回退、跨假日查找和缓存", async () => {
  const calls = []; let grouped = 0;
  const client = new MarketClient(config, async url => {
    calls.push(url);
    if (url.includes("/snapshot/")) return jsonResponse({ status: "OK", tickers: [{ ticker: "NVDA", day: { c: 0 }, updated: 0 }] });
    grouped++;
    if (grouped === 1) return jsonResponse({ status: "OK", resultsCount: 0 });
    return jsonResponse({ status: "OK", results: [{ T: "NVDA", c: grouped === 2 ? 110 : 100, v: 50, vw: 105, t: Date.now() - 86400000 }] });
  });
  try {
    const [quote] = await client.snapshots(["NVDA"]);
    assert.equal(quote.source, "daily"); assert.equal(quote.price, 110); assert.ok(Math.abs(quote.change - 10) < 1e-8);
    assert.equal(quote.turnover, 5250); assert.equal(quote.delayed, true); assert.match(quote.sessionDate, /^\d{4}-\d{2}-\d{2}$/);
    const before = grouped; await client.snapshots(["NVDA"]); assert.equal(grouped, before);
    for (const url of calls.filter(u => u.includes("/aggs/"))) {
      const day = /stocks\/(\d{4}-\d{2}-\d{2})/.exec(url)[1];
      assert.ok(![0, 6].includes(new Date(day + "T12:00:00Z").getUTCDay()));
    }
  } finally { client.dispose(); }
});
test("API 使用认证头、空列表不请求、大列表全市场单请求", async () => {
  const calls = [];
  const client = new MarketClient(config, async (url, options) => { calls.push([url, options]); return jsonResponse(payload); });
  try {
    assert.deepEqual(await client.snapshots([]), []); assert.equal(calls.length, 0);
    assert.equal((await client.snapshots(["NVDA"]))[0].symbol, "NVDA");
    assert.equal(calls[0][1].headers.Authorization, "Bearer fake-test-key");
    assert.ok(!calls[0][0].includes(config.apiKey)); assert.equal(calls[0][1].redirect, "error");
    await client.snapshots(symbolsFor("S&P 500", []));
    assert.equal(calls.length, 2); assert.ok(!calls[1][0].includes("tickers="));
  } finally { client.dispose(); }
});
for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} 脱敏错误`, async () => {
    const client = new MarketClient(config, async () => jsonResponse({ error: config.apiKey }, status, { "Retry-After": "30" }));
    try {
      await assert.rejects(client.snapshots(["NVDA"]), e => {
        assert.ok(e instanceof MarketError); assert.ok(!e.message.includes(config.apiKey));
        if (status === 429) assert.equal(e.retryMs, 30000);
        return true;
      });
    } finally { client.dispose(); }
  });
}
test("API 缺少密钥、无效响应与取消不触发额外网络", async () => {
  let count = 0;
  const client = new MarketClient({ ...config, apiKey: "" }, async () => { count++; return jsonResponse(payload); });
  await assert.rejects(client.snapshots(["NVDA"]), /未配置 API Key/);
  assert.equal(count, 0); client.dispose();
  const invalid = new MarketClient(config, async () => jsonResponse({ status: "ERROR", message: config.apiKey }));
  await assert.rejects(invalid.snapshots(["NVDA"]), /未返回成功/); invalid.dispose();
  const cancelled = new MarketClient(config, async () => { count++; return jsonResponse(payload); });
  cancelled.dispose(); await assert.rejects(cancelled.snapshots(["NVDA"])); assert.equal(count, 0);
});
test("共享请求队列串行执行，不重叠", async () => {
  let active = 0, peak = 0;
  const client = new MarketClient(config, async () => {
    active++; peak = Math.max(active, peak); await new Promise(resolve => setTimeout(resolve, 5)); active--; return jsonResponse(payload);
  });
  await Promise.all([client.snapshots(["NVDA"]), client.snapshots(["META"]), client.snapshots(["TSLA"])]);
  assert.equal(peak, 1); client.dispose();
});
test("VIX 是独立指数，不替代为 ETF", async () => {
  let url;
  const client = new MarketClient(config, async u => { url = u; return jsonResponse({ status: "OK", results: [{ ticker: "I:VIX", value: 18.2, session: { change_percent: -1.25 }, last_updated: Date.now() * 1e6 }] }); });
  const vix = await client.vix();
  assert.equal(vix.symbol, "VIX"); assert.equal(vix.price, 18.2); assert.equal(vix.change, -1.25);
  assert.match(url, /snapshot\/indices.*I%3AVIX/); client.dispose();
});

test("treemap 面积近似权重、边界不重叠", () => {
  const rects = squarify([{ weight: 60, id: 1 }, { weight: 30, id: 2 }, { weight: 10, id: 3 }], 120, 40);
  assert.equal(rects.length, 3);
  for (const r of rects) assert.ok(Math.abs(r.w * r.h / 4800 - r.item.weight / 100) < 0.025);
  for (let n = 1; n <= 503; n += 31) {
    const rects = squarify(Array.from({ length: n }, (_, i) => ({ weight: (n - i) ** 1.4 })), 80, 30);
    const occupied = new Set();
    for (const r of rects) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 80 && r.y + r.h <= 30);
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
        const key = `${x},${y}`; assert.ok(!occupied.has(key), "矩形不重叠"); occupied.add(key);
      }
    }
  }
  assert.deepEqual(squarify([{ weight: 0 }, { weight: NaN }], 80, 30), []);
});
for (const [width, rows] of [[1, 5], [20, 10], [32, 14], [60, 24], [100, 40], [160, 55]]) {
  test(`热力图 ${width}×${rows} 和下拉框不溢出`, () => {
    const state = makeState(symbolsFor("S&P 500", []));
    const view = new HeatmapView({ terminal: { rows }, requestRender() {} }, theme, () => state, () => {}, () => {}, () => {}, () => {});
    try {
      for (const dropdown of [false, true]) {
        if (dropdown) view.handleInput("c");
        const lines = view.render(width);
        assert.ok(lines.length <= rows);
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
      }
    } finally { view.dispose(); }
  });
}
test("专注模式类别搜索、模式切换、刷新和退出", () => {
  const state = makeState(); let category, mode, refresh = 0, done = 0;
  const view = new HeatmapView({ terminal: { rows: 40 }, requestRender() {} }, theme, () => state, c => { category = c; }, () => refresh++, m => { mode = m; state.weight = m; }, () => done++);
  try {
    view.handleInput("c"); view.handleInput("Finance"); view.handleInput("\r"); assert.equal(category, "Finance");
    view.handleInput("m"); assert.equal(mode, "cap"); view.handleInput("e"); assert.equal(mode, "equal");
    view.handleInput("r"); assert.equal(refresh, 1);
    view.handleInput("q"); assert.equal(done, 1);
  } finally { view.dispose(); }
});
for (const width of [1, 8, 30, 80, 240]) {
  test(`行情滚动条 ${width} 列不溢出`, () => {
    const ticker = new MarketTicker({ requestRender() {} }, theme, () => ({ quotes: makeState(["SPY", "QQQ"]).quotes, error: "", vixError: "当前套餐无指数权限" }));
    try { for (const line of ticker.render(width)) assert.equal(visibleWidth(line), width); }
    finally { ticker.dispose(); ticker.dispose(); }
  });
}
test("注册命令；非交互会话不启动网络或自定义 UI", async () => {
  const { commands, events } = setup(); const notices = [];
  assert.deepEqual([...commands.keys()].sort(), ["stock-earnings", "stock-earnings-close", "stock-earnings-mode", "stock-earnings-scope", "stock-earnings-details", "stock-earnings-refresh", "stock-add", "stock-heatmap", "stock-heatmap-close", "stock-heatmap-focus", "stock-heatmap-mode", "stock-heatmap-refresh", "stock-remove", "stock-ticker", "stock-watchlist"].sort());
  const ctx = { mode: "rpc", hasUI: true, ui: { notify: (...args) => notices.push(args) } };
  await events.get("session_start")({}, ctx);
  await commands.get("stock-heatmap").handler("S&P 500", ctx);
  assert.match(notices[0][0], /交互式终端/);
  assert.ok(commands.get("stock-heatmap").getArgumentCompletions("Tech").length >= 2);
  await events.get("session_shutdown")({}, ctx);
});

test("隔离目录集成：默认非模态、类别搜索、专注退出、隐藏和 shutdown 清理", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-integration-"));
  const extensionDir = join(directory, "extension"); await mkdir(extensionDir);
  for (const file of ["index.ts", "core.ts", "ui.ts", "earnings.ts", "earnings-ui.ts", "universe.json"]) await copyFile(new URL(`../extensions/stock-heatmap/${file}`, import.meta.url), join(extensionDir, file));
  await writeFile(join(extensionDir, ".env"), "STOCK_HEATMAP_API_KEY=fake-test-key\nSTOCK_HEATMAP_REQUEST_GAP_MS=0\n");
  const savedFetch = globalThis.fetch, savedDir = process.env.PI_CODING_AGENT_DIR, savedKey = process.env.STOCK_HEATMAP_API_KEY;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent"); process.env.STOCK_HEATMAP_API_KEY = "fake-test-key";
  let calls = 0;
  globalThis.fetch = async url => { calls++; return jsonResponse(url.includes("/indices") ? { status: "OK", results: [] } : payload); };
  let events, dialogAction = "Finance", keepFocus = false, customCalls = 0;
  const heatmapKey = "stock-heatmap:heatmap", tickerKey = "stock-heatmap:market-ticker";
  const widgets = new Map(), notices = [];
  const tui = { terminal: { rows: 40 }, requestRender() {} };
  const ctx = {
    mode: "tui", hasUI: true,
    ui: {
      notify: (...args) => notices.push(args), confirm: async () => true,
      setWidget(key, content, options) {
        widgets.get(key)?.dispose?.();
        if (content) { assert.equal(options.placement, key === heatmapKey ? "aboveEditor" : "belowEditor"); widgets.set(key, content(tui, theme)); }
        else widgets.delete(key);
      },
      custom(factory, options) {
        customCalls++;
        return new Promise(resolve => {
          const component = factory(tui, theme, {}, value => { component.dispose?.(); resolve(value); });
          component.focused = true;
          const output = component.render(100).join("\n");
          if (options?.overlay) {
            assert.match(output, /专注模式.*Esc 返回输入框/);
            if (!keepFocus) component.handleInput("q");
          } else {
            assert.match(output, /选择热图类别/);
            if (dialogAction === "cancel") component.handleInput("\x1b");
            else if (dialogAction !== "hold") { component.handleInput(dialogAction); component.handleInput("\r"); }
          }
        });
      },
    },
  };
  try {
    const extension = (await import(pathToFileURL(join(extensionDir, "index.ts")).href)).default;
    const setupResult = setup(extension); events = setupResult.events;
    await events.get("session_start")({}, ctx);
    const commands = setupResult.commands;
    await commands.get("stock-watchlist").handler("set META,TSLA,NVDA", ctx);
    await commands.get("stock-remove").handler("TSLA", ctx);
    await commands.get("stock-add").handler("AAPL META", ctx);
    const saved = JSON.parse(await readFile(join(directory, "agent/stock-heatmap/watchlist.json"), "utf8"));
    assert.deepEqual(saved.symbols, ["META", "NVDA", "AAPL"]);
    await commands.get("stock-heatmap").handler("自选", ctx);
    assert.equal(customCalls, 0, "默认显示绝不调用抢焦点的 custom()");
    assert.equal(widgets.size, 2); assert.equal(widgets.get(heatmapKey).handleInput, undefined);
    assert.match(widgets.get(heatmapKey).render(120).join("\n"), /可继续在下方输入/);
    await commands.get("stock-heatmap-mode").handler("等权", ctx);
    assert.match(widgets.get(heatmapKey).render(120).join("\n"), /面积=等权/);
    await commands.get("stock-heatmap-refresh").handler("", ctx);
    await commands.get("stock-heatmap").handler("", ctx);
    assert.match(widgets.get(heatmapKey).render(100)[0], /Finance/);
    const previous = widgets.get(heatmapKey);
    dialogAction = "cancel"; await commands.get("stock-heatmap").handler("", ctx);
    assert.equal(widgets.get(heatmapKey), previous, "取消类别选择不替换原热图");
    await commands.get("stock-heatmap-focus").handler("", ctx);
    assert.equal(widgets.get(heatmapKey), previous, "专注模式退出不关闭默认热图");
    await commands.get("stock-ticker").handler("off", ctx); assert.equal(widgets.size, 1);
    await commands.get("stock-heatmap-close").handler("", ctx); assert.equal(widgets.size, 0);
    await commands.get("stock-ticker").handler("on", ctx); assert.equal(widgets.size, 1); assert.ok(widgets.has(tickerKey));
    await commands.get("stock-heatmap").handler("自选", ctx); assert.equal(widgets.size, 2);
    await commands.get("stock-heatmap-close").handler("", ctx); assert.equal(widgets.size, 1, "收起热图保留行情条");
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(calls > 0); assert.ok(!JSON.stringify(notices).includes("fake-test-key"));
    keepFocus = true;
    const focusPromise = commands.get("stock-heatmap-focus").handler("自选", ctx);
    await new Promise(resolve => setTimeout(resolve, 10));
    await events.get("session_shutdown")({}, ctx);
    await focusPromise;
    await events.get("session_start")({}, ctx);
    dialogAction = "hold";
    const pickerPromise = commands.get("stock-heatmap").handler("", ctx);
    await new Promise(resolve => setTimeout(resolve, 10));
    await events.get("session_shutdown")({}, ctx);
    await pickerPromise;
  } finally {
    if (events) await events.get("session_shutdown")({}, ctx);
    assert.equal(widgets.size, 0);
    globalThis.fetch = savedFetch;
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedDir;
    if (savedKey === undefined) delete process.env.STOCK_HEATMAP_API_KEY; else process.env.STOCK_HEATMAP_API_KEY = savedKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("连续色阶：同方向不同幅度可区分，零值与缺失不同，超过 3% 仍有层次", () => {
  const values = [0.14, 0.26, 0.29, 0.38, 0.85, 0.99, 1.44, 2.31, 3.48, 6.28, 7.58];
  for (const sign of [1, -1]) {
    const colors = values.map(n => color(n * sign));
    assert.equal(new Set(colors).size, values.length);
    for (const c of colors) assert.match(c, /^#[0-9a-f]{6}$/);
  }
  assert.notEqual(color(0), color(undefined));
  assert.equal(color(10), color(50)); assert.equal(color(-10), color(-50));
  assert.equal(color(NaN), color(undefined));
});
function backgroundCells(line) {
  const cells = []; let bg;
  for (const match of line.matchAll(/\x1b\[([0-9;]*)m|([^\x1b])/gu)) {
    if (match[1] !== undefined) {
      const parts = match[1].split(";").map(Number);
      if (parts[0] === 48 && parts[1] === 2) bg = "#" + parts.slice(2, 5).map(n => n.toString(16).padStart(2, "0")).join("");
    } else cells.push(bg);
  }
  return cells;
}
for (const [width, height] of [[60, 14], [20, 20]]) {
  test(`相同背景股票 ${width}×${height} 具有独立横纵分隔`, () => {
    const state = makeState(["NVDA", "AVGO"]); state.weight = "equal";
    for (const q of state.quotes.values()) q.change = 0.5;
    const chart = renderTreemap(state, width, height);
    assert.equal(chart.stocks.length, 2);
    const pixels = chart.lines.map(backgroundCells);
    for (const r of chart.stocks) {
      for (let y = r.y; y < r.y + r.h; y++) assert.equal(pixels[y][r.x + r.w - 1], CHART_BACKGROUND, "右侧始终有一列分隔");
      for (let x = r.x; x < r.x + r.w; x++) assert.equal(pixels[r.y + r.h - 1][x], CHART_BACKGROUND, "底部始终有一行分隔");
      assert.equal(pixels[r.y][r.x], color(0.5));
    }
  });
}
test("小格聚合，不靠取消分隔线挤入不可读股票", () => {
  const state = makeState(symbolsFor("Tech Services", [])); state.weight = "equal";
  const chart = renderTreemap(state, 55, 12);
  assert.ok(chart.named < state.symbols.length);
  assert.match(chart.lines.join("\n"), /\+\d+/);
  for (const r of chart.stocks) assert.ok(r.h >= 3 && r.w >= 5);
});
for (const [width, rows] of [[1, 5], [20, 12], [40, 24], [80, 40], [160, 70]]) {
  test(`默认热图 ${width}×${rows} 为只读、自限高度、没有选股光标`, () => {
    const state = makeState(symbolsFor("S&P 500", []));
    const widget = new HeatmapWidget({ terminal: { rows }, requestRender() {} }, theme, () => state);
    try {
      assert.equal(widget.handleInput, undefined); assert.equal(widget.focused, undefined);
      const lines = widget.render(width);
      const budget = Math.max(1, Math.min(28, Math.floor((rows - 10) * 0.55)));
      assert.ok(lines.length <= budget);
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
      const plain = lines.join("\n").replace(/\x1b\[[\d;]*m/g, "");
      assert.doesNotMatch(plain, />[A-Z]|已选|↑↓←→|Esc 退出/);
    } finally { widget.dispose(); widget.dispose(); }
  });
}
test("类别选择器使用真实 Input 焦点，搜索与取消都可用", () => {
  const tui = { terminal: { rows: 24 }, requestRender() {} }; let result = "unchanged";
  const picker = new CategoryPicker(tui, theme, {}, value => { result = value; });
  picker.focused = true;
  picker.handleInput("Finance"); picker.handleInput("\r"); assert.equal(result, "Finance");
  picker.focused = false; assert.equal(picker.focused, false);
  const cancel = new CategoryPicker(tui, theme, {}, value => { result = value; });
  cancel.handleInput("\x1b"); assert.equal(result, undefined);
  const empty = new CategoryPicker(tui, theme, {}, () => { throw new Error("无匹配时不应确认"); });
  empty.handleInput("不存在类别"); empty.handleInput("\r");
  assert.match(empty.render(50).join("\n"), /无匹配/);
});
test("专注模式无默认选股，按方向键才出现明确选中状态", () => {
  const state = makeState(["NVDA", "AVGO"]); state.weight = "equal";
  const view = new HeatmapView({ terminal: { rows: 40 }, requestRender() {} }, theme, () => state, () => {}, () => {}, () => {}, () => {});
  try {
    assert.doesNotMatch(view.render(100).join("\n"), /已选|>NVDA/);
    view.handleInput("\x1b[C");
    assert.match(view.render(100).join("\n"), /已选 (NVDA|AVGO)/);
    assert.match(view.render(100).join("\n"), /┌/);
  } finally { view.dispose(); }
});

test("行情条不把旧板块日线误标为 ETF 日线", () => {
  const state = makeState(["SPY", "QQQ", "DIA", "IWM"]);
  state.quotes.set("NVDA", { symbol: "NVDA", price: 100, change: 1, source: "daily", sessionDate: "2025-01-01", delayed: true });
  const ticker = new MarketTicker({ requestRender() {} }, theme, () => ({ quotes: state.quotes, error: "", vixError: "当前套餐无此行情权限（403）" }));
  try {
    const text = ticker.render(600).join("\n");
    assert.match(text, /ETF 最新/); assert.doesNotMatch(text, /2025-01-01/);
    assert.match(text, /VIX —（无指数权限）/);
  } finally { ticker.dispose(); }
});
test("行情条内容放得下时不请求动画重绘", async () => {
  let renders = 0;
  const ticker = new MarketTicker({ requestRender() { renders++; } }, theme, () => ({ quotes: makeState(["SPY", "QQQ", "DIA", "IWM"]).quotes, error: "", vixError: "" }));
  try {
    ticker.render(600);
    await new Promise(resolve => setTimeout(resolve, 380));
    assert.equal(renders, 0);
    ticker.redraw(); assert.equal(renders, 1);
  } finally { ticker.dispose(); }
});
test("热图数据更新会主动使缓存失效，不依赖 ticker 动画", () => {
  let renders = 0; const state = makeState(["NVDA"]);
  const widget = new HeatmapWidget({ terminal: { rows: 50 }, requestRender() { renders++; } }, theme, () => state);
  try {
    state.quotes.get("NVDA").change = 0.14;
    const before = widget.render(80).join("\n");
    state.quotes.get("NVDA").change = 0.99;
    widget.redraw();
    const after = widget.render(80).join("\n");
    assert.equal(renders, 1); assert.notEqual(before, after); assert.match(after, /\+0.99%/);
  } finally { widget.dispose(); }
});
