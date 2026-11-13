import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Modules } from "../src/modules.ts";
import { runFeed, type FeedPorts } from "../src/modules/feed-runner.ts";
import { lockOf, VENV_MARK, venvDir } from "../src/modules/files.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { fakeTa } from "./helpers/fake-ta.ts";
import { servedAsHost } from "./helpers/fakes.ts";

const PKG = join(import.meta.dirname, "../docs/modules/examples/stock-ta");
const KEY = "sk-scan-test";
const WEDNESDAY_EVENING = "2026-11-11T23:00:00.000Z";
const SATURDAY = "2026-11-14T15:00:00.000Z";


async function scanFeed(t: TestContext, { key = KEY, viaVenv = false, installed = true } = {}) {
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
	const ports: FeedPorts = { data, submit: () => undefined, alert: () => undefined, problem: () => undefined, secret: (name) => (name === "POLYGON_API_KEY" && key !== "" ? key : undefined), now: () => Date.now() };
	const live = join(dataDir, "files", "ta", "ta.sqlite");
	return {
		live,
		setPlan: fake.setPlan,
		at(now: string, extra: Record<string, unknown> = {}) {
			settings = { ...settings, now, ...extra };
			writeSettings();
			modules = servedAsHost(Modules.load([join(root, "modules")]));
		},
		watch: (...symbols: string[]) => data.write("stock-ta", entry().components, "watchlist", symbols.map((symbol) => ({ symbol })), "使用者口述", "test"),
		runs: () => data.query("stock-ta", entry().components, "scan-runs", {}, "test").rows,
		cursor: () => data.feedState("stock-ta", "stock-ta/scan").cursor,
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

test("断网（退出码 0，每个标的都是 MARKET_UNAVAILABLE）：旧库一字不差，没有副本，存一行带原因的「失败」，cursor 不动", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	await feed.tick();
	const before = sha(feed.live);
	const cursor = feed.cursor();
	feed.at("2026-11-12T23:00:00.000Z");
	feed.setPlan({ kind: "down" });
	const run = await feed.tick();
	assert.equal(run.ok, true, JSON.stringify(run));
	assert.equal(sha(feed.live), before);
	assert.deepEqual(leftovers(feed.live), []);
	const failed = feed.runs().find((r) => r.fields["tradingDate"] === "2026-11-12");
	assert.equal(failed?.fields["outcome"], "失败");
	assert.match(String(failed?.fields["errors"]), /NVDA.*MARKET_UNAVAILABLE/);
	assert.equal(feed.cursor(), cursor);
});

test("ta 说跳过（不是交易日或还没到时间）：不换库，不存行，cursor 不动", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	await feed.tick();
	const before = sha(feed.live);
	const cursor = feed.cursor();
	feed.at(SATURDAY);
	feed.setPlan({ kind: "skip" });
	assert.deepEqual(await feed.tick(), { ok: true, records: 0, notices: 0 });
	assert.equal(feed.scans().length, 2);
	assert.equal(sha(feed.live), before);
	assert.equal(feed.runs().length, 1);
	assert.equal(feed.cursor(), cursor);
	assert.deepEqual(leftovers(feed.live), []);
});

test("ta 退出码非零：这一拍失败并说明，旧库一字不差，没有副本，不存行", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	await feed.tick();
	const before = sha(feed.live);
	feed.at("2026-11-12T23:00:00.000Z");
	feed.setPlan({ kind: "exit" });
	const run = await feed.tick();
	assert.equal(run.ok, false);
	assert.match(run.ok ? "" : run.note, /退出码 2/);
	assert.equal(sha(feed.live), before);
	assert.deepEqual(leftovers(feed.live), []);
	assert.equal(feed.runs().length, 1);
});

test("ta 超过扫描时限：被停掉，存一行「失败」写明超时，旧库不变，没有副本，cursor 不动；下一拍照常", async (t) => {
	const feed = await scanFeed(t);
	feed.watch("NVDA");
	await feed.tick();
	const before = sha(feed.live);
	const cursor = feed.cursor();
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
	assert.equal(feed.cursor(), cursor);
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

test("venv 没装完（没有 .psa-lock）：这一拍失败，说先跑 just module setup stock-ta，不起 ta", async (t) => {
	const feed = await scanFeed(t, { viaVenv: true, installed: false });
	feed.watch("NVDA");
	const run = await feed.tick();
	assert.equal(run.ok, false, JSON.stringify(run));
	assert.match(run.ok ? "" : run.note, /先跑 just module setup stock-ta/);
	assert.equal(feed.calls().length, 0);
});

test("缺 POLYGON_API_KEY：这一拍失败，一行说明，不起 ta", async (t) => {
	const feed = await scanFeed(t, { key: "" });
	feed.watch("NVDA");
	const run = await feed.tick();
	assert.equal(run.ok, false);
	assert.match(run.ok ? "" : run.note, /POLYGON_API_KEY/);
	assert.equal(run.ok ? "" : run.note.split("\n").length, 1);
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
