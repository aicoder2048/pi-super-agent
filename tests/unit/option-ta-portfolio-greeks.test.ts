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
	const low = portfolioGreeks([leg({ iv: 0.05 })], 100);
	assert.equal(low.iv_down_10, Math.round(-200 * (bsPutPrice(100, 95, 0.01, 30) - bsPutPrice(100, 95, 0.05, 30)) * 100) / 100);
});

test("同方向的两条腿是加杠杆：Delta 相加；买卖对冲的价差 Delta 变小", () => {
	const one = portfolioGreeks([leg({ action: "buy", type: "call", strike: 100 })], 100).delta_shares;
	const two = portfolioGreeks([leg({ action: "buy", type: "call", strike: 100 }), leg({ action: "buy", type: "call", strike: 105 })], 100).delta_shares;
	const spread = portfolioGreeks([leg({ action: "buy", type: "call", strike: 100 }), leg({ action: "sell", type: "call", strike: 105 })], 100).delta_shares;
	assert.ok(two > one && spread < one && spread > 0);
});

test("Gamma 区：3 天内到期、行权价离正股不到 3% 的腿列出来；没有 IV 或已到期的腿不进合计，数出来", () => {
	const out = portfolioGreeks([leg({ dte: 3, strike: 98 }), leg({ dte: 3, strike: 90 }), leg({ dte: 10, strike: 100 }), leg({ iv: null }), leg({ dte: 0, strike: 100 })], 100);
	assert.deepEqual(out.gamma_zone.map((l) => [l.strike, l.dte]), [[98, 3], [100, 0]]);
	assert.equal(out.legs_without_iv, 2);
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
	assert.match(rolled.greeks.scope, /新腿/);
});
