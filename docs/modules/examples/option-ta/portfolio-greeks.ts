/**
 * The four checks before a trade (knowledge/vol-regime「每笔交易前的四项检查」) as numbers for tools/strategy: the whole order's
 * Delta, Gamma, Theta and Vega added up, the legs in the Gamma zone, and the order's mark-to-market change if IV moves ±10 points.
 * Pure Black-Scholes under options-math's assumptions (rate 0, no dividends): a model, not the broker's numbers.
 */
import { bsGreeks } from "./chain-rows.ts";
import { bsCallPrice, bsPutPrice } from "./options-math.ts";

/** IV shift of the stress test, in IV points as a decimal (0.10 is 10 points). */
export const IV_STRESS_POINTS = 0.1;
/** IV is not taken below this when stressed down. */
const IV_FLOOR = 0.01;
/** The notes' Gamma zone: an at-the-money leg this close to expiry needs active handling. */
export const GAMMA_ZONE_DAYS = 3;
/** "At the money" for the Gamma zone: strike within this fraction of the underlying price (pin-risk-check.ts uses 3% too). */
export const GAMMA_ZONE_MONEYNESS = 0.03;

export type GreekLeg = { action: "sell" | "buy"; type: "put" | "call"; strike: number; expiration: string; contracts: number; dte: number; iv: number | null; shares: number };

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const price = (type: "put" | "call", spot: number, strike: number, iv: number, dte: number) => (type === "put" ? bsPutPrice : bsCallPrice)(spot, strike, iv, dte);

export function portfolioGreeks(legs: readonly GreekLeg[], spot: number) {
	const usable = legs.filter((l) => l.iv !== null && l.iv > 0 && l.dte > 0);
	const totals = { delta: 0, gamma: 0, theta: 0, vega: 0, up: 0, down: 0 };
	for (const l of usable) {
		const qty = (l.action === "sell" ? -1 : 1) * l.contracts * l.shares;
		const g = bsGreeks(l.type, spot, l.strike, l.iv!, l.dte);
		const now = price(l.type, spot, l.strike, l.iv!, l.dte);
		totals.delta += qty * g.delta;
		totals.gamma += qty * g.gamma;
		totals.theta += qty * g.theta;
		totals.vega += qty * g.vega;
		totals.up += qty * (price(l.type, spot, l.strike, l.iv! + IV_STRESS_POINTS, l.dte) - now);
		totals.down += qty * (price(l.type, spot, l.strike, Math.max(IV_FLOOR, l.iv! - IV_STRESS_POINTS), l.dte) - now);
	}
	const zone = legs.filter((l) => l.dte <= GAMMA_ZONE_DAYS && Math.abs(l.strike - spot) / spot <= GAMMA_ZONE_MONEYNESS);
	return {
		spot,
		delta_shares: r2(totals.delta),
		gamma_shares_per_dollar: r4(totals.gamma),
		theta_per_day: r2(totals.theta),
		theta_side: totals.theta > 0.005 ? "收租" : totals.theta < -0.005 ? "付租" : "持平",
		vega_per_point: r2(totals.vega),
		iv_up_10: r2(totals.up),
		iv_down_10: r2(totals.down),
		gamma_zone: zone.map((l) => ({ action: l.action, type: l.type, strike: l.strike, expiration: l.expiration, dte: l.dte })),
		legs_without_iv: legs.length - usable.length,
		note: `Black-Scholes 估算（利率 0、无股息），不是券商的数。delta_shares 是整单相当于多少股正股（负数是空头）；gamma 是正股涨 1 美元 delta 变多少股；theta 是每天整单美元；vega 是 IV 变 1 个点整单美元；iv_up_10、iv_down_10 是 IV 各加减 ${IV_STRESS_POINTS * 100} 个点、其余不变时整单的重估盈亏。gamma_zone 列出 ${GAMMA_ZONE_DAYS} 天内到期、行权价离正股不到 ${GAMMA_ZONE_MONEYNESS * 100}% 的腿`,
	};
}
