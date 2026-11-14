import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Modules } from "../src/modules.ts";
import { runFeed, type FeedNotice, type FeedPorts, type FeedProblem } from "../src/modules/feed-runner.ts";
import { lockOf, VENV_MARK, venvDir } from "../src/modules/files.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { fakeTa, type DailyRow } from "./helpers/fake-ta.ts";
import type { Alert } from "../src/modules/protocol.ts";
import { readHits, writeHits, type Hit } from "../docs/modules/examples/stock-ta/hits.ts";
import { quietAt } from "../docs/modules/examples/stock-ta/watch-rules.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { servedAsHost } from "./helpers/fakes.ts";
import { threadId } from "../src/sources/generic.ts";

const PKG = join(import.meta.dirname, "../docs/modules/examples/stock-ta");
const KEY = "sk-scan-test";
const WEDNESDAY_EVENING = "2026-11-11T23:00:00.000Z";
const SATURDAY = "2026-11-14T15:00:00.000Z";


async function scanFeed(t: TestContext, { key = KEY, viaVenv = false, installed = true, finnhub = "" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "psa-stock-ta-scan-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "modules", "stock-ta");
	cpSync(PKG, pkg, { recursive: true });
	const fake = fakeTa(join(root, "fake"));
	const state = join(root, "state");
	const data = instanceData(state);
	const dataDir = data.dir("stock-ta");
	if (viaVenv) {
		const venv = venvDir(dataDir, lockOf(pkg)!);
		const bin = join(venv, "bin");
		mkdirSync(bin, { recursive: true });
		if (installed) writeFileSync(join(venv, VENV_MARK), lockOf(pkg)!);
		writeFileSync(join(bin, "ta"), `#!/bin/sh\nexec "${process.execPath}" "${fake.script}" "$@"\n`);
		chmodSync(join(bin, "ta"), 0o755);
	}
	const feedJson = join(pkg, "feeds", "scan", "feed.json");
	const descriptor = JSON.parse(readFileSync(feedJson, "utf8"));
	let settings: Record<string, unknown> = { ...descriptor.settings, now: WEDNESDAY_EVENING, ...(!viaVenv && { ta: fake.script }) };
	const writeSettings = () => writeFileSync(feedJson, JSON.stringify({ ...descriptor, settings }));
	writeSettings();
	let modules = servedAsHost(Modules.load([join(root, "modules")]));
	const entry = () => {
		const found = modules.feeds().find((e) => e.source === "stock-ta/scan");
		assert.ok(found, "stock-ta 有 scan feed");
		return found;
	};
	const notices: FeedNotice[] = [];
	const alerts: Alert[] = [];
	const problems: (FeedProblem | undefined)[] = [];
	const ports: FeedPorts = { data, submit: (n) => void notices.push(n), alert: (_, a) => alerts.push(a) > 0, problem: (_, p) => void problems.push(p), secret: (name) => (name === "POLYGON_API_KEY" && key !== "" ? key : name === "FINNHUB_API_KEY" && finnhub !== "" ? finnhub : undefined), now: () => Date.now() };
	const live = join(dataDir, "files", "ta", "ta.sqlite");
	return {
		live,
		dataDir,
		notices,
		alerts,
		lines: () => alerts.filter((a) => !a.externalId.startsWith("digest:")),
		digests: () => alerts.filter((a) => a.externalId.startsWith("digest:")),
		problems,
		modules: () => modules,
		setPlan: fake.setPlan,
		at(now: string, extra: Record<string, unknown> = {}) {
			settings = { ...settings, now, ...extra };
			writeSettings();
			modules = servedAsHost(Modules.load([join(root, "modules")]));
		},
		watch: (...symbols: string[]) => data.write("stock-ta", entry().components, "watchlist", symbols.map((symbol) => ({ symbol })), "使用者口述", "test"),
		level: (fields: Record<string, unknown>) => data.write("stock-ta", entry().components, "rule-levels", [fields], "使用者口述", "test"),
		runs: () => data.query("stock-ta", entry().components, "scan-runs", {}, "test").rows,
		cursor: () => data.feedState("stock-ta", "stock-ta/scan").cursor,
		setCursor: (cursor: string) => data.saveFeedState("stock-ta", "stock-ta/scan", { cursor }),
		calls: fake.calls,
		scans: fake.scans,
		tick: () => runFeed(entry(), [], ports),
	};
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const barSymbols = (path: string) => {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return [...new Set((db.prepare("SELECT symbol FROM bars").all() as { symbol: string }[]).map((r) => r.symbol))].sort();
	} finally {
		db.close();
	}
};
const barCount = (path: string) => {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return (db.prepare("SELECT count(*) AS n FROM bars").get() as { n: number }).n;
	} finally {
		db.close();
	}
};
const LEFTOVERS = [".next", ".next-journal", ".next.scan.lock"];
const leftovers = (live: string) => LEFTOVERS.filter((s) => existsSync(live + s));

test("扫描传给 ta 的是自选股加 QQQ、SPY，日线模式，密钥以 MASSIVE_API_KEY 传入，写的是副本", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA", "amd");
	const run = await feed.tick();
	assert.equal(run.ok, true, JSON.stringify(run));
	const [scan] = feed.scans();
	assert.deepEqual(scan?.input["symbols"], ["NVDA", "AMD", "QQQ", "SPY"]);
	assert.equal(scan?.input["mode"], "daily");
	assert.equal(scan?.key, KEY);
	assert.equal(scan?.base, "https://api.massive.com");
	assert.equal(scan?.db, `${feed.live}.next`);
});

test("全部成功：副本换上成 ta.sqlite，存一行「换上」，分红提醒不算出错", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	feed.setPlan({ kind: "ok", signals: 2 });
	assert.deepEqual(await feed.tick(), { ok: true, records: 1, notices: 0 });
	assert.deepEqual(barSymbols(feed.live), ["NVDA", "QQQ", "SPY"]);
	assert.deepEqual(leftovers(feed.live), []);
	const [row] = feed.runs();
	assert.equal(row?.fields["outcome"], "换上");
	assert.equal(row?.fields["tradingDate"], "2026-11-11");
	assert.equal(row?.fields["symbols"], 3);
	assert.equal(row?.fields["watchlist"], 1);
	assert.equal(row?.fields["newSignals"], 2);
	assert.match(String(row?.fields["errors"]), /QQQ.*DIVIDENDS_UNAVAILABLE/);
});

test("自选股是空的：也扫 QQQ、SPY，那一行写明自选股是空的", async (t) => {
	const feed = await scanFeed(t);
	await feed.tick();
	assert.deepEqual(feed.scans()[0]?.input["symbols"], ["QQQ", "SPY"]);
	const [row] = feed.runs();
	assert.equal(row?.fields["watchlist"], 0);
	assert.match(String(row?.fields["note"]), /自选股是空的/);
});

test("自选股超过 30 只：只扫最早加的 30 只加 QQQ、SPY，那一行说明少扫了哪些", async (t) => {
	const feed = await scanFeed(t);
	const many = Array.from({ length: 33 }, (_, i) => `S${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
	feed.watch(...many);
	await feed.tick();
	assert.deepEqual(feed.scans()[0]?.input["symbols"], [...many.slice(0, 30), "QQQ", "SPY"]);
	const [row] = feed.runs();
	assert.equal(row?.fields["watchlist"], 33);
	assert.match(String(row?.fields["note"]), /30 只.*SBE、SBF、SBG/);
});

test("自选股里有 ta 不认的代码：跳过它们照样扫，那一行点名跳过了哪些；BRK.B 照扫", async (t) => {
	const feed = await scanFeed(t);
	const bad = ["腾讯", "NVDA US", "$NVDA", "0700.HK", "ABCDEFGHIJK"];
	feed.watch(...bad, "BRK.B", "NVDA");
	const run = await feed.tick();
	assert.equal(run.ok, true, JSON.stringify(run));
	assert.deepEqual(feed.scans()[0]?.input["symbols"], ["BRK.B", "NVDA", "QQQ", "SPY"]);
	const [row] = feed.runs();
	assert.equal(row?.fields["outcome"], "换上");
	assert.equal(row?.fields["watchlist"], 7);
	for (const symbol of bad) assert.ok(String(row?.fields["note"]).includes(symbol), `说明里点名 ${symbol}`);
});

test("BRK-B 按 ta 的规矩写成 BRK.B 传给 ta", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("brk-b");
	await feed.tick();
	assert.deepEqual(feed.scans()[0]?.input["symbols"], ["BRK.B", "QQQ", "SPY"]);
});

test("部分标的出错：照样换上，那一行列出出错的标的和原因，cursor 前进", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA", "DEAD");
	feed.setPlan({ kind: "partial", failing: ["DEAD"] });
	await feed.tick();
	assert.deepEqual(barSymbols(feed.live), ["DEAD", "NVDA", "QQQ", "SPY"]);
	const [row] = feed.runs();
	assert.equal(row?.fields["outcome"], "换上");
	assert.match(String(row?.fields["errors"]), /DEAD.*MARKET_DATA_INVALID/);
	assert.notEqual(feed.cursor(), null);
});

test("断网（退出码 0，每个标的都是 MARKET_UNAVAILABLE）：旧库一字不差，没有副本，存一行带原因的「失败」，cursor 记下这个交易日还没扫成", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	await feed.tick();
	const before = sha(feed.live);
	feed.at("2026-11-12T23:00:00.000Z");
	feed.setPlan({ kind: "down" });
	const run = await feed.tick();
	assert.equal(run.ok, true, JSON.stringify(run));
	assert.equal(sha(feed.live), before);
	assert.deepEqual(leftovers(feed.live), []);
	const failed = feed.runs().find((r) => r.fields["tradingDate"] === "2026-11-12");
	assert.equal(failed?.fields["outcome"], "失败");
	assert.match(String(failed?.fields["errors"]), /NVDA.*MARKET_UNAVAILABLE/);
	assert.deepEqual(JSON.parse(feed.cursor()!).symbols, [], "这个交易日还没扫成，下一拍再扫");
});

test("ta 说跳过（不是交易日或还没到时间）：不换库，不存行，cursor 记下这个交易日还没扫成", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	await feed.tick();
	const before = sha(feed.live);
	feed.at(SATURDAY);
	feed.setPlan({ kind: "skip" });
	assert.deepEqual(await feed.tick(), { ok: true, records: 0, notices: 0 });
	assert.equal(feed.scans().length, 2);
	assert.equal(sha(feed.live), before);
	assert.equal(feed.runs().length, 1);
	assert.deepEqual(JSON.parse(feed.cursor()!).symbols, [], "这个交易日还没扫成，下一拍再扫");
	assert.deepEqual(leftovers(feed.live), []);
});

test("ta 退出码非零：旧库一字不差，没有副本，存一行「失败」写明退出码，报问题 scan-failed", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	await feed.tick();
	const before = sha(feed.live);
	feed.at("2026-11-12T23:00:00.000Z");
	feed.setPlan({ kind: "exit" });
	const run = await feed.tick();
	assert.equal(run.ok, true, JSON.stringify(run));
	assert.equal(sha(feed.live), before);
	assert.deepEqual(leftovers(feed.live), []);
	const failed = feed.runs().find((r) => r.fields["tradingDate"] === "2026-11-12");
	assert.equal(failed?.fields["outcome"], "失败");
	assert.match(String(failed?.fields["errors"]), /退出码 2/);
	assert.deepEqual(feed.problems.map((p) => p?.id ?? "-"), ["-", "scan-failed"]);
});

test("ta 超过扫描时限：被停掉，存一行「失败」写明超时，旧库不变，没有副本，cursor 记下这个交易日还没扫成；下一拍照常", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	await feed.tick();
	const before = sha(feed.live);
	feed.at("2026-11-12T23:00:00.000Z", { scanSeconds: 1 });
	feed.setPlan({ kind: "sleep" });
	const started = Date.now();
	const run = await feed.tick();
	assert.ok(Date.now() - started < 10_000, "停在扫描时限，不是 60 秒");
	assert.equal(run.ok, true, JSON.stringify(run));
	const late = feed.runs().find((r) => r.fields["tradingDate"] === "2026-11-12");
	assert.equal(late?.fields["outcome"], "失败");
	assert.match(String(late?.fields["errors"]), /超时/);
	assert.equal(sha(feed.live), before);
	assert.deepEqual(leftovers(feed.live), []);
	assert.deepEqual(JSON.parse(feed.cursor()!).symbols, [], "这个交易日还没扫成，下一拍再扫");
	feed.setPlan({ kind: "ok" });
	assert.equal((await feed.tick()).ok, true);
	assert.equal(feed.runs().filter((r) => r.fields["outcome"] === "换上").length, 2);
});

test("上一次崩溃留下的 .next、.next-journal、.next.scan.lock 在 ta 起来之前删掉，ta 拿到的副本就是旧库", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	await feed.tick();
	const before = sha(feed.live);
	for (const suffix of LEFTOVERS) writeFileSync(feed.live + suffix, "leftover from a crash");
	feed.at("2026-11-12T23:00:00.000Z");
	await feed.tick();
	const seen = feed.scans().at(-1)?.seen;
	assert.deepEqual(seen, { next: before, journal: false, lock: false });
	assert.deepEqual(leftovers(feed.live), []);
});

test("同一个交易日两次运行（第一次失败）存两行，id 各不相同", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	feed.setPlan({ kind: "down" });
	await feed.tick();
	feed.setPlan({ kind: "ok" });
	await feed.tick();
	const rows = feed.runs();
	assert.deepEqual(rows.map((r) => r.fields["outcome"]).sort(), ["失败", "换上"]);
	assert.equal(new Set(rows.map((r) => r.id)).size, 2);
});

test("cursor 命中（同一个美东日期、同一张标的列表）时不起 ta；改了自选股当天下一拍就重扫", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	await feed.tick();
	const calls = feed.calls().length;
	assert.deepEqual(await feed.tick(), { ok: true, records: 0, notices: 0 });
	assert.equal(feed.calls().length, calls, "第二拍没有起 ta");
	assert.equal(feed.runs().length, 1);
	feed.watch("AMD");
	await feed.tick();
	assert.deepEqual(feed.scans().at(-1)?.input["symbols"], ["NVDA", "AMD", "QQQ", "SPY"]);
	assert.equal(feed.runs().length, 2);
});

test("空库第一次扫描：传上一个交易日收盘加 16 分钟的 now；有库以后传这一拍的时间", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	feed.at(SATURDAY);
	await feed.tick();
	assert.equal(feed.scans()[0]?.input["now"], "2026-11-13T21:16:00.000Z");
	assert.equal(feed.runs()[0]?.fields["tradingDate"], "2026-11-13");
	feed.at("2026-11-16T22:00:00.000Z");
	await feed.tick();
	assert.equal(feed.scans()[1]?.input["now"], "2026-11-16T22:00:00.000Z");
});

test("空库、交易日收盘前：补的是前一个交易日；当天收盘后的那一拍不被 cursor 挡住", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	feed.at("2026-11-11T15:00:00.000Z");
	await feed.tick();
	assert.equal(feed.scans()[0]?.input["now"], "2026-11-10T21:16:00.000Z");
	feed.at("2026-11-11T22:00:00.000Z");
	await feed.tick();
	assert.equal(feed.scans().length, 2);
});

test("没有 settings.ta 时用的是和自己这份包副本 uv.lock 对得上的 venv 里的 ta", async (t) => {
	const feed = await scanFeed(t, { viaVenv: true });
	feed.watch("NVDA");
	const run = await feed.tick();
	assert.equal(run.ok, true, JSON.stringify(run));
	assert.equal(feed.scans().length, 1);
});

test("venv 没装完（没有 .psa-lock）：不起 ta，报问题 scan-failed，那一行「失败」说先跑 just module setup stock-ta", async (t) => {
	const feed = await scanFeed(t, { viaVenv: true, installed: false });
	feed.watch("NVDA");
	const run = await feed.tick();
	assert.equal(run.ok, true, JSON.stringify(run));
	assert.deepEqual(feed.problems.map((p) => p?.id), ["scan-failed"]);
	assert.equal(feed.runs()[0]?.fields["outcome"], "失败");
	assert.match(String(feed.runs()[0]?.fields["errors"]), /先跑 just module setup stock-ta/);
	assert.equal(feed.calls().length, 0);
});

test("缺 POLYGON_API_KEY：不起 ta，报问题 no-key，一行说明", async (t) => {
	const feed = await scanFeed(t, { key: "" });
	feed.watch("NVDA");
	assert.deepEqual(await feed.tick(), { ok: true, records: 0, notices: 0 });
	assert.deepEqual(feed.problems.map((p) => p?.id), ["no-key"]);
	assert.match(feed.problems[0]!.text, /POLYGON_API_KEY/);
	assert.equal(feed.problems[0]!.text.split("\n").length, 1);
	assert.equal(feed.calls().length, 0);
});

test("扫描结果写进 ta.sqlite 的行数和 ta 写的一样多（副本加改名不丢数据）", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	feed.setPlan({ kind: "ok", rows: 7000 });
	await feed.tick();
	assert.equal(barCount(feed.live), 7000);
});

test("每个标的都只有「分红不可用」的提醒：日线到了，照样换上", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	feed.setPlan({ kind: "dividends" });
	await feed.tick();
	assert.equal(feed.runs()[0]?.fields["outcome"], "换上");
	assert.ok(existsSync(feed.live));
});

const THURSDAY_EVENING = "2026-11-12T23:00:00.000Z";
const CLOSE = (date: string) => Date.parse(`${date}T21:00:00Z`);
const signal = (symbol: string, rule_id: string, kind: string, direction: string, date: string, price: number | null = 150.2) => ({ id: 1, symbol, rule_id, timeframe: "1d", kind, direction, data_start_ms: CLOSE(date) - 23_400_000, data_end_ms: CLOSE(date), discovered_ms: CLOSE(date) + 960_000, price, attention: "key", read: 0 });

async function scannedOnce(t: TestContext) {
	const feed = await scanFeed(t);
	feed.watch("NVDA", "AMD");
	await feed.tick();
	feed.at(THURSDAY_EVENING);
	return feed;
}

/** 21 sessions before `date` on a million shares, swinging 99 to 101 and closing at 100, then `date` itself. */
const daily = (symbol: string, date: string, close: number, volume: number): DailyRow[] => [
	...Array.from({ length: 21 }, (_, i) => ({ symbol, date: `2026-10-${String(i + 1).padStart(2, "0")}`, close: i === 20 ? 100 : i % 2 ? 101 : 99, volume: 1_000_000 })),
	{ symbol, date, close, volume },
];
const ma = (symbol: string, period: number, direction: "bullish" | "bearish", date: string, attention = "normal") => ({ ...signal(symbol, `R-MA-2-${period}`, `${direction === "bullish" ? "站上" : "跌破"} MA${period}`, direction, date, 97), attention, values: { left: 97, right: 98.5 } });

test("收盘规则：当天的信号按盯盘规则表判，跌破 50 日线静音一行不开任务；别的日期、不在自选股里的、SPY 的不判", async (t) => {
	const feed = await scannedOnce(t);
	feed.setPlan({ kind: "ok", signals: [
		ma("NVDA", 50, "bearish", "2026-11-12"),
		ma("NVDA", 50, "bullish", "2026-11-11"),
		signal("AMD", "R-MACD-2", "金叉", "bullish", "2026-11-12"),
		ma("SPY", 50, "bearish", "2026-11-12"),
	] });
	assert.deepEqual(await feed.tick(), { ok: true, records: 1, notices: 0 });
	assert.deepEqual(feed.lines().map((a) => [a.externalId, a.push]), [["R-MA-2-50:down:NVDA:2026-11-12", "silent"]]);
	assert.match(feed.lines()[0]!.text, /^NVDA 收盘跌破 50 日线（收盘 97\.00，50 日均线 98\.50）。/);
	const hits = readHits(feed.dataDir, "2026-11-12", "scan");
	assert.deepEqual(hits.map((h) => [h.id, h.level]), [["R-MACD-2:up:AMD:2026-11-12", 0], ["R-MA-2-50:down:NVDA:2026-11-12", 2]]);
});

test("收盘跌破 200 日线：开任务的触发，线程挂在模块下，和报价 feed 同一只票同一天的线程是同一个；同日放量写「放量确认」", async (t) => {
	const feed = await scannedOnce(t);
	feed.setPlan({ kind: "ok", signals: [ma("NVDA", 200, "bearish", "2026-11-12")], bars: daily("NVDA", "2026-11-12", 97, 2_400_000) });
	assert.deepEqual(await feed.tick(), { ok: true, records: 1, notices: 1 });
	const [notice] = feed.notices;
	assert.deepEqual([notice?.source, notice?.id, threadId(notice!.threadOwner ?? notice!.source, notice!.thread)], ["stock-ta/scan", "R-MA-2-200:NVDA:2026-11-12", "thr_stock-ta:NVDA:2026-11-12"]);
	assert.match(notice!.body, /^NVDA 收盘跌破 200 日线（收盘 97\.00，200 日均线 98\.50）。当天跌 -3\.00%。放量确认（收盘成交量是 20 日均量的 2\.4 倍）。收盘日线 11-12（美东）。（规则 R-MA-2-200，层级 5，做法 structure-trend）$/);
	assert.deepEqual(feed.lines(), [], "200 日线不发提醒行，汇报就是第一次");
});

test("扫描新信号：空库第一次扫描补的两年信号一条也不判", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	feed.setPlan({ kind: "ok", signals: [ma("NVDA", 200, "bearish", "2026-11-11"), ma("NVDA", 50, "bullish", "2025-03-03")] });
	assert.deepEqual(await feed.tick(), { ok: true, records: 1, notices: 0 });
	assert.deepEqual([feed.alerts, readHits(feed.dataDir, "2026-11-11")], [[], []]);
});

test("同一天再扫一次（加了自选股）：之前判过的命中留着、不再发，新扫到的照判", async (t) => {
	const feed = await scannedOnce(t);
	feed.setPlan({ kind: "ok", signals: [ma("NVDA", 200, "bearish", "2026-11-12")] });
	await feed.tick();
	feed.watch("MSFT");
	feed.setPlan({ kind: "ok", signals: [ma("NVDA", 200, "bearish", "2026-11-12"), ma("MSFT", 50, "bearish", "2026-11-12")] });
	await feed.tick();
	assert.deepEqual(feed.notices.map((n) => n.id), ["R-MA-2-200:NVDA:2026-11-12"]);
	assert.deepEqual(feed.lines().map((a) => a.externalId), ["R-MA-2-50:down:MSFT:2026-11-12"]);
	assert.deepEqual(readHits(feed.dataDir, "2026-11-12", "scan").map((h) => h.id).sort(), ["R-MA-2-200:NVDA:2026-11-12", "R-MA-2-50:down:MSFT:2026-11-12"]);
});

test("rule-levels 改了收盘规则，下一次扫描就按新的层级：跌破 50 日线改成 5 层开任务", async (t) => {
	const feed = await scannedOnce(t);
	feed.level({ rule: "R-MA-2-50:down", level: 5, note: "跌破 50 日线也开任务" });
	feed.setPlan({ kind: "ok", signals: [ma("NVDA", 50, "bearish", "2026-11-12")] });
	await feed.tick();
	assert.deepEqual(feed.notices.map((n) => n.id), ["R-MA-2-50:down:NVDA:2026-11-12"]);
	assert.match(feed.notices[0]!.body, /做法 structure-trend/);
});

test("跨 feed：报价 feed 当天的命中算进多空分歧（盘中 52 周新高看多，收盘跌破 50 日线看空）", async (t) => {
	const feed = await scannedOnce(t);
	const high: Hit = { id: "high-52w:NVDA:2026-11-12", rule: "high-52w", symbol: "NVDA", date: "2026-11-12", at: "2026-11-12T16:00:00.000Z", lean: "bull", fact: "创 52 周新高 212.40（此前最高 210.88）", level: 2, text: "" };
	writeHits(feed.dataDir, "quotes", "2026-11-12", [high]);
	feed.setPlan({ kind: "ok", signals: [ma("NVDA", 50, "bearish", "2026-11-12")] });
	await feed.tick();
	assert.match(feed.lines()[0]!.text, /同日：创 52 周新高 212\.40（此前最高 210\.88）。多空分歧（看多 1 条，看空 1 条）。/);
});

test("收盘以后才扫：每 5 分钟一拍，收盘 20 分钟以前不起 ta；提前收盘日（13:00）跟着提前", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	feed.at("2026-11-25T23:00:00.000Z");
	await feed.tick();
	const scans = feed.scans().length;
	feed.at("2026-11-27T18:15:00.000Z");
	await feed.tick();
	assert.equal(feed.scans().length, scans, "感恩节后的提前收盘日 13:15 还没到时间");
	feed.at("2026-11-27T18:20:00.000Z");
	await feed.tick();
	assert.equal(feed.scans().length, scans + 1);
	assert.equal(feed.runs()[0]?.fields["tradingDate"], "2026-11-27");
	feed.at("2026-11-30T21:15:00.000Z");
	await feed.tick();
	assert.equal(feed.scans().length, scans + 1, "周一 16:15 还没到时间");
});

test("规则：stock-ta/scan 的触发和报价 feed 一样走 watch-task，ma-break 删掉了；扫描每 5 分钟一拍，名单设置删掉了", async (t) => {
	const modules = (await scanFeed(t)).modules();
	assert.deepEqual(modules.rulesFor("stock-ta/scan"), ["stock-ta/watch-task"]);
	assert.deepEqual(modules.rulesFor("stock-ta/quotes"), ["stock-ta/watch-task"]);
	assert.equal(modules.allRules().some((r) => r.id === "stock-ta/ma-break"), false);
	const scan = JSON.parse(readFileSync(join(PKG, "feeds", "scan", "feed.json"), "utf8"));
	assert.deepEqual([scan.every, scan.settings.signals, scan.reads], ["5m", undefined, ["watchlist", "rule-levels"]]);
});

test("一直扫不成功：同一个交易日的几拍都报 scan-failed；过了美东午夜还按那个交易日（收盘加 16 分钟）补扫，换上了才清掉", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	await feed.tick();
	feed.setPlan({ kind: "down" });
	for (const now of ["2026-11-12T22:00:00.000Z", "2026-11-12T23:00:00.000Z", "2026-11-13T06:00:00.000Z"]) {
		feed.at(now);
		await feed.tick();
	}
	assert.equal(feed.scans().at(-1)?.input["now"], "2026-11-12T21:16:00.000Z");
	feed.setPlan({ kind: "ok" });
	await feed.tick();
	assert.deepEqual(feed.problems.map((p) => p?.id ?? "-"), ["-", "scan-failed", "scan-failed", "scan-failed", "-"]);
	assert.equal(feed.runs()[0]?.fields["tradingDate"], "2026-11-12");
});

test("扫描失败报问题 scan-failed（断网、超时都算），文字不带数据；下一次换上的扫描清掉", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	feed.setPlan({ kind: "down" });
	await feed.tick();
	feed.at(THURSDAY_EVENING, { scanSeconds: 1 });
	feed.setPlan({ kind: "sleep" });
	await feed.tick();
	feed.at(THURSDAY_EVENING, { scanSeconds: 270 });
	feed.setPlan({ kind: "ok" });
	await feed.tick();
	assert.deepEqual(feed.problems.map((p) => p?.id ?? "-"), ["scan-failed", "scan-failed", "-"]);
	assert.doesNotMatch(feed.problems[0]!.text, /NVDA|MARKET_UNAVAILABLE/);
	assert.match(feed.problems[0]!.text, /扫描记录/);
});

const high52: Hit = { id: "high-52w:NVDA:2026-11-12", rule: "high-52w", symbol: "NVDA", date: "2026-11-12", at: "2026-11-12T16:00:00.000Z", lean: "bull", fact: "创 52 周新高 212.40（此前最高 210.88）", level: 2, text: "" };

test("收盘小结：扫完的同一拍发一行静音的 digest:<日期>，盘中和收盘的命中都在里面，同根合并；之后的拍不再发", async (t) => {
	const feed = await scannedOnce(t);
	writeHits(feed.dataDir, "quotes", "2026-11-12", [high52]);
	feed.setPlan({ kind: "ok", signals: [ma("NVDA", 50, "bearish", "2026-11-12")] });
	await feed.tick();
	assert.deepEqual(feed.digests().map((a) => [a.externalId, a.push]), [["digest:2026-11-12", "silent"]]);
	assert.equal(feed.digests()[0]!.text, "收盘小结 11-12（美东）：NVDA 看多：创 52 周新高 212.40，看空：收盘跌破 50 日线，多空分歧（看多 1 条，看空 1 条）。问「今天有哪些信号」看全部。");
	feed.at("2026-11-12T23:30:00.000Z");
	await feed.tick();
	assert.equal(feed.digests().length, 1, "一个交易日一份");
	assert.equal(feed.scans().length, 2, "扫过、发过小结的拍不起 ta");
});

test("收盘小结：当天没有 1 层以上的命中就不发", async (t) => {
	const feed = await scannedOnce(t);
	feed.setPlan({ kind: "ok", signals: [signal("NVDA", "R-SR-4", "跌破整数关口 150", "bearish", "2026-11-12")] });
	await feed.tick();
	assert.deepEqual(feed.digests(), []);
	assert.deepEqual(readHits(feed.dataDir, "2026-11-12", "scan").map((h) => h.level), [0]);
});

test("扫描一直没成功：美东 17:30 以前不发小结；17:30 照发盘中的命中，写明收盘规则没有算", async (t) => {
	const feed = await scannedOnce(t);
	writeHits(feed.dataDir, "quotes", "2026-11-12", [high52]);
	feed.setPlan({ kind: "down" });
	feed.at("2026-11-12T21:25:00.000Z");
	await feed.tick();
	assert.deepEqual(feed.digests(), []);
	feed.at("2026-11-12T22:30:00.000Z");
	await feed.tick();
	assert.match(feed.digests()[0]?.text ?? "", /^收盘小结 11-12（美东）：NVDA 创 52 周新高 212\.40。今天的日线扫描失败，收盘规则没有算。/);
	feed.setPlan({ kind: "ok", signals: [ma("NVDA", 200, "bearish", "2026-11-12")] });
	feed.at("2026-11-12T23:00:00.000Z");
	await feed.tick();
	assert.deepEqual([feed.digests().length, feed.notices.map((n) => n.id)], [1, ["R-MA-2-200:NVDA:2026-11-12"]], "后来扫成了，收盘规则照发，小结不重发");
});

test("免打扰：收盘扫描落在宿主本地 22:00 到 07:00，任务和静音一行先留着；时段结束后的第一拍发小结，补开留着的任务", async (t) => {
	const feed = await scannedOnce(t);
	const start = Date.parse("2026-11-12T21:20:00.000Z");
	const end = Date.parse("2026-11-13T21:20:00.000Z");
	let quietMs = start;
	while (!quietAt(quietMs, false)) quietMs += 30 * 60_000;
	let openMs = quietMs;
	while (quietAt(openMs, false)) openMs += 30 * 60_000;
	assert.ok(openMs < end, "时段结束还在同一个交易日的扫描窗口里");
	feed.setPlan({ kind: "ok", signals: [ma("NVDA", 200, "bearish", "2026-11-12"), ma("AMD", 50, "bearish", "2026-11-12")] });
	feed.at(new Date(quietMs).toISOString());
	await feed.tick();
	assert.deepEqual([feed.notices, feed.alerts], [[], []], "时段里什么都不发");
	assert.deepEqual(readHits(feed.dataDir, "2026-11-12", "scan").map((h) => [h.id, h.held]), [["R-MA-2-50:down:AMD:2026-11-12", true], ["R-MA-2-200:NVDA:2026-11-12", true]]);
	feed.at(new Date(openMs).toISOString());
	await feed.tick();
	assert.equal(feed.scans().length, 2, "补发不重扫");
	assert.match(feed.digests()[0]?.text ?? "", /NVDA 收盘跌破 200 日线，免打扰时留下，现在补开任务；AMD 收盘跌破 50 日线（免打扰时留下）/);
	assert.deepEqual(feed.notices.map((n) => [n.id, threadId(n.threadOwner ?? n.source, n.thread)]), [["R-MA-2-200:NVDA:2026-11-12", "thr_stock-ta:NVDA:2026-11-12"]]);
	assert.match(feed.notices[0]!.body, /免打扰时段留下，收盘小结时补发）（规则 R-MA-2-200，层级 5，做法 structure-trend）$/);
});

const firstQuiet = (fromMs: number) => {
	let ms = fromMs;
	while (!quietAt(ms, false)) ms += 30 * 60_000;
	return ms;
};
const firstOpen = (fromMs: number) => {
	let ms = fromMs;
	while (quietAt(ms, false)) ms += 30 * 60_000;
	return ms;
};

test("免打扰：17:30 小结已照发，补扫落在时段里；时段结束后的第一拍补开留着的任务，留着的静音行并成一行补发，只发一次", async (t) => {
	const feed = await scannedOnce(t);
	writeHits(feed.dataDir, "quotes", "2026-11-12", [high52]);
	feed.setPlan({ kind: "down" });
	feed.at("2026-11-12T22:30:00.000Z");
	await feed.tick();
	assert.equal(feed.digests().length, 1, "扫描失败，17:30 照发小结");
	const quietMs = firstQuiet(Date.parse("2026-11-12T23:00:00.000Z"));
	feed.setPlan({ kind: "ok", signals: [ma("NVDA", 200, "bearish", "2026-11-12"), ma("AMD", 50, "bearish", "2026-11-12")] });
	feed.at(new Date(quietMs).toISOString());
	await feed.tick();
	assert.deepEqual([feed.notices, feed.lines()], [[], []], "时段里什么都不发");
	const openMs = firstOpen(quietMs);
	feed.at(new Date(openMs).toISOString());
	await feed.tick();
	assert.deepEqual(feed.notices.map((n) => [n.id, threadId(n.threadOwner ?? n.source, n.thread)]), [["R-MA-2-200:NVDA:2026-11-12", "thr_stock-ta:NVDA:2026-11-12"]]);
	assert.match(feed.notices[0]!.body, /免打扰时段留下，收盘小结时补发）（规则 R-MA-2-200，层级 5，做法 structure-trend）$/);
	assert.deepEqual(feed.lines().map((a) => [a.externalId, a.push]), [["held:2026-11-12", "silent"]]);
	assert.equal(feed.lines()[0]!.text, "免打扰时段留下的收盘命中 11-12（美东）：AMD 收盘跌破 50 日线（免打扰时留下）。问「今天有哪些信号」看全部。");
	for (let ms = openMs + 60 * 60_000; ms < Date.parse("2026-11-13T21:19:00.000Z"); ms += 60 * 60_000) {
		feed.at(new Date(ms).toISOString());
		await feed.tick();
	}
	assert.deepEqual([feed.notices.length, feed.lines().length, feed.digests().length, feed.scans().length], [1, 1, 1, 4], "补发一次；之后的拍（每拍都重新载入模块）不再发、不重扫");
});

test("免打扰：小结补发过留着的任务以后重启宿主，同一个交易日的拍不再补发", async (t) => {
	const feed = await scannedOnce(t);
	const quietMs = firstQuiet(Date.parse("2026-11-12T21:20:00.000Z"));
	feed.setPlan({ kind: "ok", signals: [ma("NVDA", 200, "bearish", "2026-11-12")] });
	feed.at(new Date(quietMs).toISOString());
	await feed.tick();
	const openMs = firstOpen(quietMs);
	feed.at(new Date(openMs).toISOString());
	await feed.tick();
	assert.deepEqual([feed.notices.map((n) => n.id), feed.digests().length], [["R-MA-2-200:NVDA:2026-11-12"], 1]);
	const cursor = feed.cursor()!;
	const again = await scanFeed(t);
	again.watch("NVDA", "AMD");
	cpSync(join(feed.dataDir, "files"), join(again.dataDir, "files"), { recursive: true });
	again.setCursor(cursor);
	again.at(new Date(openMs + 5 * 60_000).toISOString());
	await again.tick();
	assert.deepEqual([again.notices, again.alerts, again.scans().length], [[], [], 0], "新宿主读同一个 cursor 和命中文件：不补发、不重扫");
});

test("报价 feed 免打扰时留下的任务也由收盘小结补发", async (t) => {
	const feed = await scannedOnce(t);
	const band: Hit = { id: "move-1:NVDA:2026-11-12:down", rule: "move-1", symbol: "NVDA", date: "2026-11-12", at: "2026-11-12T20:59:00.000Z", lean: "bear", fact: "到 -5% 档", level: 5, text: "NVDA 跌 -5.10%，到达 -5% 档。", held: true };
	writeHits(feed.dataDir, "quotes", "2026-11-12", [band]);
	await feed.tick();
	assert.deepEqual(feed.notices.map((n) => [n.id, n.thread]), [["move-1:NVDA:2026-11-12:down", "NVDA:2026-11-12"]]);
	assert.match(feed.notices[0]!.body, /做法 band-move/);
});

test("财报临近：下一次财报在 5 个交易日内记 1 层（只记下，进小结），以后几天小结里写还有几个交易日，不再记", async (t) => {
	const finnhub = createServer((req, res) => {
		const symbol = new URL(req.url!, "http://x").searchParams.get("symbol");
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ earningsCalendar: symbol === "NVDA" ? [{ symbol: "NVDA", date: "2026-11-17", hour: "amc", epsActual: null }] : [] }));
	});
	await new Promise<void>((done) => finnhub.listen(0, "127.0.0.1", done));
	t.after(() => finnhub.close());
	const feed = await scanFeed(t, { finnhub: "fh-test" });
	const base = `http://127.0.0.1:${(finnhub.address() as AddressInfo).port}`;
	feed.watch("NVDA", "AMD");
	feed.at(WEDNESDAY_EVENING, { finnhubBaseUrl: base });
	await feed.tick();
	feed.at(THURSDAY_EVENING, { finnhubBaseUrl: base });
	await feed.tick();
	assert.deepEqual(readHits(feed.dataDir, "2026-11-12", "scan").map((h) => [h.id, h.level, h.fact]), [["earnings:NVDA:2026-11-17", 1, "财报还有 3 个交易日，11-17 盘后"]]);
	assert.match(feed.digests()[0]?.text ?? "", /NVDA 财报还有 3 个交易日，11-17 盘后/);
	feed.setPlan({ kind: "ok", signals: [ma("AMD", 50, "bearish", "2026-11-13")] });
	feed.at("2026-11-13T23:00:00.000Z", { finnhubBaseUrl: base });
	await feed.tick();
	assert.deepEqual(readHits(feed.dataDir, "2026-11-13", "scan").map((h) => h.id), ["R-MA-2-50:down:AMD:2026-11-13"]);
	assert.match(feed.digests()[1]?.text ?? "", /；NVDA 财报还有 2 个交易日，11-17 盘后。/);
});

test("没有 FINNHUB_API_KEY：财报临近不算，扫描记录里写一句，其余照判", async (t) => {
	const feed = await scannedOnce(t);
	feed.setPlan({ kind: "ok", signals: [ma("NVDA", 50, "bearish", "2026-11-12")] });
	await feed.tick();
	assert.match(String(feed.runs()[0]?.fields["note"]), /没有 FINNHUB_API_KEY，财报临近没算/);
	assert.equal(feed.lines().length, 1);
});

test("第 3 期以前的 cursor（没有 hits）：那个交易日算扫过、发过小结，部署后不补发", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	await feed.tick();
	writeHits(feed.dataDir, "quotes", "2026-11-12", [high52]);
	feed.setCursor(JSON.stringify({ date: "2026-11-12", symbols: ["NVDA", "QQQ", "SPY"] }));
	feed.at("2026-11-13T15:00:00.000Z");
	await feed.tick();
	assert.deepEqual([feed.scans().length, feed.digests()], [1, []]);
});
