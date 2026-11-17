import assert from "node:assert/strict";
import test from "node:test";
import { openPositions } from "../../docs/modules/examples/option-ta/feeds/watch/positions.ts";

let next = 0;
const CONTRACT = { option_symbol: "SPY261218P00700000", underlying: "SPY", right: "put", strike: 700, expiry: "2026-12-18", multiplier: 100, account_ref: "A1" };
const row = (fields: Record<string, unknown>) => ({ id: String(++next), from: "fixture", fields: { ...CONTRACT, ...fields } });
const fill = (side: string, qty: number, price: string, trade_date: string, extra: Record<string, unknown> = {}) =>
	row({ record_type: "FILL", fill_id: `f${next + 1}`, order_key: `k${next + 1}`, side, qty, price, trade_date, ...extra });
const event = (type: string, qty: number, event_date = "2026-12-18") => row({ record_type: "EVENT", event_id: `e${next + 1}`, type, qty, event_date });
const view = (rows: ReturnType<typeof row>[]) => openPositions(rows).positions.map((p) => ({ account: p.account, occ: p.occ, side: p.side, qty: p.qty, openPrice: p.openPrice, openedOn: p.openedOn }));

test("fills 为空就没有仓位", () => {
	assert.deepEqual(openPositions([]).positions, []);
});

test("卖出开仓的 put：张数合计，开仓均价按张数加权，开仓日取最早一笔", () => {
	assert.deepEqual(view([fill("STO", 1, "2.0000", "2026-11-10"), fill("STO", 3, "3.0000", "2026-11-12")]), [{ account: "A1", occ: "SPY261218P00700000", side: "short", qty: 4, openPrice: 2.75, openedOn: "2026-11-10" }]);
});

test("买回平掉一部分，剩下的按先进先出仍是仓位（开仓日仍是这一轮第一笔）；全部买回就没有了", () => {
	assert.deepEqual(view([fill("STO", 2, "2.0000", "2026-11-10"), fill("STO", 1, "4.0000", "2026-11-11"), fill("BTC", 2, "0.5000", "2026-11-12")]), [{ account: "A1", occ: "SPY261218P00700000", side: "short", qty: 1, openPrice: 4, openedOn: "2026-11-10" }]);
	assert.deepEqual(view([fill("STO", 2, "2.0000", "2026-11-10"), fill("BTC", 2, "0.5000", "2026-11-12")]), []);
});

test("到期、指派事件平掉对应张数", () => {
	assert.deepEqual(view([fill("STO", 2, "2.0000", "2026-11-10"), event("EXPIRE", 2)]), []);
	assert.equal(view([fill("STO", 2, "2.0000", "2026-11-10"), event("ASSIGNED", 1)])[0]!.qty, 1);
});

test("被冲销的成交不算", () => {
	const wrong = fill("STO", 5, "2.0000", "2026-11-10");
	assert.equal(view([wrong, row({ record_type: "REVERSAL", reversal_of: wrong.fields.fill_id }), fill("STO", 1, "2.0000", "2026-11-11")])[0]!.qty, 1);
});

test("同一合约不同账户是两个仓位；股票行不算期权仓位", () => {
	const rows = [fill("STO", 1, "2.0000", "2026-11-10"), fill("STO", 1, "2.0000", "2026-11-10", { account_ref: "B2" }), fill("BUY", 100, "700.0000", "2026-11-10", { option_symbol: "", caused_by_event: "e1" })];
	assert.deepEqual(view(rows).map((p) => p.account).sort(), ["A1", "B2"]);
});

test("买入开仓记 long，带合约事实", () => {
	const [p] = openPositions([fill("BTO", 2, "1.1000", "2026-11-02", { option_symbol: "NVDA261120C00185500", underlying: "NVDA", right: "call", strike: 185.5, expiry: "2026-11-20" })]).positions;
	assert.deepEqual({ underlying: p!.underlying, right: p!.right, strike: p!.strike, expiry: p!.expiry, side: p!.side, qty: p!.qty }, { underlying: "NVDA", right: "call", strike: 185.5, expiry: "2026-11-20", side: "long", qty: 2 });
});

test("平掉以后同一合约再开仓，开仓日和均价从新的那笔算，仓位键也换了", () => {
	const first = openPositions([fill("STO", 1, "2.0000", "2026-11-02")]).positions[0]!.key;
	const rows = [fill("STO", 1, "2.0000", "2026-11-02"), fill("BTC", 1, "0.5000", "2026-11-05"), fill("STO", 1, "1.0000", "2026-11-09")];
	const [p] = openPositions(rows).positions;
	assert.deepEqual({ openedOn: p!.openedOn, openPrice: p!.openPrice }, { openedOn: "2026-11-09", openPrice: 1 });
	assert.notEqual(p!.key, first);
});

test("部分买回平掉最早那笔，仓位键不变（每仓位只发一次的提醒不会重发）", () => {
	const opened = [fill("STO", 1, "2.0000", "2026-11-10"), fill("STO", 1, "3.0000", "2026-11-11")];
	const before = openPositions(opened).positions[0]!.key;
	const after = openPositions([...opened, fill("BTC", 1, "0.5000", "2026-11-12")]).positions[0]!;
	assert.equal(after.qty, 1);
	assert.equal(after.key, before);
});
