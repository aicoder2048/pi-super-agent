// 出处：theta app/src/lib/first-passage.ts @ 374f593c4d9b7e82160576a9719d76970d28b524
/**
 * GBM first-passage (touch) probability — shared foundational primitive.
 *
 * Under a driftless geometric Brownian motion (log-price = σ·W_t, i.e. we read
 * "drift 0" as log-drift 0 — the omitted −σ²/2 term shifts d by ~1.6% at a
 * 1-day scale and is deliberately ignored), the probability that the price
 * TOUCHES a barrier H at any time within horizon T is the reflection-principle
 * closed form:
 *
 *     P(touch H by T) = 2·Φ( −|ln(H/spot)| / (σ√T) )
 *
 * This is a per-barrier touch probability (NOT a terminal-ITM probability and
 * NOT a distribution): P(touch) ≥ P(terminal beyond H). Barriers above and
 * below spot are symmetric — only the absolute log-distance matters.
 *
 * Consumed by premium-targets-price-channel (one shared GBM engine, no inlined copy).
 * Pure & offline: no clock, no state, no I/O. All time quantities are injected.
 */
import { normalCdf } from "./options-math.ts";

/**
 * Reflection-principle touch probability for a driftless GBM.
 *
 * @param spot             current underlying price (> 0)
 * @param barrier          the level H whose first-passage we want (> 0)
 * @param sigmaAnnualized  annualized volatility (e.g. 0.32 for 32%)
 * @param tYears           horizon in years (e.g. 1/252 for one trading day)
 * @returns touch probability, clamped to [0, 1]
 *
 * Degenerate cases:
 *   - barrier == spot                 → 1 (already at the level).
 *   - σ√T ≤ 0 with barrier ≠ spot      → 0 (no time/vol left to move).
 *   - non-positive spot or barrier    → 0 (undefined geometry, fail safe).
 */
export function touchProbFirstPassage(
	spot: number,
	barrier: number,
	sigmaAnnualized: number,
	tYears: number,
): number {
	// Fail-safe on undefined geometry rather than returning NaN.
	if (!(spot > 0) || !(barrier > 0)) return 0;

	const logDist = Math.abs(Math.log(barrier / spot));
	// Already sitting on the barrier → certain touch (also avoids 0/0).
	if (logDist === 0) return 1;

	const sigmaSqrtT = sigmaAnnualized * Math.sqrt(tYears);
	// No time or no vol to travel the (non-zero) distance → cannot touch.
	if (!(sigmaSqrtT > 0)) return 0;

	const d = logDist / sigmaSqrtT;
	const p = 2 * normalCdf(-d);
	// Clamp: at d→0 the A-S approximation can return marginally above 1.
	return Math.min(1, Math.max(0, p));
}
