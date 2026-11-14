import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { COMBOS, WATCH_RULES } from "../../docs/modules/examples/stock-ta/watch-rules.ts";
import { lockOf, VENV_MARK, venvDir } from "../../src/modules/files.ts";
import { instanceData } from "../../src/modules/instance-data.ts";
import { runModuleCodeAsync, type CodeReply } from "../../src/modules/run-code.ts";
import { scanPackage, summary } from "../../src/modules/validate.ts";
import { codeSite } from "../helpers/code-site.ts";
import { fakeMassive, minuteRow, type Answer, SNAPSHOT, snapshotBody, stockTaCopy, tickerRow } from "../helpers/market.ts";

const PKG = join(import.meta.dirname, "../../docs/modules/examples/stock-ta");
const LOCK = lockOf(PKG)!;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CLOSE = Date.UTC(2026, 10, 12, 21, 0);
const SYNCED = CLOSE + HOUR + 400;

type Reply = { status?: number; stdout?: unknown; stderr?: string };
type Call = { argv: string[]; stdin: Record<string, unknown>; db: string | undefined; network: string | undefined; key: string | undefined; root: string | undefined; notes: string[] | null };
type Venv = "ready" | "none" | "other" | "half";
type Setup = { synced?: Record<string, number> | null; closes?: Record<string, number>; watchlist?: { symbol: string; removedAt?: string }[]; venv?: Venv; notes?: Record<string, string[]> };

function fakeModule(t: TestContext, replies: Record<string, Reply>, { synced = { NVDA: SYNCED, QQQ: SYNCED, SPY: SYNCED }, closes, watchlist = [], venv = "ready", notes = {} }: Setup = {}) {
	const state = mkdtempSync(join(tmpdir(), "psa-stock-ta-"));
	t.after(() => rmSync(state, { recursive: true, force: true }));
	const data = join(state, "modules-data", "stock-ta");
	mkdirSync(data, { recursive: true });
	const live = join(data, "files/ta/ta.sqlite");
	if (synced !== null) {
		mkdirSync(join(data, "files/ta"), { recursive: true });
		const db = new DatabaseSync(live);
		db.exec("CREATE TABLE dividend_sync (symbol TEXT PRIMARY KEY, start_date TEXT NOT NULL, synced_ms INTEGER NOT NULL)");
		db.exec("CREATE TABLE bars (symbol TEXT NOT NULL, timeframe TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, complete INTEGER NOT NULL)");
		for (const [symbol, ms] of Object.entries(synced)) db.prepare("INSERT INTO dividend_sync VALUES (?, '2024-11-05', ?)").run(symbol, ms);
		for (const [symbol, end] of Object.entries(closes ?? Object.fromEntries(Object.keys(synced).map((s) => [s, CLOSE])))) {
			db.prepare("INSERT INTO bars VALUES (?, '1d', ?, ?, 1)").run(symbol, end - 6.5 * HOUR, end);
			db.prepare("INSERT INTO bars VALUES (?, '1d', ?, ?, 1)").run(symbol, end - DAY - 6.5 * HOUR, end - DAY);
		}
		db.close();
	}
	if (watchlist.length > 0) {
		const scanned = scanPackage(PKG);
		assert.ok(scanned.ok);
		instanceData(state).write("stock-ta", scanned.scan.components, "watchlist", watchlist, "使用者口述", "test");
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

test("stock-ta 包通过检查：十一个工具、十个技能、六位专家，纯计算工具的用例都过", () => {
	const result = scanPackage(PKG);
	assert.ok(result.ok, JSON.stringify(!result.ok && result.problems));
	assert.match(summary(result.scan), /^ok stock-ta@0\.1\.0 .*tools=11 skills=10 .*agents=6 evals=\d/);
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
			[["structure"], { timeframe: "1d", symbol: "NVDA", now: new Date(SYNCED).toISOString() }],
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
	assert.deepEqual(call.stdin, { symbol: "NVDA", timeframe: "1d", now: new Date(SYNCED).toISOString() });
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

test("第二天的扫描离上次差 250 毫秒不到 24 小时、ta 没刷新分红：structure 的 now 落在今天收盘之后，分红缓存仍有效", async (t) => {
	const yesterdayScan = SYNCED - DAY + 250;
	const ta = fakeModule(t, { structure: { stdout: { levels: [] } } }, { synced: { NVDA: yesterdayScan, QQQ: yesterdayScan, SPY: yesterdayScan } });
	output(await ta.call("structure", { symbol: "NVDA" }));
	const now = Date.parse(String(ta.calls()[0]?.stdin["now"]));
	assert.ok(now - 15 * 60_000 >= CLOSE, `ta's 15-minute delay cutoff ${new Date(now - 15 * 60_000).toISOString()} must reach today's close`);
	assert.ok(now - yesterdayScan >= 0 && now - yesterdayScan < DAY, `now ${new Date(now).toISOString()} keeps the dividend cache synced at ${new Date(yesterdayScan).toISOString()}`);
});

test("今天的扫描刷新了分红：now 不早于这次同步，否则 ta 会当缓存无效去联网", async (t) => {
	const ta = fakeModule(t, { structure: { stdout: { levels: [] } } });
	output(await ta.call("structure", { symbol: "NVDA" }));
	assert.equal(ta.calls()[0]?.stdin["now"], new Date(SYNCED).toISOString());
});

test("标的在自选股里但还没扫到：说等下一次收盘后的扫描，不叫人再加自选股", async (t) => {
	const ta = fakeModule(t, {}, { watchlist: [{ symbol: "AMD" }, { symbol: "TSLA" }, { symbol: "TSLA", removedAt: "2026-11-12" }] });
	const listed = noteOf(await ta.call("structure", { symbol: "amd" }));
	assert.match(listed, /AMD 在自选股里.*等下一次扫描.*收盘后/);
	assert.doesNotMatch(listed, /加进自选股/);
	assert.match(noteOf(await ta.call("structure", { symbol: "TSLA" })), /把它加进自选股/);
	assert.deepEqual(ta.calls(), []);
});

test("基准 QQQ 的分红同步落后一天多：说基准数据落后、等下一次扫描，不叫人加自选股", async (t) => {
	const ta = fakeModule(t, {}, { synced: { NVDA: SYNCED, QQQ: SYNCED - 25 * HOUR, SPY: SYNCED }, watchlist: [{ symbol: "NVDA" }] });
	const note = noteOf(await ta.call("structure", { symbol: "NVDA" }));
	assert.match(note, /QQQ.*落后.*等下一次扫描/);
	assert.doesNotMatch(note, /加进自选股/);
	assert.deepEqual(ta.calls(), []);
});

test("同一份笔记导进了两份知识文档：note 照样能查，只链一次", async (t) => {
	const file = "TA02 - MACD 实战精华总结.md";
	const ta = fakeModule(t, { note: { stdout: { source: "TA09", text: "# 支撑" } } }, { notes: { "ta02-macd": [file], "ta15-ma-trend": [file], "ta09-support-resistance": ["TA09 - 支撑阻力.md"] } });
	output(await ta.call("note", { source: "TA09" }));
	assert.deepEqual(ta.calls()[0]?.notes, [file, "TA09 - 支撑阻力.md"]);
});

test("今天新加进自选股的 AMD 刚扫完，QQQ、SPY 的分红还是差 150 毫秒不到 24 小时的昨天那次：照样调 ta，不说基准落后", async (t) => {
	const yesterdayScan = SYNCED - DAY + 150;
	const ta = fakeModule(t, { structure: { stdout: { levels: [] } } }, { synced: { NVDA: SYNCED, QQQ: yesterdayScan, SPY: yesterdayScan }, watchlist: [{ symbol: "NVDA" }] });
	output(await ta.call("structure", { symbol: "NVDA" }));
	assert.equal(ta.calls()[0]?.stdin["now"], new Date(SYNCED).toISOString());
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

test("signals 不把 ta 的已读状态交给模型：第一次补数后两年的历史信号都是未读，不能当成新信号", async (t) => {
	const ta = fakeModule(t, { signals: { stdout: { signals: [{ id: 1, rule_id: "R-MACD-1", data_end: "2024-12-02T21:00:00+00:00", read: false }] } } });
	const out = output(await ta.call("signals", { symbol: "NVDA" }));
	assert.deepEqual(out["signals"], [{ id: 1, rule_id: "R-MACD-1", data_end: "2024-12-02T21:00:00+00:00" }]);
});

const ny = (date: string, time: string) => Date.parse(`${date}T${time}:00-05:00`);

async function quoteTool(t: TestContext, secrets: Record<string, string> = { POLYGON_API_KEY: "sk-test" }) {
	const massive = await fakeMassive(t);
	const pkg = stockTaCopy(t, massive.base);
	return { massive, quote: (input: unknown) => runModuleCodeAsync(codeSite(pkg, "tools/quote"), "index.ts", input, secrets) };
}

const quotesOf = (reply: CodeReply) => output(reply)["quotes"] as Record<string, unknown>[];

test("quote：一次快照请求，回价格、昨收、涨跌幅、当天量、美东数据时间和时段；有成交价用成交价（纳秒时间），没有就退到分钟收盘（毫秒时间）", async (t) => {
	const tool = await quoteTool(t);
	tool.massive.answer({ status: 200, body: snapshotBody([tickerRow("NVDA", 180.4, 176, ny("2026-11-12", "10:44")), minuteRow("AMD", 151.5, 150, ny("2026-11-12", "10:43"))]) });
	const reply = await tool.quote({ symbols: "nvda, AMD", now: new Date(ny("2026-11-12", "11:00")).toISOString() });
	assert.deepEqual(tool.massive.hits.map((h) => [h.url, h.auth]), [[`${SNAPSHOT}?tickers=NVDA,AMD`, "Bearer sk-test"]]);
	assert.deepEqual(output(reply), {
		quotes: [
			{ symbol: "NVDA", price: 180.4, prevClose: 176, changePct: 2.5, volume: 5_000_000, at: "2026-11-12 10:44 美东", session: "盘中" },
			{ symbol: "AMD", price: 151.5, prevClose: 150, changePct: 1, volume: 5_000_000, at: "2026-11-12 10:43 美东", session: "盘中" },
		],
		missing: [],
	});
});

test("quote：自选股以外的股票和 ETF 照查，行情服务没有的代码列进 missing", async (t) => {
	const tool = await quoteTool(t);
	tool.massive.answer({ status: 200, body: snapshotBody([minuteRow("META", 600, 590, ny("2026-11-12", "10:44")), minuteRow("TSM", 300, 303, ny("2026-11-12", "10:44")), minuteRow("XLK", 290, 290, ny("2026-11-12", "10:44"))]) });
	const reply = await tool.quote({ symbols: ["META", "TSM", "XLK", "NOPE"], now: new Date(ny("2026-11-12", "11:00")).toISOString() });
	assert.deepEqual(quotesOf(reply).map((q) => [q["symbol"], q["changePct"]]), [["META", 1.69], ["TSM", -0.99], ["XLK", 0]]);
	assert.deepEqual(output(reply)["missing"], ["NOPE"]);
});

test("quote 的时段标签：盘中、盘前、盘后；周末、节假日和夜里是休市（数据是上一交易日的）；提前收盘日 13:00 以后算盘后", async (t) => {
	const tool = await quoteTool(t);
	const cases: [label: string, data: number, now: number, session: string][] = [
		["盘中", ny("2026-11-12", "10:44"), ny("2026-11-12", "11:00"), "盘中"],
		["盘前", ny("2026-11-12", "08:10"), ny("2026-11-12", "08:26"), "盘前"],
		["盘后", ny("2026-11-12", "17:30"), ny("2026-11-12", "17:46"), "盘后"],
		["周六", ny("2026-11-13", "19:59"), ny("2026-11-14", "11:00"), "休市"],
		["感恩节", ny("2026-11-25", "19:59"), ny("2026-11-26", "11:00"), "休市"],
		["凌晨", ny("2026-11-12", "19:59"), ny("2026-11-13", "03:00"), "休市"],
		["提前收盘日 12:59", ny("2026-11-27", "12:59"), ny("2026-11-27", "13:14"), "盘中"],
		["提前收盘日 13:30", ny("2026-11-27", "13:30"), ny("2026-11-27", "13:46"), "盘后"],
	];
	for (const [label, data, now, session] of cases) {
		tool.massive.answer({ status: 200, body: snapshotBody([minuteRow("NVDA", 170, 176, data)]) });
		const [quote] = quotesOf(await tool.quote({ symbols: "NVDA", now: new Date(now).toISOString() }));
		assert.equal(quote?.["session"], session, label);
		assert.equal(quote?.["price"], 170, `${label}：价格照样回，不拒绝`);
	}
});

type QuoteFixture = { now: string; symbols: string[]; snapshot: unknown };
const quoteFixture = (name: string): QuoteFixture => JSON.parse(readFileSync(join(PKG, "tools/quote/fixtures", `${name}.json`), "utf8"));
const quoteFrom = async (t: TestContext, name: string) => {
	const tool = await quoteTool(t);
	const { now, symbols, snapshot } = quoteFixture(name);
	tool.massive.answer({ status: 200, body: snapshot });
	return quotesOf(await tool.quote({ symbols: symbols.join(","), now }))[0];
};

test("quote 盘后：价格是最新的盘后成交，另外回常规时段的正式收盘价、收盘日期和收盘相对昨收的涨跌幅", async (t) => {
	assert.deepEqual(await quoteFrom(t, "after-hours"), {
		symbol: "QQQ", price: 674.25, prevClose: 688.17, changePct: -2.02, volume: 42_108_955, at: "2026-11-13 19:59 美东", session: "盘后",
		close: 679.89, closeDate: "2026-11-13", closeChangePct: -1.2,
	});
});

test("quote 休市：周六和节假日回上一交易日的正式收盘价和日期，不是盘后价", async (t) => {
	const pick = (q: Record<string, unknown> | undefined) => [q?.["session"], q?.["price"], q?.["close"], q?.["closeDate"]];
	assert.deepEqual(pick(await quoteFrom(t, "saturday")), ["休市", 674.25, 679.89, "2026-11-13"]);
	assert.deepEqual(pick(await quoteFrom(t, "holiday")), ["休市", 190.5, 191.2, "2026-11-25"]);
});

test("quote 盘中：还没收盘，不回收盘价", async (t) => {
	const q = await quoteFrom(t, "regular");
	assert.equal(q?.["session"], "盘中");
	assert.equal("close" in (q ?? {}), false);
});

test("quote 收盘以后：没有盘后成交的票（最后一根分钟线 15:59）也回正式收盘价，当天收盘以后的数据都算盘后", async (t) => {
	assert.deepEqual(await quoteFrom(t, "no-after-hours"), {
		symbol: "PFFD", price: 16.6, prevClose: 16.66, changePct: -0.36, volume: 1_547_070, at: "2026-11-13 15:59 美东", session: "盘后",
		close: 16.59, closeDate: "2026-11-13", closeChangePct: -0.42,
	});
});

test("quote 刚过 16:00：延迟 15 分钟的行情还在常规时段里，日线还不是正式收盘，不回收盘价，标 closePending 说已经收盘、正式收盘价还没出来", async (t) => {
	const q = await quoteFrom(t, "just-closed");
	assert.equal(q?.["session"], "盘中");
	assert.equal("close" in (q ?? {}), false);
	assert.equal(q?.["closePending"], true);
});

test("quote 盘中和收盘价出来以后都没有 closePending", async (t) => {
	assert.equal("closePending" in ((await quoteFrom(t, "regular")) ?? {}), false);
	assert.equal("closePending" in ((await quoteFrom(t, "no-after-hours")) ?? {}), false);
	assert.equal("closePending" in ((await quoteFrom(t, "saturday")) ?? {}), false);
});

test("quote 提前收盘日：13:00 收盘，过了行情延迟才回收盘价", async (t) => {
	const tool = await quoteTool(t);
	const at = async (time: string) => {
		tool.massive.answer({ status: 200, body: snapshotBody([minuteRow("NVDA", 170, 176, ny("2026-11-27", "12:59"))]) });
		const [q] = quotesOf(await tool.quote({ symbols: "NVDA", now: new Date(ny("2026-11-27", time)).toISOString() }));
		return [q?.["session"], q?.["close"], q?.["closePending"]];
	};
	assert.deepEqual(await at("12:50"), ["盘中", undefined, undefined]);
	assert.deepEqual(await at("13:10"), ["盘中", undefined, true]);
	assert.deepEqual(await at("13:30"), ["盘后", 170, undefined]);
});

test("quote：超过 10 个代码一行拒绝，不发请求", async (t) => {
	const tool = await quoteTool(t);
	const note = noteOf(await tool.quote({ symbols: "A,B,C,D,E,F,G,H,I,J,K" }));
	assert.match(note, /最多 10 个/);
	assert.equal(note.split("\n").length, 1);
	assert.equal(tool.massive.hits.length, 0);
});

test("quote：没有 POLYGON_API_KEY 时一行说明去哪里加，不发请求", async (t) => {
	const tool = await quoteTool(t, {});
	const note = noteOf(await tool.quote({ symbols: "NVDA" }));
	assert.match(note, /POLYGON_API_KEY/);
	assert.match(note, /密钥文件/);
	assert.equal(note.split("\n").length, 1);
	assert.equal(tool.massive.hits.length, 0);
});

test("quote：行情服务出错时一行说出状态码", async (t) => {
	const tool = await quoteTool(t);
	tool.massive.answer({ status: 500, body: { status: "ERROR" } });
	const note = noteOf(await tool.quote({ symbols: "NVDA" }));
	assert.match(note, /HTTP 500/);
	assert.equal(note.split("\n").length, 1);
});

test("quote：连不上行情服务时一行中文说明，不露出 fetch failed", async (t) => {
	const pkg = stockTaCopy(t, "http://127.0.0.1:9");
	const note = noteOf(await runModuleCodeAsync(codeSite(pkg, "tools/quote"), "index.ts", { symbols: "NVDA" }, { POLYGON_API_KEY: "sk-test" }));
	assert.match(note, /连不上行情服务/);
	assert.doesNotMatch(note, /fetch failed/);
	assert.equal(note.split("\n").length, 1);
});

test("quote：行情服务回 200 但不是 JSON 时一行中文说明，不露出解析错误", async (t) => {
	const tool = await quoteTool(t);
	tool.massive.answer({ status: 200, body: null, raw: "<html>maintenance</html>" });
	const note = noteOf(await tool.quote({ symbols: "NVDA" }));
	assert.match(note, /不是 JSON/);
	assert.doesNotMatch(note, /Unexpected token|SyntaxError/);
	assert.equal(note.split("\n").length, 1);
});

test("盘面专家只够得到报价、分钟线、缓存价和笔记，只有读文件的工具，不能读网页", () => {
	const result = scanPackage(PKG);
	assert.ok(result.ok);
	const desk = result.scan.components.flatMap((c) => (c.kind === "agents" && c.name === "market-desk" ? [c.agent] : []))[0];
	assert.equal(desk?.title, "盘面");
	assert.deepEqual(desk?.uses, ["tools/quote", "tools/intraday", "tools/prices", "tools/note"]);
	assert.deepEqual(desk?.tools, ["read"]);
});

const AGGS = "/v2/aggs/ticker";
type AggsFixture = { now: string; input: Record<string, unknown>; aggs: unknown };
const aggsFixture = (name: string): AggsFixture => JSON.parse(readFileSync(join(PKG, "tools/intraday/fixtures", `${name}.json`), "utf8"));

async function intradayTool(t: TestContext, secrets: Record<string, string> = { POLYGON_API_KEY: "sk-test" }) {
	const massive = await fakeMassive(t);
	const pkg = stockTaCopy(t, massive.base);
	return { massive, intraday: (input: unknown) => runModuleCodeAsync(codeSite(pkg, "tools/intraday"), "index.ts", input, secrets) };
}

test("intraday：一次分钟聚合请求，地址和参数照宿主的 bars；K 线从早到晚、美东时间、每根带 VWAP，另给当天的 VWAP", async (t) => {
	const tool = await intradayTool(t);
	const fx = aggsFixture("minute");
	tool.massive.answer({ status: 200, body: fx.aggs });
	const out = output(await tool.intraday({ ...fx.input, now: fx.now }));
	assert.deepEqual(tool.massive.hits.map((h) => [h.url, h.auth]), [[`${AGGS}/NVDA/range/1/minute/2026-11-12/2026-11-12?adjusted=true&sort=desc&limit=50000`, "Bearer sk-test"]]);
	assert.deepEqual(out, {
		symbol: "NVDA",
		span: "minute",
		from: "2026-11-12",
		to: "2026-11-12",
		columns: ["at", "open", "high", "low", "close", "volume", "vwap"],
		bars: [
			["2026-11-12 09:30", 180, 181.2, 179.6, 180.9, 900000, 180.5],
			["2026-11-12 09:31", 180.9, 181, 179.9, 180.1, 500000, 180.4],
			["2026-11-12 09:32", 180.1, 180.2, 176.8, 177.2, 1600000, 178.1],
			["2026-11-12 09:33", 177.2, 178.4, 177, 178.3, 700000, 177.8],
		],
		dayVwap: { date: "2026-11-12", vwap: 178.94, since: "09:30" },
		truncated: false,
		timeZone: "美东，行情延迟 15 分钟",
	});
});

test("intraday：小时线跨两天时，当天的 VWAP 只算最新那一天", async (t) => {
	const tool = await intradayTool(t);
	const fx = aggsFixture("hour");
	tool.massive.answer({ status: 200, body: fx.aggs });
	const out = output(await tool.intraday({ ...fx.input, now: fx.now }));
	assert.equal(tool.massive.hits[0]?.url, `${AGGS}/SPY/range/1/hour/2026-11-11/2026-11-12?adjusted=true&sort=desc&limit=50000`);
	assert.deepEqual(out["dayVwap"], { date: "2026-11-12", vwap: 669.96, since: "09:00" });
	assert.equal((out["bars"] as unknown[]).length, 4);
});

test("intraday：周末不填日期时查上一个交易日（周五）", async (t) => {
	const tool = await intradayTool(t);
	tool.massive.answer({ status: 200, body: { status: "OK", results: [] } });
	await tool.intraday({ symbol: "nvda", span: "minute", now: new Date(ny("2026-11-14", "11:00")).toISOString() });
	assert.equal(tool.massive.hits[0]?.url, `${AGGS}/NVDA/range/1/minute/2026-11-13/2026-11-13?adjusted=true&sort=desc&limit=50000`);
});

test("intraday：回看超过 4 个交易日、limit 超过 500、span 不是 minute 或 hour，都一行拒绝，不发请求", async (t) => {
	const tool = await intradayTool(t);
	const now = new Date(ny("2026-11-13", "11:00")).toISOString();
	const refused: [input: Record<string, unknown>, says: RegExp][] = [
		[{ symbol: "NVDA", span: "minute", from: "2026-11-09", now }, /最多回看 4 个交易日.*2026-11-10/],
		[{ symbol: "NVDA", span: "minute", limit: 600, now }, /limit 最多 500/],
		[{ symbol: "NVDA", span: "day", now }, /minute 或 hour/],
		[{ symbol: "NVDA", span: "minute", from: "2026-11-13", to: "2026-11-12", now }, /from 不能晚于 to/],
		[{ span: "minute", now }, /symbol/],
	];
	for (const [input, says] of refused) {
		const note = noteOf(await tool.intraday(input));
		assert.match(note, says, JSON.stringify(input));
		assert.equal(note.split("\n").length, 1);
	}
	assert.equal(tool.massive.hits.length, 0);
});

test("intraday：周一往回数 4 个交易日跨过周末，从上周三起都收", async (t) => {
	const tool = await intradayTool(t);
	tool.massive.answer({ status: 200, body: { status: "OK", results: [] } });
	const now = new Date(ny("2026-11-16", "11:00")).toISOString();
	assert.equal((await tool.intraday({ symbol: "NVDA", span: "hour", from: "2026-11-11", now })).ok, true);
	assert.match(noteOf(await tool.intraday({ symbol: "NVDA", span: "hour", from: "2026-11-10", now })), /2026-11-11/);
	assert.equal(tool.massive.hits.length, 1);
});

const firstAt = (out: Record<string, unknown>) => (out["bars"] as string[][])[0]?.[0];
const lastAt = (out: Record<string, unknown>) => (out["bars"] as string[][]).at(-1)?.[0];

test("intraday：三天的小时线全给（04:00 起），limit 截掉更早的才标 truncated，正好 limit 根不标", async (t) => {
	const tool = await intradayTool(t);
	const fx = aggsFixture("hour-days");
	tool.massive.answer({ status: 200, body: fx.aggs });
	const all = output(await tool.intraday({ ...fx.input, now: fx.now }));
	assert.equal(tool.massive.hits[0]?.url, `${AGGS}/NVDA/range/1/hour/2026-11-10/2026-11-12?adjusted=true&sort=desc&limit=50000`);
	assert.deepEqual([(all["bars"] as unknown[]).length, firstAt(all), lastAt(all), all["truncated"]], [48, "2026-11-10 04:00", "2026-11-12 19:00", false]);
	const cut = output(await tool.intraday({ ...fx.input, limit: 20, now: fx.now }));
	assert.deepEqual([(cut["bars"] as unknown[]).length, firstAt(cut), lastAt(cut), cut["truncated"]], [20, "2026-11-11 16:00", "2026-11-12 19:00", true]);
	const exact = output(await tool.intraday({ ...fx.input, limit: 48, now: fx.now }));
	assert.equal(exact["truncated"], false);
});

test("intraday：过去某天的早盘分钟线，from、to 带纽约时刻就只给那一段", async (t) => {
	const tool = await intradayTool(t);
	const fx = aggsFixture("minute-day");
	tool.massive.answer({ status: 200, body: fx.aggs });
	const out = output(await tool.intraday({ ...fx.input, now: fx.now }));
	assert.equal(tool.massive.hits[0]?.url, `${AGGS}/NVDA/range/1/minute/2026-11-12/2026-11-12?adjusted=true&sort=desc&limit=50000`);
	assert.deepEqual([out["from"], out["to"], (out["bars"] as unknown[]).length, out["truncated"]], ["2026-11-12 09:30", "2026-11-12 10:00", 31, false]);
	assert.deepEqual((out["bars"] as unknown[])[0], ["2026-11-12 09:30", 151.005, 151.38, 149.23, 149.27, 33303449.43127, 150.5265]);
	assert.equal(lastAt(out), "2026-11-12 10:00");
	const day = output(await tool.intraday({ symbol: "NVDA", span: "minute", to: "2026-11-12", now: fx.now }));
	assert.deepEqual([(day["bars"] as unknown[]).length, firstAt(day), day["truncated"]], [500, "2026-11-12 11:40", true]);
});

test("intraday：回放时填的 now 之后的 K 线不给，小时线只给到 now 前已走完的那根", async (t) => {
	const tool = await intradayTool(t);
	const hours = aggsFixture("hour-days");
	tool.massive.answer({ status: 200, body: hours.aggs });
	const hour = output(await tool.intraday({ ...hours.input, now: new Date(ny("2026-11-12", "12:30")).toISOString() }));
	assert.equal(lastAt(hour), "2026-11-12 11:00");
	const minutes = aggsFixture("minute-day");
	tool.massive.answer({ status: 200, body: minutes.aggs });
	const minute = output(await tool.intraday({ symbol: "NVDA", span: "minute", now: new Date(ny("2026-11-12", "09:45")).toISOString() }));
	assert.deepEqual([firstAt(minute), lastAt(minute)], ["2026-11-12 04:00", "2026-11-12 09:44"]);
});

test("intraday：to 晚于今天、时刻写错格式，一行拒绝，不发请求", async (t) => {
	const tool = await intradayTool(t);
	const now = new Date(ny("2026-11-13", "11:00")).toISOString();
	const future = noteOf(await tool.intraday({ symbol: "NVDA", span: "minute", to: "2026-11-16", now }));
	assert.match(future, /to 不能晚于今天.*2026-11-13/);
	const badTime = noteOf(await tool.intraday({ symbol: "NVDA", span: "minute", from: "2026-11-12 9:30", now }));
	assert.match(badTime, /2026-11-12 09:30/);
	const backwards = noteOf(await tool.intraday({ symbol: "NVDA", span: "minute", from: "2026-11-12 10:00", to: "2026-11-12 09:30", now }));
	assert.match(backwards, /from 不能晚于 to/);
	assert.equal(tool.massive.hits.length, 0);
});

test("intraday：行情服务回 200 但 status 是 ERROR 时一行说出它的错误，不说休市", async (t) => {
	const tool = await intradayTool(t);
	tool.massive.answer({ status: 200, body: { status: "ERROR", error: "Could not parse the time parameter" } });
	const note = noteOf(await tool.intraday({ symbol: "NVDA", span: "minute", now: new Date(ny("2026-11-13", "11:00")).toISOString() }));
	assert.match(note, /行情服务回了错误.*Could not parse the time parameter/);
	assert.equal(note.split("\n").length, 1);
});

test("intraday：交易日没有 K 线时说代码可能不对，凌晨 04:00 前说盘前还没开始，时段里没有 K 线时说这段没有，都不说休市", async (t) => {
	const tool = await intradayTool(t);
	tool.massive.answer({ status: 200, body: { ticker: "ZZZZQX", queryCount: 0, resultsCount: 0, status: "OK" } });
	const unknown = output(await tool.intraday({ symbol: "ZZZZQX", span: "hour", now: new Date(ny("2026-11-13", "11:00")).toISOString() }));
	assert.match(String(unknown["note"]), /ZZZZQX.*代码.*quote/);
	const early = output(await tool.intraday({ symbol: "NVDA", span: "minute", now: new Date(ny("2026-11-13", "03:00")).toISOString() }));
	assert.match(String(early["note"]), /04:00.*2026-11-12/);
	tool.massive.answer({ status: 200, body: aggsFixture("minute-day").aggs });
	const quiet = output(await tool.intraday({ symbol: "NVDA", span: "minute", from: "2026-11-12 02:00", to: "2026-11-12 03:00", now: new Date(ny("2026-11-13", "11:00")).toISOString() }));
	assert.match(String(quiet["note"]), /02:00.*03:00.*这段没有 K 线/);
	for (const out of [unknown, early, quiet]) assert.doesNotMatch(String(out["note"]), /休市/);
});

test("intraday：没有 POLYGON_API_KEY 时一行说明去哪里加，不发请求", async (t) => {
	const tool = await intradayTool(t, {});
	const note = noteOf(await tool.intraday({ symbol: "NVDA", span: "minute" }));
	assert.match(note, /POLYGON_API_KEY/);
	assert.match(note, /密钥文件/);
	assert.equal(note.split("\n").length, 1);
	assert.equal(tool.massive.hits.length, 0);
});

test("intraday：行情服务回 HTTP 500 或 429 时一行说明，429 说请求太多、稍后再查", async (t) => {
	const tool = await intradayTool(t);
	tool.massive.answer({ status: 500, body: { status: "ERROR" } });
	const failed = noteOf(await tool.intraday({ symbol: "NVDA", span: "minute" }));
	assert.match(failed, /HTTP 500/);
	assert.equal(failed.split("\n").length, 1);
	tool.massive.answer({ status: 429, body: { status: "ERROR" } });
	const limited = noteOf(await tool.intraday({ symbol: "NVDA", span: "minute" }));
	assert.match(limited, /429.*请求太多.*稍后/);
	assert.equal(limited.split("\n").length, 1);
});

test("intraday：那天没有 K 线（节假日）时说明休市，让改日期，不只回一个空列表", async (t) => {
	const tool = await intradayTool(t);
	tool.massive.answer({ status: 200, body: { status: "OK", results: [] } });
	const out = output(await tool.intraday({ symbol: "NVDA", span: "minute", now: new Date(ny("2026-11-26", "11:00")).toISOString() }));
	assert.deepEqual(out["bars"], []);
	assert.match(String(out["note"]), /2026-11-26.*没有 K 线.*from/);
});

const CALENDAR = "/calendar/earnings";
const calendarFixture = (name: string): unknown => JSON.parse(readFileSync(join(PKG, "tools/earnings-date/fixtures", `${name}.json`), "utf8")).body;
const calendarRow = (date: string, hour: string, epsActual: number | null = null) => ({ symbol: "NVDA", date, hour, quarter: 3, year: 2027, epsEstimate: 2.5, epsActual, revenueEstimate: 1e11, revenueActual: null });
const at = (date: string, time: string) => new Date(ny(date, time)).toISOString();

async function earningsTool(t: TestContext, secrets: Record<string, string> = { FINNHUB_API_KEY: "fh-test" }) {
	const finnhub = await fakeMassive(t);
	const pkg = stockTaCopy(t, "http://127.0.0.1:9");
	writeFileSync(join(pkg, "tools/earnings-date/finnhub.json"), JSON.stringify({ baseUrl: finnhub.base }));
	return { finnhub, earnings: (input: unknown) => runModuleCodeAsync(codeSite(pkg, "tools/earnings-date"), "index.ts", input, secrets) };
}

test("earnings-date：一次 Finnhub 财报日历请求（今天到 120 天后），多条里取最近的未来一条，回日期、盘前盘后和离今天几个交易日", async (t) => {
	const tool = await earningsTool(t);
	tool.finnhub.answer({ status: 200, body: calendarFixture("nvda") });
	const out = output(await tool.earnings({ symbol: "nvda", now: at("2026-11-12", "11:00") }));
	assert.deepEqual(tool.finnhub.hits.map((h) => [h.url, h.token]), [[`${CALENDAR}?from=2026-11-12&to=2027-03-12&symbol=NVDA`, "fh-test"]]);
	assert.deepEqual(out, { symbol: "NVDA", today: "2026-11-12", date: "2026-11-17", time: "盘后", tradingDays: 3 });
});

test("earnings-date：今天盘后的财报算今天（0 个交易日）；今天已公布的、日历里比今天早的都跳过", async (t) => {
	const tool = await earningsTool(t);
	tool.finnhub.answer({ status: 200, body: { earningsCalendar: [calendarRow("2026-11-19", "bmo"), calendarRow("2026-11-12", "amc")] } });
	assert.deepEqual(output(await tool.earnings({ symbol: "NVDA", now: at("2026-11-12", "15:00") })), { symbol: "NVDA", today: "2026-11-12", date: "2026-11-12", time: "盘后", tradingDays: 0 });
	tool.finnhub.answer({ status: 200, body: { earningsCalendar: [calendarRow("2026-11-11", "amc"), calendarRow("2026-11-12", "bmo", 2.6), calendarRow("2026-11-19", "dmh")] } });
	assert.deepEqual(output(await tool.earnings({ symbol: "NVDA", now: at("2026-11-12", "15:00") })), { symbol: "NVDA", today: "2026-11-12", date: "2026-11-19", time: "盘中", tradingDays: 5 });
});

test("earnings-date：交易日只数工作日，跳过周末和休市的节假日；周末问时下周一算 1 个交易日", async (t) => {
	const tool = await earningsTool(t);
	tool.finnhub.answer({ status: 200, body: { earningsCalendar: [calendarRow("2026-11-30", "")] } });
	assert.deepEqual(output(await tool.earnings({ symbol: "NVDA", now: at("2026-11-25", "11:00") })), { symbol: "NVDA", today: "2026-11-25", date: "2026-11-30", time: "时间未公布", tradingDays: 2 });
	tool.finnhub.answer({ status: 200, body: { earningsCalendar: [calendarRow("2026-11-16", "bmo")] } });
	assert.equal(output(await tool.earnings({ symbol: "NVDA", now: at("2026-11-14", "11:00") }))["tradingDays"], 1);
});

test("earnings-date：120 天内没有财报（ETF、空列表）时回一行说明，不编日期", async (t) => {
	const tool = await earningsTool(t);
	tool.finnhub.answer({ status: 200, body: calendarFixture("spy-none") });
	assert.deepEqual(output(await tool.earnings({ symbol: "SPY", now: at("2026-11-13", "11:00") })), { symbol: "SPY", today: "2026-11-13", note: "120 天内没有已公布的财报日" });
});

test("earnings-date：只回日期，不回预期、实际 EPS 和营收，应答里有也不带出来；tool.json 的输出也没有这些字段", async (t) => {
	const tool = await earningsTool(t);
	tool.finnhub.answer({ status: 200, body: calendarFixture("nvda") });
	const text = JSON.stringify(output(await tool.earnings({ symbol: "NVDA", now: at("2026-11-12", "11:00") })));
	const schema = JSON.stringify(JSON.parse(readFileSync(join(PKG, "tools/earnings-date/tool.json"), "utf8")).output);
	for (const shown of [text, schema]) assert.doesNotMatch(shown, /eps|revenue|estimate|actual|营收|预期|EPS/i);
});

test("earnings-date：没有 FINNHUB_API_KEY 时一行说明去哪里加，不发请求", async (t) => {
	const tool = await earningsTool(t, {});
	const note = noteOf(await tool.earnings({ symbol: "NVDA" }));
	assert.match(note, /FINNHUB_API_KEY/);
	assert.match(note, /密钥文件/);
	assert.equal(note.split("\n").length, 1);
	assert.equal(tool.finnhub.hits.length, 0);
});

test("earnings-date：Finnhub 回 429 说请求太多、稍后再查，回别的错误码、不是 JSON、没有日历都一行说明", async (t) => {
	const tool = await earningsTool(t);
	const cases: [answer: Answer, line: RegExp][] = [
		[{ status: 429, body: { error: "API limit reached" } }, /429.*请求太多.*稍后/],
		[{ status: 401, body: { error: "Invalid API key" } }, /HTTP 401/],
		[{ status: 200, body: null, raw: "<html>maintenance</html>" }, /不是 JSON/],
		[{ status: 200, body: { error: "unexpected" } }, /没有财报日历/],
	];
	for (const [answer, line] of cases) {
		tool.finnhub.answer(answer);
		const note = noteOf(await tool.earnings({ symbol: "NVDA" }));
		assert.match(note, line);
		assert.doesNotMatch(note, /Unexpected token|SyntaxError|fetch failed/);
		assert.equal(note.split("\n").length, 1);
	}
});

test("只有风险与交易计划够得到 earnings-date，别的专家的 uses 里没有它", () => {
	const result = scanPackage(PKG);
	assert.ok(result.ok);
	const agents = result.scan.components.flatMap((c) => (c.kind === "agents" ? [c.agent] : []));
	assert.deepEqual(agents.filter((a) => a.uses.includes("tools/earnings-date")).map((a) => a.name), ["risk-plan"]);
});

test("到档触发：两档的做法是 band-move，规则 watch-task 让任务照做法同名的技能做，技能只派盘面、结构与形态、趋势与动量三位，一次同时派，汇报先写盘面", () => {
	const watchTask = readFileSync(join(PKG, "rules.md"), "utf8").split("## ").find((r) => r.startsWith("watch-task"))!;
	assert.match(watchTask, /做法的名字就是领队要先读的技能/);
	assert.deepEqual(WATCH_RULES.filter((r) => r.id.startsWith("move-")).map((r) => r.plan), ["band-move", "band-move"]);
	assert.deepEqual(WATCH_RULES.filter((r) => r.level === 5 || r.level === 6).map((r) => [r.id, r.plan]), [["move-1", "band-move"], ["move-2", "band-move"], ["vixy-2", "market-desk"], ["R-MA-2-200", "structure-trend"], ["stop-loss", "holding-ask"]]);
	const skill = readFileSync(join(PKG, "skills/band-move/SKILL.md"), "utf8");
	for (const said of ["market-desk", "structure-pattern", "trend-momentum", "一次 dispatch 同时派出", "信号分诊、市场情绪、风险与交易计划这次不派", "先写盘面", "只是数据"]) assert.match(skill, new RegExp(said));
});

test("收盘规则的做法 structure-trend 有同名技能：只派结构与形态、趋势与动量两位，一次同时派；表里每个做法都有同名技能", () => {
	const plans = new Set<string>([...WATCH_RULES, ...COMBOS].map((r) => r.plan));
	for (const plan of plans) assert.ok(existsSync(join(PKG, "skills", plan, "SKILL.md")), `做法 ${plan} 有技能`);
	const skill = readFileSync(join(PKG, "skills/structure-trend/SKILL.md"), "utf8");
	for (const said of ["structure-pattern", "trend-momentum", "一次 dispatch 同时派出", "盘面、信号分诊、市场情绪、风险与交易计划这次不派", "放量确认", "同一个线程", "不是交易指令", "只是数据"]) assert.match(skill, new RegExp(said));
});
