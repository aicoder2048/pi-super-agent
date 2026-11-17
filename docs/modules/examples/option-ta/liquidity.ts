// 出处：theta app/src/lib/liquidity.ts @ 404254dee0078bfe8a35d7efdbf3c949bde9bfe7
/**
 * Shared liquidity scoring for option strikes. Extracted from score_liquidity
 * so other tools (find_best_strike, find_cc_after_assignment, etc.) can compute
 * the same composite without spawning a separate Python sidecar call.
 *
 * Composite formula (weights tuned for short-premium wheel use):
 *   spread_score   — piecewise: tight ≤2% → 1.0; ≤5% → 0.8; ≤10% → 0.5; ≤20% → 0.2; >20% → 0
 *   oi_score       — log-scaled: ≥2000 → 1.0; 500 → 0.75; 100 → 0.5; 10 → 0.1; 0 → 0
 *   volume_score   — log-scaled: ≥500 → 1.0; 100 → 0.7; 20 → 0.4; 0 → 0
 *   composite      = 0.55*spread_score + 0.30*oi_score + 0.15*volume_score
 *
 * Tier + fill verdict:
 *   ≥0.75 → 🟢 liquid       "fills at mid; comfortable to roll/close anytime"
 *   ≥0.50 → 🟡 thin         "may need to cross half the spread; hold-to-expiry only is safest"
 *   ≥0.30 → 🟠 poor         "expect to give up edge to spread on entry AND exit"
 *   <0.30 → 🔴 illiquid     "don't enter — fill quality will eat the trade"
 *
 * NBBO-unavailable fallback:
 *   When bid/ask are absent (market closed, no live quote, or pre-Advanced
 *   tier on Polygon), the spread component is undefined. Instead of treating
 *   spread_score as 0 (which falsely caps composite at 0.45 and mislabels
 *   high-OI liquid strikes as "poor"/"illiquid"), the composite is renormalized
 *   over only OI+vol weights:
 *     composite = (0.30*oi_score + 0.15*volume_score) / 0.45
 *   The result is tagged with `nbbo_status: "unknown"` so downstream tools can
 *   surface the caveat. Tier thresholds remain the same — a high-OI strike
 *   keeps its 🟢 / 🟡 verdict, just with a note that the spread couldn't be
 *   confirmed in real time.
 */

export type LiquidityTier = "liquid" | "thin" | "poor" | "illiquid";

/** Whether the score was computed with live NBBO bid/ask or fell back to
 *  OI+volume only (because the market is closed, the strike has no live
 *  quote right now, or the Polygon plan doesn't include real-time quotes). */
export type NbboStatus = "live" | "unknown";

export interface LiquidityInputs {
	/** Per-share bid ($). Null if missing. */
	bid: number | null;
	/** Per-share ask ($). Null if missing. */
	ask: number | null;
	/** Per-share mid used as denominator for spread%. Pass r.mid. */
	mid: number;
	open_interest: number | null;
	volume: number | null;
}

export interface LiquidityScore {
	spread: number | null;
	spread_pct: number | null;
	oi: number | null;
	volume: number | null;
	spread_score: number;
	oi_score: number;
	volume_score: number;
	composite: number;
	tier: LiquidityTier;
	fill_verdict: string;
	/** "live" when bid/ask were usable to compute spread; "unknown" when the
	 *  composite was renormalized from OI+volume only (market closed,
	 *  no live quote, or tier doesn't include NBBO). */
	nbbo_status: NbboStatus;
}

function spreadScoreFromPct(pct: number | null): number {
	if (pct == null || !Number.isFinite(pct)) return 0;
	if (pct <= 0.02) return 1.0;
	if (pct <= 0.05) return 1.0 - (pct - 0.02) * (1.0 - 0.8) / (0.05 - 0.02); // 0.02→1.0, 0.05→0.8
	if (pct <= 0.1) return 0.8 - (pct - 0.05) * (0.8 - 0.5) / (0.1 - 0.05); // 0.05→0.8, 0.1→0.5
	if (pct <= 0.2) return 0.5 - (pct - 0.1) * (0.5 - 0.2) / (0.2 - 0.1); // 0.1→0.5, 0.2→0.2
	if (pct <= 0.5) return Math.max(0, 0.2 - (pct - 0.2) * 0.2 / 0.3);
	return 0;
}

function oiScoreFromCount(oi: number | null): number {
	if (oi == null || oi <= 0) return 0;
	if (oi >= 2000) return 1.0;
	if (oi >= 500) return 0.75 + (oi - 500) * (1.0 - 0.75) / (2000 - 500);
	if (oi >= 100) return 0.5 + (oi - 100) * (0.75 - 0.5) / (500 - 100);
	if (oi >= 10) return 0.1 + (oi - 10) * (0.5 - 0.1) / (100 - 10);
	return Math.max(0, oi / 10 * 0.1);
}

function volumeScoreFromCount(vol: number | null): number {
	if (vol == null || vol <= 0) return 0;
	if (vol >= 500) return 1.0;
	if (vol >= 100) return 0.7 + (vol - 100) * (1.0 - 0.7) / (500 - 100);
	if (vol >= 20) return 0.4 + (vol - 20) * (0.7 - 0.4) / (100 - 20);
	return Math.max(0, vol / 20 * 0.4);
}

function tierOf(composite: number): LiquidityTier {
	if (composite >= 0.75) return "liquid";
	if (composite >= 0.5) return "thin";
	if (composite >= 0.3) return "poor";
	return "illiquid";
}

const TIER_VERDICT: Record<LiquidityTier, string> = {
	liquid: "🟢 liquid — fills at mid; comfortable to roll/close anytime",
	thin: "🟡 thin — may need to cross half the spread; hold-to-expiry safest",
	poor: "🟠 poor — expect to give up edge to spread on entry AND exit",
	illiquid: "🔴 illiquid — don't enter; fill quality will eat the trade",
};

export const TIER_BADGE: Record<LiquidityTier, string> = {
	liquid: "🟢 liquid",
	thin: "🟡 thin",
	poor: "🟠 poor",
	illiquid: "🔴 illiquid",
};

export function scoreLiquidity(inputs: LiquidityInputs): LiquidityScore {
	const { bid, ask, mid, open_interest, volume } = inputs;
	const hasLiveNbbo =
		bid != null && ask != null && bid > 0 && ask > 0 && ask >= bid && mid > 0;

	let spread: number | null = null;
	let spreadPct: number | null = null;
	if (hasLiveNbbo) {
		spread = ask! - bid!;
		spreadPct = spread / mid;
	}
	const sScore = spreadScoreFromPct(spreadPct);
	const oScore = oiScoreFromCount(open_interest);
	const vScore = volumeScoreFromCount(volume);

	// When NBBO is unavailable, renormalize over OI+volume only (0.30 + 0.15
	// = 0.45) instead of letting spread_score=0 cap the composite at 0.45 and
	// mislabel liquid strikes as poor/illiquid.
	const composite = hasLiveNbbo
		? 0.55 * sScore + 0.3 * oScore + 0.15 * vScore
		: (0.3 * oScore + 0.15 * vScore) / 0.45;
	const tier = tierOf(composite);
	return {
		spread,
		spread_pct: spreadPct,
		oi: open_interest,
		volume,
		spread_score: sScore,
		oi_score: oScore,
		volume_score: vScore,
		composite,
		tier,
		fill_verdict: TIER_VERDICT[tier],
		nbbo_status: hasLiveNbbo ? "live" : "unknown",
	};
}
