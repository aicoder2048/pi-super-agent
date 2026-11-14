import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { Modules } from "../src/modules.ts";
import { runFeed, type FeedNotice, type FeedPorts, type FeedProblem } from "../src/modules/feed-runner.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import type { Alert } from "../src/modules/protocol.ts";
import { problemLine, scanPackage } from "../src/modules/validate.ts";
import { Kernel } from "../src/kernel/kernel.ts";
import { openStore } from "../src/kernel/store.ts";
import { threadId } from "../src/sources/generic.ts";
import { servedAsHost } from "./helpers/fakes.ts";
import { fakeMassive, SNAPSHOT, snapshotBody, stockTaCopy, tickerRow, type Answer } from "./helpers/market.ts";

const PKG = join(import.meta.dirname, "../docs/modules/examples/stock-ta");
const AT = Date.parse("2026-11-12T15:44:00Z");

const ny = (local: string) => Date.parse(`${local}-05:00`);
const snapshot = (rows: Record<string, unknown>[]): Answer => ({ status: 200, body: snapshotBody(rows) });

async function quotesFeed(t: TestContext, key = "sk-test", settings: Record<string, unknown> = {}) {
	const massive = await fakeMassive(t);
	const modules = servedAsHost(Modules.load([dirname(stockTaCopy(t, massive.base, settings))]));
	const entry = modules.feeds().find((e) => e.source === "stock-ta/quotes");
	assert.ok(entry, "stock-ta 有 quotes feed");
	const state = mkdtempSync(join(tmpdir(), "psa-stock-ta-quotes-"));
	t.after(() => rmSync(state, { recursive: true, force: true }));
	const data = instanceData(state);
	const notices: FeedNotice[] = [];
	const lines: Alert[] = [];
	const clock = { now: AT + 15 * 60_000 };
	const problems: (FeedProblem | undefined)[] = [];
	const ports: FeedPorts = {
		data,
		submit: (n) => void notices.push(n),
		alert: (_, a) => !lines.some((l) => l.externalId === a.externalId) && lines.push(a) > 0,
		problem: (_, p) => void problems.push(p),
		secret: (name) => (name === "POLYGON_API_KEY" && key !== "" ? key : undefined),
		now: () => clock.now,
	};
	const watch = (...symbols: string[]) => data.write("stock-ta", entry.components, "watchlist", symbols.map((symbol) => ({ symbol })), "使用者口述", "test");
	const levels = (...rows: Record<string, unknown>[]) => data.write("stock-ta", entry.components, "rule-levels", rows as never, "使用者口述", "test");
	const hold = (...rows: Record<string, unknown>[]) => data.write("stock-ta", entry.components, "holdings", rows as never, "使用者口述", "test");
	const quotes = () => data.query("stock-ta", entry.components, "quotes", {}, "test").rows;
	const restart = () => (ports.data = instanceData(state));
	const hitsFile = (date = DAY) => join(data.dir("stock-ta"), "files", "hits", date, "quotes.json");
	return { massive, modules, entry, data, hitsFile, notices, lines, problems, problemIds: () => problems.map((p) => p?.id ?? "-"), alerts: () => lines.map((l) => l.text), watch, levels, hold, quotes, clock, restart, round: () => runFeed(entry, [], ports), rehearse: () => runFeed(entry, [], ports, entry.fixtures[0]) };
}

test("快照解析：一次请求取回整张自选股，每只一行，带价格、相对昨收的涨跌幅、成交量和数据时间", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA", "amd");
	feed.massive.answer(snapshot([tickerRow("AMD", 151.5, 150, AT), tickerRow("NVDA", 180.4, 176, AT)]));
	assert.deepEqual(await feed.round(), { ok: true, records: 2, notices: 0 });
	assert.equal(feed.massive.hits.length, 1);
	assert.equal(feed.massive.hits[0]!.url, `${SNAPSHOT}?tickers=AMD,NVDA,QQQ,SPY,VIXY`);
	assert.equal(feed.massive.hits[0]!.auth, "Bearer sk-test");
	const nvda = feed.quotes().find((r) => r.fields["symbol"] === "NVDA");
	assert.deepEqual(nvda?.fields, { symbol: "NVDA", price: 180.4, prevClose: 176, changePct: 2.5, volume: 5_000_000, at: "2026-11-12T15:44:00.000Z" });
	assert.equal(nvda?.from, "stock-ta/quotes");
});

test("同一数据时间再来一轮：不重复存", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 180.4, 176, AT)]));
	await feed.round();
	await feed.round();
	assert.equal(feed.quotes().length, 1);
	feed.massive.answer(snapshot([tickerRow("NVDA", 181, 176, AT + 60_000)]));
	await feed.round();
	assert.equal(feed.quotes().length, 2, "新的数据时间存成新的一行");
});

test("自选股改了下一轮就用新名单；划掉的不再请求；名单空着只取 SPY、QQQ", async (t) => {
	const feed = await quotesFeed(t);
	feed.massive.answer(snapshot([]));
	assert.deepEqual(await feed.round(), { ok: true, records: 0, notices: 0 });
	const written = feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 180.4, 176, AT), tickerRow("AAPL", 230, 229, AT)]));
	await feed.round();
	feed.watch("AAPL");
	await feed.round();
	assert.deepEqual(feed.massive.hits.map((h) => h.url), [`${SNAPSHOT}?tickers=QQQ,SPY,VIXY`, `${SNAPSHOT}?tickers=NVDA,QQQ,SPY,VIXY`, `${SNAPSHOT}?tickers=AAPL,NVDA,QQQ,SPY,VIXY`]);
	feed.data.write("stock-ta", feed.entry.components, "watchlist", [{ id: written.rows[0]!.id, removedAt: "2026-11-12" }], "使用者口述", "test");
	await feed.round();
	assert.equal(feed.massive.hits.at(-1)!.url, `${SNAPSHOT}?tickers=AAPL,QQQ,SPY,VIXY`);
});

test("同一只股票有两行：以最新的一行为准，最新一行划掉了就不再请求它，划掉后又加回来就照常请求", async (t) => {
	const feed = await quotesFeed(t);
	feed.massive.answer(snapshot([tickerRow("NVDA", 180.4, 176, AT)]));
	const [first] = feed.watch("NVDA").rows;
	const [second] = feed.watch("NVDA").rows;
	feed.data.write("stock-ta", feed.entry.components, "watchlist", [{ id: second!.id, removedAt: "2026-11-12" }], "使用者口述", "test");
	assert.deepEqual(await feed.round(), { ok: true, records: 0, notices: 0 });
	assert.equal(feed.massive.hits.at(-1)?.url, `${SNAPSHOT}?tickers=QQQ,SPY,VIXY`, `最新一行（${second!.id}）划掉了，较早的 ${first!.id} 不算`);
	feed.watch("NVDA");
	await feed.round();
	assert.equal(feed.massive.hits.at(-1)?.url, `${SNAPSHOT}?tickers=NVDA,QQQ,SPY,VIXY`);
});

test("缺密钥：不发请求，每一轮都报问题 no-key，一行说明去哪里设 POLYGON_API_KEY（宿主只在头一轮说）", async (t) => {
	const feed = await quotesFeed(t, "");
	feed.watch("NVDA");
	assert.deepEqual(await feed.round(), { ok: true, records: 0, notices: 0 });
	await feed.round();
	assert.deepEqual(feed.problemIds(), ["no-key", "no-key"]);
	assert.match(feed.problems[0]!.text, /没有设置 POLYGON_API_KEY/);
	assert.equal(feed.problems[0]!.text.split("\n").length, 1);
	assert.equal(feed.massive.hits.length, 0, "没有密钥就不去敲行情服务的门");
	assert.equal(feed.quotes().length, 0);
});

test("样例排练：样例代替网络，没有密钥也照常跑完", async (t) => {
	const feed = await quotesFeed(t, "");
	assert.deepEqual(await feed.rehearse(), { ok: true, records: 2, notices: 1 });
});

test("接口出错：不存任何东西；连着 5 轮取不到报价才报问题 massive-down，之后每轮照报，取到了那一轮清掉", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer({ status: 500, body: { status: "ERROR" } }, { status: 200, body: { status: "OK" } }, { status: 401, body: {} }, { status: 500, body: {} }, { status: 500, body: {} }, { status: 500, body: {} });
	for (let i = 0; i < 6; i++) {
		assert.deepEqual(await feed.round(), { ok: true, records: 0, notices: 0 }, "应答出错或没有 tickers 都不算这一轮跑坏");
		feed.clock.now += 60_000;
	}
	assert.deepEqual(feed.problemIds(), ["-", "-", "-", "-", "massive-down", "massive-down"]);
	assert.match(feed.problems[4]!.text, /连着 5 轮/);
	assert.match(feed.problems[4]!.text, /最近一次：行情服务返回 HTTP 500/);
	assert.match(feed.problems[4]!.text, /恢复后自动接着取/);
	feed.massive.answer(snapshot([tickerRow("NVDA", 180.4, 176, feed.clock.now - 15 * 60_000)]));
	assert.deepEqual(await feed.round(), { ok: true, records: 1, notices: 0 });
	assert.equal(feed.problems.at(-1), undefined);
	assert.equal(feed.quotes().length, 1);
});

test("密钥被拒（HTTP 401、403）：问题里写上最近一次的错误，让你去查密钥，不说等它自己恢复", async (t) => {
	for (const status of [401, 403]) {
		const feed = await quotesFeed(t);
		feed.massive.answer({ status, body: {} });
		for (let i = 0; i < 5; i++) await feed.round();
		const problem = feed.problems.at(-1);
		assert.equal(problem?.id, "massive-down");
		assert.match(problem!.text, new RegExp(`最近一次：行情服务返回 HTTP ${status}`));
		assert.match(problem!.text, /POLYGON_API_KEY/);
		assert.doesNotMatch(problem!.text, /恢复后自动接着取/);
		assert.ok(problem!.text.length <= 200, "宿主只留问题的前 200 个字");
	}
});

test("接口出错的轮数在宿主重启后接着数；隔了一天重新数", async (t) => {
	const feed = await quotesFeed(t);
	feed.massive.answer({ status: 500, body: {} });
	for (let i = 0; i < 3; i++) await feed.round();
	feed.restart();
	for (let i = 0; i < 2; i++) await feed.round();
	assert.equal(feed.problemIds().at(-1), "massive-down");
	feed.clock.now += 86_400_000;
	await feed.round();
	assert.equal(feed.problemIds().at(-1), "-");
});

test("报价旧了：交易时段 20 分钟没有数据时间更新的报价就报问题 stale，新的报价来了清掉；收盘后不报", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	const at = (local: string) => ny(`2026-11-12T${local}:00`);
	const quote = (data: string) => snapshot([tickerRow("NVDA", 180.4, 176, at(data))]);
	const roundAt = async (local: string, answer: Answer) => {
		feed.clock.now = at(local);
		feed.massive.answer(answer);
		await feed.round();
	};
	await roundAt("10:00", quote("09:45"));
	await roundAt("10:19", quote("09:45"));
	await roundAt("10:20", quote("09:45"));
	await roundAt("10:21", quote("09:46"));
	await roundAt("15:59", quote("09:46"));
	await roundAt("16:05", quote("09:46"));
	assert.deepEqual(feed.problemIds(), ["-", "-", "stale", "-", "stale", "-"]);
	assert.match(feed.problems[2]!.text, /20 分钟/);
});

test("报价旧了：开盘后第一份快照还是盘前的（行情延迟 15 分钟），开盘 20 分钟内不报", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	for (const minute of ["09:30", "09:40", "09:49"]) {
		feed.clock.now = ny(`2026-11-12T${minute}:00`);
		feed.massive.answer(snapshot([tickerRow("NVDA", 180.4, 176, ny("2026-11-11T15:59:00"))]));
		await feed.round();
	}
	feed.clock.now = ny("2026-11-12T09:50:00");
	await feed.round();
	assert.deepEqual(feed.problemIds(), ["-", "-", "-", "stale"]);
});

test("报价旧了：节假日（感恩节）宿主照样在美股时段跑，拿到的一直是昨天的报价，不报 stale", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	for (const minute of ["09:30", "09:40", "09:50", "10:30"]) {
		feed.clock.now = ny(`2026-11-26T${minute}:00`);
		feed.massive.answer(snapshot([tickerRow("NVDA", 180.4, 176, ny("2026-11-25T15:59:00"))]));
		await feed.round();
	}
	assert.deepEqual(feed.problemIds(), ["-", "-", "-", "-"]);
});

test("报价旧了：提前收盘日 13:00 收盘后不再有新报价，不报 stale", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	for (const minute of ["12:50", "13:10", "13:30", "15:00"]) {
		feed.clock.now = ny(`2026-11-27T${minute}:00`);
		feed.massive.answer(snapshot([tickerRow("NVDA", 180.4, 176, ny("2026-11-27T12:45:00"))]));
		await feed.round();
	}
	assert.deepEqual(feed.problemIds(), ["-", "-", "-", "-"]);
});

const DAY = "2026-11-12";
const band = (feed: Awaited<ReturnType<typeof quotesFeed>>) => feed.lines.filter((l) => l.externalId.startsWith("band:")).map((l) => l.externalId);

test("分档：每轮取已经到达的最高一档，跳空直接到 8% 只报 8% 档，一行提醒和一条触发同一个 id", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 108.2, 100, AT)]));
	assert.deepEqual(await feed.round(), { ok: true, records: 1, notices: 1 });
	assert.deepEqual(band(feed), [`band:NVDA:${DAY}:up8`]);
	assert.deepEqual(feed.notices.map((n) => n.id), [`band:NVDA:${DAY}:up8`]);
	assert.equal(feed.alerts()[0], "NVDA 涨 +8.20%，到达 +8% 档。现价 108.20，昨收 100.00。报价时间 10:44 ET（延迟行情）。");
	assert.equal(feed.lines[0]!.push, undefined, "第二档响铃");
	assert.equal(feed.notices[0]!.body, `${feed.alerts()[0]}（规则 move-2，层级 5，做法 band-move）`, "触发正文是那一行，加上规则、层级和做法");
	assert.equal(feed.notices[0]!.thread, `NVDA:${DAY}`);
});

test("个股第一档：静音一行加一条触发（三人小组）；第二档：响铃一行，触发进同一条线程", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 105.31, 100, AT)]), snapshot([tickerRow("NVDA", 108.1, 100, AT + 60_000)]));
	await feed.round();
	await feed.round();
	assert.deepEqual(feed.lines.map((l) => [l.externalId, l.push ?? "ring"]), [[`band:NVDA:${DAY}:up5`, "silent"], [`band:NVDA:${DAY}:up8`, "ring"]]);
	assert.deepEqual(feed.notices.map((n) => [n.id, n.thread, n.body.replace(/^.*（/, "（")]), [
		[`band:NVDA:${DAY}:up5`, `NVDA:${DAY}`, "（规则 move-1，层级 5，做法 band-move）"],
		[`band:NVDA:${DAY}:up8`, `NVDA:${DAY}`, "（规则 move-2，层级 5，做法 band-move）"],
	]);
});

test("分档：只升不降，回落再上来不重报；再到更高一档才报，汇报进同一条线程", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(
		snapshot([tickerRow("NVDA", 105.2, 100, AT)]),
		snapshot([tickerRow("NVDA", 104.8, 100, AT + 60_000)]),
		snapshot([tickerRow("NVDA", 105.6, 100, AT + 120_000)]),
		snapshot([tickerRow("NVDA", 108.1, 100, AT + 180_000)]),
	);
	for (let i = 0; i < 4; i++) await feed.round();
	assert.deepEqual(band(feed), [`band:NVDA:${DAY}:up5`, `band:NVDA:${DAY}:up8`]);
	assert.deepEqual(feed.notices.map((n) => n.thread), [`NVDA:${DAY}`, `NVDA:${DAY}`]);
});

test("分档：涨和跌各算各的；按 now 的美东日期换日清空", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 94.9, 100, AT)]), snapshot([tickerRow("NVDA", 105.1, 100, AT + 60_000)]));
	await feed.round();
	await feed.round();
	assert.deepEqual(band(feed), [`band:NVDA:${DAY}:down5`, `band:NVDA:${DAY}:up5`]);
	assert.match(feed.alerts()[0]!, /^NVDA 跌 -5\.10%，到达 -5% 档。/);
	const next = AT + 86_400_000;
	feed.clock.now = next + 15 * 60_000;
	feed.massive.answer(snapshot([tickerRow("NVDA", 105.3, 100, next)]));
	await feed.round();
	assert.deepEqual(band(feed).at(-1), "band:NVDA:2026-11-13:up5");
});

test("分档不取整：4.996% 不到 5% 档，5.00% 到", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 104.996, 100, AT)]), snapshot([tickerRow("NVDA", 105, 100, AT + 60_000)]));
	await feed.round();
	assert.deepEqual(band(feed), [], "4.996% 两位小数是 5.00%，但没到 5% 档");
	await feed.round();
	assert.deepEqual(band(feed), [`band:NVDA:${DAY}:up5`]);
});

test("SPY 和 QQQ 用自己的 2%、3% 档；个股 3% 和 SPY 1.6% 不报；没有放量提醒", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(
		snapshot([tickerRow("NVDA", 103.5, 100, AT, { min: { c: 103.5, t: AT, v: 9_000_000 } }), tickerRow("SPY", 508, 500, AT), tickerRow("QQQ", 400, 400, AT)]),
		snapshot([tickerRow("SPY", 510.5, 500, AT + 60_000), tickerRow("QQQ", 387.9, 400, AT + 60_000)]),
	);
	await feed.round();
	assert.deepEqual(feed.lines, [], "个股 3.5%、SPY 1.6%、一分钟巨量都不报");
	await feed.round();
	assert.deepEqual(band(feed).sort(), [`band:QQQ:${DAY}:down3`, `band:SPY:${DAY}:up2`]);
	assert.deepEqual(Object.fromEntries(feed.lines.map((l) => [l.externalId, l.push ?? "ring"])), { [`band:SPY:${DAY}:up2`]: "silent", [`band:QQQ:${DAY}:down3`]: "ring" }, "指数 2% 静音，3% 响铃");
	assert.equal(feed.notices.length, 2, "两条都开任务");
});

test("SPY、QQQ 总在请求里，不在自选股里也取、也存行；还是一次快照请求", async (t) => {
	const feed = await quotesFeed(t);
	feed.massive.answer(snapshot([tickerRow("SPY", 501, 500, AT), tickerRow("QQQ", 401, 400, AT)]));
	await feed.round();
	feed.watch("NVDA");
	await feed.round();
	assert.deepEqual(feed.massive.hits.map((h) => h.url), [`${SNAPSHOT}?tickers=QQQ,SPY,VIXY`, `${SNAPSHOT}?tickers=NVDA,QQQ,SPY,VIXY`]);
	assert.deepEqual(feed.quotes().map((r) => r.fields["symbol"]).sort(), ["QQQ", "SPY"]);
});

test("已报到哪一档存在 cursor 里：宿主重启后接着用，不重报", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 105.2, 100, AT)]), snapshot([tickerRow("NVDA", 105.9, 100, AT + 60_000)]));
	await feed.round();
	feed.restart();
	feed.lines.length = 0;
	await feed.round();
	assert.deepEqual(feed.lines, []);
	assert.deepEqual(feed.notices.map((n) => n.id), [`band:NVDA:${DAY}:up5`]);
});

test("你设的当天涨跌条件和档位同一轮到：只发一行，档位那一行后面接上你的条件", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.data.watch("stock-ta", feed.entry.components, { kind: "watch", collection: "quotes" as never, op: "set", watch: { key: "NVDA", condition: { when: "day-move", atLeast: 5, direction: "either" } } }, "test");
	feed.massive.answer(snapshot([tickerRow("NVDA", 105.31, 100, AT)]), snapshot([tickerRow("NVDA", 108.1, 100, AT + 60_000)]));
	await feed.round();
	assert.equal(feed.lines.length, 1, feed.alerts().join("\n"));
	assert.equal(feed.alerts()[0], "NVDA 涨 +5.31%，到达 +5% 档。现价 105.31，昨收 100.00。报价时间 10:44 ET（延迟行情）。也到了你设的涨跌 5% 提醒线。");
	await feed.round();
	assert.equal(feed.lines.length, 2, "条件当天已经报过，+8% 档照常单独一行");
	assert.match(feed.alerts()[1]!, /^NVDA 涨 \+8\.10%，到达 \+8% 档。.*（延迟行情）。$/);
	assert.deepEqual(feed.notices.map((n) => n.id), [`band:NVDA:${DAY}:up5`, `band:NVDA:${DAY}:up8`], "触发照旧每档一条");
});

test("条件和档位方向不同、或不在同一轮：各发各的", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.data.watch("stock-ta", feed.entry.components, { kind: "watch", collection: "quotes" as never, op: "set", watch: { key: "NVDA", condition: { when: "day-move", atLeast: 1, direction: "either" } } }, "test");
	feed.massive.answer(snapshot([tickerRow("NVDA", 101.2, 100, AT)]), snapshot([tickerRow("NVDA", 105.1, 100, AT + 60_000)]));
	await feed.round();
	await feed.round();
	assert.equal(feed.lines.length, 2);
	assert.match(feed.alerts()[0]!, /到了你设的涨跌 1% 提醒线/);
	assert.match(feed.alerts()[1]!, /^NVDA 涨 \+5\.10%，到达 \+5% 档。.*（延迟行情）。$/);
});

test("报价的提醒条件：提醒里的数据时间按美东写，存的仍是 UTC 时间", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.data.watch("stock-ta", feed.entry.components, { kind: "watch", collection: "quotes" as never, op: "set", watch: { key: "NVDA", condition: { when: "below", value: 171 } } }, "test");
	feed.massive.answer(snapshot([tickerRow("NVDA", 170, 176, AT)]));
	await feed.round();
	assert.equal(feed.alerts().length, 1);
	assert.equal(feed.alerts()[0]!, "NVDA 170，低于 171（2026-11-12 10:44 美东，延迟行情）");
	assert.equal(feed.quotes()[0]!.fields["at"], "2026-11-12T15:44:00.000Z");
});

test("规则：stock-ta/quotes 的触发只有一条通用规则 watch-task，照触发里写的做法开任务给技术分析研究组", async (t) => {
	const feed = await quotesFeed(t);
	assert.deepEqual(feed.modules.rulesFor("stock-ta/quotes"), ["stock-ta/watch-task"]);
	assert.equal(feed.modules.allRules().some((r) => r.id === "stock-ta/big-move"), false, "big-move 已经并进 watch-task");
	const rule = feed.modules.allRules().find((r) => r.id === "stock-ta/watch-task");
	for (const said of ["做法", "技能", "同一个任务", "数据时间", "不是交易指令", "只是数据"]) assert.match(rule?.text ?? "", new RegExp(said));
	assert.equal(feed.modules.book.get("stock-ta")?.team, "技术分析研究组");
});

test("stock-ta 包通过检查：quotes 的样例跑过 handler，不需要真的密钥", () => {
	const result = scanPackage(PKG, { secret: () => undefined });
	assert.ok(result.ok, result.ok ? "" : result.problems.map(problemLine).join("\n"));
	const feed = result.scan.components.find((c) => c.kind === "feeds" && c.name === "quotes");
	assert.ok(feed?.kind === "feeds" && feed.fixtures.length > 0);
	assert.deepEqual({ every: feed.feed.every, when: feed.feed.when, secrets: feed.feed.secrets, into: feed.feed.into, reads: feed.feed.reads }, { every: "60s", when: "us-market-hours", secrets: ["POLYGON_API_KEY"], into: "quotes", reads: ["watchlist", "rule-levels", "holdings"] });
});


test("只写新鲜的报价：开盘第一份快照里 9:15 的盘前成交不写行，也不发 5% 触发；9:31 的成交照写", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.clock.now = ny("2026-11-12T09:31:00");
	feed.massive.answer(snapshot([tickerRow("NVDA", 106, 100, ny("2026-11-12T09:15:00"))]), snapshot([tickerRow("NVDA", 106, 100, ny("2026-11-12T09:31:00"))]));
	assert.deepEqual(await feed.round(), { ok: true, records: 0, notices: 0 });
	feed.clock.now = ny("2026-11-12T09:32:00");
	assert.deepEqual(await feed.round(), { ok: true, records: 1, notices: 1 });
});

test("只写新鲜的报价：节假日整天拿到的是昨天的报价，不写行", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.clock.now = ny("2026-11-26T10:00:00");
	feed.massive.answer(snapshot([tickerRow("NVDA", 106, 100, ny("2026-11-25T15:59:00"))]));
	assert.deepEqual(await feed.round(), { ok: true, records: 0, notices: 0 });
});

test("只写新鲜的报价：提前收盘日 13:00 以后的成交不写行，12:59 的照写", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.clock.now = ny("2026-11-27T13:10:00");
	feed.massive.answer(snapshot([tickerRow("NVDA", 101, 100, ny("2026-11-27T12:59:00"))]), snapshot([tickerRow("NVDA", 102, 100, ny("2026-11-27T13:05:00"))]));
	assert.deepEqual(await feed.round(), { ok: true, records: 1, notices: 0 });
	assert.deepEqual(await feed.round(), { ok: true, records: 0, notices: 0 });
});

test("你的改动：rule-levels 一行写 TSLA 的第一档 7%，下一轮起 TSLA 按 7% 算；别的票照旧 5%", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA", "TSLA");
	feed.levels({ rule: "move-1", symbol: "tsla", threshold: 7, note: "TSLA 的第一档改成 7%" });
	feed.massive.answer(snapshot([tickerRow("TSLA", 105.5, 100, AT), tickerRow("NVDA", 105.5, 100, AT)]), snapshot([tickerRow("TSLA", 107.1, 100, AT + 60_000)]));
	await feed.round();
	assert.deepEqual(band(feed), [`band:NVDA:${DAY}:up5`]);
	await feed.round();
	assert.deepEqual(feed.lines.map((l) => [l.externalId, l.push ?? "ring"]), [[`band:NVDA:${DAY}:up5`, "silent"], [`band:TSLA:${DAY}:up7`, "silent"]]);
	assert.match(feed.alerts()[1]!, /^TSLA 涨 \+7\.10%，到达 \+7% 档。/);
	assert.deepEqual(feed.notices.map((n) => n.id), [`band:NVDA:${DAY}:up5`, `band:TSLA:${DAY}:up7`]);
	assert.deepEqual(feed.problemIds(), ["-", "-"]);
});

test("你的改动：第一档改成 3 层，到档只响铃一行、不开任务；同一条规则以最新的一行为准，写上 removedAt 就回到默认", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA", "AMD", "META");
	feed.levels({ rule: "move-1", level: 2 }, { rule: "move-1", level: 3 });
	feed.massive.answer(snapshot([tickerRow("NVDA", 105.5, 100, AT)]));
	await feed.round();
	assert.deepEqual(feed.lines.map((l) => [l.externalId, l.push ?? "ring"]), [[`band:NVDA:${DAY}:up5`, "ring"]]);
	assert.deepEqual(feed.notices, [], "3 层不开任务");
	feed.levels({ rule: "move-1", level: 3, removedAt: "2026-11-12" });
	feed.massive.answer(snapshot([tickerRow("AMD", 105.5, 100, AT + 60_000)]));
	await feed.round();
	assert.deepEqual(feed.lines.map((l) => l.push ?? "ring"), ["ring", "silent"], "撤回以后回到表里的 5 层静音");
	assert.deepEqual(feed.notices.map((n) => n.id), [`band:AMD:${DAY}:up5`]);
});

test("你的改动：不写代码的门槛只改个股，SPY、QQQ 照旧用自己的档", async (t) => {
	const feed = await quotesFeed(t);
	feed.levels({ rule: "move-1", threshold: 4 });
	feed.massive.answer(snapshot([tickerRow("SPY", 510.5, 500, AT), tickerRow("QQQ", 409, 400, AT)]));
	await feed.round();
	assert.deepEqual(band(feed).sort(), [`band:QQQ:${DAY}:up2`, `band:SPY:${DAY}:up2`]);
});

test("你的改动写坏了（表里没有的规则、层级不在 0 到 6、门槛不是正数）：报问题 bad-level 说是哪几行，这几行不生效，其余照算", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA", "TSLA");
	feed.levels({ rule: "move-9", level: 2 }, { rule: "move-1", level: 9 }, { rule: "move-1", symbol: "NVDA", threshold: -1 }, { rule: "move-1", symbol: "TSLA", threshold: 6 });
	feed.massive.answer(snapshot([tickerRow("NVDA", 105.5, 100, AT), tickerRow("TSLA", 105.5, 100, AT)]));
	await feed.round();
	assert.deepEqual(band(feed), [`band:NVDA:${DAY}:up5`], "NVDA 坏的那行不生效，TSLA 按 6% 没到");
	assert.deepEqual(feed.problemIds(), ["bad-level"]);
	assert.match(feed.problems[0]!.text, /rule-levels 第 1、2、3 行/);
	assert.doesNotMatch(feed.problems[0]!.text, /move-9/, "问题的文字不抄集合里的内容");
});

test("写坏的一行能清掉：同样的 rule 和 symbol 加一行 removedAt，或再加一行写对的，下一轮问题就消失", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.levels({ rule: "move-9", level: 2 }, { rule: "move-1", level: 9 }, { rule: "move-1", symbol: "NVDA", threshold: -1 });
	feed.massive.answer(snapshot([tickerRow("NVDA", 100, 100, AT)]), snapshot([tickerRow("NVDA", 106.5, 100, AT + 60_000)]));
	await feed.round();
	assert.match(feed.problems[0]!.text, /rule-levels 第 1、2、3 行/);
	feed.levels({ rule: "move-9", removedAt: "2026-11-12" }, { rule: "move-1", removedAt: "2026-11-12" }, { rule: "move-1", symbol: "NVDA", threshold: 6 });
	await feed.round();
	assert.deepEqual(feed.problemIds(), ["bad-level", "-"]);
	assert.deepEqual(band(feed), [`band:NVDA:${DAY}:up6`], "写对的那行接替了坏的那行");
});

test("你的改动让第一档门槛不低于第二档：报问题 bad-level 说是哪一行，这一行不生效；SPY、QQQ 按自己的档比", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA", "TSLA");
	feed.levels({ rule: "move-1", symbol: "TSLA", threshold: 9 }, { rule: "move-1", symbol: "SPY", threshold: 4 }, { rule: "move-1", threshold: 4 }, { rule: "move-2", symbol: "NVDA", threshold: 4 });
	feed.massive.answer(snapshot([tickerRow("TSLA", 105.5, 100, AT), tickerRow("SPY", 510.5, 500, AT), tickerRow("NVDA", 104.5, 100, AT)]));
	await feed.round();
	assert.deepEqual(feed.problemIds(), ["bad-level"]);
	assert.match(feed.problems[0]!.text, /rule-levels 第 1、2、4 行/);
	assert.deepEqual(band(feed).sort(), [`band:NVDA:${DAY}:up4`, `band:SPY:${DAY}:up2`, `band:TSLA:${DAY}:up4`], "坏的行不生效，全部个股的第一档 4% 照算");
});

test("一轮跳过两档、第二档调低了：第二档 0 层不吞掉第一档，照发第一档的静音一行和任务", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.levels({ rule: "move-2", level: 0 });
	feed.massive.answer(snapshot([tickerRow("NVDA", 108.2, 100, AT)]), snapshot([tickerRow("NVDA", 109, 100, AT + 60_000)]));
	await feed.round();
	await feed.round();
	assert.deepEqual(feed.lines.map((l) => [l.externalId, l.push ?? "ring"]), [[`band:NVDA:${DAY}:up5`, "silent"]]);
	assert.match(feed.alerts()[0]!, /到达 \+5% 档/);
	assert.deepEqual(feed.notices.map((n) => [n.id, n.body.replace(/^.*（/, "（")]), [[`band:NVDA:${DAY}:up5`, "（规则 move-1，层级 5，做法 band-move）"]]);
});

test("一轮跳过两档、第二档调成 3 层：响铃的第二档一行，任务照第一档开", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.levels({ rule: "move-2", level: 3 });
	feed.massive.answer(snapshot([tickerRow("NVDA", 108.2, 100, AT)]));
	await feed.round();
	assert.deepEqual(feed.lines.map((l) => [l.externalId, l.push ?? "ring"]), [[`band:NVDA:${DAY}:up8`, "ring"]]);
	assert.deepEqual(feed.notices.map((n) => [n.id, n.body.replace(/^.*（/, "（")]), [[`band:NVDA:${DAY}:up8`, "（规则 move-1，层级 5，做法 band-move）"]]);
});

test("一轮跳过两档：第一档 3 层、第二档 2 层，有一档响铃这一行就响", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.levels({ rule: "move-1", level: 3 }, { rule: "move-2", level: 2 });
	feed.massive.answer(snapshot([tickerRow("NVDA", 108.2, 100, AT)]));
	await feed.round();
	assert.deepEqual(feed.lines.map((l) => [l.externalId, l.push ?? "ring"]), [[`band:NVDA:${DAY}:up8`, "ring"]]);
	assert.deepEqual(feed.notices, []);
});

test("档位只在盯盘规则表 watch-rules.ts 里：feed.json 没有 settings.bands，幕僚长读的规则、领队和盘面读的技能、feed 的说明都不写死档位数字", () => {
	const read = (path: string) => readFileSync(join(PKG, path), "utf8");
	const feedJson = JSON.parse(read("feeds/quotes/feed.json"));
	assert.equal("bands" in feedJson.settings, false);
	const watchTask = read("rules.md").split("## ").find((r) => r.startsWith("watch-task"))!;
	const texts = { "rules.md watch-task": watchTask, "feeds/quotes/feed.json description": feedJson.description, "skills/market-desk": read("skills/market-desk/SKILL.md"), "skills/band-move 正文": read("skills/band-move/SKILL.md").split("---").at(-1)!, "skills/rule-levels 正文": read("skills/rule-levels/SKILL.md").split("---").at(-1)! };
	for (const [where, text] of Object.entries(texts)) assert.doesNotMatch(text, /\d+(\.\d+)?% ?档|\d+%、/, `${where} 写死了档位`);
	assert.match(read("watch-rules.ts"), /"move-1"[\s\S]*stock: 5[\s\S]*index: 2[\s\S]*"move-2"[\s\S]*stock: 8[\s\S]*index: 3/);
});

/** The module's daily-bar database as the scan leaves it: `days` complete daily bars before 2026-11-12 per symbol. */
function taDatabase(dataDir: string, bars: Record<string, { days: number; high: number; low: number; volume: number }>) {
	mkdirSync(join(dataDir, "files", "ta"), { recursive: true });
	const db = new DatabaseSync(join(dataDir, "files", "ta", "ta.sqlite"));
	db.exec("CREATE TABLE bars (symbol TEXT NOT NULL, timeframe TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, session_date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, vw REAL, complete INTEGER NOT NULL, PRIMARY KEY (symbol, timeframe, start_ms))");
	const insert = db.prepare("INSERT INTO bars VALUES (?, '1d', ?, ?, ?, 100, ?, ?, 100, ?, NULL, 1)");
	for (const [symbol, b] of Object.entries(bars)) {
		for (let i = 1; i <= b.days; i++) {
			const start = Date.parse("2026-11-12T05:00:00Z") - i * 86_400_000;
			insert.run(symbol, start, start + 86_400_000, new Date(start).toISOString().slice(0, 10), b.high, b.low, b.volume);
		}
	}
	insert.run("NVDA", Date.parse("2026-11-12T05:00:00Z"), Date.parse("2026-11-13T05:00:00Z"), DAY, 999, 1, 1);
	db.close();
}

test("VIXY 总在快照请求里，但不存进自选股报价", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 180.4, 176, AT), tickerRow("VIXY", 17, 16.8, AT)]));
	assert.deepEqual(await feed.round(), { ok: true, records: 1, notices: 0 });
	assert.equal(feed.massive.hits[0]!.url, `${SNAPSHOT}?tickers=NVDA,QQQ,SPY,VIXY`);
	assert.deepEqual(feed.quotes().map((r) => r.fields["symbol"]), ["NVDA"]);
});

test("52 周新高：第一轮只读打开模块自己的日线库，算出此前 252 根日线的最高；当天的日线不算；快照的 day.h 过了就静音一行", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	taDatabase(feed.data.dir("stock-ta"), { NVDA: { days: 260, high: 110, low: 90, volume: 1_000_000 } });
	feed.massive.answer(snapshot([tickerRow("NVDA", 109, 105, AT, { day: { o: 105.5, h: 111.2, l: 104.9, c: 109, v: 400_000 } })]));
	await feed.round();
	assert.deepEqual(feed.lines.map((l) => [l.externalId, l.push ?? "ring"]), [[`high-52w:NVDA:${DAY}`, "silent"]]);
	assert.match(feed.lines[0]!.text, /^NVDA 创 52 周新高 111\.20（此前最高 110\.00）。/);
	assert.deepEqual(feed.notices, []);
});

test("日线库还没有（扫描没跑过）：要历史的规则不算，不报问题，到档照常", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 105.3, 100, AT, { day: { o: 100, h: 999, l: 1, c: 105.3, v: 9e9 } })]));
	await feed.round();
	assert.deepEqual(feed.lines.map((l) => l.externalId), [`band:NVDA:${DAY}:up5`]);
	assert.deepEqual(feed.problemIds(), ["-"]);
});

test("当天命中写进 files/hits/<日期>/quotes.json，和 cursor 里的一样；文件写坏、留下半截的临时文件，下一轮从 cursor 整份重写", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 105.3, 100, AT, { day: { o: 103.2, h: 105.4, l: 102, c: 105.3, v: 1 } })]));
	await feed.round();
	const first = JSON.parse(readFileSync(feed.hitsFile(), "utf8"));
	assert.deepEqual([first.feed, first.date, first.hits.map((h: { rule: string }) => h.rule)], ["quotes", DAY, ["move-1", "gap"]]);
	assert.deepEqual(first.hits, JSON.parse(feed.data.feedState("stock-ta", "stock-ta/quotes").cursor!).hits);
	writeFileSync(feed.hitsFile(), '{"feed":"quotes","hits":[{"id":"half');
	writeFileSync(`${feed.hitsFile()}.tmp`, "half");
	feed.restart();
	await feed.round();
	assert.deepEqual(JSON.parse(readFileSync(feed.hitsFile(), "utf8")), first);
	assert.equal(existsSync(`${feed.hitsFile()}.tmp`), false);
	assert.equal(feed.lines.length, 1, "重启后不重发");
});

test("当天没有命中就不写文件", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 101, 100, AT)]));
	await feed.round();
	assert.equal(existsSync(feed.hitsFile()), false);
});

test("来回翻：前几个交易日的命中文件里开盘跳空翻了 3 次，今天再翻就只记成 0 层", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	const past = [["2026-11-06", "bull"], ["2026-11-09", "bear"], ["2026-11-10", "bull"], ["2026-10-20", "bear"]] as const;
	for (const [date, lean] of past) {
		mkdirSync(dirname(feed.hitsFile(date)), { recursive: true });
		writeFileSync(feed.hitsFile(date), JSON.stringify({ feed: "quotes", date, hits: [{ id: `gap:NVDA:${date}`, rule: "gap", symbol: "NVDA", date, at: `${date}T15:00:00.000Z`, lean, fact: "开盘跳空", level: 1, text: "" }] }));
	}
	feed.massive.answer(snapshot([tickerRow("NVDA", 96.8, 100, AT, { day: { o: 96.5, h: 97, l: 96, c: 96.8, v: 1 } })]));
	await feed.round();
	const [hit] = JSON.parse(readFileSync(feed.hitsFile(), "utf8")).hits;
	assert.deepEqual([hit.rule, hit.level, hit.whipsaw], ["gap", 0, 3], "10 个交易日以外的 10-20 那条不算");
});

test("工具 hits：读最近几天的命中文件，可按代码和最低层级筛，新的在前", async (t) => {
	const feed = await quotesFeed(t);
	const dir = feed.data.dir("stock-ta");
	const hit = (date: string, symbol: string, rule: string, level: number, at: string) => ({ id: `${rule}:${symbol}:${date}`, rule, symbol, date, at, lean: "bull", fact: rule, level, text: `${symbol} ${rule}` });
	for (const [date, hits] of [["2026-11-11", [hit("2026-11-11", "NVDA", "gap", 1, "2026-11-11T15:00:00Z")]], [DAY, [hit(DAY, "NVDA", "high-52w", 2, "2026-11-12T15:00:00Z"), hit(DAY, "AMD", "gap", 1, "2026-11-12T16:00:00Z")]]] as const) {
		mkdirSync(join(dir, "files", "hits", date), { recursive: true });
		writeFileSync(join(dir, "files", "hits", date, "quotes.json"), JSON.stringify({ feed: "quotes", date, hits }));
	}
	const tool = (await import(join(PKG, "tools/hits/index.ts"))).default as (input: unknown) => { hits: { id: string }[]; dates: string[] };
	process.env["PSA_MODULE_DATA"] = dir;
	t.after(() => delete process.env["PSA_MODULE_DATA"]);
	assert.deepEqual(tool({}).hits.map((h) => h.id), [`gap:AMD:${DAY}`, `high-52w:NVDA:${DAY}`]);
	assert.deepEqual(tool({ days: 2, symbol: "nvda" }).hits.map((h) => h.id), [`high-52w:NVDA:${DAY}`, "gap:NVDA:2026-11-11"]);
	assert.deepEqual(tool({ days: 2, minLevel: 2 }).hits.map((h) => h.id), [`high-52w:NVDA:${DAY}`]);
	assert.deepEqual(tool({ days: 2 }).dates, [DAY, "2026-11-11"]);
});

test("持仓：读 holdings，触到止损线响铃一行写数字；触发进这只票当天的持仓线程，正文不带成本和止损价", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.hold({ symbol: "NVDA", cost: 150, stopPrice: 138, note: "NVDA 成本 150，止损 138" });
	feed.massive.answer(snapshot([tickerRow("NVDA", 139.1, 145.2, AT, { day: { o: 145, h: 145.5, l: 137.8, c: 139.1, v: 1 } })]));
	assert.deepEqual(await feed.round(), { ok: true, records: 1, notices: 1 });
	assert.deepEqual(feed.lines.map((l) => [l.externalId, l.push ?? "ring", l.text]), [[`stop-loss:NVDA:${DAY}`, "ring", "NVDA 触到你的止损线 138.00（你设的止损价）。当天最低 137.80，现价 139.10，当天跌 -4.20%。报价时间 10:44 ET（延迟行情）。"]]);
	const [notice] = feed.notices;
	assert.deepEqual([notice!.id, threadId(notice!.threadOwner ?? notice!.source, notice!.thread)], [`stop-loss:NVDA:${DAY}`, `thr_stock-ta:NVDA:${DAY}:holding`]);
	assert.equal(notice!.body, "NVDA 触到你的止损线。现价 139.10，当天跌 -4.20%。报价时间 10:44 ET（延迟行情）。（规则 stop-loss，层级 6，做法 holding-ask）");
	assert.doesNotMatch(notice!.body, /150|138/);
});

test("持仓：从自选股划掉的票，持仓那一行还在也不再盯", async (t) => {
	const feed = await quotesFeed(t);
	const [row] = feed.watch("NVDA").rows;
	feed.watch("AMD");
	feed.hold({ symbol: "NVDA", cost: 150 });
	feed.data.write("stock-ta", feed.entry.components, "watchlist", [{ id: row!.id, removedAt: DAY }], "使用者口述", "test");
	feed.massive.answer(snapshot([tickerRow("NVDA", 139.1, 145.2, AT, { day: { o: 145, h: 145.5, l: 137.8, c: 139.1, v: 1 } })]));
	await feed.round();
	assert.deepEqual([feed.lines, feed.notices], [[], []]);
});

test("持仓写坏了：报问题 bad-holding 说是哪几行、怎么清掉，这只票的持仓规则先停；rule-levels 也写坏时先报 bad-level；加一行写对的就清掉", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA", "AMD");
	feed.hold({ symbol: "NVDA", cost: 0 }, { symbol: "AMD", cost: 100, stopPct: 120 });
	feed.massive.answer(snapshot([tickerRow("NVDA", 101, 100, AT)]));
	await feed.round();
	assert.deepEqual(feed.problemIds(), ["bad-holding"]);
	assert.match(feed.problems[0]!.text, /holdings 第 1、2 行不生效/);
	assert.match(feed.problems[0]!.text, /removedAt/);
	feed.levels({ rule: "move-9", level: 2 });
	await feed.round();
	assert.equal(feed.problemIds().at(-1), "bad-level");
	feed.levels({ rule: "move-9", removedAt: DAY });
	feed.hold({ symbol: "NVDA", cost: 150 }, { symbol: "AMD", removedAt: DAY });
	await feed.round();
	assert.equal(feed.problemIds().at(-1), "-");
});

test("回撤的高点每天从日线库读一次（建仓日期到昨天，当天的日线不算）：当天库换了也照用读到的；换了建仓日期就重读", async (t) => {
	const feed = await quotesFeed(t);
	const dir = feed.data.dir("stock-ta");
	feed.watch("NVDA", "AMD");
	feed.hold({ symbol: "NVDA", cost: 50, boughtAt: "2026-11-01" }, { symbol: "AMD", cost: 50, boughtAt: "2026-11-01" });
	taDatabase(dir, { NVDA: { days: 30, high: 110, low: 90, volume: 1e9 }, AMD: { days: 30, high: 110, low: 90, volume: 1e9 } });
	feed.massive.answer(snapshot([tickerRow("NVDA", 100, 100, AT), tickerRow("AMD", 260, 260, AT)]), snapshot([tickerRow("NVDA", 92, 100, AT + 60_000), tickerRow("AMD", 250, 260, AT + 60_000)]));
	await feed.round();
	assert.deepEqual(feed.lines, []);
	rmSync(join(dir, "files", "ta", "ta.sqlite"));
	taDatabase(dir, { NVDA: { days: 30, high: 300, low: 90, volume: 1e9 }, AMD: { days: 30, high: 300, low: 90, volume: 1e9 } });
	feed.hold({ symbol: "AMD", cost: 50, boughtAt: "2026-11-02" });
	await feed.round();
	assert.deepEqual(feed.lines.filter((l) => l.externalId.startsWith("drawdown:")).map((l) => l.text.split("，")[0]), ["NVDA 从建仓以来的高点 110.00 回撤 16.36%", "AMD 从建仓以来的高点 300.00 回撤 16.67%"]);
});
