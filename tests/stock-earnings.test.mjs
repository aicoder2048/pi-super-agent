import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import "./pi-runtime.mjs";
const { EarningsCalendarClient, EarningsController, resolveEarningsRange, validDate, newYorkDate, rangeDays, parseCalendarDay, epsSurprise, visibleEarnings, hasActual } = await import("../extensions/stock-heatmap/earnings.ts");
const { earningsTiles, earningsDetails, EarningsWidget } = await import("../extensions/stock-heatmap/earnings-ui.ts");
const { MarketClient, MarketError } = await import("../extensions/stock-heatmap/core.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");
const theme = { fg: (_token, text) => text };
const NOW = new Date("2026-11-09T17:00:00Z");
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const raw = (date = "2026-11-06", symbol = "AAPL", extra = {}) => ({ date, symbol, hour: "amc", epsActual: 1.2, epsEstimate: 1, quarter: 3, year: 2026, ...extra });
const event = (date, symbol = "AAPL", extra = {}) => parseCalendarDay({ earningsCalendar: [raw(date, symbol, extra)] }, date).events[0];
async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("异步状态未及时收敛"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function setupController(rows, overrides = {}) {
  const calls = [];
  const calendar = new EarningsCalendarClient("fake-calendar-key", 0, async url => {
    const date = new URL(url).searchParams.get("from"); calls.push(date);
    return response({ earningsCalendar: typeof rows === "function" ? rows(date) : rows });
  });
  const marketCalls = [];
  const market = {
    async dailyBars(date) { marketCalls.push(date); return new Map([["AAPL", { symbol: "AAPL", close: date === "2026-11-06" ? 110 : 100, timestamp: new Date(date + "T21:00:00Z").getTime() }]]); },
    async snapshots(symbols) { marketCalls.push(symbols); return []; },
    ...overrides,
  };
  const controller = new EarningsController(calendar, market, () => {}, () => NOW);
  return { controller, calls, marketCalls };
}

test("日期：真实日期、美东午夜及 DST、本周周一至周日", () => {
  assert.equal(validDate("2026-02-30"), false); assert.equal(validDate("2024-02-29"), true);
  assert.equal(newYorkDate(new Date("2026-11-09T01:00:00Z")), "2026-11-08");
  assert.equal(newYorkDate(new Date("2026-07-01T03:30:00Z")), "2026-06-30");
  assert.equal(resolveEarningsRange("tomorrow", NOW).from, "2026-11-10");
  const range = resolveEarningsRange("week", NOW);
  assert.equal(range.from, "2026-11-09"); assert.equal(range.to, "2026-11-15"); assert.equal(rangeDays(range).length, 7);
  assert.equal(resolveEarningsRange("week", new Date("2026-11-08T17:00:00Z")).from, "2026-11-02");
  assert.throws(() => resolveEarningsRange("2026-02-30", NOW), /日期无效/);
});
test("解析：actual=0 有效、负预期、缺失和未知时段", () => {
  const e = event("2026-11-06", "AAPL", { epsActual: 0, epsEstimate: -0.5, hour: "unexpected" });
  assert.equal(e.hour, "unknown"); assert.equal(epsSurprise(e), 100); assert.equal(hasActual(e, "2026-11-09"), true);
  assert.equal(epsSurprise({ ...e, epsActual: -0.3 }), 40);
  assert.equal(epsSurprise({ ...e, epsEstimate: 0 }), undefined);
  assert.equal(epsSurprise({ ...e, epsActual: undefined }), undefined);
  assert.equal(epsSurprise({ ...e, epsActual: Infinity }), undefined);
});
test("日历过滤越界、异常代码、去重且保留实际值", () => {
  const parsed = parseCalendarDay({ earningsCalendar: [raw(), raw("2026-11-06", "AAPL", { epsActual: null, epsEstimate: 0.9 }), raw("2026-11-07"), raw("2026-11-06", "../.env")] }, "2026-11-06");
  assert.equal(parsed.events.length, 1); assert.equal(parsed.events[0].epsActual, 1.2); assert.equal(parsed.events[0].epsEstimate, 0.9);
  assert.match(parsed.warnings.join(""), /过滤 2 条/);
  assert.throws(() => parseCalendarDay({ error: "secret-value" }, "2026-11-06"), error => !error.message.includes("secret-value"));
  assert.throws(() => parseCalendarDay({}, "2026-11-06"));
  assert.equal(parseCalendarDay({ earningsCalendar: [] }, "2026-11-06").events.length, 0);
});
test("疑似 1500 条截断必须保留提示", () => {
  const parsed = parseCalendarDay({ earningsCalendar: Array.from({ length: 1500 }, () => raw()) }, "2026-11-06");
  assert.match(parsed.warnings.join(""), /1500.*截断/);
});
test("同一股票不同发布日期/财季不会覆盖", () => {
  const a = event("2026-11-06"), b = event("2026-11-09"), c = event("2026-11-06", "AAPL", { quarter: 4 });
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
});
test("Finnhub 认证头、按日请求、缓存与强制刷新", async () => {
  const calls = []; const abort = new AbortController();
  const client = new EarningsCalendarClient("fake-calendar-key", 0, async (url, options) => {
    calls.push([url, options]); return response({ earningsCalendar: [raw()] });
  });
  try {
    await client.day("2026-11-06", abort.signal); await client.day("2026-11-06", abort.signal);
    assert.equal(calls.length, 1); await client.day("2026-11-06", abort.signal, true); assert.equal(calls.length, 2);
    assert.equal(calls[0][1].headers["X-Finnhub-Token"], "fake-calendar-key"); assert.equal(calls[0][1].redirect, "error");
    assert.ok(!calls[0][0].includes("fake-calendar-key"));
    const url = new URL(calls[0][0]); assert.equal(url.searchParams.get("from"), url.searchParams.get("to")); assert.equal(url.searchParams.get("international"), "false");
  } finally { client.dispose(); }
});
for (const status of [401, 403, 429, 500]) {
  test(`Finnhub HTTP ${status} 脱敏和 Retry-After`, async () => {
    const client = new EarningsCalendarClient("private-test-key", 0, async () => response({ error: "private-test-key" }, status, { "Retry-After": "7200" }));
    try {
      await assert.rejects(client.day("2026-11-06", new AbortController().signal), error => {
        assert.ok(error instanceof MarketError); assert.ok(!error.message.includes("private-test-key"));
        if (status === 429) assert.equal(error.retryMs, 7200000, "不把服务端两小时等待截短成一小时"); return true;
      });
    } finally { client.dispose(); }
  });
}
test("缺 key 或已取消时不发送网络请求", async () => {
  let calls = 0; const transport = async () => { calls++; return response({ earningsCalendar: [] }); };
  const empty = new EarningsCalendarClient("", 0, transport);
  await assert.rejects(empty.day("2026-11-06", new AbortController().signal), /FINNHUB_API_KEY/); empty.dispose();
  const canceled = new EarningsCalendarClient("fake-key", 0, transport); canceled.dispose();
  await assert.rejects(canceled.day("2026-11-06", new AbortController().signal)); assert.equal(calls, 0);
});
test("本周按七个自然日请求；EPS 默认不访问行情", async () => {
  const { controller, calls, marketCalls } = setupController(date => [raw(date)]);
  try {
    controller.activate(resolveEarningsRange("week", NOW)); await until(() => !controller.state.loadingCalendar);
    assert.equal(calls.length, 7); assert.equal(controller.state.events.length, 7); assert.equal(marketCalls.length, 0);
    assert.equal(new Set(controller.state.events.map(e => e.id)).size, 7);
  } finally { controller.dispose(); }
});
test("日历错误不冒充空列表；已有 EPS 得以保留", async () => {
  let fail = false;
  const calendar = new EarningsCalendarClient("fake-key", 0, async () => fail ? response({ error: "denied" }, 403) : response({ earningsCalendar: [raw()] }));
  const controller = new EarningsController(calendar, {}, () => {}, () => NOW);
  try {
    controller.activate(resolveEarningsRange("2026-11-06", NOW)); await until(() => !controller.state.loadingCalendar);
    fail = true; controller.refresh(true); await until(() => !controller.state.loadingCalendar);
    assert.equal(controller.state.events.length, 1); assert.match(controller.state.calendarError, /403.*不完整或过期/);
  } finally { controller.dispose(); }
});
test("切日期：忽略不服从取消的晚到响应", async () => {
  let release;
  const client = new EarningsCalendarClient("fake-key", 0, async url => {
    const date = new URL(url).searchParams.get("from");
    if (date === "2026-11-06") await new Promise(resolve => { release = resolve; });
    return response({ earningsCalendar: [raw(date)] });
  });
  const controller = new EarningsController(client, {}, () => {}, () => NOW);
  try {
    controller.activate(resolveEarningsRange("2026-11-06", NOW)); await until(() => !!release);
    controller.activate(resolveEarningsRange("today", NOW)); release(); await until(() => !controller.state.loadingCalendar);
    assert.equal(controller.state.events.length, 1); assert.equal(controller.state.events[0].date, "2026-11-09");
  } finally { controller.dispose(); }
});
test("历史 price 使用指定发布日与上一交易日，不用当前价冒充", async () => {
  const { controller, marketCalls } = setupController([raw()]);
  try {
    controller.setMode("price"); controller.activate(resolveEarningsRange("2026-11-06", NOW));
    await until(() => !controller.state.loadingCalendar && !controller.state.loadingPrices);
    const price = controller.state.prices.get(controller.state.events[0].id);
    assert.equal(price.date, "2026-11-06"); assert.equal(price.referenceDate, "2026-11-05"); assert.equal(price.kind, "close"); assert.ok(Math.abs(price.change - 10) < 1e-8);
    assert.deepEqual(marketCalls, ["2026-11-06", "2026-11-05"]);
    assert.match(earningsDetails(controller.state, [], NOW), /不是公告后的事件收益.*盘后财报/);
  } finally { controller.dispose(); }
});
test("发布日没有日线时不回退成其他日期的表现", async () => {
  const queries = [];
  const { controller } = setupController([raw("2026-11-08")], { async dailyBars(date) { queries.push(date); return new Map(); } });
  try {
    controller.setMode("price"); controller.activate(resolveEarningsRange("2026-11-08", NOW)); await until(() => !controller.state.loadingCalendar && !controller.state.loadingPrices);
    assert.equal(controller.state.prices.size, 0); assert.deepEqual(queries, ["2026-11-08"]);
  } finally { controller.dispose(); }
});
test("今日快照回退成旧交易日时保持灰色", async () => {
  const { controller } = setupController([raw("2026-11-09")], { async snapshots() { return [{ symbol: "AAPL", price: 110, change: 10, source: "daily", sessionDate: "2026-11-06" }]; } });
  try {
    controller.setMode("price"); controller.activate(resolveEarningsRange("today", NOW)); await until(() => !controller.state.loadingCalendar && !controller.state.loadingPrices);
    assert.equal(controller.state.prices.size, 0);
  } finally { controller.dispose(); }
});
test("行情无权限不破坏 EPS，EPS 不依赖股票报价", async () => {
  const { controller } = setupController([raw()], { async dailyBars() { throw new MarketError("行情权限不足（403）。"); } });
  try {
    controller.setMode("price"); controller.activate(resolveEarningsRange("2026-11-06", NOW)); await until(() => !controller.state.loadingCalendar && !controller.state.loadingPrices);
    assert.match(controller.state.priceError, /403/); controller.setMode("eps");
    assert.ok(Math.abs(earningsTiles(controller.state, NOW)[0].value - 20) < 1e-8);
    assert.equal(controller.state.calendarError, "");
  } finally { controller.dispose(); }
});
test("未来事件、缺 actual、预期为零均灰色；有实际零值仍可计算", async () => {
  const { controller } = setupController([]);
  try {
    controller.state.events = [event("2026-11-10"), event("2026-11-06", "MSFT", { epsActual: null }), event("2026-11-06", "NVDA", { epsEstimate: 0 }), event("2026-11-06", "META", { epsActual: 0, epsEstimate: -1 })];
    const tiles = earningsTiles(controller.state, NOW), bySymbol = new Map(tiles.map(tile => [tile.symbol, tile]));
    assert.equal(bySymbol.get("AAPL").value, undefined); assert.equal(bySymbol.get("MSFT").value, undefined); assert.equal(bySymbol.get("NVDA").value, undefined); assert.equal(bySymbol.get("META").value, 100);
    controller.setMode("price");
    controller.state.prices.set(controller.state.events[0].id, { date: "2026-11-10", change: 5, price: 100, kind: "snapshot" });
    assert.equal(earningsTiles(controller.state, NOW).find(t => t.symbol === "AAPL").value, undefined);
  } finally { controller.dispose(); }
});
test("范围筛选、颜色切换不改变面积和排序", () => {
  const { controller } = setupController([]);
  try {
    controller.state.events = [event("2026-11-06", "AAPL"), event("2026-11-06", "UNKNOWN")];
    const before = earningsTiles(controller.state, NOW).map(t => [t.id, t.weight]);
    controller.setMode("price"); assert.deepEqual(earningsTiles(controller.state, NOW).map(t => [t.id, t.weight]), before);
    controller.setScope("indices"); assert.equal(visibleEarnings(controller.state).length, 1);
    controller.setWatchlist(["UNKNOWN"]); controller.setScope("watchlist"); assert.equal(visibleEarnings(controller.state)[0].symbol, "UNKNOWN");
  } finally { controller.dispose(); }
});
for (const [width, rows] of [[1, 5], [25, 12], [40, 24], [80, 40], [160, 65]]) {
  test(`财报只读 widget ${width}×${rows} 不溢出、不抢焦点`, () => {
    const { controller } = setupController([]);
    controller.state.events = [event("2026-11-06"), event("2026-11-06", "MSFT", { hour: "bmo" })];
    const widget = new EarningsWidget({ terminal: { rows }, requestRender() {} }, theme, () => controller.state);
    try {
      assert.equal(widget.handleInput, undefined);
      const lines = widget.render(width); assert.ok(lines.length <= Math.max(1, Math.min(28, Math.floor((rows - 10) * 0.55))));
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
    } finally { widget.dispose(); controller.dispose(); }
  });
}
test("Massive 历史日线解析保留日期路径、空市场日及非法数值", async () => {
  const urls = [];
  const market = new MarketClient({ apiKey: "fake", baseURL: "https://api.massive.com", requestGapMs: 0, refreshMs: 60000, ticker: false }, async url => {
    urls.push(url); return response({ status: "OK", results: [{ T: "AAPL", c: 100, v: 200 }, { T: "MSFT", c: 0 }] });
  });
  try { const bars = await market.dailyBars("2026-11-06"); assert.equal(bars.size, 1); assert.equal(bars.get("AAPL").close, 100); assert.match(urls[0], /2026-11-06\?adjusted=true/); }
  finally { market.dispose(); }
});

test("集成：股票/财报共享一个槽、ticker 独立、选择取消和 session 清理", async () => {
  const directory = await mkdtemp(join(tmpdir(), "earnings-integration-")), extension = join(directory, "extension"); await mkdir(extension);
  for (const file of ["index.ts", "core.ts", "ui.ts", "earnings.ts", "earnings-ui.ts", "universe.json"]) await copyFile(new URL(`../extensions/stock-heatmap/${file}`, import.meta.url), join(extension, file));
  await writeFile(join(extension, ".env"), "POLYGON_API_KEY=fake-market\nFINNHUB_API_KEY=fake-calendar\nSTOCK_EARNINGS_REQUEST_GAP_MS=0\nSTOCK_HEATMAP_REQUEST_GAP_MS=0\n");
  const savedFetch = globalThis.fetch, savedDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  await mkdir(join(directory, "agent/stock-heatmap"), { recursive: true });
  await writeFile(join(directory, "agent/stock-heatmap/watchlist.json"), JSON.stringify({ version: 1, symbols: ["AAPL"], ticker: false, usage: {} }));
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    if (url.includes("finnhub.io")) return response({ earningsCalendar: [raw(parsed.searchParams.get("from"))] });
    if (url.includes("/indices")) return response({ status: "OK", results: [] });
    if (url.includes("/aggs/grouped/")) return response({ status: "OK", results: [{ T: "AAPL", c: url.includes("2026-11-06") ? 110 : 100 }] });
    return response({ status: "OK", tickers: [{ ticker: "AAPL", day: { c: 100, v: 100, vw: 100 }, todaysChangePerc: 1, updated: Date.now() * 1e6 }] });
  };
  const commands = new Map(), events = new Map(), widgets = new Map(), notices = [];
  const tui = { terminal: { rows: 42 }, requestRender() {} }, key = "stock-heatmap:heatmap";
  const ctx = { mode: "tui", hasUI: true, ui: {
    notify: (...args) => notices.push(args), select: async () => undefined,
    setWidget(name, factory, options) { widgets.get(name)?.dispose?.(); if (factory) { assert.equal(options.placement, name === key ? "aboveEditor" : "belowEditor"); widgets.set(name, factory(tui, theme)); } else widgets.delete(name); },
    custom(factory) { return new Promise(resolve => { const view = factory(tui, theme, {}, resolve); view.render(120); view.handleInput("q"); view.dispose(); }); },
  } };
  try {
    const module = await import(pathToFileURL(join(extension, "index.ts")).href);
    module.default({ registerCommand: (name, command) => commands.set(name, command), on: (name, handler) => events.set(name, handler) });
    await events.get("session_start")({}, ctx);
    assert.equal(widgets.size, 0);
    await commands.get("stock-heatmap").handler("自选", ctx); assert.equal(widgets.size, 1);
    await commands.get("stock-earnings").handler("2026-11-06", ctx); assert.equal(widgets.size, 1);
    const earnings = widgets.get(key); assert.equal(earnings.handleInput, undefined);
    await until(() => earnings.render(120).join("\n").includes("标注 1/1"));
    await commands.get("stock-heatmap-close").handler("", ctx); assert.equal(widgets.get(key), earnings);
    await commands.get("stock-heatmap-focus").handler("自选", ctx); assert.equal(widgets.get(key), earnings);
    await commands.get("stock-earnings-mode").handler("price", ctx); assert.match(earnings.render(120).join("\n"), /非财报反应/);
    await commands.get("stock-earnings-details").handler("AAPL", ctx); assert.ok(notices.some(n => /EPS 实际/.test(n[0])));
    await commands.get("stock-ticker").handler("on", ctx); assert.equal(widgets.size, 2);
    await commands.get("stock-earnings-close").handler("", ctx); assert.equal(widgets.size, 1);
    await commands.get("stock-heatmap").handler("自选", ctx); const stock = widgets.get(key);
    await commands.get("stock-earnings-close").handler("", ctx); assert.equal(widgets.get(key), stock);
    await commands.get("stock-earnings").handler("", ctx); assert.equal(widgets.get(key), stock, "取消日期选择不更换图表");
    await commands.get("stock-earnings").handler("2026-02-30", ctx); assert.equal(widgets.get(key), stock);
    assert.ok(!JSON.stringify(notices).includes("fake-calendar"));
  } finally {
    if (events.has("session_shutdown")) await events.get("session_shutdown")({}, ctx);
    assert.equal(widgets.size, 0); globalThis.fetch = savedFetch;
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test("美东跨日后 today 自动推进，不把昨天持续标为今天", async () => {
  let now = new Date("2026-11-09T17:00:00Z");
  const calendar = new EarningsCalendarClient("fake", 0, async url => response({ earningsCalendar: [raw(new URL(url).searchParams.get("from"))] }));
  const controller = new EarningsController(calendar, {}, () => {}, () => now);
  try {
    controller.activate(resolveEarningsRange("today", now)); await until(() => !controller.state.loadingCalendar);
    now = new Date("2026-11-10T17:00:00Z"); controller.refresh(); await until(() => !controller.state.loadingCalendar);
    assert.equal(controller.state.range.from, "2026-11-10"); assert.equal(controller.state.events[0].date, "2026-11-10");
  } finally { controller.dispose(); }
});
