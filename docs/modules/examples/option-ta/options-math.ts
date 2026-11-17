// 出处：theta app/src/lib/options-math.ts @ 94c32859efcd8f8ff1df51e273f306e0a1bd4ef0（加了命名常量 BS_ASSUMPTIONS）
/**
 * Shared options math helpers — used by compute_csp_yield and compute_cc_yield.
 * All Black-Scholes formulas assume r = 0 and no dividends (good enough for
 * short-dated wheel positions where carry is negligible).
 */

/** The rate and dividend assumptions every formula below is written for (spec「IV 历史」). */
export const BS_ASSUMPTIONS = { riskFreeRate: 0, dividendYield: 0 } as const;

/**
 * Abramowitz-Stegun standard normal CDF approximation.
 * Max absolute error ~7.5e-8 — plenty for trading-decision precision.
 */
export function normalCdf(x: number): number {
	const a1 = 0.254829592;
	const a2 = -0.284496736;
	const a3 = 1.421413741;
	const a4 = -1.453152027;
	const a5 = 1.061405429;
	const p = 0.3275911;
	const sign = x < 0 ? -1 : 1;
	const ax = Math.abs(x) / Math.SQRT2;
	const t = 1.0 / (1.0 + p * ax);
	const y =
		1.0 -
		((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
	return 0.5 * (1.0 + sign * y);
}

/** Period return scaled to a year: periodReturn × (365 ÷ days). Unguarded on
 *  purpose: each caller owns its capital base and its zero-capital / non-positive
 *  days policy (NaN, null, 0, or upstream validation). */
export function annualize(periodReturn: number, days: number): number {
	return periodReturn * (365 / days);
}

/** 选腿/比较工具的统一退化口径:capital ≤ 0 或 days ≤ 0(含 NaN)→ null,
 *  不返回看起来真实的 Infinity / 负 ROC。调用方把 null 显示成「—」,
 *  并在按 ROC 排序时排除该行。正常输入 = annualize(profit / capital, days),逐位不变。 */
export function annualizeOrNull(profit: number, capital: number, days: number): number | null {
	if (!(capital > 0) || !(days > 0)) return null;
	return annualize(profit / capital, days);
}

/** Black-Scholes d1 with r=0. */
function d1(spot: number, strike: number, iv: number, dte: number): number {
	const T = dte / 365;
	const sigmaSqrtT = iv * Math.sqrt(T);
	return (Math.log(spot / strike) + 0.5 * iv * iv * T) / sigmaSqrtT;
}

/** Black-Scholes d2 with r=0. */
function d2(spot: number, strike: number, iv: number, dte: number): number {
	const T = dte / 365;
	const sigmaSqrtT = iv * Math.sqrt(T);
	return (Math.log(spot / strike) - 0.5 * iv * iv * T) / sigmaSqrtT;
}

/**
 * Black-Scholes call price (r=0, no dividends). Returns price per share.
 * Used by compute_scenario_pl to mark-to-market mid-DTE under spot scenarios.
 */
export function bsCallPrice(spot: number, strike: number, iv: number, dte: number): number {
	if (dte <= 0) return Math.max(0, spot - strike);
	if (iv <= 0) return Math.max(0, spot - strike);
	const D1 = d1(spot, strike, iv, dte);
	const D2 = d2(spot, strike, iv, dte);
	return spot * normalCdf(D1) - strike * normalCdf(D2);
}

/**
 * Black-Scholes put price (r=0, no dividends). Returns price per share.
 * Used by compute_scenario_pl to mark-to-market mid-DTE under spot scenarios.
 */
export function bsPutPrice(spot: number, strike: number, iv: number, dte: number): number {
	if (dte <= 0) return Math.max(0, strike - spot);
	if (iv <= 0) return Math.max(0, strike - spot);
	const D1 = d1(spot, strike, iv, dte);
	const D2 = d2(spot, strike, iv, dte);
	return strike * normalCdf(-D2) - spot * normalCdf(-D1);
}

/** P(S_T < K) — short-put assignment probability under BS. */
export function bsShortPutAssignProb(
	spot: number,
	strike: number,
	iv: number,
	dte: number,
): number {
	if (iv <= 0 || dte <= 0) return spot < strike ? 1 : 0;
	return normalCdf(-d2(spot, strike, iv, dte));
}

/** P(S_T > K) — short-call assignment probability under BS. */
export function bsShortCallAssignProb(
	spot: number,
	strike: number,
	iv: number,
	dte: number,
): number {
	if (iv <= 0 || dte <= 0) return spot > strike ? 1 : 0;
	return normalCdf(d2(spot, strike, iv, dte));
}

/**
 * Invert Black-Scholes on SPOT: find the underlying price S* at which a leg
 * reprices to `targetPremium`, holding IV (`ivToday`) and tenor (`tenorDte`)
 * FIXED. This is the "price channel" twin of the IV/HV vol channel — it answers
 * "how far must the stock MOVE, at today's IV, to pay this premium", NOT "what
 * IV pays it". Monotone in spot (call price increasing, put price decreasing),
 * so bisection converges unconditionally inside the bracket.
 *
 * Mirrors impliedVolPut's discipline — returns null (NEVER NaN, never a clamped
 * edge) whenever the target is unreachable:
 *   - non-finite / non-positive inputs, or an expired/zero-vol tenor;
 *   - PUT target ≥ the MODEL max put value (`bsPutPrice` as spot→0, which is the
 *     strike at r=0) → the premium would require spot < 0 → unreachable. We use
 *     the model-computed cap, not the literal strike, so a future non-zero carry
 *     stays correct.
 * A CALL target > 0 is always reachable — the call price sweeps (0, ∞) in spot.
 *
 * @param side  "cc" (short call → call price) or "csp" (short put → put price).
 */
export function spotForPremium(
	side: "cc" | "csp",
	targetPremium: number,
	strike: number,
	ivToday: number,
	tenorDte: number,
): number | null {
	if (
		!Number.isFinite(targetPremium) ||
		!Number.isFinite(strike) ||
		!Number.isFinite(ivToday)
	) {
		return null;
	}
	if (targetPremium <= 0 || strike <= 0 || ivToday <= 0 || tenorDte <= 0) return null;

	const MAX_ITER = 100;
	const GROW_CAP = 80;

	if (side === "csp") {
		// Put price DECREASES in spot; its max value is at spot→0 (the model cap,
		// = strike at r=0). A target at/above that cap would need spot < 0.
		const cap = bsPutPrice(0, strike, ivToday, tenorDte);
		if (targetPremium >= cap) return null; // unreachable — no non-negative spot

		// Bracket: put(lo=0) = cap ≥ target; grow hi until put(hi) ≤ target
		// (put → 0 as spot → ∞, so the growth terminates).
		let lo = 0;
		let hi = strike;
		for (let g = 0; g < GROW_CAP && bsPutPrice(hi, strike, ivToday, tenorDte) > targetPremium; g++) {
			hi *= 2;
		}
		for (let i = 0; i < MAX_ITER; i++) {
			const mid = (lo + hi) / 2;
			// Price too high → spot too low → raise the floor.
			if (bsPutPrice(mid, strike, ivToday, tenorDte) > targetPremium) lo = mid;
			else hi = mid;
		}
		return (lo + hi) / 2;
	}

	// side === "cc": call price INCREASES in spot; call(0) = 0, call(∞) = ∞.
	// call(spot) ≥ max(spot − strike, 0), so hi = strike + target guarantees
	// call(hi) ≥ target; lo = 0 gives call(lo) = 0 < target.
	let lo = 0;
	let hi = strike + targetPremium;
	for (let g = 0; g < GROW_CAP && bsCallPrice(hi, strike, ivToday, tenorDte) < targetPremium; g++) {
		hi *= 2;
	}
	for (let i = 0; i < MAX_ITER; i++) {
		const mid = (lo + hi) / 2;
		// Price too low → spot too low → raise the floor.
		if (bsCallPrice(mid, strike, ivToday, tenorDte) < targetPremium) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}
