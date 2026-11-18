import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import fills from "../../docs/modules/examples/option-ta/feeds/fills/index.ts";
import type { FillLetter } from "../../docs/modules/examples/option-ta/feeds/fills/parse.ts";
import { openPositions } from "../../docs/modules/examples/option-ta/feeds/watch/positions.ts";
import { ledgerView } from "../../docs/modules/examples/option-ta/tools/ledger/index.ts";
import { recordFill } from "../../docs/modules/examples/option-ta/tools/record/index.ts";

/** Every account name and short code here is made up. */
const PACKAGE = new URL("../../docs/modules/examples/option-ta/", import.meta.url);
const LETTER: FillLetter = JSON.parse(readFileSync(new URL("feeds/fills/fixtures/csp-partial-underlyings.json", PACKAGE), "utf8")).input.items[0];
const AMZN = "AMZN260220P00210000";
const MAIL_CODE = "QRSTalfa";
const REGISTERED = "DEMO-QRST-1001";

const registry = (...rows: [string, ...string[]][]) => rows.map(([account_ref, ...codes], i) => ({ _id: i + 1, account_ref, aliases: JSON.stringify(codes.map((code) => ({ kind: "email", code }))) }));
const feedRows = (rows: readonly Record<string, unknown>[]) => rows.map((fields, i) => ({ id: String(i + 1), from: "fixture", fields }));
const amznRows = (records: readonly { option_symbol: string; side: string }[]) => records.filter((r) => r.option_symbol === AMZN && r.side === "STO");

function recorded(accounts: Record<string, unknown>[], prior: Record<string, unknown>[] = []) {
	const r = recordFill({ account_ref: MAIL_CODE, side: "STO", underlying: "AMZN", right: "put", strike: "210", expiry: "2026-02-20", cum_qty: 10, avg_price: "3.0500", trade_date: "2026-02-09" }, { fills: prior, accounts });
	assert.equal(r.status, "ok", JSON.stringify(r));
	return (r as { row: Record<string, unknown> }).row;
}

test("先用 record 记了一单，同一单的成交邮件后到：不再记第二次", () => {
	const accounts = registry([REGISTERED, MAIL_CODE]);
	const row = recorded(accounts);
	const out = fills({ items: [LETTER], rows: { fills: feedRows([row]), accounts: feedRows(accounts) } } as never);
	assert.deepEqual(amznRows(out.records).filter((r) => (r as { account_ref: string }).account_ref !== "LMNObeta"), []);
});

test("认得出的邮件短码：新行记登记名，原短码留在 account_alias_seen", () => {
	const accounts = registry([REGISTERED, MAIL_CODE]);
	const out = fills({ items: [LETTER], rows: { fills: [], accounts: feedRows(accounts) } } as never);
	const mine = out.records.find((r) => r.order_key.startsWith(`${AMZN}:STO:2026-02-09:`) && (r as { account_alias_seen?: string }).account_alias_seen === MAIL_CODE);
	assert.ok(mine, JSON.stringify(out.records.map((r) => r.order_key)));
	assert.equal(mine.account_ref, REGISTERED);
	assert.equal(mine.order_key, `${AMZN}:STO:2026-02-09:${REGISTERED}`);
	assert.equal(mine.id, `${AMZN}:STO:2026-02-09:${REGISTERED}:cum10`);
	assert.equal(mine.qty, 10);
});

test("以前用短码记的邮件行算进同一单的累计：后来的信只补增量", () => {
	const accounts = registry([REGISTERED, MAIL_CODE]);
	const key = `${AMZN}:STO:2026-02-09:${MAIL_CODE}`;
	const earlier = { record_type: "FILL", fill_id: `${key}:cum4`, order_key: key, account_ref: MAIL_CODE, option_symbol: AMZN, side: "STO", qty: 4, cum_qty: 4, price: "3.0500", trade_date: "2026-02-09", source: "broker-email" };
	const out = fills({ items: [LETTER], rows: { fills: feedRows([earlier]), accounts: feedRows(accounts) } } as never);
	const mine = out.records.filter((r) => r.option_symbol === AMZN && r.account_ref === REGISTERED);
	assert.deepEqual(mine.map((r) => [r.order_key, r.qty, r.cum_qty]), [[`${AMZN}:STO:2026-02-09:${REGISTERED}`, 6, 10]]);
});

test("一个短码对上两个登记账户：不入账，记 ambiguous-account，通知领队问使用者", () => {
	const accounts = registry(["DEMO-QRST-1001", MAIL_CODE], ["DEMO-QRST-2002", MAIL_CODE]);
	const out = fills({ items: [LETTER], rows: { fills: [], accounts: feedRows(accounts) } } as never);
	assert.deepEqual(out.records.filter((r) => r.option_symbol === AMZN && [MAIL_CODE, "DEMO-QRST-1001", "DEMO-QRST-2002"].includes(r.account_ref)), []);
	assert.equal(out.notices.length, 1);
	assert.match(out.notices[0]!.fields.reasons, /ambiguous-account 1 行/);
});

test("登记了别名但这个短码认不出：照旧按短码入账，通知领队确认", () => {
	const accounts = registry([REGISTERED, "ZZZZx0000"]);
	const out = fills({ items: [LETTER], rows: { fills: [], accounts: feedRows(accounts) } } as never);
	assert.deepEqual(amznRows(out.records).map((r) => r.account_ref).sort(), ["LMNObeta", MAIL_CODE]);
	assert.equal(out.notices.length, 1);
	assert.match(out.notices[0]!.fields.reasons, /unknown-account 2 行/);
});

test("没有登记别名的旧安装：照旧写邮件短码，不通知", () => {
	const legacy = fills({ items: [LETTER], rows: { fills: [], accounts: feedRows([{ account_ref: "OLD-1" }]) } } as never);
	const bare = fills({ items: [LETTER] } as never);
	assert.deepEqual(legacy, bare);
	assert.deepEqual(amznRows(bare.records).map((r) => r.account_ref).sort(), ["LMNObeta", MAIL_CODE]);
});

const OCC = "TSLA261218C00300000";
const CLOSE_ACCOUNTS = [{ _id: 1, account_ref: "DEMO-NORT-4411", aliases: JSON.stringify([{ kind: "email", code: "NORTx4411" }]) }];
const mailOpen = (code: string) => ({ _id: 1, record_type: "FILL", source: "broker-email", account_ref: code, account_key: null, option_symbol: OCC, underlying: "TSLA", right: "call", strike: 300, expiry: "2026-12-18", multiplier: 100, side: "STO", trade_date: "2026-11-10", order_key: `${OCC}:STO:2026-11-10:${code}`, fill_id: `${OCC}:STO:2026-11-10:${code}:cum2`, qty: 2, cum_qty: 2, price: "2.1000", commission: "0", fees: "0" });

function recordClose(open: Record<string, unknown>, accounts: Record<string, unknown>[]) {
	const r = recordFill({ account_ref: "NORTx4411", side: "BTC", underlying: "TSLA", right: "call", strike: "300", expiry: "2026-12-18", cum_qty: 2, avg_price: "0.50", trade_date: "2026-11-17", commission: "0", fees: "0" }, { fills: [open], accounts });
	assert.equal(r.status, "ok", JSON.stringify(r));
	return { _id: 2, ...(r as { row: Record<string, unknown> }).row };
}

test("邮件记了开仓、record 记了平仓：盯盘不再报这个仓位", () => {
	const open = mailOpen("NORTx4411");
	const close = recordClose(open, CLOSE_ACCOUNTS);
	const out = openPositions(feedRows([open, close]), feedRows(CLOSE_ACCOUNTS));
	assert.deepEqual(out.positions, []);
});

test("邮件记了开仓、record 记了平仓：税务视图算出这条腿，没有找不到开仓的平仓", () => {
	const open = mailOpen("NORTx4411");
	const close = recordClose(open, CLOSE_ACCOUNTS);
	const out = ledgerView({ view: "tax", year: 2026 }, { fills: [open, close], chains: [], accounts: CLOSE_ACCOUNTS }, "2026-11-17") as { legs: { account_ref: string; qty: number; gain: string }[]; open: unknown[]; notes: string[] };
	assert.deepEqual(out.legs.map((l) => [l.account_ref, l.qty, l.gain]), [["DEMO-NORT-4411", 2, "320.00"]]);
	assert.deepEqual(out.open, []);
	assert.equal(out.notes.some((n) => n.includes("找不到开仓记录")), false, out.notes.join("\n"));
});

test("交易链视图：短码开仓和登记名平仓在同一条链里，链已平", () => {
	const open = mailOpen("NORTx4411");
	const close = recordClose(open, CLOSE_ACCOUNTS);
	const out = ledgerView({ view: "chain" }, { fills: [open, close], chains: [], accounts: CLOSE_ACCOUNTS }) as { chains: { chain_id: string; state: string }[] };
	assert.deepEqual(out.chains.map((c) => [c.chain_id, c.state]), [[`未归链:DEMO-NORT-4411:${OCC}`, "closed"]]);
});

test("历史行的短码对上两个登记账户：不合并，盯盘和账本都列进待确认", () => {
	const accounts = [
		{ _id: 1, account_ref: "DEMO-NORT-4411", aliases: JSON.stringify([{ kind: "email", code: "NORTxxxx" }]) },
		{ _id: 2, account_ref: "DEMO-NORT-5522", aliases: JSON.stringify([{ kind: "email", code: "NORTxxxx" }]) },
	];
	const open = mailOpen("NORTxxxx");
	const close = { ...mailOpen("DEMO-NORT-4411"), _id: 2, side: "BTC", trade_date: "2026-11-17", order_key: `${OCC}:BTC:2026-11-17:DEMO-NORT-4411`, fill_id: `${OCC}:BTC:2026-11-17:DEMO-NORT-4411:cum2`, price: "0.5000", source: "manual" };
	const watch = openPositions(feedRows([open, close]), feedRows(accounts));
	assert.deepEqual(watch.positions.map((p) => [p.account, p.qty]), [["NORTxxxx", 2]]);
	assert.ok(watch.notes.some((n) => n.includes("待确认账户") && n.includes("NORTxxxx")), watch.notes.join("\n"));
	const tax = ledgerView({ view: "tax", year: 2026 }, { fills: [open, close], chains: [], accounts }, "2026-11-17") as { notes: string[]; pending: string[] };
	assert.ok(tax.notes.some((n) => n.includes("待确认账户") && n.includes("NORTxxxx")), tax.notes.join("\n"));
	assert.ok(tax.pending.includes("待确认账户"), tax.pending.join("\n"));
});

test("没有登记别名的旧安装：盯盘照旧按 fills 里的账户分", () => {
	const open = mailOpen("NORTx4411");
	assert.deepEqual(openPositions(feedRows([open]), feedRows([{ account_ref: "NORTx4411" }])), openPositions(feedRows([open])));
});
