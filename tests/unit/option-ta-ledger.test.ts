import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ledger, { ledgerView } from "../../docs/modules/examples/option-ta/tools/ledger/index.ts";
import record, { recordFill } from "../../docs/modules/examples/option-ta/tools/record/index.ts";
import { buildLedgerDb, FIXTURE, PACKAGE } from "../helpers/option-ta-ledger-db.ts";

type Case = { name: string; input: Record<string, unknown>; data?: string; expect: unknown };

/** The check's own rule (src/modules/validate.ts `same`): objects match on the expected keys, lists in full. */
function same(actual: unknown, expected: unknown): boolean {
	if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => same(actual[i], item));
	if (expected !== null && typeof expected === "object") return actual !== null && typeof actual === "object" && Object.entries(expected).every(([k, v]) => same((actual as Record<string, unknown>)[k], v ?? null));
	return actual === expected;
}

function withData<T>(folder: string | undefined, run: () => T): T {
	const before = process.env["PSA_MODULE_DATA"];
	process.env["PSA_MODULE_DATA"] = folder === undefined ? join(FIXTURE, "no-such-folder") : join(PACKAGE, folder);
	try {
		return run();
	} finally {
		if (before === undefined) delete process.env["PSA_MODULE_DATA"];
		else process.env["PSA_MODULE_DATA"] = before;
	}
}

const TOOLS = { record, ledger } as Record<string, (input: never) => unknown>;
for (const tool of Object.keys(TOOLS)) {
	const cases: Case[] = JSON.parse(readFileSync(join(PACKAGE, `tools/${tool}/cases.json`), "utf8"));
	for (const c of cases) {
		test(`${tool} cases.json：${c.name}`, () => {
			const out = withData(c.data, () => TOOLS[tool]!(c.input as never));
			assert.ok(same(out, c.expect), `expected ${JSON.stringify(c.expect)}\n     got ${JSON.stringify(out)}`);
		});
	}
}

test("提交的夹具 data.db 和 seed.json 一致（由 tests/helpers/option-ta-ledger-db.ts 生成）", () => {
	const built = buildLedgerDb();
	const rows = (path: string) => {
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			return ["fills", "chains", "accounts"].map((t) => db.prepare(`SELECT * FROM "${t}" ORDER BY "_id"`).all().map((r) => ({ ...r })));
		} finally {
			db.close();
		}
	};
	try {
		assert.deepEqual(rows(join(FIXTURE, "data/data.db")), rows(built.db));
	} finally {
		built.drop();
	}
});

const fill = (over: Record<string, unknown>) => {
	const symbol = String(over["option_symbol"]);
	const m = /^([A-Z.]+)(\d\d)(\d\d)(\d\d)([CP])(\d{8})$/.exec(symbol)!;
	const key = `${symbol}:${over["side"]}:${over["trade_date"]}:${over["account_ref"] ?? "A1"}`;
	return {
		record_type: "FILL", account_ref: "A1", underlying: m[1], right: m[5] === "C" ? "call" : "put", strike: Number(m[6]) / 1000, expiry: `20${m[2]}-${m[3]}-${m[4]}`, multiplier: 100,
		order_key: key, fill_id: `${key}:cum${over["qty"]}`, commission: null, fees: null, ...over,
	};
};
const event = (over: Record<string, unknown>) => {
	const base = fill({ ...over, side: "STO", trade_date: over["event_date"], price: "1" });
	return { ...base, record_type: "EVENT", event_id: `${over["option_symbol"]}:${over["type"]}:${over["event_date"]}`, fill_id: null, order_key: null, side: null, price: null, trade_date: null };
};
const rows = (...list: Record<string, unknown>[]) => ({ fills: list.map((r, i) => ({ _id: i + 1, ...r })), chains: [], accounts: [] });
const tax = (data: ReturnType<typeof rows>, year = 2026) => ledgerView({ view: "tax", year }, data, "2026-11-17") as { legs: { marks: string[]; term: string; gain: string }[]; stock: Record<string, unknown>[]; open: { marks: string[] }[]; pending: string[] };

test("卖出的 call 平掉了也标 QCC 待确认，从不判成合格或不合格", () => {
	const out = tax(rows(fill({ option_symbol: "AAPL260320C00250000", side: "STO", qty: 1, price: "3.0000", trade_date: "2026-03-02" }), fill({ option_symbol: "AAPL260320C00250000", side: "BTC", qty: 1, price: "1.0000", trade_date: "2026-03-10" })));
	assert.deepEqual(out.legs.map((l) => [l.gain, l.term, l.marks.includes("QCC 待确认")]), [["200.00", "短期", true]]);
	assert.ok(out.pending.includes("QCC 待确认"));
	assert.doesNotMatch(JSON.stringify(out), /合格备兑|QCC 成立|不是 QCC/);
});

test("§1256：tax_class 写明 nonequity 才按 60/40；指数代码没写类别标待核实", () => {
	const spx = (taxClass: string | null) => tax(rows(fill({ option_symbol: "SPX260320P05000000", side: "BTO", qty: 1, price: "10", trade_date: "2026-03-02", tax_class: taxClass }), fill({ option_symbol: "SPX260320P05000000", side: "STC", qty: 1, price: "12", trade_date: "2026-03-05", tax_class: taxClass })));
	assert.equal(spx("nonequity").legs[0]!.term, "60/40");
	assert.deepEqual([spx(null).legs[0]!.term, spx(null).legs[0]!.marks.includes("§1256 类别待核实")], ["待确认", true]);
});

test("期权间 wash sale：亏损平仓 30 天内又开同一合约，标同一合约；31 天外不标", () => {
	const loss = [fill({ option_symbol: "QQQ260417C00600000", side: "BTO", qty: 1, price: "5", trade_date: "2026-03-02" }), fill({ option_symbol: "QQQ260417C00600000", side: "STC", qty: 1, price: "3", trade_date: "2026-03-05" })];
	const again = (date: string) => fill({ option_symbol: "QQQ260417C00600000", side: "BTO", qty: 1, price: "3", trade_date: date });
	assert.ok(tax(rows(...loss, again("2026-04-04"))).legs[0]!.marks.includes("期权间 wash sale 标记（同一合约）"));
	assert.ok(!tax(rows(...loss, again("2026-04-05"))).legs[0]!.marks.some((m) => m.startsWith("期权间 wash sale")));
});

test("价差的亏损腿先平、另一腿到年底还开着：跨式标记加损失递延待确认", () => {
	const out = tax(rows(
		fill({ option_symbol: "SPY261218P00600000", side: "STO", qty: 1, price: "5", trade_date: "2026-03-02" }),
		fill({ option_symbol: "SPY261218P00590000", side: "BTO", qty: 1, price: "3", trade_date: "2026-03-02" }),
		fill({ option_symbol: "SPY261218P00600000", side: "BTC", qty: 1, price: "8", trade_date: "2026-03-20" }),
	));
	assert.deepEqual(out.legs[0]!.marks.filter((m) => /跨式/.test(m)), ["价差跨式标记", "跨式损失递延待确认（缺年末收盘快照）"]);
	assert.deepEqual(out.open.map((o) => o.marks), [["价差跨式标记"]]);
});

test("卖出的 call 被指派：所得照算，交出的股票批次待确认；买进股票时还有买入的 put 没平，持有期待确认", () => {
	const called = tax(rows(fill({ option_symbol: "AAPL260320C00250000", side: "STO", qty: 1, price: "3", trade_date: "2026-03-02" }), event({ option_symbol: "AAPL260320C00250000", type: "ASSIGNED", qty: 1, event_date: "2026-03-20" })));
	assert.deepEqual(called.stock.map((s) => [s["stock"], s["proceeds"], (s["marks"] as string[]).includes("交出的股票批次待确认（成本和长短期）")]), [["SELL", "25300.00", true]]);
	const put = tax(rows(
		fill({ option_symbol: "MSFT260320P00400000", side: "STO", qty: 1, price: "4", trade_date: "2026-03-02" }),
		fill({ option_symbol: "MSFT260320P00380000", side: "BTO", qty: 1, price: "1", trade_date: "2026-03-02" }),
		event({ option_symbol: "MSFT260320P00400000", type: "ASSIGNED", qty: 1, event_date: "2026-03-10" }),
	));
	assert.deepEqual(put.stock.map((s) => [s["basis"], (s["marks"] as string[]).includes("持有期待确认（同一股票上还有买入的 put）")]), [["39600.00", true]]);
});

test("record：增量价格按万分之一四舍五入；代码和 put/call 的大小写都认", () => {
	const recorded = [{ _id: 1, record_type: "FILL", order_key: "AAPL260320C00250000:STO:2026-03-05:A1", fill_id: "AAPL260320C00250000:STO:2026-03-05:A1:cum1", qty: 1, price: "1.0000" }];
	const out = recordFill({ account_ref: "A1", side: "STO", underlying: "aapl", right: "CALL", strike: "250", expiry: "2026-03-20", cum_qty: 3, avg_price: "1.0001", trade_date: "2026-03-05" }, { fills: recorded, accounts: [] }) as { qty: number; price: string };
	assert.deepEqual([out.qty, out.price], [2, "1.0002"]);
});

const TSLA_CALL = { side: "STO", underlying: "TSLA", right: "call", strike: "300", expiry: "2026-12-18", cum_qty: 2, avg_price: "2.10", trade_date: "2026-11-17" };
const emailed = [{ _id: 1, record_type: "FILL", account_ref: "QRSTalfa", fill_id: "x", order_key: "y" }, { _id: 2, record_type: "FILL", account_ref: "QRSTa1001", fill_id: "z", order_key: "w" }];

test("record：账户短码不在 accounts 也不在已记的 fills 里，不拼行，列出已知短码要使用者确认", () => {
	const out = recordFill({ ...TSLA_CALL, account_ref: "qrst-alfa" }, { fills: emailed, accounts: [{ _id: 1, account_ref: "IRA1" }] }) as Record<string, unknown>;
	assert.equal(out["status"], "needs-input");
	assert.deepEqual(out["missing"], ["account_ref"]);
	assert.deepEqual(out["known_accounts"], ["IRA1", "QRSTa1001", "QRSTalfa"]);
	assert.equal(out["row"], undefined);
});

test("record：短码在 accounts 或已记的 fills 里就照常记", () => {
	assert.equal((recordFill({ ...TSLA_CALL, account_ref: "QRSTalfa" }, { fills: emailed, accounts: [] }) as { status: string }).status, "ok");
	assert.equal((recordFill({ ...TSLA_CALL, account_ref: "IRA1" }, { fills: emailed, accounts: [{ _id: 1, account_ref: "IRA1" }] }) as { status: string }).status, "ok");
});

test("record：accounts 和 fills 都空（第一次用）照常记，回复里说这是第一个账户短码", () => {
	const out = recordFill({ ...TSLA_CALL, account_ref: "acct-blue" }, { fills: [], accounts: [] }) as { status: string; notes: string[] };
	assert.equal(out.status, "ok");
	assert.ok(out.notes.some((n) => n.includes("这是第一个账户短码")), JSON.stringify(out.notes));
});

const owned = (data: ReturnType<typeof rows>, owner = "owner-1") => ({ ...data, accounts: ["A1", "A2"].map((account_ref) => ({ account_ref, tax_owner_key: owner })) });

test("只看一个账户时，同一归属人别的账户里的开仓照样算进 wash sale 窗口", () => {
	const data = owned(rows(
		fill({ option_symbol: "QQQ260417C00600000", side: "BTO", qty: 1, price: "5", trade_date: "2026-03-02" }),
		fill({ option_symbol: "QQQ260417C00600000", side: "STC", qty: 1, price: "3", trade_date: "2026-03-05" }),
		fill({ option_symbol: "QQQ260417C00600000", side: "BTO", qty: 1, price: "3", trade_date: "2026-03-06", account_ref: "A2" }),
	));
	const out = ledgerView({ view: "tax", year: 2026, account_ref: "A1" }, data, "2026-11-17") as { legs: { marks: string[] }[]; open: unknown[] };
	assert.ok(out.legs[0]!.marks.includes("期权间 wash sale 标记（同一合约）"));
	assert.deepEqual(out.open, []);
});

test("被 REVERSAL 冲销的成交不算，notes 里说明", () => {
	const data = rows(fill({ option_symbol: "AAPL260320C00250000", side: "STO", qty: 1, price: "3", trade_date: "2026-03-02" }), { record_type: "REVERSAL", reversal_of: "AAPL260320C00250000:STO:2026-03-02:A1:cum1" });
	const out = ledgerView({ view: "chain" }, data) as { chains: unknown[]; notes: string[] };
	assert.deepEqual(out.chains, []);
	assert.ok(out.notes.includes("1 行已被冲销（REVERSAL），没有算"));
});

test("§1256 跨年平仓：不直接给 60/40，标上年年末计价待确认", () => {
	const leg = tax(rows(fill({ option_symbol: "SPX260320P05000000", side: "BTO", qty: 1, price: "10", trade_date: "2025-12-10", tax_class: "nonequity" }), fill({ option_symbol: "SPX260320P05000000", side: "STC", qty: 1, price: "7", trade_date: "2026-01-10", tax_class: "nonequity" }))).legs[0]!;
	assert.deepEqual([leg.term, leg.marks.includes("§1256 上年年末计价待确认（缺年末收盘快照）")], ["待确认", true]);
});

test("价差里持有超过一年的买入腿：长短期待确认，不判长期", () => {
	const leg = tax(rows(
		fill({ option_symbol: "MSFT270115C00400000", side: "BTO", qty: 1, price: "50", trade_date: "2025-01-02" }),
		fill({ option_symbol: "MSFT270115C00450000", side: "STO", qty: 1, price: "30", trade_date: "2025-01-02" }),
		fill({ option_symbol: "MSFT270115C00400000", side: "STC", qty: 1, price: "60", trade_date: "2026-02-03" }),
	)).legs[0]!;
	assert.deepEqual([leg.term, leg.marks.includes("长短期待确认（跨式里的持有期）")], ["待确认", true]);
});

test("指派：已知的开仓费用和指派费进股票成本；事件行没有佣金不算未知", () => {
	const out = tax(rows(
		fill({ option_symbol: "MSFT260320P00400000", side: "STO", qty: 1, price: "4", trade_date: "2026-03-02", commission: "0.65", fees: "0.05" }),
		{ ...event({ option_symbol: "MSFT260320P00400000", type: "ASSIGNED", qty: 1, event_date: "2026-03-20" }), fees: "15" },
	));
	assert.deepEqual(out.stock.map((s) => [s["basis"], (s["marks"] as string[]).includes("费用未知，未扣")]), [["39615.70", false]]);
});
