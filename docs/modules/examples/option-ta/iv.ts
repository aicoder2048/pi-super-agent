// 出处：theta app/src/backtest/iv.ts @ 404254dee0078bfe8a35d7efdbf3c949bde9bfe7（补了 call 版 impliedVolCall；bsPutDelta 不搬）
/**
 * Historical-IV reconstruction: invert Black-Scholes from an option close
 * price. Polygon aggregates carry trade closes, not quote mids — the noise
 * this introduces is a documented data limitation (design doc §4), not
 * something to hide; unstable inputs return null and the metrics pipeline
 * degrades exactly like live (computeTimingMetrics handles iv=null).
 *
 * Forward pricing reuses options-math.ts verbatim.
 */
import { bsCallPrice, bsPutPrice } from "./options-math.ts";

const IV_LO = 1e-4;
const IV_HI = 5;
const MAX_ITER = 100;

/**
 * Implied vol of a put from its price (r=0, no dividends). Bisection on
 * bsPutPrice — monotone in σ, so convergence is unconditional inside the
 * bracket. Returns null (never NaN) when the price carries no usable time
 * value: at/below intrinsic, at/above the strike (max put value), bad
 * inputs, or expired.
 */
export function impliedVolPut(
	price: number,
	spot: number,
	strike: number,
	dte: number,
): number | null {
	if (!Number.isFinite(price) || !Number.isFinite(spot) || !Number.isFinite(strike)) return null;
	if (price <= 0 || spot <= 0 || strike <= 0 || dte <= 0) return null;
	const intrinsic = Math.max(0, strike - spot);
	if (price <= intrinsic + 1e-12) return null; // no time value → inversion unstable
	if (price >= strike) return null; // exceeds the theoretical max put value
	if (price > bsPutPrice(spot, strike, IV_HI, dte)) return null; // outside bracket

	let lo = IV_LO;
	let hi = IV_HI;
	for (let i = 0; i < MAX_ITER; i++) {
		const mid = (lo + hi) / 2;
		if (bsPutPrice(spot, strike, mid, dte) < price) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/**
 * Implied vol of a call from its price (r=0, no dividends), the mirror of
 * impliedVolPut: bisection on bsCallPrice. A call is worth at most the spot,
 * so a price at or above the spot has no solution. Returns null (never NaN)
 * under the same conditions as the put version.
 */
export function impliedVolCall(
	price: number,
	spot: number,
	strike: number,
	dte: number,
): number | null {
	if (!Number.isFinite(price) || !Number.isFinite(spot) || !Number.isFinite(strike)) return null;
	if (price <= 0 || spot <= 0 || strike <= 0 || dte <= 0) return null;
	const intrinsic = Math.max(0, spot - strike);
	if (price <= intrinsic + 1e-12) return null;
	if (price >= spot) return null;
	if (price > bsCallPrice(spot, strike, IV_HI, dte)) return null;

	let lo = IV_LO;
	let hi = IV_HI;
	for (let i = 0; i < MAX_ITER; i++) {
		const mid = (lo + hi) / 2;
		if (bsCallPrice(spot, strike, mid, dte) < price) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}
