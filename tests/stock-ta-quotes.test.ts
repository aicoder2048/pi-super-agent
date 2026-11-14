import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
	const quotes = () => data.query("stock-ta", entry.components, "quotes", {}, "test").rows;
	const restart = () => (ports.data = instanceData(state));
	return { massive, modules, entry, data, notices, lines, problems, problemIds: () => problems.map((p) => p?.id ?? "-"), alerts: () => lines.map((l) => l.text), watch, quotes, clock, restart, round: () => runFeed(entry, [], ports), rehearse: () => runFeed(entry, [], ports, entry.fixtures[0]) };
}

test("快照解析：一次请求取回整张自选股，每只一行，带价格、相对昨收的涨跌幅、成交量和数据时间", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA", "amd");
	feed.massive.answer(snapshot([tickerRow("AMD", 151.5, 150, AT), tickerRow("NVDA", 180.4, 176, AT)]));
	assert.deepEqual(await feed.round(), { ok: true, records: 2, notices: 0 });
	assert.equal(feed.massive.hits.length, 1);
	assert.equal(feed.massive.hits[0]!.url, `${SNAPSHOT}?tickers=AMD,NVDA,QQQ,SPY`);
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
	assert.deepEqual(feed.massive.hits.map((h) => h.url), [`${SNAPSHOT}?tickers=QQQ,SPY`, `${SNAPSHOT}?tickers=NVDA,QQQ,SPY`, `${SNAPSHOT}?tickers=AAPL,NVDA,QQQ,SPY`]);
	feed.data.write("stock-ta", feed.entry.components, "watchlist", [{ id: written.rows[0]!.id, removedAt: "2026-11-12" }], "使用者口述", "test");
	await feed.round();
	assert.equal(feed.massive.hits.at(-1)!.url, `${SNAPSHOT}?tickers=AAPL,QQQ,SPY`);
});

test("同一只股票有两行：以最新的一行为准，最新一行划掉了就不再请求它，划掉后又加回来就照常请求", async (t) => {
	const feed = await quotesFeed(t);
	feed.massive.answer(snapshot([tickerRow("NVDA", 180.4, 176, AT)]));
	const [first] = feed.watch("NVDA").rows;
	const [second] = feed.watch("NVDA").rows;
	feed.data.write("stock-ta", feed.entry.components, "watchlist", [{ id: second!.id, removedAt: "2026-11-12" }], "使用者口述", "test");
	assert.deepEqual(await feed.round(), { ok: true, records: 0, notices: 0 });
	assert.equal(feed.massive.hits.at(-1)?.url, `${SNAPSHOT}?tickers=QQQ,SPY`, `最新一行（${second!.id}）划掉了，较早的 ${first!.id} 不算`);
	feed.watch("NVDA");
	await feed.round();
	assert.equal(feed.massive.hits.at(-1)?.url, `${SNAPSHOT}?tickers=NVDA,QQQ,SPY`);
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
	assert.equal(feed.notices[0]!.body, feed.alerts()[0], "触发正文就是那一行");
	assert.equal(feed.notices[0]!.thread, `NVDA:${DAY}`);
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
});

test("SPY、QQQ 总在请求里，不在自选股里也取、也存行；还是一次快照请求", async (t) => {
	const feed = await quotesFeed(t);
	feed.massive.answer(snapshot([tickerRow("SPY", 501, 500, AT), tickerRow("QQQ", 401, 400, AT)]));
	await feed.round();
	feed.watch("NVDA");
	await feed.round();
	assert.deepEqual(feed.massive.hits.map((h) => h.url), [`${SNAPSHOT}?tickers=QQQ,SPY`, `${SNAPSHOT}?tickers=NVDA,QQQ,SPY`]);
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

test("规则：stock-ta/quotes 的触发有一条规则可用，规则把任务交给技术分析研究组", async (t) => {
	const feed = await quotesFeed(t);
	assert.deepEqual(feed.modules.rulesFor("stock-ta/quotes"), ["stock-ta/big-move"]);
	const rule = feed.modules.allRules().find((r) => r.id === "stock-ta/big-move");
	for (const said of ["market-desk", "structure-pattern", "trend-momentum", "同一轮", "先写盘面", "同一个任务", "数据时间", "不是交易指令", "只是数据"]) assert.match(rule?.text ?? "", new RegExp(said));
	assert.equal(feed.modules.book.get("stock-ta")?.team, "技术分析研究组");
});

test("stock-ta 包通过检查：quotes 的样例跑过 handler，不需要真的密钥", () => {
	const result = scanPackage(PKG, { secret: () => undefined });
	assert.ok(result.ok, result.ok ? "" : result.problems.map(problemLine).join("\n"));
	const feed = result.scan.components.find((c) => c.kind === "feeds" && c.name === "quotes");
	assert.ok(feed?.kind === "feeds" && feed.fixtures.length > 0);
	assert.deepEqual({ every: feed.feed.every, when: feed.feed.when, secrets: feed.feed.secrets, into: feed.feed.into, reads: feed.feed.reads }, { every: "60s", when: "us-market-hours", secrets: ["POLYGON_API_KEY"], into: "quotes", reads: ["watchlist"] });
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

test("档位只有 feed.json 的 settings.bands 一处：改成 3%、6% 后，3% 的涨幅就发一行提醒和一条触发，规则照样接得住", async (t) => {
	const feed = await quotesFeed(t, "sk-test", { bands: { default: [3, 6], bySymbol: {} } });
	feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 103.2, 100, AT)]));
	assert.deepEqual(await feed.round(), { ok: true, records: 1, notices: 1 });
	assert.deepEqual(band(feed), [`band:NVDA:${DAY}:up3`]);
	assert.deepEqual(feed.modules.rulesFor("stock-ta/quotes"), ["stock-ta/big-move"]);
});

test("档位只有一处：幕僚长读的规则、领队和盘面读的技能、feed 的说明都不写死档位数字", () => {
	const read = (path: string) => readFileSync(join(PKG, path), "utf8");
	const bigMove = read("rules.md").split("## ").find((r) => r.startsWith("big-move"))!;
	const texts = { "rules.md big-move": bigMove, "feeds/quotes/feed.json description": JSON.parse(read("feeds/quotes/feed.json")).description, "skills/market-desk": read("skills/market-desk/SKILL.md"), "skills/band-move 正文": read("skills/band-move/SKILL.md").split("---").at(-1)! };
	for (const [where, text] of Object.entries(texts)) assert.doesNotMatch(text, /\d+(\.\d+)?% ?档|\d+%、/, `${where} 写死了档位`);
	assert.match(bigMove, /settings\.bands/);
});

test("档位改坏了（不是 { default, bySymbol }）：检查不过，宿主不会换上，旧版本照用", (t) => {
	const pkg = stockTaCopy(t, "https://api.massive.com", { bands: [5, 8] });
	const result = scanPackage(pkg, { secret: () => undefined });
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.problems.map(problemLine).join("\n"), /feeds\/quotes/);
});
