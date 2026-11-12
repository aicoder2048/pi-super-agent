import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { runModuleCodeAsync, type CodeReply } from "../src/modules/run-code.ts";
import { scanPackage, summary } from "../src/modules/validate.ts";

const PKG = join(import.meta.dirname, "../docs/modules/examples/stock-ta");
const HOUR = 3_600_000;
const SYNCED = Date.UTC(2026, 10, 10, 8, 28, 40);

type Reply = { status?: number; stdout?: unknown; stderr?: string };
type Call = { argv: string[]; stdin: Record<string, unknown>; db: string | undefined; network: string | undefined };

function fakeProject(t: TestContext, replies: Record<string, Reply>, synced: Record<string, number> = { NVDA: SYNCED, QQQ: SYNCED, SPY: SYNCED }) {
	const root = mkdtempSync(join(tmpdir(), "psa-stock-ta-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "app/trading"), { recursive: true });
	mkdirSync(join(root, "app/data"), { recursive: true });
	mkdirSync(join(root, "bin"));
	const db = new DatabaseSync(join(root, "app/data/ta.sqlite"));
	db.exec("CREATE TABLE dividend_sync (symbol TEXT PRIMARY KEY, start_date TEXT NOT NULL, synced_ms INTEGER NOT NULL)");
	for (const [symbol, ms] of Object.entries(synced)) db.prepare("INSERT INTO dividend_sync VALUES (?, '2024-11-05', ?)").run(symbol, ms);
	db.close();
	writeFileSync(join(root, "replies.json"), JSON.stringify(replies));
	writeFileSync(
		join(root, "bin/uv"),
		`#!${process.execPath}
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (c) => (stdin += c)).on("end", () => {
	const argv = process.argv.slice(2);
	const env = process.env;
	fs.appendFileSync(env.TA_ROOT + "/calls.jsonl", JSON.stringify({ argv, stdin: JSON.parse(stdin), db: env.TA_DB_PATH, network: env.MASSIVE_BASE_URL }) + "\\n");
	if (env.TA_DB_PATH) fs.appendFileSync(env.TA_DB_PATH, "x");
	const reply = JSON.parse(fs.readFileSync(env.TA_ROOT + "/replies.json", "utf8"))[argv.at(-1)] ?? {};
	if (reply.stdout !== undefined) process.stdout.write(JSON.stringify(reply.stdout) + "\\n");
	if (reply.stderr !== undefined) process.stderr.write(reply.stderr + "\\n");
	process.exitCode = reply.status ?? 0;
});
`,
	);
	chmodSync(join(root, "bin/uv"), 0o755);
	const secrets = { TA_ROOT: root, PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin` };
	return {
		root,
		call: (tool: string, input: unknown): Promise<CodeReply> => runModuleCodeAsync(join(PKG, "tools", tool), "index.ts", input, secrets),
		calls: (): Call[] => (existsSync(join(root, "calls.jsonl")) ? readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Call) : []),
	};
}

const output = (reply: CodeReply) => {
	assert.ok(reply.ok, JSON.stringify(reply));
	return reply.output as Record<string, unknown>;
};

test("stock-ta 包通过检查：八个工具、五位专家，纯计算工具的用例都过", () => {
	const result = scanPackage(PKG);
	assert.ok(result.ok, JSON.stringify(!result.ok && result.problems));
	assert.match(summary(result.scan), /^ok stock-ta@0\.1\.0 .*tools=8 skills=4 .*agents=5 evals=\d/);
	assert.equal(result.scan.manifest.team, "技术分析研究组");
});

test("盈亏比工具：止损和目标在买入价同一侧时给出看得懂的错误", async () => {
	const reply = await runModuleCodeAsync(join(PKG, "tools/risk-reward"), "index.ts", { entry: 100, stop: 105, target: 110 });
	assert.equal(reply.ok, false);
	assert.match(!reply.ok ? reply.note : "", /止损.*目标.*两侧/);
});

test("没设 TA_ROOT：工具不调用 ta，给一行说明怎么设", async () => {
	const reply = await runModuleCodeAsync(join(PKG, "tools/structure"), "index.ts", { symbol: "NVDA" });
	assert.equal(reply.ok, false);
	const note = !reply.ok ? reply.note : "";
	assert.match(note, /TA_ROOT/);
	assert.match(note, /docs\/modules\/stock-ta\.md/);
	assert.doesNotMatch(note, /\n/);
});

test("ta 的结果超过 20 KB：裁剪到 20 KB 以内，标明 truncated，列表仍有内容", async (t) => {
	const rows = Array.from({ length: 400 }, (_, i) => ({ symbol: "NVDA", rule_id: `R-${i}`, state: "上升", values: { note: "很长的说明".repeat(60), highs: Array.from({ length: 30 }, (_, j) => ({ index: j, price: j })) } }));
	const ta = fakeProject(t, { conditions: { stdout: { conditions: rows } } });
	const out = output(await ta.call("conditions", {}));
	assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 20_000, `${Buffer.byteLength(JSON.stringify(out))} bytes`);
	assert.equal(out["truncated"], true);
	assert.ok((out["conditions"] as unknown[]).length > 0);
});

test("note 不把笔记在本机的绝对路径交给模型", async (t) => {
	const ta = fakeProject(t, { note: { stdout: { source: "TA02", text: "# MACD\n\n背离是核心信号", path: "/somewhere/on/this/mac/TA02.md" } } });
	const out = output(await ta.call("note", { source: "TA02" }));
	assert.equal(out["text"], "# MACD\n\n背离是核心信号");
	assert.ok(!("path" in out));
	assert.doesNotMatch(JSON.stringify(out), /somewhere/);
});

test("structure 在数据库副本上、断网、用本机缓存覆盖得到的 now 跑，原库一个字节都不变", async (t) => {
	const ta = fakeProject(t, { structure: { stdout: { symbol: "NVDA", data_end: "2026-11-09T21:00:00+00:00", levels: [] } } }, { NVDA: SYNCED, QQQ: SYNCED - HOUR, SPY: SYNCED - 2 * HOUR });
	const original = join(ta.root, "app/data/ta.sqlite");
	const before = readFileSync(original);
	const out = output(await ta.call("structure", { symbol: "nvda" }));
	assert.equal(out["data_end"], "2026-11-09T21:00:00+00:00");
	const [call] = ta.calls();
	assert.ok(call);
	assert.deepEqual(call.stdin, { symbol: "NVDA", timeframe: "1d", now: new Date(SYNCED + 60_000).toISOString() });
	assert.deepEqual(call.argv.slice(0, 2), ["run", "--no-sync"]);
	assert.equal(call.network, "http://127.0.0.1:9");
	assert.notEqual(call.db, original);
	assert.ok(call.db && !existsSync(call.db), "the copy is removed after the call");
	assert.deepEqual(readFileSync(original), before);
});

test("本机缓存里没有或太旧的标的：不调用 ta，说明这个工具不联网", async (t) => {
	const ta = fakeProject(t, {}, { NVDA: SYNCED, QQQ: SYNCED, SPY: SYNCED, AAPL: SYNCED - 5 * 24 * HOUR });
	for (const symbol of ["TSLA", "AAPL"]) {
		const reply = await ta.call("structure", { symbol });
		assert.equal(reply.ok, false);
		assert.match(!reply.ok ? reply.note : "", new RegExp(`${symbol}.*不联网`));
	}
	assert.deepEqual(ta.calls(), []);
});

test("ta 报业务错误：把 message 和 hint 转成一行说明", async (t) => {
	const ta = fakeProject(t, { note: { status: 1, stderr: JSON.stringify({ error: { code: "NOT_FOUND", message: "找不到这篇笔记。", hint: "检查编号和标题。" } }) } });
	const reply = await ta.call("note", { source: "TA99" });
	assert.equal(reply.ok, false);
	assert.match(!reply.ok ? reply.note : "", /找不到这篇笔记。检查编号和标题。/);
});
