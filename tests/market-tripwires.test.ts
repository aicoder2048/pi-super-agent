import assert from "node:assert/strict";
import test from "node:test";
import { applyEdit, LIMITS, parseBook, parseEdit, polledSymbols, serializeBook, type Applied, type Book } from "../src/sources/market/tripwires.ts";

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

