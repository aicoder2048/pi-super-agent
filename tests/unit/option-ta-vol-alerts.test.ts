import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { afterEach, beforeEach } from "node:test";
import type { IvPoint } from "../../docs/modules/examples/option-ta/iv-series.ts";
import { MIN_PERCENTILE_DAYS, richEntries, vixEvents } from "../../docs/modules/examples/option-ta/opportunity.ts";
import { bsPutPrice } from "../../docs/modules/examples/option-ta/options-math.ts";
import { replay } from "../helpers/option-ta-feed-replay.ts";

/** Weekdays ending on `last`, oldest first. */
function weekdays(last: string, count: number): string[] {
	const out: string[] = [];
	for (let t = Date.parse(`${last}T00:00:00Z`); out.length < count; t -= 86_400_000) {
		const day = new Date(t).getUTCDay();
		if (day !== 0 && day !== 6) out.unshift(new Date(t).toISOString().slice(0, 10));
	}
	return out;
}
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Closes alternating ±1% a day: HV20 about 0.16. */
const closesFor = (dates: string[]) => Object.fromEntries(dates.map((d, i) => [d, 100 * Math.exp(i % 2 === 0 ? 0 : 0.01)]));
const pointsFor = (dates: string[], ivs: number[]): IvPoint[] => dates.map((date, i) => ({ date, iv: ivs[i]!, expiry: addDays(date, 30) }));

test("偏贵：分位 ≥0.8 且 IV/HV ≥1.2 那天进入一次；之后一直高不再算；分位回到 0.7 以下再进入才是新的一次", () => {
	const dates = weekdays("2026-11-18", 160);
	const ivs = dates.map((_, i) => (i === 140 || i === 141 || i === 155 ? 0.3 : 0.15));
	const entries = richEntries(pointsFor(dates, ivs), closesFor(dates));
	assert.deepEqual(entries.map((e) => e.date), [dates[140], dates[155]]);
	assert.ok(entries[0]!.ratio > 1.2 && entries[0]!.percentile >= 0.8);
	assert.equal(entries[0]!.expiry, addDays(dates[140]!, 30));
});

test("偏贵：分位高但 IV/HV 不到 1.2 不算；IV 历史不到 120 天不判", () => {
	const dates = weekdays("2026-11-18", 160);
	assert.deepEqual(richEntries(pointsFor(dates, dates.map((_, i) => (i === 150 ? 0.18 : 0.15))), closesFor(dates)), [], "0.18 / 0.16 约 1.1");
	const short = dates.slice(0, MIN_PERCENTILE_DAYS - 1);
	assert.deepEqual(richEntries(pointsFor(short, short.map((_, i) => (i === short.length - 1 ? 0.4 : 0.15))), closesFor(short)), []);
});

test("偏贵：一直高没回落到 0.7 以下，第二次冲高不再提醒", () => {
	const dates = weekdays("2026-11-18", 160);
	const ivs = dates.map((_, i) => (i < 130 ? 0.15 : i === 130 ? 0.3 : i === 150 ? 0.32 : 0.2));
	assert.deepEqual(richEntries(pointsFor(dates, ivs), closesFor(dates)).map((e) => e.date), [dates[130]]);
});

test("偏贵：HV20 只用当天及以前的收盘——进入之后正股大幅波动，不改变那天已经进入", () => {
	const dates = weekdays("2026-11-18", 160);
	const closes = Object.fromEntries(dates.map((d, i) => [d, 100 * Math.exp(i % 2 === 0 ? 0 : i > 140 ? 0.1 : 0.01)]));
	const ivs = dates.map((_, i) => (i === 140 ? 0.3 : 0.15));
	assert.deepEqual(richEntries(pointsFor(dates, ivs), closes).map((e) => e.date), [dates[140]]);
});

test("偏贵：分位只看最近 365 天，一年多以前的高 IV 不压低今天的分位", () => {
	const dates = weekdays("2026-11-18", 400);
	const ivs = dates.map((_, i) => (i < 130 ? 0.5 : i === 399 ? 0.3 : 0.15));
	const entries = richEntries(pointsFor(dates, ivs), closesFor(dates));
	assert.equal(entries.at(-1)?.date, dates[399]);
	assert.ok(entries.at(-1)!.days < 400 && entries.at(-1)!.days > 250);
});

/** IVs of distinct baseline values, a spike at 140, the given dip at 145, another spike at 150. */
function rearmCase(dipPercentile: number) {
	const dates = weekdays("2026-11-18", 152);
	const ivs: number[] = [];
	for (let i = 0; i < 152; i++) {
		if (i === 140) ivs.push(0.3);
		else if (i === 150) ivs.push(0.31);
		else if (i === 145) {
			const sorted = [...ivs].sort((a, b) => a - b);
			const k = Math.round(dipPercentile * (ivs.length + 1));
			ivs.push((sorted[k - 1]! + sorted[k]!) / 2);
		} else ivs.push(0.1 + 0.0004 * i);
	}
	return richEntries(pointsFor(dates, ivs), closesFor(dates)).map((e) => dates.indexOf(e.date));
}

test("偏贵：回落到分位 0.72 不算结束，再冲高不提醒；回落到 0.68 才算结束，再冲高提醒", () => {
	assert.deepEqual(rearmCase(0.72), [140]);
	assert.deepEqual(rearmCase(0.68), [140, 150]);
});

const vix = (rows: [string, number, number?][]) => ({ VIX: new Map(rows.map(([d, v]) => [d, v])), VIX9D: new Map<string, number>(), VIX3M: new Map(rows.filter((r) => r[2] !== undefined).map(([d, , m]) => [d, m!])) });

test("VIX：收盘到 25 静音、到 35 响铃，一天跳过两条线只算高的那条；回到 20（25 线）、30（35 线）以下才重新生效；期限结构由正常转倒挂算一次，两天都要有 VIX3M", () => {
	const events = vixEvents(vix([["2026-11-10", 20, 22], ["2026-11-11", 26, 25], ["2026-11-12", 24, 23], ["2026-11-13", 36, 30], ["2026-11-16", 40], ["2026-11-17", 19, 21], ["2026-11-18", 36, 34]]));
	assert.deepEqual(events.map((e) => (e.kind === "level" ? `${e.date} ${e.level} ${e.ring}` : `${e.date} 倒挂`)), [
		"2026-11-11 25 false", "2026-11-11 倒挂", "2026-11-13 35 true", "2026-11-18 35 true", "2026-11-18 倒挂",
	]);
	assert.deepEqual(vixEvents(vix([["2026-11-10", 26], ["2026-11-11", 24], ["2026-11-12", 26]])), [], "第一天已在 25 以上，之后没回到 20 以下");
	const at35 = (dip: number) => vixEvents(vix([["2026-11-10", 20], ["2026-11-11", 36], ["2026-11-12", dip], ["2026-11-13", 36]])).filter((e) => e.kind === "level" && e.level === 35).length;
	assert.equal(at35(32), 1, "36→32→36：没回到 30 以下，不再响");
	assert.equal(at35(29), 2, "36→29→36：回到 30 以下，再响");
});

let dir = "";
const saved = process.env["PSA_MODULE_DATA"];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "option-ta-alerts-"));
	process.env["PSA_MODULE_DATA"] = dir;
});
afterEach(() => {
	if (saved === undefined) delete process.env["PSA_MODULE_DATA"];
	else process.env["PSA_MODULE_DATA"] = saved;
	rmSync(dir, { recursive: true, force: true });
});

/** A fictional data.db: SPY's IV series with a spike on its last session, and VIX crossing 35 on the last session. */
function seed(lastIv = 0.3, last = "2026-11-18") {
	const dates = weekdays(last, 160);
	const closes = closesFor(dates);
	const db = new DatabaseSync(join(dir, "data.db"));
	db.exec(`CREATE TABLE "iv-snapshots" ("_id" INTEGER PRIMARY KEY, symbol TEXT, trade_date TEXT, strike REAL, expiry TEXT, contract_close REAL, underlying_close REAL, methodology TEXT, data_status TEXT)`);
	const insert = db.prepare(`INSERT INTO "iv-snapshots" (symbol, trade_date, strike, expiry, contract_close, underlying_close, methodology, data_status) VALUES ('SPY', ?, ?, ?, ?, ?, 'option-ta-iv-close-v2', 'ok')`);
	dates.forEach((d, i) => insert.run(d, 100, addDays(d, 30), bsPutPrice(closes[d]!, 100, i === dates.length - 1 ? lastIv : 0.15, 30), closes[d]!));
	db.exec(`CREATE TABLE "vix-closes" ("_id" INTEGER PRIMARY KEY, ticker TEXT, trade_date TEXT, close REAL)`);
	const v = db.prepare(`INSERT INTO "vix-closes" (ticker, trade_date, close) VALUES (?, ?, ?)`);
	for (const [t, d, c] of [["VIX", "2026-11-17", 30], ["VIX", "2026-11-18", 36], ["VIX3M", "2026-11-17", 31], ["VIX3M", "2026-11-18", 33]] as const) v.run(t, d, c);
	db.close();
}
const EARNINGS = "https://finnhub.io/api/v1/calendar/earnings?from=2026-11-18&to=2027-03-18&symbol=SPY";
const earnings = (date: string | null) => (r: Record<string, unknown>) => (r[EARNINGS] = { earningsCalendar: date === null ? [] : [{ symbol: "SPY", date, epsActual: null }] });

test("feed：收盘 45 分钟后发 SPY 偏贵（静音，写到期前有财报会坍塌）、VIX 上穿 35（响铃）、倒挂（静音）；再跑一次不重发", async () => {
	seed();
	const first = await replay("vol-alerts", "no-history", { respond: earnings("2026-12-10") });
	const alerts = first.output.alerts as { id: string; text: string; push?: string }[];
	assert.deepEqual(alerts.map((a) => [a.id, a.push ?? "bell"]), [["vix-35:2026-11-18", "bell"], ["vix-inverted:2026-11-18", "silent"], ["iv-rich:SPY:2026-11-18", "silent"]]);
	const rich = alerts.at(-1)!.text;
	assert.match(rich, /^SPY 期权偏贵：2026-11-18 收盘 IV 30%/);
	assert.match(rich, /到 2026-12-18 到期前有财报（2026-12-10），这段高 IV 多半是财报撑的/);
	assert.match(rich, /不是交易建议/);
	const again = await replay("vol-alerts", "no-history", { change: (input) => (input.cursor = first.output.cursor), respond: earnings("2026-12-10") });
	assert.deepEqual(again.output.alerts, []);
	assert.deepEqual(again.fetched, []);
});

test("feed：到期前没有财报时写明不是财报撑的；没有 FINNHUB key 时写没查，照样发", async () => {
	seed();
	const none = await replay("vol-alerts", "no-history", { respond: earnings("2027-01-28") });
	assert.match(none.output.alerts.at(-1).text, /到 2026-12-18 到期前没有已宣布的财报/);
	const noKey = await replay("vol-alerts", "no-history", { secrets: {} });
	assert.match(noKey.output.alerts.at(-1).text, /财报日没查（没有设置 FINNHUB_API_KEY）/);
	assert.deepEqual(noKey.fetched, []);
});

test("feed：收盘 45 分钟内、或事件是两个交易日以前的（宿主停过），都不发", async () => {
	seed();
	const early = await replay("vol-alerts", "no-history", { change: (input) => (input.now = "2026-11-18T21:30:00.000Z"), respond: earnings(null) });
	assert.deepEqual(early.output.alerts.map((a: { id: string }) => a.id), [], "目标还是 11-17，事件在 11-18（还没到）");
	const late = await replay("vol-alerts", "no-history", { change: (input) => (input.now = "2026-11-23T22:00:00.000Z"), respond: earnings(null) });
	assert.deepEqual(late.output.alerts, []);
});

test("feed：当天盘后财报已经公布（Finnhub 带 epsActual）也算到期前的财报，从进入那天查起", async () => {
	seed();
	const reported = await replay("vol-alerts", "no-history", { respond: (r) => (r[EARNINGS] = { earningsCalendar: [{ symbol: "SPY", date: "2026-11-18", epsActual: 1.2 }, { symbol: "SPY", date: "2027-02-18", epsActual: null }] }) });
	assert.match(reported.output.alerts.at(-1).text, /到期前有财报（2026-11-18）/);
});

test("feed：Finnhub 失败时照发并写没查到", async () => {
	seed();
	const down = await replay("vol-alerts", "no-history", { respond: (r) => (r[EARNINGS] = { status: 503, body: "down" }) });
	assert.match(down.output.alerts.at(-1).text, /财报日没查到（Finnhub 返回 HTTP 503）/);
});

test("feed：进入偏贵的不是最新一天（后一天已存）不发；最新一天是无数据行时不算", async () => {
	seed();
	const db = new DatabaseSync(join(dir, "data.db"));
	db.prepare(`INSERT INTO "iv-snapshots" (symbol, trade_date, strike, expiry, contract_close, underlying_close, methodology, data_status) VALUES ('SPY', '2026-11-19', 100, '2026-12-19', 2, 100, 'option-ta-iv-close-v2', 'ok')`).run();
	db.close();
	const later = await replay("vol-alerts", "no-history", { change: (input) => (input.now = "2026-11-19T22:00:00.000Z"), secrets: {} });
	assert.ok(later.output.alerts.every((a: { id: string }) => !a.id.startsWith("iv-rich:")));
	rmSync(join(dir, "data.db"));
	seed();
	const db2 = new DatabaseSync(join(dir, "data.db"));
	db2.exec(`UPDATE "iv-snapshots" SET data_status = 'no-data' WHERE trade_date = '2026-11-18'`);
	db2.close();
	const noData = await replay("vol-alerts", "no-history", { secrets: {} });
	assert.ok(noData.output.alerts.every((a: { id: string }) => !a.id.startsWith("iv-rich:")));
});

test("feed：周六、下周一早上照发上周五的事；感恩节那天发前一天的；提前收盘日 13:45 以后才发当天的", async () => {
	const sent = async (last: string, now: string) => {
		rmSync(join(dir, "data.db"), { force: true });
		seed(0.3, last);
		const out = await replay("vol-alerts", "no-history", { change: (input) => (input.now = now), secrets: {} });
		return out.output.alerts.some((a: { id: string }) => a.id === `iv-rich:SPY:${last}`);
	};
	assert.equal(await sent("2026-11-20", "2026-11-21T18:00:00.000Z"), true, "周六");
	assert.equal(await sent("2026-11-20", "2026-11-23T15:00:00.000Z"), true, "周一开盘前");
	assert.equal(await sent("2026-11-20", "2026-11-23T22:00:00.000Z"), true, "周一收盘后，前一个交易日是上周五");
	assert.equal(await sent("2026-11-19", "2026-11-21T18:00:00.000Z"), true, "周六，最近两个交易日是周四、周五");
	assert.equal(await sent("2026-11-25", "2026-11-26T22:00:00.000Z"), true, "感恩节");
	assert.equal(await sent("2026-11-27", "2026-11-27T18:30:00.000Z"), false, "提前收盘 13:30");
	assert.equal(await sent("2026-11-27", "2026-11-27T18:50:00.000Z"), true, "提前收盘 13:50");
});

test("feed：没有 data.db、被移出自选的标的都不发 IV 提醒", async () => {
	assert.deepEqual((await replay("vol-alerts", "no-history")).output.alerts, []);
	seed();
	const removed = await replay("vol-alerts", "no-history", { change: (input) => (input.rows.watchlist = [{ id: "1", fields: { symbol: "SPY" } }, { id: "2", fields: { symbol: "SPY", removed_at: "2026-11-18T00:00:00Z" } }]) });
	assert.ok(removed.output.alerts.every((a: { id: string }) => !a.id.startsWith("iv-rich:")));
});
