import assert from "node:assert/strict";
import test from "node:test";
import type { Quote } from "../src/sources/market/detect.ts";
import { sessionAt } from "../src/sources/market/session.ts";
import {
	alertText,
	applyEdit,
	checkIntraday,
	crossShape,
	echoText,
	firingId,
	LIMITS,
	parseBook,
	parseEdit,
	polledSymbols,
	receiptText,
	redact,
	serializeBook,
	settleCross,
	type Applied,
	type Book,
	type Firing,
	type History,
	type Tripwire,
} from "../src/sources/market/tripwires.ts";

const NOW = Date.parse("2026-11-09T15:00:00Z");
const EMPTY: Book = new Map();

function apply(book: Book, op: string, args: unknown, watchlist: readonly string[] = [], now = NOW): Applied {
	const edit = parseEdit(op, args);
	if (edit.op === "list") throw new Error("list does not edit");
	return applyEdit(book, edit, watchlist, now);
}

function bookOf(...sets: unknown[]): Book {
	return sets.reduce<Book>((book, args) => {
		const r = apply(book, "set", args);
		if (!r.ok) throw new Error(r.reason);
		return r.book;
	}, EMPTY);
}

const conditions = (book: Book) => [...book.values()].map((t) => ({ symbol: t.symbol, ...t.condition }));
const reasonOf = (r: Applied) => (r.ok ? "" : r.reason);

test("parseEdit 拒绝：未知操作、非法代码、多余字段、越界阈值、未知方向，报错写明字段", () => {
	const rejects = (op: string, args: unknown, field: RegExp) => assert.throws(() => parseEdit(op, args), field);
	rejects("watch", {}, /未知操作 watch/);
	rejects("list", { symbol: "NVDA" }, /symbol/);
	rejects("set", { symbol: "nv da", condition: { kind: "day", pct: 5 } }, /symbol/);
	rejects("set", { symbol: "NVDA", condition: { kind: "day", pct: 5 }, note: "x" }, /note/);
	rejects("set", { symbol: "NVDA", condition: { kind: "day", pct: 5, basis: 120 } }, /condition\.basis/);
	rejects("set", { symbol: "NVDA", condition: { kind: "day", pct: 0.05 } }, /condition\.pct/);
	rejects("set", { symbol: "NVDA", condition: { kind: "day", pct: 101 } }, /condition\.pct/);
	rejects("set", { symbol: "NVDA", condition: { kind: "day", pct: "5" } }, /condition\.pct/);
	rejects("set", { symbol: "NVDA", condition: { kind: "day", dir: "sideways" } }, /condition\.dir/);
	rejects("set", { symbol: "NVDA", condition: { kind: "rsi" } }, /condition\.kind/);
	rejects("set", { symbol: "NVDA" }, /condition/);
	rejects("set", { symbol: "NVDA", condition: { kind: "cost", basis: -1 } }, /condition\.basis/);
	rejects("set", { symbol: "NVDA", condition: { kind: "cost", shares: -1 } }, /condition\.shares/);
	rejects("set", { symbol: "TSLA", condition: { kind: "cross", fast: 1 } }, /condition\.fast/);
	rejects("set", { symbol: "TSLA", condition: { kind: "cross", slow: 201 } }, /condition\.slow/);
	rejects("set", { symbol: "TSLA", condition: { kind: "cross", fast: 20, slow: 5 } }, /fast.*slow/);
	rejects("remove", { symbol: "TSLA", kind: "rsi" }, /kind/);
	rejects("remove", {}, /symbol/);
});

test("parseEdit 接受：代码转大写，remove 可以不给 kind，list 不带参数", () => {
	assert.deepEqual(parseEdit("set", { symbol: " nvda ", condition: { kind: "day", pct: 5 } }), { op: "set", symbol: "NVDA", patch: { kind: "day", pct: 5 } });
	assert.deepEqual(parseEdit("remove", { symbol: "TSLA" }), { op: "remove", symbol: "TSLA" });
	assert.deepEqual(parseEdit("list", undefined), { op: "list" });
	assert.deepEqual(parseEdit("list", {}), { op: "list" });
});

test("新条件缺必填字段时拒绝并写明字段；cross 不给均线用默认 5/20，day 不给方向算两个方向", () => {
	assert.match(reasonOf(apply(EMPTY, "set", { symbol: "NVDA", condition: { kind: "day", dir: "up" } })), /pct/);
	assert.match(reasonOf(apply(EMPTY, "set", { symbol: "NVDA", condition: { kind: "cost", pct: 10 } })), /basis/);
	assert.deepEqual(conditions(bookOf({ symbol: "TSLA", condition: { kind: "cross" } }, { symbol: "NVDA", condition: { kind: "day", pct: 5 } })), [
		{ symbol: "TSLA", kind: "cross", fast: LIMITS.crossDefault.fast, slow: LIMITS.crossDefault.slow },
		{ symbol: "NVDA", kind: "day", pct: 5, dir: "either" },
	]);
});

test("set 是合并补丁：只改阈值时成本价和股数不变；shares 给 null 才清掉；改完 fast 不小于 slow 时拒绝", () => {
	const book = bookOf({ symbol: "NVDA", condition: { kind: "cost", basis: 120, shares: 100, pct: 10, dir: "either" } });
	const r = apply(book, "set", { symbol: "NVDA", condition: { kind: "cost", pct: 8 } });
	assert.ok(r.ok);
	assert.deepEqual(conditions(r.book), [{ symbol: "NVDA", kind: "cost", basis: 120, shares: 100, pct: 8, dir: "either" }]);
	const cleared = apply(r.book, "set", { symbol: "NVDA", condition: { kind: "cost", shares: null } });
	assert.deepEqual(cleared.ok && conditions(cleared.book), [{ symbol: "NVDA", kind: "cost", basis: 120, pct: 8, dir: "either" }]);
	const cross = bookOf({ symbol: "TSLA", condition: { kind: "cross", fast: 5, slow: 20 } });
	assert.match(reasonOf(apply(cross, "set", { symbol: "TSLA", condition: { kind: "cross", fast: 30 } })), /fast.*slow/);
});

test("同一个修改做两遍：第二遍 changed 为 false，清单和设定时间都不变", () => {
	const args = { symbol: "NVDA", condition: { kind: "day", pct: 5, dir: "up" } };
	const first = apply(EMPTY, "set", args);
	assert.ok(first.ok && first.changed);
	const again = apply(first.book, "set", args, [], NOW + 60_000);
	assert.ok(again.ok);
	assert.equal(again.changed, false);
	assert.deepEqual([...again.book.values()], [...first.book.values()]);
	const removed = apply(first.book, "remove", { symbol: "NVDA" });
	assert.ok(removed.ok && removed.changed && removed.book.size === 0);
	const removedAgain = apply(removed.book, "remove", { symbol: "NVDA" });
	assert.ok(removedAgain.ok && !removedAgain.changed);
});

test("remove 不给 kind 去掉这只的全部条件；给了只去掉那一种", () => {
	const book = bookOf({ symbol: "NVDA", condition: { kind: "day", pct: 5 } }, { symbol: "NVDA", condition: { kind: "cross" } }, { symbol: "TSLA", condition: { kind: "day", pct: 3 } });
	const keys = (r: Applied) => (r.ok ? conditions(r.book).map((c) => `${c.symbol}:${c.kind}`) : []);
	assert.deepEqual(keys(apply(book, "remove", { symbol: "NVDA", kind: "cross" })), ["NVDA:day", "TSLA:day"]);
	const all = apply(book, "remove", { symbol: "NVDA" });
	assert.deepEqual(keys(all), ["TSLA:day"]);
	assert.deepEqual(all.ok && all.before.map((t) => t.condition.kind), ["day", "cross"]);
});

const syms = (n: number, prefix = "S") => Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);

test("上限：watchlist 加条件里的股票最多 50 只，第 51 只拒绝；已在 watchlist 里的不占新名额", () => {
	const watchlist = syms(49, "W");
	const first = apply(EMPTY, "set", { symbol: "NEWA", condition: { kind: "day", pct: 5 } }, watchlist);
	assert.ok(first.ok);
	assert.match(reasonOf(apply(first.book, "set", { symbol: "NEWB", condition: { kind: "day", pct: 5 } }, watchlist)), /50/);
	assert.ok(apply(first.book, "set", { symbol: watchlist[0], condition: { kind: "day", pct: 5 } }, watchlist).ok);
	assert.ok(apply(first.book, "set", { symbol: "NEWA", condition: { kind: "cross" } }, watchlist).ok);
});

test("上限：均线交叉最多 10 只，第 11 只拒绝；改已有的交叉、给第 11 只设别的条件不受影响", () => {
	const book = bookOf(...syms(10).map((symbol) => ({ symbol, condition: { kind: "cross" } })));
	assert.match(reasonOf(apply(book, "set", { symbol: "ELEVEN", condition: { kind: "cross" } })), /10/);
	assert.ok(apply(book, "set", { symbol: syms(1)[0], condition: { kind: "cross", fast: 10, slow: 30 } }).ok);
	assert.ok(apply(book, "set", { symbol: "ELEVEN", condition: { kind: "day", pct: 5 } }).ok);
});

test("轮询的股票：watchlist 在前，然后是只在条件里的，不重复", () => {
	const book = bookOf({ symbol: "TSLA", condition: { kind: "day", pct: 5 } }, { symbol: "SPY", condition: { kind: "day", pct: 1 } }, { symbol: "TSLA", condition: { kind: "cross" } }, { symbol: "NVDA", condition: { kind: "cross" } });
	assert.deepEqual(polledSymbols(book, ["SPY", "QQQ"]), ["SPY", "QQQ", "TSLA", "NVDA"]);
});

test("存取：serializeBook 再 parseBook 得到同一份清单；没有数据是空清单；读不出来报问题，不当成空清单", () => {
	const book = bookOf({ symbol: "NVDA", condition: { kind: "cost", basis: 120, shares: 100, pct: 10, dir: "either" } }, { symbol: "TSLA", condition: { kind: "cross" } });
	const raw = serializeBook(book);
	assert.equal(JSON.parse(raw).version, 1);
	const back = parseBook(raw);
	assert.ok("book" in back);
	assert.deepEqual([...back.book.entries()], [...book.entries()]);
	const empty = parseBook(undefined);
	assert.ok("book" in empty && empty.book.size === 0);
	const unreadable = [
		"{",
		"[]",
		'{"version":2,"tripwires":[]}',
		'{"version":1,"tripwires":[{"symbol":"nv da","condition":{"kind":"day","pct":5,"dir":"up"},"setAt":1}]}',
		'{"version":1,"tripwires":[{"symbol":"NVDA","condition":{"kind":"cost","pct":5,"dir":"up"},"setAt":1}]}',
		'{"version":1,"tripwires":[{"symbol":"NVDA","condition":{"kind":"day","pct":5,"dir":"up"},"setAt":1},{"symbol":"NVDA","condition":{"kind":"day","pct":3,"dir":"up"},"setAt":1}]}',
	];
	for (const raw of unreadable) {
		const r = parseBook(raw);
		assert.ok("problem" in r && typeof r.problem === "string" && r.problem.length > 0, raw);
	}
});


const TODAY = "2026-11-09";
const SESSION = sessionAt(NOW);
const NO_HISTORY: History = new Map();

function quote(symbol: string, price: number, prevClose: number, over: Partial<Quote> = {}): Quote {
	return { symbol, price, prevClose, changePct: ((price - prevClose) / prevClose) * 100, at: NOW, delayed: true, ...over };
}

const fired = (book: Book, quotes: Quote[], history = NO_HISTORY) => checkIntraday(book, quotes, SESSION, history).map((f) => `${f.symbol}:${f.kind}:${"side" in f ? f.side : f.shape}`);

test("day：涨跌幅到了阈值就报，方向要符合；没到、方向不对、不在清单里的不报", () => {
	const book = bookOf(
		{ symbol: "NVDA", condition: { kind: "day", pct: 5 } },
		{ symbol: "AAPL", condition: { kind: "day", pct: 3, dir: "up" } },
		{ symbol: "TSLA", condition: { kind: "day", pct: 3, dir: "down" } },
		{ symbol: "AMD", condition: { kind: "day", pct: 3, dir: "down" } },
	);
	const quotes = [quote("NVDA", 105.2, 100), quote("AAPL", 96, 100), quote("TSLA", 96.5, 100), quote("AMD", 102, 100), quote("MSFT", 90, 100)];
	assert.deepEqual(fired(book, quotes), ["NVDA:day:up", "TSLA:day:down"]);
	assert.deepEqual(fired(book, [quote("NVDA", 95, 100), quote("AAPL", 103, 100)]), ["NVDA:day:down", "AAPL:day:up"]);
	assert.deepEqual(fired(book, [quote("NVDA", 104.9, 100)]), []);
	const q = quote("NVDA", 105.2, 100);
	assert.deepEqual(checkIntraday(book, [q], SESSION, NO_HISTORY), [{ kind: "day", symbol: "NVDA", side: "up", pct: 5, changePct: q.changePct, price: 105.2, prevClose: 100 }]);
});

test("过期和不在常规时段的报价不算：上个交易日、盘前、收盘后", () => {
	const book = bookOf({ symbol: "NVDA", condition: { kind: "day", pct: 5 } });
	for (const at of [Date.parse("2026-11-06T20:59:00Z"), Date.parse("2026-11-09T14:00:00Z"), Date.parse("2026-11-09T21:30:00Z")]) {
		assert.deepEqual(fired(book, [quote("NVDA", 110, 100, { at })]), [], new Date(at).toISOString());
	}
});

test("cost：今天越过线才报，按昨收算已在线外的不报；方向不符不报；带上精确偏离", () => {
	const book = bookOf({ symbol: "NVDA", condition: { kind: "cost", basis: 100, shares: 50, pct: 10 } }, { symbol: "AMD", condition: { kind: "cost", basis: 100, pct: 10, dir: "up" } });
	const [up] = checkIntraday(book, [quote("NVDA", 111, 108)], SESSION, NO_HISTORY);
	assert.ok(up?.kind === "cost");
	const { driftPct, ...rest } = up;
	assert.deepEqual(rest, { kind: "cost", symbol: "NVDA", side: "up", pct: 10, price: 111 });
	assert.ok(Math.abs(driftPct - 11) < 1e-9);
	assert.deepEqual(fired(book, [quote("NVDA", 112, 110.5)]), []);
	assert.deepEqual(fired(book, [quote("NVDA", 89, 95)]), ["NVDA:cost:down"]);
	assert.deepEqual(fired(book, [quote("NVDA", 85, 89)]), []);
	assert.deepEqual(fired(book, [quote("AMD", 89, 95)]), []);
	assert.deepEqual(fired(book, [quote("NVDA", 109, 100)]), []);
});

const GOLDEN_BEFORE = [12, 11, 10, 10];
const DEATH_BEFORE = [8, 9, 10, 10];

test("crossShape：快线从不高于慢线变成高于是金叉，反过来是死叉；没翻转或收盘价不够是 null", () => {
	assert.deepEqual(crossShape(GOLDEN_BEFORE, 13, 2, 3), { shape: "golden", fastSma: 11.5, slowSma: 11 });
	assert.deepEqual(crossShape(DEATH_BEFORE, 7, 2, 3), { shape: "death", fastSma: 8.5, slowSma: 9 });
	assert.equal(crossShape(GOLDEN_BEFORE, 10, 2, 3), null);
	assert.equal(crossShape([11, 10, 10], 13, 2, 3), null);
});

test("cross 盘中：拿今天取的已收盘日线加现价报疑似；日线不是今天取的或不够长都不报", () => {
	const book = bookOf({ symbol: "TSLA", condition: { kind: "cross", fast: 2, slow: 3 } });
	const history: History = new Map([["TSLA", { fetchedOn: TODAY, settledCloses: GOLDEN_BEFORE }]]);
	assert.deepEqual(checkIntraday(book, [quote("TSLA", 13, 10)], SESSION, history), [
		{ kind: "cross", symbol: "TSLA", fast: 2, slow: 3, shape: "golden", stage: "suspected", price: 13, fastSma: 11.5, slowSma: 11 },
	]);
	assert.deepEqual(fired(book, [quote("TSLA", 10, 10)], history), []);
	assert.deepEqual(fired(book, [quote("TSLA", 13, 10)], new Map([["TSLA", { fetchedOn: "2026-11-06", settledCloses: GOLDEN_BEFORE }]])), []);
	assert.deepEqual(fired(book, [quote("TSLA", 13, 10)], new Map([["TSLA", { fetchedOn: TODAY, settledCloses: [11, 10, 10] }]])), []);
	assert.deepEqual(fired(book, [quote("TSLA", 13, 10)]), []);
});

test("settleCross：当天收盘翻转就确认（没报过疑似也确认）；没翻转但报过疑似就撤回；否则什么都不报", () => {
	const [cross] = bookOf({ symbol: "TSLA", condition: { kind: "cross", fast: 2, slow: 3 } }).values() as unknown as [Tripwire & { condition: { kind: "cross" } }];
	const base = { kind: "cross", symbol: "TSLA", fast: 2, slow: 3 };
	assert.deepEqual(settleCross(cross, [...GOLDEN_BEFORE, 13], false), { ...base, shape: "golden", stage: "confirmed", price: 13, fastSma: 11.5, slowSma: 11 });
	assert.deepEqual(settleCross(cross, [...DEATH_BEFORE, 7], true), { ...base, shape: "death", stage: "confirmed", price: 7, fastSma: 8.5, slowSma: 9 });
	assert.deepEqual(settleCross(cross, [...GOLDEN_BEFORE, 10], true), { ...base, shape: "golden", stage: "withdrawn", price: 10, fastSma: 10, slowSma: 10 });
	assert.deepEqual(settleCross(cross, [...DEATH_BEFORE, 10], true), { ...base, shape: "death", stage: "withdrawn", price: 10, fastSma: 10, slowSma: 10 });
	assert.equal(settleCross(cross, [...GOLDEN_BEFORE, 10], false), null);
	assert.equal(settleCross(cross, [11, 10, 10, 13], true), null);
});

const LIVE = { at: NOW, delayed: true };

test("firingId：代码、纽约日、带阈值的信号，没有时钟；同一触发换个报价时间 id 不变，改阈值 id 就变", () => {
	const book = bookOf({ symbol: "NVDA", condition: { kind: "day", pct: 5 } }, { symbol: "AMD", condition: { kind: "cost", basis: 100, pct: 10 } });
	const ids = (b: Book, at: number) => checkIntraday(b, [quote("NVDA", 106, 100, { at }), quote("AMD", 89, 95, { at })], sessionAt(at), NO_HISTORY).map((f) => firingId(TODAY, f));
	assert.deepEqual(ids(book, NOW), ["NVDA:2026-11-09:day-up-5", "AMD:2026-11-09:cost-down-10"]);
	assert.deepEqual(ids(book, NOW + 47 * 60_000 + 13_000), ids(book, NOW));
	const retuned = apply(book, "set", { symbol: "NVDA", condition: { kind: "day", pct: 5.5 } });
	assert.ok(retuned.ok);
	assert.deepEqual(ids(retuned.book, NOW), ["NVDA:2026-11-09:day-up-5.5", "AMD:2026-11-09:cost-down-10"]);
	const cross: Firing = { kind: "cross", symbol: "TSLA" as never, fast: 5, slow: 20, shape: "golden", stage: "suspected", price: 250.1, fastSma: 248.31, slowSma: 247.95 };
	assert.equal(firingId(TODAY, cross), "TSLA:2026-11-09:cross-5-20-golden-suspected");
	assert.equal(firingId(TODAY, { ...cross, shape: "death", stage: "withdrawn" }), "TSLA:2026-11-09:cross-5-20-death-withdrawn");
});

test("alertText：一行中文，只有价格和百分比，写明报价时间和是否延迟", () => {
	const [day] = checkIntraday(bookOf({ symbol: "NVDA", condition: { kind: "day", pct: 5 } }), [quote("NVDA", 105.2, 100)], SESSION, NO_HISTORY);
	assert.equal(alertText(day!, LIVE), "【盯盘提醒】NVDA 涨 +5.20%，到了你设的 +5% 提醒线。现价 105.20，昨收 100.00。报价时间 10:00 ET（延迟行情）。");
	const [cost] = checkIntraday(bookOf({ symbol: "AMD", condition: { kind: "cost", basis: 100, pct: 10 } }), [quote("AMD", 89, 95)], SESSION, NO_HISTORY);
	assert.equal(alertText(cost!, { at: NOW, delayed: false }), "【盯盘提醒】AMD 相对成本价 -11.00%，到了你设的 -10% 提醒线。现价 89.00。报价时间 10:00 ET。");
	const cross = (stage: "suspected" | "confirmed" | "withdrawn", shape: "golden" | "death" = "golden"): Firing => ({ kind: "cross", symbol: "TSLA" as never, fast: 5, slow: 20, shape, stage, price: 250.1, fastSma: 248.31, slowSma: 247.95 });
	assert.equal(alertText(cross("suspected"), LIVE), "【盯盘提醒】TSLA 疑似金叉：把现价 250.10 当作今天收盘，5 日均线 248.31 上穿 20 日均线 247.95。收盘后确认。报价时间 10:00 ET（延迟行情）。");
	assert.equal(alertText(cross("confirmed"), LIVE), "【盯盘提醒】TSLA 金叉确认：今天收盘 250.10，5 日均线 248.31 上穿 20 日均线 247.95。");
	assert.equal(alertText(cross("withdrawn", "death"), LIVE), "【盯盘提醒】TSLA 死叉没有成立：今天收盘 250.10，5 日均线 248.31，20 日均线 247.95。早前的疑似死叉提醒作废。");
	for (const f of [day!, cost!, cross("suspected"), cross("confirmed", "death"), cross("withdrawn")]) {
		const text = alertText(f, LIVE);
		assert.ok(!/[\r\n]/.test(text) && text.length <= 1000, text);
	}
});

test("防泄露：每一种 cost 触发的提醒、给 Worker 的回显和清单里都没有成本价和股数", () => {
	const basis = 123.45;
	const shares = 777;
	const set = apply(EMPTY, "set", { symbol: "NVDA", condition: { kind: "cost", basis, shares, pct: 10 } });
	assert.ok(set.ok);
	const changed = apply(set.book, "set", { symbol: "NVDA", condition: { kind: "cost", pct: 8 } });
	const same = apply(set.book, "set", { symbol: "NVDA", condition: { kind: "cost", pct: 10 } });
	const removed = apply(set.book, "remove", { symbol: "NVDA" });
	const firings = [
		[137, 130],
		[110, 116],
		[136, 120],
		[111, 125],
	].flatMap(([price, prev]) => checkIntraday(set.book, [quote("NVDA", price!, prev!)], SESSION, NO_HISTORY));
	assert.equal(firings.length, 4);
	const outbound = [...firings.map((f) => alertText(f, LIVE)), ...[set, changed, same, removed].map(echoText), JSON.stringify(redact(set.book))];
	for (const text of outbound) {
		assert.ok(!text.includes(String(basis)) && !text.includes(String(shares)), text);
	}
	assert.match(receiptText(set.before, set.after, set.book), /123\.45/);
	assert.match(receiptText(set.before, set.after, set.book), /777 股/);
	assert.deepEqual(redact(set.book), [{ symbol: "NVDA", kind: "cost", pct: 10, dir: "either", hasShares: true }]);
});

test("回显：说清新加、改了、没变、去掉和现在共几条；拒绝时带上原因", () => {
	const added = apply(EMPTY, "set", { symbol: "NVDA", condition: { kind: "cost", basis: 120, shares: 100, pct: 10 } });
	assert.equal(echoText(added), "已添加：NVDA 相对成本价涨跌超过 10% 时提醒（成本价和股数只在网页显示）。现在共 1 条。");
	assert.ok(added.ok);
	const changed = apply(added.book, "set", { symbol: "NVDA", condition: { kind: "cost", pct: 8, dir: "down" } });
	assert.equal(echoText(changed), "已改：NVDA 相对成本价跌超过 8% 时提醒（成本价和股数只在网页显示），原来是 NVDA 相对成本价涨跌超过 10% 时提醒（成本价和股数只在网页显示）。现在共 1 条。");
	assert.match(echoText(apply(added.book, "set", { symbol: "NVDA", condition: { kind: "cost", pct: 10 } })), /^没有变化：/);
	assert.equal(echoText(apply(added.book, "remove", { symbol: "NVDA" })), "已去掉：NVDA 相对成本价涨跌超过 10% 时提醒（成本价和股数只在网页显示）。现在共 0 条。");
	assert.match(echoText(apply(EMPTY, "set", { symbol: "NVDA", condition: { kind: "cost", pct: 10 } })), /^没改成：NVDA：.*basis/);
});

test("收据：一条一行，写明成本价和股数、共几条；成本线设下时已在线外要说明回到线内再越过才提醒", () => {
	const book = bookOf({ symbol: "TSLA", condition: { kind: "cross" } });
	const r = apply(book, "set", { symbol: "NVDA", condition: { kind: "cost", basis: 120, shares: 100, pct: 10, dir: "up" } });
	assert.ok(r.ok);
	assert.equal(
		receiptText(r.before, r.after, r.book, 16.666),
		["已添加：NVDA 成本价 120、100 股，相对成本价涨超过 10% 时提醒。", "现在已在 +16.7%，回到线内后再越过才提醒。", "现在共 2 条：", "TSLA 5 日均线和 20 日均线金叉、死叉时提醒", "NVDA 成本价 120、100 股，相对成本价涨超过 10% 时提醒"].join("\n"),
	);
	assert.doesNotMatch(receiptText(r.before, r.after, r.book, 4), /现在已在/);
	assert.doesNotMatch(receiptText(r.before, r.after, r.book, -16), /现在已在/);
});

test("收据在满额清单（50 只 × 3 种，最长的代码和数字）时不超过 16000 字", () => {
	const symbol = (i: number) => `ABCDEFGH${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}.XYZ`;
	const tripwires = Array.from({ length: LIMITS.polledSymbols }, (_, i) => [
		{ symbol: symbol(i), condition: { kind: "day", pct: 99.99, dir: "either" }, setAt: NOW },
		{ symbol: symbol(i), condition: { kind: "cost", pct: 99.99, dir: "either", basis: 999999.9999, shares: 999999999.99 }, setAt: NOW },
		{ symbol: symbol(i), condition: { kind: "cross", fast: 199, slow: 200 }, setAt: NOW },
	]).flat();
	const parsed = parseBook(JSON.stringify({ version: 1, tripwires }));
	assert.ok("book" in parsed && parsed.book.size === 150);
	const [, cost] = parsed.book.values();
	const before = { ...cost!, condition: { ...cost!.condition, pct: 50 } } as Tripwire;
	const text = receiptText([before], [cost!], parsed.book, 99.99);
	assert.ok(text.length <= 16000, `${text.length}`);
	assert.equal(text.split("\n").length, 153);
});
