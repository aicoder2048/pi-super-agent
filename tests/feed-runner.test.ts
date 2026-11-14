import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Modules } from "../src/modules.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { runFeed, type FeedNotice } from "../src/modules/feed-runner.ts";
import type { Alert, Badge } from "../src/modules/protocol.ts";
import { problemLine, scanPackage } from "../src/modules/validate.ts";
import { servedAsHost } from "./helpers/fakes.ts";
import { Kernel } from "../src/kernel/kernel.ts";
import { openStore } from "../src/kernel/store.ts";
import { threadId } from "../src/sources/generic.ts";

const TAX = join(import.meta.dirname, "../docs/modules/architecture/sample/personal-tax");

function taxCopy(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "psa-feed-runner-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	cpSync(TAX, join(root, "modules", "personal-tax"), { recursive: true });
	return { root, pkg: join(root, "modules", "personal-tax") };
}

const brokerage = (root: string) => {
	const entry = servedAsHost(Modules.load([join(root, "modules")])).feeds().find((e) => e.source === "personal-tax/brokerage-statements");
	assert.ok(entry);
	return entry;
};

test("fixtures 代替网络：券商样例按样例应答得到两行记录、一条触发和新的进度", async (t) => {
	const { root } = taxCopy(t);
	const entry = brokerage(root);
	const fixture = entry.fixtures.find((f) => f.name === "two-trades");
	assert.ok(fixture, "样例读进了 fixtures");
	const data = instanceData(join(root, "state"));
	const submitted: FeedNotice[] = [];
	const run = await runFeed(entry, [], { data, submit: (n) => void submitted.push(n), alert: () => {}, problem: () => {}, secret: () => undefined, now: () => Date.parse("2026-11-12T00:00:00Z") }, fixture);
	assert.deepEqual(run, { ok: true, records: 2, notices: 1 });
	assert.equal(data.query(entry.module, entry.components, "transactions", {}, "test").rows.length, 2);
	assert.equal(submitted[0]!.body, "券商有 2 笔新成交，已实现盈亏合计 294.20 美元。");
	assert.equal(data.feedState(entry.module, entry.source).cursor, "2026-03-05");
});

test("fixtures 没给的网址：这一次失败，说出是哪个网址，不存任何东西", async (t) => {
	const { root } = taxCopy(t);
	const entry = brokerage(root);
	const fixture = { name: "wrong", input: { settings: { account: "OTHER" } }, responses: entry.fixtures[0]!.responses };
	const data = instanceData(join(root, "state"));
	const run = await runFeed(entry, [], { data, submit: () => {}, alert: () => {}, problem: () => {}, secret: () => undefined, now: () => 0 }, fixture);
	assert.equal(run.ok, false);
	assert.match(!run.ok ? run.note : "", /accounts\/OTHER\/trades/);
	assert.equal(data.feedState(entry.module, entry.source).cursor, null);
});

test("just module check 用 fixtures 跑 handler：样例包通过；handler 交回的行有 into 里没有的字段时说出问题", async (t) => {
	const { pkg } = taxCopy(t);
	const ok = scanPackage(pkg);
	assert.ok(ok.ok, ok.ok ? "" : ok.problems.map(problemLine).join("\n"));
	writeFileSync(join(pkg, "feeds", "brokerage-statements", "index.ts"), `export default async function () {\n\tawait fetch("https://api.broker.example/v1/accounts/A-1/trades?since=1970-01-01");\n\treturn { records: [{ id: "t", ticker: "VTI" }] };\n}\n`);
	const bad = scanPackage(pkg);
	assert.equal(bad.ok, false);
	assert.match(bad.ok ? "" : bad.problems.map(problemLine).join("\n"), /feeds\/brokerage-statements\/fixtures\/two-trades\.json.*"ticker"/);
});

test("feed 的输入里有 now：宿主时钟的 ISO 时间，handler 不用读自己的挂钟", async (t) => {
	const { root, pkg } = taxCopy(t);
	writeFileSync(join(pkg, "feeds", "brokerage-statements", "index.ts"), "export default (input: { now: string }) => ({ cursor: input.now });\n");
	const entry = brokerage(root);
	const data = instanceData(join(root, "state"));
	const run = await runFeed(entry, [], { data, submit: () => {}, alert: () => {}, problem: () => {}, secret: () => "token", now: () => Date.parse("2026-11-12T15:05:00Z") });
	assert.deepEqual(run, { ok: true, records: 0, notices: 0 });
	assert.equal(data.feedState(entry.module, entry.source).cursor, "2026-11-12T15:05:00.000Z");
});

test("handler 交回的 alerts 经 ports.alert 当模块提醒行贴出，在触发之前；宿主说贴过了的 externalId 不再算新的", async (t) => {
	const { root, pkg } = taxCopy(t);
	writeFileSync(join(pkg, "feeds", "brokerage-statements", "index.ts"), `export default () => ({ alerts: [{ id: "a-1", text: "到了一档", at: "2026-11-12T15:05:00Z" }], notices: [{ id: "a-1", fields: {} }] });\n`);
	const entry = brokerage(root);
	const data = instanceData(join(root, "state"));
	const order: string[] = [];
	const seen = new Set<string>();
	const ports = {
		data, problem: () => {}, secret: () => "token", now: () => 0,
		submit: (n: FeedNotice) => void order.push(`trigger ${n.id}`),
		alert: (module: string, a: Alert) => {
			order.push(`line ${module} ${a.externalId} ${a.text} ${a.at}`);
			return !seen.has(a.externalId) && seen.add(a.externalId).size > 0;
		},
	};
	await runFeed(entry, [], ports);
	await runFeed(entry, [], ports);
	assert.deepEqual(order.slice(0, 2), ["line personal-tax a-1 到了一档 2026-11-12T15:05:00Z", "trigger a-1"]);
	assert.equal(seen.size, 1);
});

test("handler 交回的提醒写了 push: silent：ports.alert 收到的那一行也带着静音；没写的照旧响铃", async (t) => {
	const { root, pkg } = taxCopy(t);
	writeFileSync(join(pkg, "feeds", "brokerage-statements", "index.ts"), `export default () => ({ alerts: [{ id: "q", text: "静音一行", at: "2026-11-12T15:05:00Z", push: "silent" }, { id: "r", text: "响铃一行", at: "2026-11-12T15:05:00Z" }] });\n`);
	const lines: Alert[] = [];
	await runFeed(brokerage(root), [], { data: instanceData(join(root, "state")), submit: () => {}, alert: (_, a) => lines.push(a) > 0, problem: () => {}, secret: () => "token", now: () => 0 });
	assert.deepEqual(lines, [{ externalId: "q", text: "静音一行", at: "2026-11-12T15:05:00Z", push: "silent" }, { externalId: "r", text: "响铃一行", at: "2026-11-12T15:05:00Z" }]);
});

test("提醒的 push 只认 silent 和 badge：别的值这一轮失败，说出要什么", async (t) => {
	const { root, pkg } = taxCopy(t);
	writeFileSync(join(pkg, "feeds", "brokerage-statements", "index.ts"), `export default () => ({ alerts: [{ id: "a-1", text: "x", at: "2026-11-12T15:05:00Z", push: "loud" }] });\n`);
	const run = await runFeed(brokerage(root), [], { data: instanceData(join(root, "state")), submit: () => {}, alert: () => true, problem: () => {}, secret: () => "token", now: () => 0 });
	assert.equal(run.ok, false);
	assert.match(run.ok ? "" : run.note, /push 只能是 silent 或 badge/);
});

test("页面标记：push: badge 的提醒交给 ports.badge，不走 ports.alert；key 不写就是 id", async (t) => {
	const { root, pkg } = taxCopy(t);
	writeFileSync(join(pkg, "feeds", "brokerage-statements", "index.ts"), `export default () => ({ alerts: [{ id: "b-1", text: "NVDA · 开盘跳空 +3.40%", at: "2026-11-12T15:05:00Z", push: "badge", key: "NVDA" }, { id: "b-2", text: "AMD · 盘中反转", at: "2026-11-12T15:05:00Z", push: "badge" }, { id: "r", text: "响铃一行", at: "2026-11-12T15:05:00Z" }] });\n`);
	const lines: Alert[] = [];
	const badges: Badge[] = [];
	await runFeed(brokerage(root), [], { data: instanceData(join(root, "state")), submit: () => {}, alert: (_, a) => lines.push(a) > 0, badge: (_, b) => void badges.push(b), problem: () => {}, secret: () => "token", now: () => 0 });
	assert.deepEqual(badges, [{ key: "NVDA", text: "NVDA · 开盘跳空 +3.40%", at: "2026-11-12T15:05:00Z" }, { key: "b-2", text: "AMD · 盘中反转", at: "2026-11-12T15:05:00Z" }]);
	assert.deepEqual(lines.map((l) => l.externalId), ["r"]);
});

test("页面标记：key 只跟着 badge 走，要是不空的文字；写错这一轮失败，说出原因", async (t) => {
	const { root, pkg } = taxCopy(t);
	for (const alert of [`{ id: "a", text: "x", at: "2026-11-12T15:05:00Z", key: "NVDA" }`, `{ id: "a", text: "x", at: "2026-11-12T15:05:00Z", push: "silent", key: "NVDA" }`, `{ id: "a", text: "x", at: "2026-11-12T15:05:00Z", push: "badge", key: "" }`, `{ id: "a", text: "x", at: "2026-11-12T15:05:00Z", push: "badge", key: 7 }`, `{ id: "a", text: "x", at: "2026-11-12T15:05:00Z", push: "badge", fold: { key: "NVDA", side: "up" } }`]) {
		writeFileSync(join(pkg, "feeds", "brokerage-statements", "index.ts"), `export default () => ({ alerts: [${alert}] });\n`);
		const run = await runFeed(brokerage(root), [], { data: instanceData(join(root, "state")), submit: () => {}, alert: () => true, problem: () => {}, secret: () => "token", now: () => 0 });
		assert.equal(run.ok, false, alert);
		assert.match(run.ok ? "" : run.note, /key 只给 push: badge 用|badge 的那一项不能 fold/, alert);
	}
});

test("alerts 的形状不对：这一轮失败，说出要什么", async (t) => {
	const { root, pkg } = taxCopy(t);
	writeFileSync(join(pkg, "feeds", "brokerage-statements", "index.ts"), `export default () => ({ alerts: [{ id: "a-1" }] });\n`);
	const run = await runFeed(brokerage(root), [], { data: instanceData(join(root, "state")), submit: () => {}, alert: () => true, problem: () => {}, secret: () => "token", now: () => 0 });
	assert.equal(run.ok, false);
	assert.match(run.ok ? "" : run.note, /alerts 要是一列 \{ id, text, at \}/);
});

test("problem 的 once 不是 true：这一轮失败，说出要什么", async (t) => {
	const { root, pkg } = taxCopy(t);
	writeFileSync(join(pkg, "feeds", "brokerage-statements", "index.ts"), `export default () => ({ problem: { id: "gap", text: "断了一天", once: "yes" } });\n`);
	const run = await runFeed(brokerage(root), [], { data: instanceData(join(root, "state")), submit: () => {}, alert: () => true, problem: () => {}, secret: () => "token", now: () => 0 });
	assert.equal(run.ok, false);
	assert.match(run.ok ? "" : run.note, /once 只能是 true/);
});

test("触发写了 threadScope: module：线程挂在模块名下，同一模块的两个 feed 落进同一个线程；没写的挂在 feed 自己的来源名下", async (t) => {
	const { root, pkg } = taxCopy(t);
	const feed = join(pkg, "feeds", "brokerage-statements");
	const descriptor = JSON.parse(readFileSync(join(feed, "feed.json"), "utf8"));
	writeFileSync(join(feed, "feed.json"), JSON.stringify({ ...descriptor, notice: "{{line}}" }));
	writeFileSync(join(feed, "index.ts"), `export default () => ({ notices: [{ id: "a", thread: "VTI:2026-11-13", threadScope: "module", fields: { line: "共用" } }, { id: "b", thread: "VTI:2026-11-13", fields: { line: "自己的" } }] });\n`);
	const submitted: FeedNotice[] = [];
	const run = await runFeed(brokerage(root), [], { data: instanceData(join(root, "state")), submit: (n) => void submitted.push(n), alert: () => true, problem: () => {}, secret: () => "token", now: () => 0 });
	assert.deepEqual(run, { ok: true, records: 0, notices: 2 });
	assert.deepEqual(submitted.map((n) => [n.id, threadId(n.threadOwner ?? n.source, n.thread)]), [
		["a", "thr_personal-tax:VTI:2026-11-13"],
		["b", "thr_personal-tax/brokerage-statements:VTI:2026-11-13"],
	]);
});

test("threadScope 只认 module：别的值这一轮失败，说出要什么", async (t) => {
	const { root, pkg } = taxCopy(t);
	writeFileSync(join(pkg, "feeds", "brokerage-statements", "index.ts"), `export default () => ({ notices: [{ id: "a", thread: "x", threadScope: "host", fields: {} }] });\n`);
	const run = await runFeed(brokerage(root), [], { data: instanceData(join(root, "state")), submit: () => {}, alert: () => true, problem: () => {}, secret: () => "token", now: () => 0 });
	assert.equal(run.ok, false);
	assert.match(run.ok ? "" : run.note, /threadScope 只能是 module/);
});

test("模块名下的线程：报价 feed 的触发开的任务还开着时，扫描 feed 同一线程的触发直接交给这个任务", () => {
	const kernel = new Kernel({ db: openStore(":memory:"), clock: { now: () => Date.now() }, sourcePolicy: () => "candidate" });
	const thread = "thr_stock-ta:NVDA:2026-11-13";
	const submit = (source: string, externalId: string) => kernel.submitTrigger({ source, externalId, threads: [{ id: thread }], sender: source, body: "事件", occurredAt: Date.now() });
	const band = submit("stock-ta/quotes", "band:NVDA:2026-11-13:down5");
	const [opened] = kernel.route([{ kind: "open_ticket", title: "NVDA 到档", basis: "rule", ruleId: "stock-ta/watch-task", triggerId: band.triggerId, threads: [thread], brief: "看一下" }]);
	assert.ok(opened.ok, !opened.ok ? opened.reason : "");
	submit("stock-ta/scan", "R-MA-2-200:NVDA:2026-11-13");
	const view = kernel.read(opened.ticketId!) as { recentInputs: { triggerId: string | null }[] };
	assert.equal(view.recentInputs.filter((i) => i.triggerId !== null).length, 2, "收盘的触发进了白天开的同一个任务");
});
