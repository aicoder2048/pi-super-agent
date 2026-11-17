import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fills from "../../docs/modules/examples/option-ta/feeds/fills/index.ts";
import { parseFills, type FillLetter, type StoredRow } from "../../docs/modules/examples/option-ta/feeds/fills/parse.ts";

const PACKAGE = new URL("../../docs/modules/examples/option-ta/", import.meta.url);
const SAMPLES = new URL("../../docs/modules/option-ta-p1/mail-samples/", import.meta.url);
const NAMES = ["cc-open-put-close-unfilled", "csp-partial-underlyings", "mixed-with-stock-and-working", "cp1252-executed-at-nested"];
const CUT = "\n\n[HTML 超过 256 KB，后面截掉了，全文在 Gmail 里看]";

const json = (url: URL) => JSON.parse(readFileSync(url, "utf8"));
const letterOf = (name: string): FillLetter => json(new URL(`feeds/fills/fixtures/${name}.json`, PACKAGE)).input.items[0];

type Drafted = { id: string; fill_id: string; order_key: string; account_ref: string; side: string; qty: number; partial_fill: boolean; price: number; limit: number; trade_date: string; settle_date: string; executed_at: string | null; source: string; instrument: { underlying: string; option_symbol: string; right: string; strike: number; expiry: string; multiplier: number } };

/** The P1 drafts (`<name>.expected.json`) are written as plain JSON numbers; a stored `fills` row keeps prices as 4-decimal text. */
function expected(name: string, letterId: string) {
	const draft = json(new URL(`${name}.expected.json`, SAMPLES)) as { fills: Drafted[]; skipped: object[] };
	const rows = draft.fills.map((f) => ({
		id: f.id,
		record_type: "FILL",
		fill_id: f.fill_id,
		order_key: f.order_key,
		order_id: null,
		account_ref: f.account_ref,
		account_key: null,
		instrument: JSON.stringify(f.instrument),
		underlying: f.instrument.underlying,
		option_symbol: f.instrument.option_symbol,
		right: f.instrument.right,
		strike: f.instrument.strike,
		expiry: f.instrument.expiry,
		multiplier: f.instrument.multiplier,
		side: f.side,
		qty: f.qty,
		price: f.price.toFixed(4),
		cum_qty: f.qty,
		partial_fill: String(f.partial_fill),
		limit_price: f.limit.toFixed(4),
		trade_date: f.trade_date,
		executed_at: f.executed_at,
		trade_time: null,
		settle_date: f.settle_date,
		commission: null,
		fees: null,
		source: f.source,
		source_message_id: letterId,
	}));
	return { fills: rows, skipped: draft.skipped };
}

for (const name of NAMES) {
	test(`${name}: HTML 解析和 P1 草稿逐行一致（fills 和 skipped 都断言）`, () => {
		const letter = letterOf(name);
		assert.deepEqual(parseFills(letter, []), expected(name, letter.id));
	});

	test(`${name}: 没有 html 时按纯文本后备解析，结果相同`, () => {
		const { html: _html, ...plain } = letterOf(name);
		assert.deepEqual(parseFills(plain, []), expected(name, plain.id));
	});

	test(`${name}: handler 把 fills 写成 records，不发通知`, () => {
		const letter = letterOf(name);
		const out = fills({ items: [letter], rows: { fills: [] } });
		assert.deepEqual(out.records, expected(name, letter.id).fills);
		assert.deepEqual(out.notices, []);
	});
}

test("样例 4 的 Executed At 存进 executed_at，样例 1 没有这一列就是 null", () => {
	assert.deepEqual(parseFills(letterOf("cp1252-executed-at-nested"), []).fills.map((f) => f.executed_at), ["2026-03-09", "2026-03-09", "2026-03-09"]);
	assert.deepEqual(new Set(parseFills(letterOf("cc-open-put-close-unfilled"), []).fills.map((f) => f.executed_at)), new Set([null]));
});

const HEAD = ["Account", "Side", "Position", "Security", "Security Description", "Exe Qty", "Avg Price", "Open Qty", "Price Instructions", "Trade Date", "Settlement Date"];
const cells = (row: readonly string[]) => row.map((c) => `<td class="MsoNormalTable">${c === "" ? "" : `<p class="MsoNormal"><span>${c}</span></p>`}</td>`).join("");
const table = (...rows: string[][]) => `<table class="MsoNormalTable"><tr>${cells(HEAD)}</tr>${rows.map((r) => `<tr>${cells(r)}</tr>`).join("")}</table>`;
const letter = (html: string, id = "m-1"): FillLetter => ({ id, html, body: "" });
const aapl = (account: string, exe: string, avg: string, open: string, side = "Sell Call", position = "Open") => [account, side, position, "AAPL", "APPLE INC CALL 03/20/2026 @ 250", exe, avg, open, "3.10 Limit", "05-Mar-2026", "06-Mar-2026"];
const stored = (fields: Record<string, unknown>, id = "1"): StoredRow => ({ id, from: "option-ta/fills", fields });
const KEY = "AAPL260320C00250000:STO:2026-03-05:QRSTalfa";

test("部分成交：Open Qty 还有值，整单是第一笔，partial_fill 为 true", () => {
	const { fills: rows, skipped } = parseFills(letter(table(aapl("QRSTalfa", "5", "3.00", "7"))), []);
	assert.deepEqual(skipped, []);
	assert.deepEqual(rows.map((r) => [r.id, r.qty, r.price, r.cum_qty, r.partial_fill]), [[`${KEY}:cum5`, 5, "3.0000", 5, "true"]]);
});

test("累计增量：已记 cum5@3.00，新信 cum12 均价 3.10，只记 7 张、价格 (12×3.10−5×3.00)/7 按万分之一四舍五入", () => {
	const prior = [stored({ record_type: "FILL", fill_id: `${KEY}:cum5`, order_key: KEY, qty: 5, price: "3.0000" })];
	const { fills: rows } = parseFills(letter(table(aapl("QRSTalfa", "12", "3.10", ""))), prior);
	assert.deepEqual(rows.map((r) => [r.id, r.qty, r.price, r.cum_qty, r.partial_fill]), [[`${KEY}:cum12`, 7, "3.1714", 12, "false"]]);
});

test("四舍五入：恰好半个万分之一时进位", () => {
	const prior = [stored({ fill_id: `${KEY}:cum1`, order_key: KEY, qty: 1, price: "1.0000" })];
	const { fills: rows } = parseFills(letter(table(aapl("QRSTalfa", "3", "1.0001", ""))), prior);
	assert.deepEqual(rows.map((r) => [r.qty, r.price]), [[2, "1.0002"]]);
});

test("cum 不大于已记的张数：同一张表又来了一次，不记也不进 skipped", () => {
	const prior = [stored({ fill_id: `${KEY}:cum12`, order_key: KEY, qty: 12, price: "3.1000" })];
	assert.deepEqual(parseFills(letter(table(aapl("QRSTalfa", "12", "3.10", ""))), prior), { fills: [], skipped: [] });
	assert.deepEqual(parseFills(letter(table(aapl("QRSTalfa", "5", "3.00", "7"))), prior), { fills: [], skipped: [] });
});

test("手动记过同一 fill_id：不再写", () => {
	const prior = [stored({ record_type: "FILL", fill_id: `${KEY}:cum12`, order_key: KEY, qty: 12, price: "3.1000", source: "manual" })];
	assert.deepEqual(parseFills(letter(table(aapl("QRSTalfa", "12", "3.10", ""))), prior).fills, []);
});

test("算出的增量价格不大于 0：不记，进 skipped unparsed", () => {
	const prior = [stored({ fill_id: `${KEY}:cum5`, order_key: KEY, qty: 5, price: "9.0000" })];
	const { fills: rows, skipped } = parseFills(letter(table(aapl("QRSTalfa", "6", "1.00", ""))), prior);
	assert.deepEqual(rows, []);
	assert.deepEqual(skipped, [{ reason: "unparsed", detail: "nonpositive-increment", account_ref: "QRSTalfa" }]);
});

test("同一张表里同订单键出现两行：只取第一行，第二行 duplicate-order-key", () => {
	const { fills: rows, skipped } = parseFills(letter(table(aapl("QRSTalfa", "5", "3.00", ""), aapl("QRSTalfa", "4", "3.05", ""))), []);
	assert.deepEqual(rows.map((r) => r.id), [`${KEY}:cum5`]);
	assert.deepEqual(skipped, [{ reason: "duplicate-order-key", account_ref: "QRSTalfa", order_key: KEY }]);
});

test("四个方向：Sell/Buy 加 Open/Close 合成 STO、BTO、BTC、STC", () => {
	const rows = [aapl("A1", "1", "1.00", "", "Sell Call", "Open"), aapl("A2", "1", "1.00", "", "Buy Call", "Open"), aapl("A3", "1", "1.00", "", "Buy Call", "Close"), aapl("A4", "1", "1.00", "", "Sell Call", "Close")];
	assert.deepEqual(parseFills(letter(table(...rows)), []).fills.map((r) => r.side), ["STO", "BTO", "BTC", "STC"]);
});

test("Side 和描述的 PUT/CALL 不一致、描述切不开、日期不对：进 unparsed，其余行照记", () => {
	const bad = [
		aapl("A1", "1", "1.00", "", "Sell Put"),
		["A2", "Sell Call", "Open", "AAPL", "APPLE INC CALL 3/20/26 @ 250", "1", "1.00", "", "1.00 Limit", "05-Mar-2026", "06-Mar-2026"],
		["A3", "Sell Call", "Open", "AAPL", "APPLE INC CALL 03/20/2026 @ 250", "1", "1.00", "", "1.00 Limit", "2026-03-05", "06-Mar-2026"],
		aapl("A4", "1", "1.00", ""),
	];
	const { fills: rows, skipped } = parseFills(letter(table(...bad)), []);
	assert.deepEqual(rows.map((r) => r.account_ref), ["A4"]);
	assert.deepEqual(skipped.map((s) => [s.reason, s.account_ref]), [["unparsed", "A1"], ["unparsed", "A2"], ["unparsed", "A3"]]);
});

test("带小数的行权价拼进 OCC 代码；发行人名里有空格、连字符和 &", () => {
	const row = ["A1", "Sell Put", "Open", "BRK.B", "BERKSHIRE HATHAWAY-CL B &amp; CO PUT 01/15/2027 @ 452.5", "2", "6.10", "", "6.10 Limit", "09-Mar-2026", "10-Mar-2026"];
	const [fill] = parseFills(letter(table(row)), []).fills;
	assert.equal(fill?.option_symbol, "BRKB270115P00452500");
	assert.equal(fill?.strike, 452.5);
});

test("按列名取值：Account 之后的列换了顺序、多一列也照取", () => {
	const head = ["Account", "Security", "Side", "Position", "Security Description", "Avg Price", "Exe Qty", "Open Qty", "Price Instructions", "Trade Date", "Settlement Date", "Note"];
	const html = `<table><tr>${cells(head)}</tr><tr>${cells(["A1", "AAPL", "Sell Call", "Open", "APPLE INC CALL 03/20/2026 @ 250", "3.10", "4", "", "3.10 Limit", "05-Mar-2026", "06-Mar-2026", "x"])}</tr></table>`;
	assert.deepEqual(parseFills(letter(html), []).fills.map((r) => [r.qty, r.price]), [[4, "3.1000"]]);
});

test("缺必需的列：整张表进 unparsed", () => {
	const html = `<table><tr>${cells(HEAD.filter((h) => h !== "Open Qty"))}</tr></table>`;
	assert.deepEqual(parseFills(letter(html), []), { fills: [], skipped: [{ reason: "unparsed", detail: "missing-columns" }] });
});

test("信里没有交易表：什么都不记", () => {
	assert.deepEqual(parseFills(letter("<p>Order received, working.</p>"), []), { fills: [], skipped: [] });
});

test("html 被截断、交易表在截断前已经完整：照常解析", () => {
	const html = table(aapl("QRSTalfa", "5", "3.00", "")) + "<p>signature</p>" + CUT;
	assert.deepEqual(parseFills(letter(html), []).fills.map((r) => r.id), [`${KEY}:cum5`]);
});

test("html 被截断在交易表中间：表里的行一行都不当真，纯文本也没有表时进 unparsed", () => {
	const html = table(aapl("QRSTalfa", "5", "3.00", "")).replace("</table>", "") + CUT;
	assert.deepEqual(parseFills(letter(html), []), { fills: [], skipped: [{ reason: "unparsed", detail: "html-truncated" }] });
});

test("html 被截断在交易表中间：改用纯文本的表", () => {
	const name = "csp-partial-underlyings";
	const full = letterOf(name);
	const cut = { ...full, html: full.html!.slice(0, full.html!.indexOf("</table>")) + CUT };
	assert.deepEqual(parseFills(cut, []), expected(name, full.id));
});

test("纯文本后备推不出来（描述后面四个值）：剩下的行进 unparsed", () => {
	const body = [...HEAD, "A1", "Sell Call", "Open", "AAPL", "APPLE INC CALL 03/20/2026 @ 250", "1", "2", "3", "4", "3.10 Limit", "05-Mar-2026", "06-Mar-2026", ""].join("\n");
	assert.deepEqual(parseFills({ id: "m-1", body }, []), { fills: [], skipped: [{ reason: "unparsed", detail: "text-row" }] });
});

test("已记的行坏了（价格不是数）：这一单进 unparsed，不猜", () => {
	const prior = [stored({ fill_id: `${KEY}:cum5`, order_key: KEY, qty: 5, price: "abc" })];
	assert.deepEqual(parseFills(letter(table(aapl("QRSTalfa", "12", "3.10", ""))), prior).skipped, [{ reason: "unparsed", detail: "recorded-rows", account_ref: "QRSTalfa" }]);
});

test("handler：unparsed 和 duplicate-order-key 发一条通知，只带原因和数目，不带信的内容", () => {
	const html = table(aapl("QRSTalfa", "5", "3.00", ""), aapl("QRSTalfa", "4", "3.05", ""), aapl("SECRETacct", "1", "1.00", "", "Sell Put"));
	const out = fills({ items: [{ id: "m-9", threadId: "t-9", subject: "secret subject", html, body: "" }], rows: { fills: [] } });
	assert.equal(out.records.length, 1);
	assert.deepEqual(out.notices, [{ id: "m-9:skipped", thread: "t-9", fields: { letter: "m-9", count: "2", reasons: "duplicate-order-key 1 行、unparsed 1 行" } }]);
	assert.doesNotMatch(JSON.stringify(out.notices), /SECRET|secret|AAPL|QRST/);
});

test("handler：挂单、没成交、股票行、部分成交不打扰", () => {
	const out = fills({ items: [letterOf("mixed-with-stock-and-working")], rows: { fills: [] } });
	assert.deepEqual(out.notices, []);
});

test("handler：信的形状不对就抛一句固定的话，不引用信的内容", () => {
	assert.throws(() => fills({ items: [{ secret: "QRSTalfa 12 AAPL" }], rows: {} }), (error: Error) => error.message === "成交邮件的信缺 id，这封信没有入账" && !/QRST|AAPL/.test(error.message));
});

test("handler：下一封信从 rows 里已记的行算增量", () => {
	const html = table(aapl("QRSTalfa", "5", "3.00", "7"));
	const first = fills({ items: [letter(html, "m-1")], rows: { fills: [] } }).records;
	const prior = first.map((r, i) => stored(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id")), String(i + 1)));
	const second = fills({ items: [letter(table(aapl("QRSTalfa", "12", "3.10", "")), "m-2")], rows: { fills: prior } }).records;
	assert.deepEqual(second.map((r) => [r.id, r.qty, r.price, r.partial_fill]), [[`${KEY}:cum12`, 7, "3.1714", "false"]]);
});

test("手动记过同一单、数和邮件对不上：不写，进 unparsed 让领队问", () => {
	const prior = [stored({ record_type: "FILL", fill_id: `${KEY}:cum12`, order_key: KEY, qty: 12, price: "2.5000", source: "manual" })];
	assert.deepEqual(parseFills(letter(table(aapl("QRSTalfa", "12", "3.10", ""))), prior), { fills: [], skipped: [{ reason: "unparsed", detail: "conflicts-with-recorded", account_ref: "QRSTalfa" }] });
});

test("增量价格四舍五入以后是 0：不记，进 unparsed", () => {
	const prior = [stored({ fill_id: `${KEY}:cum1`, order_key: KEY, qty: 1, price: "0.0003" })];
	assert.deepEqual(parseFills(letter(table(aapl("QRSTalfa", "4", "0.0001", ""))), prior).skipped, [{ reason: "unparsed", detail: "nonpositive-increment", account_ref: "QRSTalfa" }]);
});

test("同一订单键先是挂单行、后是成交行：只认第一行，成交行进 duplicate-order-key", () => {
	const { fills: rows, skipped } = parseFills(letter(table(aapl("QRSTalfa", "", "", "5"), aapl("QRSTalfa", "5", "3.00", ""))), []);
	assert.deepEqual(rows, []);
	assert.deepEqual(skipped.map((s) => s.reason), ["working-order", "duplicate-order-key"]);
});

test("HTML 省略了 </td> 和 </tr>：下一格、下一行或表尾替它收尾", () => {
	const open = (row: readonly string[]) => `<tr>${row.map((c) => `<td>${c}`).join("")}`;
	const html = `<table>${open(HEAD)}${open(aapl("QRSTalfa", "5", "3.00", ""))}${open(aapl("LMNObeta", "2", "3.00", ""))}</table>`;
	assert.deepEqual(parseFills(letter(html), []).fills.map((r) => [r.account_ref, r.qty]), [["QRSTalfa", 5], ["LMNObeta", 2]]);
});

test("一行的格数和表头对不上（例如 colspan）：这一行进 unparsed，不按位置猜", () => {
	const html = `<table><tr>${cells(HEAD)}</tr><tr>${cells(aapl("QRSTalfa", "5", "3.00", "").slice(1))}</tr></table>`;
	assert.deepEqual(parseFills(letter(html), []), { fills: [], skipped: [{ reason: "unparsed", detail: "row-shape" }] });
});
