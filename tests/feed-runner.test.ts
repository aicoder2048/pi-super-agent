import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Modules } from "../src/modules.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { runFeed, type FeedNotice } from "../src/modules/feed-runner.ts";
import type { Alert } from "../src/modules/protocol.ts";
import { problemLine, scanPackage } from "../src/modules/validate.ts";
import { servedAsHost } from "./helpers/fakes.ts";

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
