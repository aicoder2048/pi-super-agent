import assert from "node:assert/strict";
import test from "node:test";
import strategy from "../../docs/modules/examples/option-ta/tools/strategy/index.ts";

type Reply = Record<string, any>;
const run = (input: Record<string, unknown>) => strategy(input as never) as Reply;
const legs = (...items: object[]) => JSON.stringify(items);
const asof = "2026-11-17";

const csp = {
	action: "sell",
	type: "put",
	strike: 100,
	expiration: "2026-12-17",
	contracts: 2,
	price: 2,
	bid: 1.95,
	ask: 2.05,
	iv: 0.4,
	open_interest: 2000,
	volume: 500,
};

test("CSP：权利金、占用资金、盈亏平衡、年化、指派概率、参考价、流动性、到期盈亏", () => {
	const out = run({ kind: "CSP", legs: legs(csp), spot: 105, asof, scenario_prices: "[90, 98, 110]" });
	assert.equal(out.status, "OK");
	assert.equal(out.dte, 30);
	assert.equal(out.net_premium, 400);
	assert.equal(out.net_direction, "净收");
	assert.equal(out.capital, 20000);
	assert.equal(out.max_profit, 400);
	assert.equal(out.max_loss, 19600);
	assert.equal(out.breakeven, 98);
	assert.equal(out.annualized_return, 0.2433);
	assert.equal(out.reference_price, 2);
	assert.equal(out.reference_total, 400);
	const [leg] = out.legs;
	assert.equal(leg.assignment_probability, 0.3564);
	assert.equal(leg.touch_probability, 0.6705);
	assert.equal(leg.iv_source, "给定");
	assert.deepEqual(leg.liquidity, { score: 0.89, tier: "好", nbbo: "有报价" });
	assert.deepEqual(out.expiry_pl, [
		{ spot: 90, pl: -1600 },
		{ spot: 98, pl: 0 },
		{ spot: 110, pl: 400 },
	]);
	assert.equal(out.roll, null);
});

test("没给 IV：有正股价和权利金就反解，标「自算」；缺正股价标「无数据」", () => {
	const { iv: _iv, ...noIv } = csp;
	const solved = run({ kind: "CSP", legs: legs(noIv), spot: 105, asof }).legs[0];
	assert.equal(solved.iv_source, "自算");
	assert.equal(solved.iv, 0.3426);
	assert.equal(solved.assignment_probability, 0.3272);
	const blind = run({ kind: "CSP", legs: legs(noIv), asof }).legs[0];
	assert.equal(blind.iv_source, "无数据");
	assert.equal(blind.iv, null);
	assert.equal(blind.assignment_probability, null);
});

test("缺 bid/ask：照算权利金，参考价留空并说明，流动性只按 OI 和成交量", () => {
	const { bid: _b, ask: _a, ...noQuote } = csp;
	const out = run({ kind: "CSP", legs: legs(noQuote), spot: 105, asof });
	assert.equal(out.net_premium, 400);
	assert.equal(out.reference_price, null);
	assert.equal(out.reference_total, null);
	assert.match(out.reference_note, /bid/);
	assert.equal(out.legs[0].liquidity.nbbo, "缺报价");
});

test("到期日当天：不年化，按日算不出指派概率，留空", () => {
	const out = run({ kind: "CSP", legs: legs({ ...csp, expiration: asof }), spot: 99, asof });
	assert.equal(out.status, "OK");
	assert.equal(out.dte, 0);
	assert.equal(out.annualized_return, null);
	assert.equal(out.legs[0].assignment_probability, null);
	assert.equal(out.legs[0].touch_probability, null);
});

test("IV 为 0 当缺 IV：用权利金反解，不当 0 用", () => {
	const out = run({ kind: "CSP", legs: legs({ ...csp, iv: 0 }), spot: 105, asof });
	assert.equal(out.legs[0].iv_source, "自算");
	assert.equal(out.legs[0].assignment_probability, 0.3272);
});

test("CC：有持股成本时按成本算年化和被 call 走的收益", () => {
	const out = run({
		kind: "CC",
		legs: legs({ action: "sell", type: "call", strike: 110, expiration: "2026-12-17", contracts: 2, price: 2.5 }),
		spot: 105,
		asof,
		cost_basis: 100,
	});
	assert.equal(out.net_premium, 500);
	assert.equal(out.breakeven, 97.5);
	assert.equal(out.max_profit, 2500);
	assert.equal(out.max_loss, 19500);
	assert.equal(out.capital, 20000);
	assert.equal(out.annualized_return, 0.3042);
});

test("贷方价差：净收、限定的最大亏损、盈亏平衡", () => {
	const out = run({
		kind: "credit-vertical",
		legs: legs(
			{ action: "sell", type: "put", strike: 100, expiration: "2026-12-17", price: 2.1 },
			{ action: "buy", type: "put", strike: 95, expiration: "2026-12-17", price: 0.6 },
		),
		asof,
		scenario_prices: "[90, 97.5, 105]",
	});
	assert.equal(out.net_premium, 150);
	assert.equal(out.capital, 350);
	assert.equal(out.max_profit, 150);
	assert.equal(out.max_loss, 350);
	assert.equal(out.breakeven, 98.5);
	assert.equal(out.annualized_return, 5.2143);
	assert.deepEqual(out.expiry_pl.map((row: Reply) => row.pl), [-350, -100, 150]);
});

test("借方价差：净付、最大盈利是宽度减净付", () => {
	const out = run({
		kind: "debit-vertical",
		legs: legs(
			{ action: "buy", type: "call", strike: 100, expiration: "2026-12-17", price: 3 },
			{ action: "sell", type: "call", strike: 105, expiration: "2026-12-17", price: 1 },
		),
		asof,
	});
	assert.equal(out.net_premium, -200);
	assert.equal(out.net_direction, "净付");
	assert.equal(out.max_profit, 300);
	assert.equal(out.max_loss, 200);
	assert.equal(out.breakeven, 102);
	assert.equal(out.annualized_return, null);
});

test("买 call：最大盈利无上限，不年化", () => {
	const out = run({ kind: "long-call", legs: legs({ action: "buy", type: "call", strike: 100, expiration: "2026-12-17", price: 3 }), asof, scenario_prices: "[95, 110]" });
	assert.equal(out.net_premium, -300);
	assert.equal(out.max_profit, null);
	assert.equal(out.max_loss, 300);
	assert.equal(out.breakeven, 103);
	assert.equal(out.annualized_return, null);
	assert.deepEqual(out.expiry_pl, [
		{ spot: 95, pl: -300 },
		{ spot: 110, pl: 700 },
	]);
});

const closeLeg = { action: "buy", type: "put", strike: 140, expiration: "2026-12-18", contracts: 2, price: 3.2, role: "close" };
const openLeg = { action: "sell", type: "put", strike: 135, expiration: "2027-01-15", contracts: 2, price: 4.15, role: "open" };

test("Diagonal Roll：净收 = 新腿收的减旧腿买回的", () => {
	const out = run({ kind: "Diagonal", legs: legs(closeLeg, openLeg), asof });
	assert.equal(out.status, "OK");
	assert.equal(out.net_premium, 190);
	assert.equal(out.net_direction, "净收");
	assert.deepEqual(out.roll, { type: "Diagonal", close_cash: -640, open_cash: 830, net: 190, verdict: "ROLL_OK", verdict_note: out.roll.verdict_note, penny_threshold: 64 });
	assert.equal(out.breakeven, null);
	assert.equal(out.expiry_pl, null);
});

test("Roll 净付：不 Roll", () => {
	const out = run({ kind: "Diagonal", legs: legs(closeLeg, { ...openLeg, price: 2.85 }), asof });
	assert.equal(out.net_premium, -70);
	assert.equal(out.net_direction, "净付");
	assert.equal(out.roll.verdict, "DO_NOT_ROLL_TAKE_LOSS");
});

test("Roll 净收不到平仓成本一成：警告", () => {
	const out = run({ kind: "Diagonal", legs: legs(closeLeg, { ...openLeg, price: 3.25 }), asof });
	assert.equal(out.net_premium, 10);
	assert.equal(out.roll.verdict, "ROLL_FOR_PENNIES");
});

test("Calendar 和 Combo 按腿判定；说的种类和腿对不上就拒算", () => {
	const calendar = run({ kind: "Calendar", legs: legs(closeLeg, { ...openLeg, strike: 140, price: 4 }), asof });
	assert.equal(calendar.roll.type, "Calendar");
	assert.equal(calendar.net_premium, 160);
	const combo = run({ kind: "Combo", legs: legs(closeLeg, { ...openLeg, contracts: 3, price: 2.5 }), asof });
	assert.equal(combo.roll.type, "Combo");
	assert.equal(combo.net_premium, 110);
	const wrong = run({ kind: "Calendar", legs: legs(closeLeg, openLeg), asof });
	assert.equal(wrong.status, "INVALID_INPUT");
	assert.match(wrong.reason, /Diagonal/);
});

test("买方 Roll 不套净收门槛", () => {
	const out = run({
		kind: "Calendar",
		legs: legs(
			{ action: "sell", type: "call", strike: 100, expiration: "2026-12-18", price: 5, role: "close" },
			{ action: "buy", type: "call", strike: 100, expiration: "2027-01-15", price: 7, role: "open" },
		),
		asof,
	});
	assert.equal(out.net_premium, -200);
	assert.equal(out.roll.close_cash, 500, "卖出旧腿是收");
	assert.equal(out.roll.open_cash, -700, "买入新腿是付");
	assert.equal(out.roll.verdict, null);
});

test("Roll 两腿都有报价时给净参考价", () => {
	const out = run({
		kind: "Diagonal",
		legs: legs({ ...closeLeg, contracts: 1, bid: 1.0, ask: 1.1 }, { ...openLeg, contracts: 1, bid: 1.6, ask: 1.72 }),
		asof,
	});
	assert.equal(out.reference_price, 0.57);
	assert.equal(out.reference_total, 57);
});

test("调整过的合约：不按 100 股算，拒算", () => {
	const out = run({ kind: "CSP", legs: legs({ ...csp, shares_per_contract: 150 }), spot: 105, asof });
	assert.equal(out.status, "ADJUSTED_CONTRACT");
	assert.match(out.reason, /150/);
});

test("坏输入：拒算并说明", () => {
	const invalid = (input: Record<string, unknown>) => {
		const out = run(input);
		assert.equal(out.status, "INVALID_INPUT", JSON.stringify(out));
		assert.ok(out.reason.length > 0);
	};
	invalid({ kind: "CSP", legs: "not json", asof });
	invalid({ kind: "CSP", legs: "[]", asof });
	invalid({ kind: "iron-condor", legs: legs(csp), asof });
	invalid({ kind: "CSP", legs: legs({ ...csp, action: "buy" }), asof });
	invalid({ kind: "CSP", legs: legs({ ...csp, expiration: "2026-11-16" }), asof });
	invalid({ kind: "CSP", legs: legs({ ...csp, price: undefined, bid: undefined, ask: undefined }), asof });
	invalid({ kind: "CSP", legs: legs({ ...csp, strike: -1 }), asof });
	invalid({ kind: "CSP", legs: legs(csp), asof: "11/17/2026" });
	invalid({
		kind: "credit-vertical",
		legs: legs(
			{ action: "sell", type: "put", strike: 95, expiration: "2026-12-17", price: 2.1 },
			{ action: "buy", type: "put", strike: 100, expiration: "2026-12-17", price: 0.6 },
		),
		asof,
	});
	invalid({ kind: "Diagonal", legs: legs(closeLeg, { ...openLeg, role: undefined }), asof });
	invalid({ kind: "CSP", legs: legs(csp), asof, scenario_prices: "[-1]" });
	invalid({ kind: "CSP", legs: legs({ ...csp, shares_per_contract: "150" }), asof });
	invalid({ kind: "CSP", legs: legs({ ...csp, price: undefined, bid: 2, ask: 1.5 }), asof });
	invalid({ kind: "CSP", legs: legs({ ...csp, expiration: "2026-02-30" }), asof: "2026-01-02" });
	invalid({ kind: "long-put", legs: legs({ action: "buy", type: "put", strike: 100, expiration: "2026-12-17", price: 0 }), asof });
	invalid({ kind: "CC", legs: legs({ action: "sell", type: "call", strike: 110, expiration: "2026-12-17", price: 2 }), asof, cost_basis: 0 });
	const spreadRoll = run({
		kind: "Calendar",
		legs: legs(
			{ action: "buy", type: "put", strike: 100, expiration: "2026-12-18", price: 3, role: "close" },
			{ action: "sell", type: "put", strike: 95, expiration: "2026-12-18", price: 1, role: "close" },
			{ action: "sell", type: "put", strike: 100, expiration: "2027-01-15", price: 4, role: "open" },
			{ action: "buy", type: "put", strike: 95, expiration: "2027-01-15", price: 2, role: "open" },
		),
		asof,
	});
	assert.match(spreadRoll.reason, /价差的 Roll 还不支持/);
});
