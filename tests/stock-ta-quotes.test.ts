import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Modules } from "../src/modules.ts";
import { runFeed, type FeedNotice, type FeedPorts } from "../src/modules/feed-runner.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { problemLine, scanPackage } from "../src/modules/validate.ts";
import { Kernel } from "../src/kernel/kernel.ts";
import { openStore } from "../src/kernel/store.ts";
import { threadId } from "../src/sources/generic.ts";
import { servedAsHost } from "./helpers/fakes.ts";
import { snapshotBody, tickerRow } from "./helpers/market.ts";

const PKG = join(import.meta.dirname, "../docs/modules/examples/stock-ta");
const SNAPSHOT = "/v2/snapshot/locale/us/markets/stocks/tickers";
const AT = Date.parse("2026-11-12T15:44:00Z");

type Answer = { status: number; body: unknown };
type Hit = { url: string; auth: string | undefined };

async function fakeMassive(t: TestContext) {
	const hits: Hit[] = [];
	let answers: Answer[] = [];
	const server = createServer((req, res) => {
		hits.push({ url: req.url ?? "", auth: req.headers.authorization });
		const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
		res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => new Promise((done) => server.close(done)));
	const { port } = server.address() as { port: number };
	return { hits, base: `http://127.0.0.1:${port}`, answer: (...next: Answer[]) => void (answers = next) };
}

const snapshot = (rows: Record<string, unknown>[]): Answer => ({ status: 200, body: snapshotBody(rows) });

async function quotesFeed(t: TestContext, key = "sk-test") {
	const massive = await fakeMassive(t);
	const root = mkdtempSync(join(tmpdir(), "psa-stock-ta-quotes-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "modules", "stock-ta");
	cpSync(PKG, pkg, { recursive: true });
	const feedJson = join(pkg, "feeds", "quotes", "feed.json");
	writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), settings: { baseUrl: massive.base } }));
	const modules = servedAsHost(Modules.load([join(root, "modules")]));
	const entry = modules.feeds().find((e) => e.source === "stock-ta/quotes");
	assert.ok(entry, "stock-ta 有 quotes feed");
	const data = instanceData(join(root, "state"));
	const notices: FeedNotice[] = [];
	const alerts: string[] = [];
	const ports: FeedPorts = { data, submit: (n) => void notices.push(n), alert: (_, a) => void alerts.push(a.text), secret: (name) => (name === "POLYGON_API_KEY" && key !== "" ? key : undefined), now: () => AT + 15 * 60_000 };
	const watch = (...symbols: string[]) => data.write("stock-ta", entry.components, "watchlist", symbols.map((symbol) => ({ symbol })), "使用者口述", "test");
	const quotes = () => data.query("stock-ta", entry.components, "quotes", {}, "test").rows;
	return { massive, modules, entry, data, notices, alerts, watch, quotes, round: () => runFeed(entry, [], ports), rehearse: () => runFeed(entry, [], ports, entry.fixtures[0]) };
}

test("快照解析：一次请求取回整张自选股，每只一行，带价格、相对昨收的涨跌幅、成交量和数据时间", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA", "amd");
	feed.massive.answer(snapshot([tickerRow("AMD", 151.5, 150, AT), tickerRow("NVDA", 180.4, 176, AT)]));
	assert.deepEqual(await feed.round(), { ok: true, records: 2, notices: 0 });
	assert.equal(feed.massive.hits.length, 1);
	assert.equal(feed.massive.hits[0]!.url, `${SNAPSHOT}?tickers=AMD,NVDA`);
	assert.equal(feed.massive.hits[0]!.auth, "Bearer sk-test");
	const nvda = feed.quotes().find((r) => r.fields["symbol"] === "NVDA");
	assert.deepEqual(nvda?.fields, { symbol: "NVDA", price: 180.4, changePct: 2.5, volume: 5_000_000, at: "2026-11-12T15:44:00.000Z" });
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

test("自选股改了下一轮就用新名单；划掉的不再请求；名单空着不请求", async (t) => {
	const feed = await quotesFeed(t);
	assert.deepEqual(await feed.round(), { ok: true, records: 0, notices: 0 });
	assert.equal(feed.massive.hits.length, 0, "名单空着不请求");
	const written = feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 180.4, 176, AT), tickerRow("AAPL", 230, 229, AT)]));
	await feed.round();
	feed.watch("AAPL");
	await feed.round();
	assert.deepEqual(feed.massive.hits.map((h) => h.url), [`${SNAPSHOT}?tickers=NVDA`, `${SNAPSHOT}?tickers=AAPL,NVDA`]);
	feed.data.write("stock-ta", feed.entry.components, "watchlist", [{ id: written.rows[0]!.id, removedAt: "2026-11-12" }], "使用者口述", "test");
	await feed.round();
	assert.equal(feed.massive.hits.at(-1)!.url, `${SNAPSHOT}?tickers=AAPL`);
});

test("同一只股票有两行：以最新的一行为准，最新一行划掉了就不再请求，划掉后又加回来就照常请求", async (t) => {
	const feed = await quotesFeed(t);
	feed.massive.answer(snapshot([tickerRow("NVDA", 180.4, 176, AT)]));
	const [first] = feed.watch("NVDA").rows;
	const [second] = feed.watch("NVDA").rows;
	feed.data.write("stock-ta", feed.entry.components, "watchlist", [{ id: second!.id, removedAt: "2026-11-12" }], "使用者口述", "test");
	assert.deepEqual(await feed.round(), { ok: true, records: 0, notices: 0 });
	assert.equal(feed.massive.hits.length, 0, `最新一行（${second!.id}）划掉了，较早的 ${first!.id} 不算`);
	feed.watch("NVDA");
	await feed.round();
	assert.equal(feed.massive.hits.at(-1)?.url, `${SNAPSHOT}?tickers=NVDA`);
});

test("缺密钥：不发请求，这一轮失败，一行说明去哪里设 POLYGON_API_KEY", async (t) => {
	const feed = await quotesFeed(t, "");
	feed.watch("NVDA");
	feed.massive.answer({ status: 401, body: { status: "ERROR" } });
	const run = await feed.round();
	assert.equal(run.ok, false);
	const note = run.ok ? "" : run.note;
	assert.match(note, /没有设置 POLYGON_API_KEY/);
	assert.equal(note.split("\n").length, 1);
	assert.equal(feed.massive.hits.length, 0, "没有密钥就不去敲行情服务的门");
	assert.equal(feed.quotes().length, 0);
});

test("样例排练：样例代替网络，没有密钥也照常跑完", async (t) => {
	const feed = await quotesFeed(t, "");
	assert.deepEqual(await feed.rehearse(), { ok: true, records: 2, notices: 1 });
});

test("接口出错：这一轮失败，说出状态码，不存任何东西", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer({ status: 500, body: { status: "ERROR" } });
	const run = await feed.round();
	assert.equal(run.ok, false);
	assert.match(run.ok ? "" : run.note, /500/);
	feed.massive.answer({ status: 200, body: { status: "OK" } });
	const shapeless = await feed.round();
	assert.equal(shapeless.ok, false, "应答里没有 tickers 也算这一轮失败");
	assert.equal(feed.quotes().length, 0);
});

test("涨跌 5%：NVDA 跌 5.2% 发一条触发，同一天同方向的 id 不变，涨 5% 是另一条；不到 5% 不发", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA", "AMD", "AAPL");
	feed.massive.answer(
		snapshot([tickerRow("NVDA", 94.8, 100, AT), tickerRow("AMD", 104.99, 100, AT), tickerRow("AAPL", 95.01, 100, AT)]),
		snapshot([tickerRow("NVDA", 94.5, 100, AT + 60_000)]),
		snapshot([tickerRow("NVDA", 105, 100, AT + 120_000)]),
	);
	assert.deepEqual(await feed.round(), { ok: true, records: 3, notices: 1 });
	await feed.round();
	await feed.round();
	assert.deepEqual(feed.notices.map((n) => n.id), ["big-move:NVDA:2026-11-12:down", "big-move:NVDA:2026-11-12:down", "big-move:NVDA:2026-11-12:up"]);
	const body = feed.notices[0]!.body;
	assert.match(body, /NVDA/);
	assert.match(body, /跌/);
	assert.match(body, /94\.80/);
	assert.match(body, /-5\.20%/);
	assert.doesNotMatch(body, /跌 -|\+-|--/);
	assert.match(body, /2026-11-12 10:44/, "数据时间按美东写");
	assert.match(body, /延迟 15 分钟/);
	assert.match(feed.notices[2]!.body, /\+5\.00%/);
	assert.equal(feed.notices[0]!.source, "stock-ta/quotes");
	assert.equal(feed.notices[0]!.thread, "big-move:NVDA:2026-11-12:down", "每只股票每天每个方向一条线程");
});

test("先跌 5% 的任务还开着，同一天反过来涨 5%：另开一个任务，不落进前一个任务", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.massive.answer(snapshot([tickerRow("NVDA", 94.8, 100, AT)]), snapshot([tickerRow("NVDA", 105, 100, AT + 60_000)]));
	await feed.round();
	await feed.round();
	const kernel = new Kernel({ db: openStore(":memory:"), clock: { now: () => AT }, sourcePolicy: () => "candidate" });
	const submit = (n: FeedNotice) => kernel.submitTrigger({ source: n.source, externalId: n.id, threads: [{ id: threadId(n.source, n.thread) }], sender: n.source, body: n.body, occurredAt: n.at });
	const [down, up] = feed.notices;
	const first = submit(down!);
	kernel.route([{ kind: "open_ticket", basis: "rule", ruleId: "stock-ta/big-move", triggerId: first.triggerId, title: "看 NVDA 跌 5%", brief: "看结构", threads: [threadId(down!.source, down!.thread)] }]);
	assert.ok(kernel.listTickets().length === 1 && !["stopped", "closed"].includes(kernel.listTickets()[0]!.stage), "跌 5% 的任务还开着");
	const second = submit(up!);
	assert.equal(kernel.triggerLog().find((tr) => tr.id === second.triggerId)?.disposition, "to_router");
});

test("报价的提醒条件：提醒里的数据时间按美东写，存的仍是 UTC 时间", async (t) => {
	const feed = await quotesFeed(t);
	feed.watch("NVDA");
	feed.data.watch("stock-ta", feed.entry.components, { kind: "watch", collection: "quotes" as never, op: "set", watch: { key: "NVDA", condition: { when: "below", value: 171 } } }, "test");
	feed.massive.answer(snapshot([tickerRow("NVDA", 170, 176, AT)]));
	await feed.round();
	assert.equal(feed.alerts.length, 1);
	assert.match(feed.alerts[0]!, /（2026-11-12 10:44 美东，来自 stock-ta\/quotes）/);
	assert.equal(feed.quotes()[0]!.fields["at"], "2026-11-12T15:44:00.000Z");
});

test("规则：stock-ta/quotes 的触发有一条规则可用，规则把任务交给技术分析研究组", async (t) => {
	const feed = await quotesFeed(t);
	assert.deepEqual(feed.modules.rulesFor("stock-ta/quotes"), ["stock-ta/big-move"]);
	const rule = feed.modules.allRules().find((r) => r.id === "stock-ta/big-move");
	for (const said of ["structure-pattern", "trend-momentum", "数据时间", "不是交易指令", "只是数据"]) assert.match(rule?.text ?? "", new RegExp(said));
	assert.equal(feed.modules.book.get("stock-ta")?.team, "技术分析研究组");
});

test("stock-ta 包通过检查：quotes 的样例跑过 handler，不需要真的密钥", () => {
	const result = scanPackage(PKG, { secret: () => undefined });
	assert.ok(result.ok, result.ok ? "" : result.problems.map(problemLine).join("\n"));
	const feed = result.scan.components.find((c) => c.kind === "feeds" && c.name === "quotes");
	assert.ok(feed?.kind === "feeds" && feed.fixtures.length > 0);
	assert.deepEqual({ every: feed.feed.every, when: feed.feed.when, secrets: feed.feed.secrets, into: feed.feed.into, reads: feed.feed.reads }, { every: "60s", when: "us-market-hours", secrets: ["POLYGON_API_KEY"], into: "quotes", reads: ["watchlist"] });
});
