import assert from "node:assert/strict";
import test from "node:test";
import { detect, moveId, toTrigger, type MarketCursor, type Quote } from "../src/sources/market/detect.ts";
import { sessionAt } from "../src/sources/market/session.ts";

const settings = { bands: { default: [3, 5, 8], bySymbol: { SPY: [1.5, 2, 3], QQQ: [1.5, 2, 3] } }, volumeSpikeX: 5 };
const T = (iso: string) => Date.parse(iso);
const tenAm = T("2026-11-09T15:00:00Z");

function quote(symbol: string, changePct: number, over: Partial<Quote> = {}): Quote {
	return { symbol, price: Number((100 * (1 + changePct / 100)).toFixed(2)), prevClose: 100, changePct, at: tenAm, delayed: false, ...over };
}

function run(cursor: MarketCursor | undefined, quotes: Quote[], now = tenAm) {
	const r = detect(cursor, quotes, sessionAt(now), settings);
	return { ...r, ids: r.moves.map(moveId) };
}

test("档位只升不降：+3.4% 报 3% 档，+5.3% 报 5% 档，回落到 +4.1% 不再报，跌 3.2% 另算一个方向", () => {
	let r = run(undefined, [quote("NVDA", 3.4)]);
	assert.deepEqual(r.ids, ["NVDA:2026-11-09:up3"]);
	r = run(r.cursor, [quote("NVDA", 5.3)]);
	assert.deepEqual(r.ids, ["NVDA:2026-11-09:up5"]);
	r = run(r.cursor, [quote("NVDA", 4.1)]);
	assert.deepEqual(r.ids, []);
	r = run(r.cursor, [quote("NVDA", 5.6)]);
	assert.deepEqual(r.ids, []);
	r = run(r.cursor, [quote("NVDA", -3.2)]);
	assert.deepEqual(r.ids, ["NVDA:2026-11-09:down3"]);
});

test("跳空 +8.6% 只报最高的 8% 档一条", () => {
	assert.deepEqual(run(undefined, [quote("TSLA", 8.6)]).ids, ["TSLA:2026-11-09:up8"]);
});

test("SPY、QQQ 用指数档位：+1.6% 报 1.5% 档；同样幅度的个股不报", () => {
	assert.deepEqual(run(undefined, [quote("SPY", 1.6), quote("NVDA", 1.6), quote("QQQ", -2.1)]).ids, ["SPY:2026-11-09:up1.5", "QQQ:2026-11-09:down2"]);
});

test("新鲜度：报价时间不在今天的常规时段内（上个交易日、盘前）不算，游标记下今天还没见过新鲜报价、连续几轮没见到", () => {
	const stale = run(undefined, [quote("NVDA", 6, { at: T("2026-11-06T20:59:00Z") }), quote("AAPL", 6, { at: T("2026-11-09T14:00:00Z") })]);
	assert.deepEqual([stale.ids, stale.cursor.sawFreshQuote, stale.cursor.pollsWithoutFreshQuote], [[], false, 1]);
	assert.equal(run(stale.cursor, []).cursor.pollsWithoutFreshQuote, 2);
	const fresh = run(stale.cursor, [quote("NVDA", 0.2)]).cursor;
	assert.deepEqual([fresh.sawFreshQuote, fresh.pollsWithoutFreshQuote], [true, 0]);
	assert.equal(run(fresh, []).cursor.sawFreshQuote, true);
});

test("换日后重新计档：昨天报过 5% 档，今天再到 5% 还报，线程按天分开", () => {
	const yesterday: MarketCursor = { nyDate: "2026-11-06", sawFreshQuote: true, pollsWithoutFreshQuote: 0, fired: { NVDA: { highestUpBand: 5, highestDownBand: 0, volume: false } } };
	const r = run(yesterday, [quote("NVDA", 5.3)]);
	assert.deepEqual(r.ids, ["NVDA:2026-11-09:up5"]);
	assert.equal(r.cursor.nyDate, "2026-11-09");
});

test("放量：最近一分钟成交是昨日分钟均量的 5 倍以上报一次；开盘头 10 分钟不算", () => {
	const elevenAm = T("2026-11-09T16:00:00Z");
	const spike = (at: number) => quote("AAPL", 0.5, { at, minuteVolume: 6 * (39_000_000 / 390), prevVolume: 39_000_000 });
	let r = run(undefined, [spike(elevenAm)], elevenAm);
	assert.deepEqual(r.ids, ["AAPL:2026-11-09:volume"]);
	r = run(r.cursor, [spike(elevenAm + 60_000)], elevenAm + 60_000);
	assert.deepEqual(r.ids, []);
	const early = T("2026-11-09T14:35:00Z");
	assert.deepEqual(run(undefined, [spike(early)], early).ids, []);
	assert.deepEqual(run(undefined, [quote("AAPL", 0.5, { at: elevenAm, minuteVolume: 4 * 100_000, prevVolume: 39_000_000 })], elevenAm).ids, []);
});

test("触发：按代码按天的线程、稳定的外部 id、正文写明幅度、档位、价格和报价时间", () => {
	const [move] = run(undefined, [quote("NVDA", 5.31, { price: 142.85, prevClose: 135.65, at: T("2026-11-09T15:42:00Z"), delayed: true })]).moves;
	const trigger = toTrigger("us-market", move);
	assert.deepEqual(
		{ source: trigger.source, externalId: trigger.externalId, threads: trigger.threads, occurredAt: trigger.occurredAt },
		{ source: "us-market", externalId: "NVDA:2026-11-09:up5", threads: [{ id: "thr_us-market:NVDA:2026-11-09", title: "NVDA 2026-11-09 行情" }], occurredAt: T("2026-11-09T15:42:00Z") },
	);
	assert.equal(trigger.body, "NVDA 涨 +5.31%，到达 +5% 档。现价 142.85，昨收 135.65。报价时间 10:42 ET（延迟行情）。");
});

test("正好到档：609 对 600 是 +1.5%，算到 1.5% 档；不被浮点误差漏掉", () => {
	const exact = (symbol: string, price: number, prevClose: number) => quote(symbol, (price / prevClose - 1) * 100, { price, prevClose });
	assert.deepEqual(run(undefined, [exact("SPY", 609, 600), exact("NVDA", 103, 100), exact("AAPL", 95, 100)]).ids, ["SPY:2026-11-09:up1.5", "NVDA:2026-11-09:up3", "AAPL:2026-11-09:down5"]);
});

test("提前收盘日：13:00 以后的成交不算常规时段，不报档；第二天的放量按前一日 210 分钟算均量", () => {
	const afterHalfClose = T("2026-11-27T19:00:00Z");
	assert.deepEqual(run(undefined, [quote("NVDA", 6, { at: afterHalfClose })], afterHalfClose).ids, []);
	const volume = (at: number) => quote("AAPL", 0.5, { at, minuteVolume: 400_000, prevVolume: 21_000_000 });
	const mondayAfterHalfDay = T("2026-11-30T16:00:00Z");
	assert.deepEqual(run(undefined, [volume(mondayAfterHalfDay)], mondayAfterHalfDay).ids, []);
	const ordinaryDay = T("2026-11-10T16:00:00Z");
	assert.deepEqual(run(undefined, [volume(ordinaryDay)], ordinaryDay).ids, ["AAPL:2026-11-10:volume"]);
});
