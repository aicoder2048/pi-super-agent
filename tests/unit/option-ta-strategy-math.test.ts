import assert from "node:assert/strict";
import test from "node:test";
import { computeCcYield } from "../../docs/modules/examples/option-ta/cc-yield.ts";
import { computeIvCrush } from "../../docs/modules/examples/option-ta/iv-crush.ts";
import { recommendLimitPrice, recommendNetLimitPrice } from "../../docs/modules/examples/option-ta/limit-price.ts";
import { scoreLiquidity } from "../../docs/modules/examples/option-ta/liquidity.ts";
import { bsCallPrice, bsPutPrice } from "../../docs/modules/examples/option-ta/options-math.ts";
import { ROLL_PENNY_FRACTION, rollCreditGate } from "../../docs/modules/examples/option-ta/roll-credit-gate.ts";
import {
	expiryPLBearCallSpread,
	expiryPLBearPutSpread,
	expiryPLBullCallSpread,
	expiryPLBullPutSpread,
	expiryPLLongCall,
	expiryPLLongPut,
	expiryPLShortCall,
	expiryPLShortPut,
} from "../../docs/modules/examples/option-ta/scenario-pl.ts";
import {
	creditSpreadEconomics,
	cspEconomics,
	debitSpreadEconomics,
	longOptionEconomics,
	nakedStockEconomics,
} from "../../docs/modules/examples/option-ta/strategy-economics.ts";

const near = (actual: number | null | undefined, expected: number, eps = 1e-9) =>
	assert.ok(actual != null && Math.abs(actual - expected) <= eps, `expected ${expected} ± ${eps}, got ${actual}`);

test("到期盈亏：卖 put", () => {
	near(expiryPLShortPut(100, 2, 105), 2);
	near(expiryPLShortPut(100, 2, 95), -3);
	near(expiryPLShortPut(100, 2, 0), -98);
});

test("到期盈亏：卖 call，裸卖和有持股两种", () => {
	near(expiryPLShortCall(100, 2, 95), 2);
	near(expiryPLShortCall(100, 2, 110), -8);
	near(expiryPLShortCall(100, 2, 110, 90), 12);
	near(expiryPLShortCall(100, 2, 110, 100), 2);
	near(expiryPLShortCall(100, 2, 95, 90), 7);
});

test("到期盈亏：贷方价差", () => {
	near(expiryPLBullPutSpread(100, 95, 1.5, 105), 1.5);
	near(expiryPLBullPutSpread(100, 95, 1.5, 90), -3.5);
	near(expiryPLBullPutSpread(100, 95, 1.5, 97.5), -1);
	near(expiryPLBearCallSpread(100, 105, 1.5, 95), 1.5);
	near(expiryPLBearCallSpread(100, 105, 1.5, 110), -3.5);
	near(expiryPLBearCallSpread(100, 105, 1.5, 102.5), -1);
});

test("到期盈亏：买 put、买 call", () => {
	near(expiryPLLongPut(100, 3, 105), -3);
	near(expiryPLLongPut(100, 3, 90), 7);
	near(expiryPLLongPut(100, 3, 0), 97);
	near(expiryPLLongCall(100, 3, 95), -3);
	near(expiryPLLongCall(100, 3, 110), 7);
	near(expiryPLLongCall(100, 3, 103), 0);
});

test("到期盈亏：借方价差", () => {
	near(expiryPLBullCallSpread(100, 105, 2, 95), -2);
	near(expiryPLBullCallSpread(100, 105, 2, 110), 3);
	near(expiryPLBullCallSpread(100, 105, 2, 102), 0);
	near(expiryPLBearPutSpread(105, 100, 2, 110), -2);
	near(expiryPLBearPutSpread(105, 100, 2, 90), 3);
	near(expiryPLBearPutSpread(105, 100, 2, 103), 0);
});

test("方案经济：CSP", () => {
	const csp = cspEconomics(100, 2, 30);
	near(csp.capital, 10000);
	near(csp.max_profit, 200);
	near(csp.max_loss, 9800);
	near(csp.annualized_roc, (200 / 10000) * (365 / 30));
	near(csp.breakeven, 98);
	assert.equal(csp.bad_quote, false);
	assert.equal(cspEconomics(100, 2, 0).annualized_roc, null, "到期 0 天不年化");
});

test("方案经济：贷方价差", () => {
	const bullPut = creditSpreadEconomics(5, 1.5, 30, 100, "put");
	near(bullPut.capital, 350);
	near(bullPut.max_profit, 150);
	near(bullPut.max_loss, 350);
	near(bullPut.annualized_roc, (150 / 350) * (365 / 30));
	near(bullPut.breakeven, 98.5);
	near(creditSpreadEconomics(5, 1.5, 30, 100, "call").breakeven, 101.5);
	const crossed = creditSpreadEconomics(5, 5.2, 30, 100, "put");
	assert.equal(crossed.bad_quote, true);
	assert.equal(crossed.annualized_roc, null);
	const atWidth = creditSpreadEconomics(5, 5, 30, 100, "call");
	assert.equal(atWidth.bad_quote && atWidth.annualized_roc === null, true);
	assert.equal(creditSpreadEconomics(5, 1.5, 0, 100, "put").annualized_roc, null);
});

test("方案经济：正股对照", () => {
	const stock = nakedStockEconomics(50, 0.03, 30);
	near(stock.capital, 5000);
	near(stock.max_profit, 150);
	near(stock.max_loss, 5000);
	near(stock.breakeven, 50);
	assert.equal(nakedStockEconomics(0, 0.03, 30).annualized_roc, null);
});

test("方案经济：买 put、买 call（买方不年化）", () => {
	const longPut = longOptionEconomics(100, 3, 30, "put");
	near(longPut.capital, 300);
	near(longPut.max_loss, 300);
	near(longPut.max_profit, 9700);
	near(longPut.breakeven, 97);
	assert.equal(longPut.annualized_roc, null);
	const longCall = longOptionEconomics(100, 3, 30, "call");
	assert.equal(longCall.max_profit, null, "买 call 上不封顶");
	near(longCall.breakeven, 103);
	assert.equal(longOptionEconomics(100, 0, 30, "call").bad_quote, true, "权利金不为正是坏报价");
});

test("方案经济：借方价差（买方不年化）", () => {
	const bullCall = debitSpreadEconomics(5, 2, 30, 100, "call");
	near(bullCall.capital, 200);
	near(bullCall.max_loss, 200);
	near(bullCall.max_profit, 300);
	near(bullCall.breakeven, 102);
	assert.equal(bullCall.annualized_roc, null);
	near(debitSpreadEconomics(5, 2, 30, 105, "put").breakeven, 103);
	const overWidth = debitSpreadEconomics(5, 5, 30, 100, "call");
	assert.equal(overWidth.bad_quote, true, "净付不低于宽度是坏报价");
	assert.equal(overWidth.annualized_roc, null);
});

test("CC 收益：有成本、没成本、被 call 走锁定亏损", () => {
	const f1 = computeCcYield({ strike: 110, premium: 2.5, dte: 30, cost_basis: 100, current_price: 105, contracts: 2 })!;
	assert.equal(f1.shares, 200);
	near(f1.premium_total, 500);
	near(f1.max_profit_if_called!, 2500);
	near(f1.max_profit_return_on_cost!, 0.125);
	near(f1.downside_breakeven, 97.5);
	near(f1.annualized_yield_on_strike, (2.5 / 110) * (365 / 30));
	near(f1.annualized_yield_on_cost!, 0.025 * (365 / 30));
	const f2 = computeCcYield({ strike: 50, premium: 1, dte: 365, contracts: 1 })!;
	near(f2.annualized_yield_on_strike, 0.02);
	assert.equal(f2.yield_on_cost_period, null);
	assert.equal(f2.max_profit_if_called, null);
	near(f2.downside_breakeven, 49);
	const f3 = computeCcYield({ strike: 95, premium: 2, dte: 30, cost_basis: 100, contracts: 1 })!;
	near(f3.max_profit_if_called!, -300);
	near(f3.max_profit_return_on_cost!, -0.03);
	near(computeCcYield({ strike: 60, premium: 1.5, dte: 45, current_price: 55 })!.downside_breakeven, 53.5);
	assert.equal(computeCcYield({ strike: 0, premium: 1, dte: 30 }), null);
	assert.equal(computeCcYield({ strike: 100, premium: -1, dte: 30 }), null);
	assert.equal(computeCcYield({ strike: 100, premium: 1, dte: 0 }), null);
});

test("财报 IV 压缩：PRE 用全部天数，POST 用财报后天数", () => {
	const put = computeIvCrush({ side: "put", spot: 100, strike: 100, current_iv: 0.6, historical_crush_pct: 0.4, days_to_earnings: 5, post_event_dte: 10, contracts: 2 })!;
	near(put.post_event_iv, 0.36);
	assert.equal(put.total_dte, 15);
	near(put.crush_per_share, bsPutPrice(100, 100, 0.6, 15) - bsPutPrice(100, 100, 0.36, 10));
	assert.ok(put.crush_per_share > 0);
	near(put.crush_total, put.crush_per_share * 100 * 2);
	near(put.capital, 10000);
	const call = computeIvCrush({ side: "call", spot: 120, strike: 125, current_iv: 0.5, historical_crush_pct: 0.3, days_to_earnings: 3, post_event_dte: 7 })!;
	near(call.capital, 12000);
	near(call.crush_per_share, bsCallPrice(120, 125, 0.5, 10) - bsCallPrice(120, 125, 0.35, 7));
	near(computeIvCrush({ side: "put", spot: 50, strike: 50, current_iv: 0.8, days_to_earnings: 2, post_event_dte: 5 })!.post_event_iv, 0.52);
	assert.equal(computeIvCrush({ side: "put", spot: 100, strike: 100, current_iv: 0, days_to_earnings: 5, post_event_dte: 10 }), null);
	assert.equal(computeIvCrush({ side: "put", spot: 100, strike: 100, current_iv: 0.5, days_to_earnings: 0, post_event_dte: 0 }), null);
	assert.equal(computeIvCrush({ side: "put", spot: 100, strike: 100, current_iv: 0.5, historical_crush_pct: 1, days_to_earnings: 5, post_event_dte: 5 }), null);
	assert.equal(computeIvCrush({ side: "put", spot: 100, strike: 100, current_iv: 0.5, historical_crush_pct: -0.1, days_to_earnings: 5, post_event_dte: 5 }), null);
});

test("Roll 净收门槛：净付或打平不 Roll，净收不到平仓成本一成要警告", () => {
	assert.equal(ROLL_PENNY_FRACTION, 0.1);
	assert.equal(rollCreditGate(-500, 3000).verdict, "DO_NOT_ROLL_TAKE_LOSS");
	assert.equal(rollCreditGate(0, 3000).verdict, "DO_NOT_ROLL_TAKE_LOSS");
	assert.equal(rollCreditGate(200, 3000).verdict, "ROLL_FOR_PENNIES");
	assert.equal(rollCreditGate(300, 3000).verdict, "ROLL_OK", "正好一成不算");
	assert.equal(rollCreditGate(1500, 3000).verdict, "ROLL_OK");
	assert.equal(rollCreditGate(50, 0).verdict, "ROLL_OK", "平仓成本为 0 时不比一成");
	assert.equal(rollCreditGate(-500, 3000).net_credit, -500);
});

test("单腿参考价：按价差宽度让步、按 tick 取整、夹在 bid 和 ask 之间", () => {
	const tight = recommendLimitPrice({ bid: 3.4, ask: 3.5, side: "sell" })!;
	near(tight.limit, 3.45);
	assert.equal(tight.band, "tight");
	const normal = recommendLimitPrice({ bid: 2.8, ask: 3.1, side: "sell" })!;
	near(normal.limit, 2.91);
	near(normal.mid, 2.95);
	near(recommendLimitPrice({ bid: 4.0, ask: 5.0, side: "sell" })!.limit, 4.3);
	near(recommendLimitPrice({ bid: 4.0, ask: 5.0, side: "buy" })!.limit, 4.7);
	near(recommendLimitPrice({ bid: 0.95, ask: 1.05, side: "sell" })!.limit, 0.99);
	const coarse = recommendLimitPrice({ bid: 4.9, ask: 5.1, side: "sell", tick: 0.5 })!;
	assert.ok(coarse.limit >= 4.9 && coarse.limit <= 5.1);
	near(recommendLimitPrice({ bid: 5.0, ask: 5.0, side: "sell" })!.limit, 5);
	assert.equal(recommendLimitPrice({ bid: 5.1, ask: 5.0, side: "sell" }), null);
	assert.equal(recommendLimitPrice({ bid: 0, ask: 5.0, side: "sell" }), null);
	assert.equal(recommendLimitPrice({ bid: Number.NaN, ask: 5.0, side: "sell" }), null);
	near(recommendLimitPrice({ bid: 0.25, ask: 0.35, side: "sell" })!.frictionPctOfMid, 0.1667, 1e-4);
});

test("多腿净参考价：Roll 净收、净付镜像、按比例、坏报价回 null", () => {
	const roll = recommendNetLimitPrice({ legs: [{ bid: 1.0, ask: 1.1, side: "buy" }, { bid: 1.6, ask: 1.72, side: "sell" }] })!;
	near(roll.netMid, 0.61);
	near(roll.netHalfSpread, 0.11);
	near(roll.spreadPct, 0.3607);
	assert.equal(roll.band, "wide");
	near(roll.netLimit, 0.57);
	near(roll.netWorst, 0.5);
	near(roll.netBest, 0.72);
	assert.equal(roll.direction, "credit");
	const debit = recommendNetLimitPrice({ legs: [{ bid: 1.0, ask: 1.1, side: "sell" }, { bid: 1.6, ask: 1.72, side: "buy" }] })!;
	near(debit.netMid, -0.61);
	near(debit.netLimit, -0.65);
	assert.equal(debit.direction, "debit");
	const ratio = recommendNetLimitPrice({ legs: [{ bid: 1.0, ask: 1.1, side: "buy" }, { bid: 0.6, ask: 0.66, side: "sell", ratio: 2 }] })!;
	near(ratio.netMid, 0.21);
	const good = { bid: 1.6, ask: 1.72, side: "sell" as const };
	assert.equal(recommendNetLimitPrice({ legs: [{ bid: 1.2, ask: 1.1, side: "buy" }, good] }), null);
	assert.equal(recommendNetLimitPrice({ legs: [{ bid: 0, ask: 1.1, side: "buy" }, good] }), null);
	assert.equal(recommendNetLimitPrice({ legs: [{ bid: 1.0, ask: 1.1, side: "buy", ratio: 0 }, good] }), null);
	assert.equal(recommendNetLimitPrice({ legs: [] }), null);
	assert.equal(recommendNetLimitPrice({ legs: [{ bid: 1.6, ask: 1.72, side: "buy" }, { bid: 1.61, ask: 1.72, side: "sell" }] }), null, "净价不到一个 tick");
});

test("流动性评分：分档、缺报价时只用 OI 和成交量重算", () => {
	const liquid = scoreLiquidity({ bid: 1.0, ask: 1.02, mid: 1.01, open_interest: 4000, volume: 600 });
	assert.equal(liquid.nbbo_status, "live");
	near(liquid.composite, 1);
	assert.equal(liquid.tier, "liquid");
	const renorm = scoreLiquidity({ bid: null, ask: null, mid: 2.0, open_interest: 4000, volume: 600 });
	assert.equal(renorm.nbbo_status, "unknown");
	near(renorm.composite, 1);
	const thin = scoreLiquidity({ bid: 0.95, ask: 1.05, mid: 1.0, open_interest: 2000, volume: 500 });
	near(thin.spread_score, 0.5);
	near(thin.composite, 0.725);
	assert.equal(thin.tier, "thin");
	const poor = scoreLiquidity({ bid: 0.95, ask: 1.05, mid: 1.0, open_interest: 100, volume: 20 });
	near(poor.composite, 0.485);
	assert.equal(poor.tier, "poor");
	const dead = scoreLiquidity({ bid: null, ask: null, mid: 0.5, open_interest: 0, volume: 0 });
	assert.equal(dead.tier, "illiquid");
});
