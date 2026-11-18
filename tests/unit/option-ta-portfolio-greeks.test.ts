import assert from "node:assert/strict";
import test from "node:test";
import { bsGreeks } from "../../docs/modules/examples/option-ta/chain-rows.ts";
import { bsPutPrice } from "../../docs/modules/examples/option-ta/options-math.ts";
import { portfolioGreeks, type GreekLeg } from "../../docs/modules/examples/option-ta/portfolio-greeks.ts";
import strategy from "../../docs/modules/examples/option-ta/tools/strategy/index.ts";

const leg = (over: Partial<GreekLeg>): GreekLeg => ({ action: "sell", type: "put", strike: 95, expiration: "2026-12-18", contracts: 2, dte: 30, iv: 0.3, shares: 100, ...over });

test("整单希腊值：卖出的腿记负，按张数 × 100 股加总；卖 put 收租、Delta 为正、Vega 为负", () => {
	const g = bsGreeks("put", 100, 95, 0.3, 30);
	const out = portfolioGreeks([leg({})], 100);
	assert.equal(out.delta_shares, Math.round(-200 * g.delta * 100) / 100);
	assert.ok(out.delta_shares > 0);
	assert.equal(out.gamma_shares_per_dollar, Math.round(-200 * g.gamma * 10000) / 10000);
	assert.equal(out.theta_per_day, Math.round(-200 * g.theta * 100) / 100);
	assert.equal(out.theta_side, "收租");
	assert.equal(out.vega_per_point, Math.round(-200 * g.vega * 100) / 100);
	assert.ok(out.vega_per_point < 0);
});

test("IV ±10 点压力测试：按 BS 重估整单；卖 put 在 IV 涨时亏、跌时赚；IV 不低于 1%", () => {
	const out = portfolioGreeks([leg({})], 100);
	const now = bsPutPrice(100, 95, 0.3, 30);
	assert.equal(out.iv_up_10, Math.round(-200 * (bsPutPrice(100, 95, 0.4, 30) - now) * 100) / 100);
	assert.ok(out.iv_up_10 < 0 && out.iv_down_10 > 0);
	const low = portfolioGreeks([leg({ iv: 0.05, strike: 100 })], 100);
	assert.equal(low.iv_down_10, Math.round(-200 * (bsPutPrice(100, 100, 0.01, 30) - bsPutPrice(100, 100, 0.05, 30)) * 100) / 100);
	const tiny = portfolioGreeks([leg({ iv: 0.005, strike: 100 })], 100);
	assert.equal(tiny.iv_down_10, 0, "IV 已低于 1% 时向下不会反而往上调");
});

test("同方向的两条腿是加杠杆：Delta 相加；买卖对冲的价差 Delta 变小", () => {
	const one = portfolioGreeks([leg({ action: "buy", type: "call", strike: 100 })], 100).delta_shares;
	const two = portfolioGreeks([leg({ action: "buy", type: "call", strike: 100 }), leg({ action: "buy", type: "call", strike: 105 })], 100).delta_shares;
	const spread = portfolioGreeks([leg({ action: "buy", type: "call", strike: 100 }), leg({ action: "sell", type: "call", strike: 105 })], 100).delta_shares;
	assert.ok(two > one && spread < one && spread > 0);
});

test("Gamma 区：3 天内到期、行权价离正股不到 3% 的腿列出来（正好 3% 不算）；当天到期的腿 Delta 按价内 ±1、价外 0", () => {
	const out = portfolioGreeks([leg({ dte: 3, strike: 98 }), leg({ dte: 3, strike: 97 }), leg({ dte: 10, strike: 100 }), leg({ dte: 0, strike: 101, contracts: 1 }), leg({ dte: 0, strike: 99, contracts: 1 })], 100);
	assert.deepEqual(out.gamma_zone.map((l) => [l.strike, l.dte]), [[98, 3], [101, 0], [99, 0]]);
	assert.equal(out.legs_expired, 2);
	const only = portfolioGreeks([leg({ dte: 0, strike: 101, contracts: 1 })], 100);
	assert.equal(only.status === "OK" && only.delta_shares, 100, "卖出价内 put 当天到期：-1 × -100 股");
	const call = portfolioGreeks([leg({ dte: 0, type: "call", action: "buy", strike: 99, contracts: 1 }), leg({ dte: 0, type: "call", action: "buy", strike: 101, contracts: 1 })], 100);
	assert.equal(call.status === "OK" && call.delta_shares, 100, "买入价内 call 记 +1、价外记 0");
});

test("有腿没有 IV：回 PARTIAL，整单的数都不回，不把价差算成裸卖", () => {
	const out = portfolioGreeks([leg({}), leg({ action: "buy", strike: 90, iv: null })], 100);
	assert.equal(out.status, "PARTIAL");
	assert.equal(out.legs_without_iv, 1);
	assert.equal("delta_shares" in out, false);
});

test("strategy：给了 spot 回 greeks；没给回 NO_SPOT；Roll 只算留下的新腿", () => {
	const legs = JSON.stringify([{ action: "sell", type: "put", strike: 95, expiration: "2026-12-18", contracts: 1, price: 2, iv: 0.3 }]);
	const ok = strategy({ kind: "CSP", legs, spot: 100, asof: "2026-11-18" } as never) as Record<string, any>;
	assert.equal(ok.greeks.status, "OK");
	assert.ok(ok.greeks.delta_shares > 0);
	assert.equal((strategy({ kind: "CSP", legs, asof: "2026-11-18" } as never) as Record<string, any>).greeks.status, "NO_SPOT");
	const roll = JSON.stringify([
		{ action: "buy", type: "put", strike: 95, expiration: "2026-11-20", contracts: 1, price: 0.5, iv: 0.3, role: "close" },
		{ action: "sell", type: "put", strike: 95, expiration: "2026-12-18", contracts: 1, price: 2, iv: 0.3, role: "open" },
	]);
	const rolled = strategy({ kind: "Calendar", legs: roll, spot: 100, asof: "2026-11-18" } as never) as Record<string, any>;
	assert.equal(rolled.greeks.delta_shares, ok.greeks.delta_shares);
	assert.match(rolled.greeks.scope, /新腿.*不含持有的正股/);
	assert.equal((strategy({ kind: "CSP", legs, spot: 0, asof: "2026-11-18" } as never) as Record<string, any>).greeks.status, "NO_SPOT");
});

test("strategy：CC 把持股算进 Delta，持 100 股卖 1 张虚值 call 是净多头", () => {
	const cc = JSON.stringify([{ action: "sell", type: "call", strike: 105, expiration: "2026-12-18", contracts: 1, price: 1.5, iv: 0.3 }]);
	const out = strategy({ kind: "CC", legs: cc, spot: 100, asof: "2026-11-18" } as never) as Record<string, any>;
	assert.equal(out.greeks.stock_shares, 100);
	assert.equal(out.greeks.delta_shares, Math.round((100 - 100 * bsGreeks("call", 100, 105, 0.3, 30).delta) * 100) / 100);
	assert.ok(out.greeks.delta_shares > 0);
	assert.match(out.greeks.note, /含持股 100 股/);
});

test("strategy：腿没给 iv 时用价格反解，和给定同一个 IV 算出来的一样", () => {
	const iv = 0.3;
	const priced = bsPutPrice(100, 95, iv, 30);
	const given = strategy({ kind: "CSP", legs: JSON.stringify([{ action: "sell", type: "put", strike: 95, expiration: "2026-12-18", contracts: 1, price: priced, iv }]), spot: 100, asof: "2026-11-18" } as never) as Record<string, any>;
	const solved = strategy({ kind: "CSP", legs: JSON.stringify([{ action: "sell", type: "put", strike: 95, expiration: "2026-12-18", contracts: 1, price: priced }]), spot: 100, asof: "2026-11-18" } as never) as Record<string, any>;
	assert.equal(solved.greeks.status, "OK");
	assert.ok(Math.abs(solved.greeks.delta_shares - given.greeks.delta_shares) < 0.05);
});
