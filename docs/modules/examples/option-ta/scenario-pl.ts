// 出处：theta app/src/lib/scenario-pl.ts @ 404254dee0078bfe8a35d7efdbf3c949bde9bfe7（补了买方：买 put、买 call、两种借方价差）
/**
 * scenario-pl — pure at-expiry payoff math for compute_scenario_pl (the wheel stress
 * test). Deterministic option payoffs per share; no Black-Scholes, no network. The
 * mid-DTE marks (Black-Scholes MTM) stay in the tool — they reuse options-math, which
 * is already smoke-covered. Extracted here so the expiry math is offline-tested.
 */

/** Short put at expiry: keep premium, pay intrinsic below the strike. */
export function expiryPLShortPut(strike: number, premium: number, spotAtExpiry: number): number {
	return premium - Math.max(0, strike - spotAtExpiry);
}

/**
 * Short call at expiry, per share.
 *  - Naked (no costBasis): premium − max(0, spot − strike) (intrinsic loss above strike).
 *  - Covered (costBasis given): the shares are called away at the strike when ITM, so the
 *    result is just premium + (min(spot,strike) − costBasis). NOTE: do NOT also subtract the
 *    call intrinsic — the min(spot,strike) cap already represents being called away. Doing both
 *    double-counts the intrinsic and shows a called-away (max-profit) CC as a loss (the
 *    2026-06-17 bug, fix-cc-expiry-pl-scenario).
 */
export function expiryPLShortCall(
	strike: number,
	premium: number,
	spotAtExpiry: number,
	costBasis?: number,
): number {
	if (costBasis === undefined) return premium - Math.max(0, spotAtExpiry - strike);
	return premium + (Math.min(spotAtExpiry, strike) - costBasis);
}

/** Bull put spread at expiry: net credit, short leg loses below its strike, long leg hedges
 *  below its (lower) strike. Max loss = (width − credit), capped. */
export function expiryPLBullPutSpread(
	shortStrike: number,
	longStrike: number,
	netCredit: number,
	spotAtExpiry: number,
): number {
	const shortLoss = Math.max(0, shortStrike - spotAtExpiry);
	const longGain = Math.max(0, longStrike - spotAtExpiry);
	return netCredit - shortLoss + longGain;
}

/** Bear call spread at expiry: net credit, short leg loses above its strike, long leg hedges
 *  above its (higher) strike. Max loss = (width − credit), capped. */
export function expiryPLBearCallSpread(
	shortStrike: number,
	longStrike: number,
	netCredit: number,
	spotAtExpiry: number,
): number {
	const shortLoss = Math.max(0, spotAtExpiry - shortStrike);
	const longGain = Math.max(0, spotAtExpiry - longStrike);
	return netCredit - shortLoss + longGain;
}

/** Long put at expiry: pay premium, gain intrinsic below the strike. */
export function expiryPLLongPut(strike: number, premium: number, spotAtExpiry: number): number {
	return Math.max(0, strike - spotAtExpiry) - premium;
}

/** Long call at expiry: pay premium, gain intrinsic above the strike. */
export function expiryPLLongCall(strike: number, premium: number, spotAtExpiry: number): number {
	return Math.max(0, spotAtExpiry - strike) - premium;
}

/** Bull call spread at expiry: net debit, long leg gains above its (lower) strike, short leg
 *  gives it back above its (higher) strike. Max gain = width − debit, max loss = debit. */
export function expiryPLBullCallSpread(
	longStrike: number,
	shortStrike: number,
	netDebit: number,
	spotAtExpiry: number,
): number {
	return Math.max(0, spotAtExpiry - longStrike) - Math.max(0, spotAtExpiry - shortStrike) - netDebit;
}

/** Bear put spread at expiry: net debit, long leg gains below its (higher) strike, short leg
 *  gives it back below its (lower) strike. Max gain = width − debit, max loss = debit. */
export function expiryPLBearPutSpread(
	longStrike: number,
	shortStrike: number,
	netDebit: number,
	spotAtExpiry: number,
): number {
	return Math.max(0, longStrike - spotAtExpiry) - Math.max(0, shortStrike - spotAtExpiry) - netDebit;
}
