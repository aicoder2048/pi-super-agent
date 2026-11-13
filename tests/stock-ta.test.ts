import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { lockOf, VENV_MARK, venvDir } from "../src/modules/files.ts";
import { runModuleCodeAsync, type CodeReply } from "../src/modules/run-code.ts";
import { scanPackage, summary } from "../src/modules/validate.ts";
import { codeSite } from "./helpers/code-site.ts";

const PKG = join(import.meta.dirname, "../docs/modules/examples/stock-ta");
const LOCK = lockOf(PKG)!;
const HOUR = 3_600_000;
const SYNCED = Date.UTC(2026, 10, 10, 8, 28, 40);

type Reply = { status?: number; stdout?: unknown; stderr?: string };
type Call = { argv: string[]; stdin: Record<string, unknown>; db: string | undefined; network: string | undefined; key: string | undefined; root: string | undefined; notes: string[] | null };
type Venv = "ready" | "none" | "other" | "half";
type Setup = { synced?: Record<string, number> | null; venv?: Venv; notes?: Record<string, string[]> };

/** A module data dir whose venv holds a fake `ta` that logs each call and answers from replies.json beside it. */
function fakeModule(t: TestContext, replies: Record<string, Reply>, { synced = { NVDA: SYNCED, QQQ: SYNCED, SPY: SYNCED }, venv = "ready", notes = {} }: Setup = {}) {
	const data = mkdtempSync(join(tmpdir(), "psa-stock-ta-"));
	t.after(() => rmSync(data, { recursive: true, force: true }));
	const live = join(data, "files/ta/ta.sqlite");
	if (synced !== null) {
		mkdirSync(join(data, "files/ta"), { recursive: true });
		const db = new DatabaseSync(live);
		db.exec("CREATE TABLE dividend_sync (symbol TEXT PRIMARY KEY, start_date TEXT NOT NULL, synced_ms INTEGER NOT NULL)");
		for (const [symbol, ms] of Object.entries(synced)) db.prepare("INSERT INTO dividend_sync VALUES (?, '2024-11-05', ?)").run(symbol, ms);
		db.close();
	}
	for (const [doc, files] of Object.entries(notes)) {
		mkdirSync(join(data, "knowledge", doc), { recursive: true });
		for (const file of files) writeFileSync(join(data, "knowledge", doc, file), `# ${file}\n`);
	}
	const dir = venvDir(data, venv === "other" ? "0".repeat(64) : LOCK);
	if (venv !== "none") {
		mkdirSync(join(dir, "bin"), { recursive: true });
		if (venv !== "half") writeFileSync(join(dir, VENV_MARK), venv === "other" ? "0".repeat(64) : LOCK);
		writeFileSync(join(dir, "replies.json"), JSON.stringify(replies));
		writeFileSync(
			join(dir, "bin/ta"),
			`#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const home = path.dirname(__dirname);
let stdin = "";
process.stdin.on("data", (c) => (stdin += c)).on("end", () => {
	const argv = process.argv.slice(2);
	const env = process.env;
	const notes = env.TA_NOTES_DIR && fs.existsSync(env.TA_NOTES_DIR) ? fs.readdirSync(env.TA_NOTES_DIR).sort() : null;
	fs.appendFileSync(path.join(home, "calls.jsonl"), JSON.stringify({ argv, stdin: JSON.parse(stdin), db: env.TA_DB_PATH, network: env.MASSIVE_BASE_URL, key: env.MASSIVE_API_KEY, root: env.TA_ROOT, notes }) + "\\n");
	if (env.TA_DB_PATH && fs.existsSync(env.TA_DB_PATH)) fs.appendFileSync(env.TA_DB_PATH, "x");
	const reply = JSON.parse(fs.readFileSync(path.join(home, "replies.json"), "utf8"))[argv.at(-1)] ?? {};
	if (reply.stdout !== undefined) process.stdout.write(JSON.stringify(reply.stdout) + "\\n");
	if (reply.stderr !== undefined) process.stderr.write(reply.stderr + "\\n");
	process.exitCode = reply.status ?? 0;
});
`,
		);
		chmodSync(join(dir, "bin/ta"), 0o755);
	}
	return {
		live,
		call: (tool: string, input: unknown): Promise<CodeReply> => runModuleCodeAsync(codeSite(PKG, join("tools", tool), data), "index.ts", input),
		calls: (): Call[] => (existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Call) : []),
	};
}

const output = (reply: CodeReply) => {
	assert.ok(reply.ok, JSON.stringify(reply));
	return reply.output as Record<string, unknown>;
};
const noteOf = (reply: CodeReply) => {
	assert.equal(reply.ok, false, JSON.stringify(reply));
	return !reply.ok ? reply.note : "";
};

test("stock-ta 包通过检查：七个工具、三个技能、五位专家，纯计算工具的用例都过", () => {
	const result = scanPackage(PKG);
	assert.ok(result.ok, JSON.stringify(!result.ok && result.problems));
	assert.match(summary(result.scan), /^ok stock-ta@0\.1\.0 .*tools=7 skills=3 .*agents=5 evals=\d/);
	assert.equal(result.scan.manifest.team, "技术分析研究组");
});

test("没有 screen 工具，也没有工具要 TA_ROOT 这把密钥", () => {
	assert.ok(!existsSync(join(PKG, "tools/screen")));
	assert.ok(!existsSync(join(PKG, "skills/ta-screen")));
	for (const tool of readdirSync(join(PKG, "tools"))) {
		const descriptor = JSON.parse(readFileSync(join(PKG, "tools", tool, "tool.json"), "utf8")) as { secrets?: string[] };
		assert.ok(!(descriptor.secrets ?? []).includes("TA_ROOT"), tool);
	}
});

test("盈亏比工具：止损和目标在买入价同一侧时给出看得懂的错误", async () => {
	const reply = await runModuleCodeAsync(codeSite(PKG, "tools/risk-reward"), "index.ts", { entry: 100, stop: 105, target: 110 });
	assert.match(noteOf(reply), /止损.*目标.*两侧/);
});

test("每个读数据的工具直接调 venv 里的 ta（不经过 uv），传对子命令和参数", async (t) => {
	const ta = fakeModule(t, { prices: { stdout: { prices: [] } }, signals: { stdout: { signals: [] } }, conditions: { stdout: { conditions: [] } }, rules: { stdout: { rules: [] } }, structure: { stdout: { levels: [] } } });
	await ta.call("prices", { symbols: "NVDA, QQQ" });
	await ta.call("signals", { symbol: "NVDA", timeframe: "1w", attention: "key" });
	await ta.call("conditions", { symbol: "NVDA" });
	await ta.call("rules", { rule_id: "R-MACD-1" });
	await ta.call("structure", { symbol: "NVDA" });
	assert.deepEqual(
		ta.calls().map((c) => [c.argv, c.stdin]),
		[
			[["prices"], { symbols: ["NVDA", "QQQ"] }],
			[["signals"], { limit: 20, symbol: "NVDA", timeframe: "1w", attention: ["key"] }],
			[["conditions"], { symbol: "NVDA" }],
			[["rules"], { rule_id: "R-MACD-1" }],
			[["structure"], { timeframe: "1d", symbol: "NVDA", now: new Date(SYNCED + 60_000).toISOString() }],
		],
	);
});

test("ta 在模块数据库的副本上跑：关着的端口、offline 密钥、没有 TA_ROOT，原库一个字节都不变", async (t) => {
	const ta = fakeModule(t, { structure: { stdout: { symbol: "NVDA", data_end: "2026-11-09T21:00:00+00:00", levels: [] } } }, { synced: { NVDA: SYNCED, QQQ: SYNCED - HOUR, SPY: SYNCED - 2 * HOUR } });
	const before = readFileSync(ta.live);
	const out = output(await ta.call("structure", { symbol: "nvda" }));
	assert.equal(out["data_end"], "2026-11-09T21:00:00+00:00");
	const [call] = ta.calls();
	assert.ok(call);
	assert.deepEqual(call.stdin, { symbol: "NVDA", timeframe: "1d", now: new Date(SYNCED + 60_000).toISOString() });
	assert.equal(call.network, "http://127.0.0.1:9");
	assert.equal(call.key, "offline");
	assert.equal(call.root, undefined);
	assert.notEqual(call.db, ta.live);
	assert.ok(call.db && !existsSync(call.db), "the copy is removed after the call");
	assert.deepEqual(readFileSync(ta.live), before);
});

test("一个 venv 都没有，或者只有没装完的（没有 .psa-lock）：不调 ta，说先跑 just module setup stock-ta", async (t) => {
	for (const venv of ["none", "half"] as const) {
		const ta = fakeModule(t, {}, { venv });
		const note = noteOf(await ta.call("prices", {}));
		assert.match(note, /先跑 just module setup stock-ta/, venv);
		assert.doesNotMatch(note, /\n/);
		assert.deepEqual(ta.calls(), []);
	}
});

test("只有别的锁文件装的 venv：说包里钉的 ta 版本变了，重跑 setup", async (t) => {
	const ta = fakeModule(t, {}, { venv: "other" });
	assert.match(noteOf(await ta.call("structure", { symbol: "NVDA" })), /包里钉的 ta 版本变了.*重跑 just module setup stock-ta/);
	assert.deepEqual(ta.calls(), []);
});

test("还没有数据库（scan 还没跑过）：读数据的工具说等第一次扫描，不调 ta", async (t) => {
	const ta = fakeModule(t, {}, { synced: null });
	for (const tool of ["prices", "signals", "conditions", "structure"]) assert.match(noteOf(await ta.call(tool, { symbol: "NVDA" })), /还没有数据.*scan/, tool);
	assert.deepEqual(ta.calls(), []);
});

test("还没有数据库时 rules 照常：规则定义不在数据库里", async (t) => {
	const ta = fakeModule(t, { rules: { stdout: { rules: [{ rule_id: "R-MACD-1" }] } } }, { synced: null });
	assert.deepEqual(output(await ta.call("rules", {}))["rules"], [{ rule_id: "R-MACD-1" }]);
});

test("note 读 just module import 导入的笔记：TA_NOTES_DIR 里链着各份导入的 TA?? 笔记", async (t) => {
	const ta = fakeModule(t, { note: { stdout: { source: "TA02", text: "# MACD", path: "/somewhere/TA02 - MACD.md" } } }, { notes: { "ta02-macd": ["TA02 - MACD 实战精华总结.md"], "ta15-dow-theory": ["TA15 - 趋势 - 从道氏理论总结.md"], "pattern-guide": ["经典技术分析形态完全指南.md"] } });
	const out = output(await ta.call("note", { source: "TA02" }));
	assert.equal(out["text"], "# MACD");
	assert.ok(!("path" in out));
	assert.deepEqual(ta.calls()[0]?.notes, ["TA02 - MACD 实战精华总结.md", "TA15 - 趋势 - 从道氏理论总结.md"]);
});

test("note 查一份还没导入的笔记：不调 ta，说哪份没导入、怎么导入", async (t) => {
	const ta = fakeModule(t, {}, { notes: { "ta15-dow-theory": ["TA15 - 趋势 - 从道氏理论总结.md"] } });
	const note = noteOf(await ta.call("note", { source: "TA02#用法二：背离是 MACD 最核心的信号" }));
	assert.match(note, /TA02.*还没导入.*just module import stock-ta ta02-macd/);
	assert.doesNotMatch(note, /\n/);
	assert.deepEqual(ta.calls(), []);
});

test("signals 和 structure 只收日线和周线：timeframe 写 5m 时一行拒绝，不调 ta", async (t) => {
	const ta = fakeModule(t, {});
	for (const tool of ["signals", "structure"]) assert.match(noteOf(await ta.call(tool, { symbol: "NVDA", timeframe: "5m" })), /1d.*1w/, tool);
	assert.deepEqual(ta.calls(), []);
	const descriptor = readFileSync(join(PKG, "tools/signals/tool.json"), "utf8");
	assert.doesNotMatch(descriptor, /5m/);
});

test("ta 的结果超过 20 KB：裁剪到 20 KB 以内，标明 truncated，列表仍有内容", async (t) => {
	const rows = Array.from({ length: 400 }, (_, i) => ({ symbol: "NVDA", rule_id: `R-${i}`, state: "上升", values: { note: "很长的说明".repeat(60), highs: Array.from({ length: 30 }, (_, j) => ({ index: j, price: j })) } }));
	const ta = fakeModule(t, { conditions: { stdout: { conditions: rows } } });
	const out = output(await ta.call("conditions", {}));
	assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 20_000, `${Buffer.byteLength(JSON.stringify(out))} bytes`);
	assert.equal(out["truncated"], true);
	assert.ok((out["conditions"] as unknown[]).length > 0);
});

test("模块数据库里没有或太旧的标的：不调用 ta，说明不联网、怎么让它有数据", async (t) => {
	const ta = fakeModule(t, {}, { synced: { NVDA: SYNCED, QQQ: SYNCED, SPY: SYNCED, AAPL: SYNCED - 5 * 24 * HOUR } });
	for (const symbol of ["TSLA", "AAPL"]) {
		const note = noteOf(await ta.call("structure", { symbol }));
		assert.match(note, new RegExp(`${symbol}.*不联网.*自选股`));
		assert.doesNotMatch(note, /技术分析项目/);
	}
	assert.deepEqual(ta.calls(), []);
});

test("ta 报业务错误：把 message 和 hint 转成一行说明", async (t) => {
	const ta = fakeModule(t, { note: { status: 1, stderr: JSON.stringify({ error: { code: "NOTE_SECTION_NOT_FOUND", message: "笔记中没有这个标题。", hint: "可用标题为 一；二" } }) } }, { notes: { "ta02-macd": ["TA02 - MACD.md"] } });
	assert.match(noteOf(await ta.call("note", { source: "TA02#三" })), /笔记中没有这个标题。可用标题为 一；二/);
});

test("QQQ 的缓存比标的旧一天差 30 秒：加 60 秒的 now 会让 ta 联网补数据，所以不调用 ta", async (t) => {
	const ta = fakeModule(t, {}, { synced: { NVDA: SYNCED, QQQ: SYNCED - 24 * HOUR + 30_000, SPY: SYNCED } });
	assert.match(noteOf(await ta.call("structure", { symbol: "NVDA" })), /不联网/);
	assert.deepEqual(ta.calls(), []);
});

test("ta 退出码 0 却没有输出：给一行中文说明，不露出 JSON 解析错误", async (t) => {
	const ta = fakeModule(t, { signals: {} });
	const note = noteOf(await ta.call("signals", { symbol: "NVDA" }));
	assert.match(note, /ta signals 没有输出结果/);
	assert.doesNotMatch(note, /JSON|\n|技术分析项目/);
});

test("数字字段收到 true 或空白：一行拒绝，不调用 ta", async (t) => {
	const ta = fakeModule(t, {});
	for (const limit of [true, " "]) assert.match(noteOf(await ta.call("signals", { symbol: "NVDA", limit })), /limit 要是数字/, JSON.stringify(limit));
	assert.deepEqual(ta.calls(), []);
});
