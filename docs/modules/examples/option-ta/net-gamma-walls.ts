// 出处：theta app/src/lib/net-gamma-walls.ts @ 404254dee0078bfe8a35d7efdbf3c949bde9bfe7
/**
 * net-gamma-walls — put-wall / call-wall + naive net-GEX sign from an option
 * chain's per-strike gamma × open interest. Pure — no I/O.
 *
 * GEX (Gamma Exposure) per strike = Gamma × OI × 100 × Spot²   [SpotGamma]
 *   calls contribute POSITIVE gamma exposure, puts contribute NEGATIVE.
 *   - call_wall = strike with the largest positive call-gamma → soft resistance
 *     (dealers short calls SELL stock as price rises toward it).
 *   - put_wall  = strike with the largest |put-gamma| → soft support BELOW spot
 *     (dealers short puts BUY stock as price falls toward it); once price breaks
 *     the put_wall the support flips to an accelerant (gamma collapses) — so this
 *     is context, never a guaranteed floor.
 *   - net_gex > 0 → "positive/stabilizing" (favors premium selling);
 *     net_gex < 0 → "negative/amplifying" (favors long premium / directional).
 *
 * ⚠️ INFORMATIONAL ONLY — this is a structure/regime lens (like IV-rank), NOT a
 * trade signal. Two disclaimers are emitted on every result:
 *   1. assumption — naive: assumes dealers are net short the public OI; true
 *      dealer positioning is unobservable, so the sign is a MODEL ESTIMATE.
 *   2. confidence — thin OI (total < THIN_OI_THRESHOLD) makes walls/GEX
 *      unreliable on single names (SpotGamma); flagged "low".
 */

/** Total OI below this → walls/GEX flagged low-confidence (thin single-name). */
export const THIN_OI_THRESHOLD = 5000;

export const GEX_ASSUMPTION =
	"naive — assumes dealers are net short the public OI; true dealer positioning " +
	"is unobservable, so the net-GEX sign is a model estimate, not a measured fact.";

export interface GammaRow {
	strike: number;
	gamma: number | null;
	open_interest: number | null;
}

export interface NetGammaInput {
	spot: number;
	calls: GammaRow[];
	puts: GammaRow[];
}

export interface WallStrike {
	strike: number;
	/** Signed GEX contribution at this strike ($, calls +, puts −). */
	gex: number;
}

export type Regime = "positive/stabilizing" | "negative/amplifying";
export type SpotPosition =
	| "between"
	| "below_put_wall"
	| "above_call_wall"
	| "unknown";
/** spot relative to the naive gamma-flip (regime pivot). */
export type SpotVsFlip = "above" | "below" | "near" | null;

/** |spot − flip| / spot below this → "near" the flip (the transition / danger zone). */
export const NEAR_FLIP_PCT = 0.01;
/** A naive flip more than this far from spot is not an actionable pivot → report null. */
export const FLIP_MAX_DIST_PCT = 0.25;

export interface NetGammaWalls {
	spot: number;
	call_wall: WallStrike | null;
	put_wall: WallStrike | null;
	net_gex: number;
	regime: Regime;
	spot_position: SpotPosition;
	/**
	 * Naive gamma-flip estimate: the price where the cumulative net signed GEX
	 * (calls +, puts −), swept by ascending strike, first crosses from negative
	 * to ≥0. Below it puts dominate (amplifying), above it calls dominate
	 * (stabilizing). null when there is no such crossing. NAIVE — uses static
	 * per-strike gamma, NOT a SpotGamma-grade per-price re-pricing.
	 */
	gamma_flip: number | null;
	/** spot vs the gamma-flip: above (seller-comfortable) / below / near (danger). */
	spot_vs_flip: SpotVsFlip;
	total_oi: number;
	/** Per-strike breakdown (sorted ascending) for rendering. */
	by_strike: { strike: number; call_gex: number; put_gex: number; net: number }[];
	assumption: string;
	confidence: string;
}

/**
 * Single-contract GEX magnitude = |Gamma| × OI × 100 × Spot². Returns 0 when
 * gamma or OI is missing/NaN (defensive — chains often have null greeks).
 * The sign (call +, put −) is applied by the caller.
 */
export function gexContribution(
	gamma: number | null,
	open_interest: number | null,
	spot: number,
): number {
	if (gamma == null || Number.isNaN(gamma)) return 0;
	if (open_interest == null || Number.isNaN(open_interest)) return 0;
	if (!Number.isFinite(spot)) return 0;
	return Math.abs(gamma) * open_interest * 100 * spot * spot;
}

export function netGammaWalls(input: NetGammaInput): NetGammaWalls {
	const { spot, calls, puts } = input;

	// Aggregate per-strike (a strike may appear once per side).
	const callGexByStrike = new Map<number, number>();
	const putGexByStrike = new Map<number, number>();
	let totalOi = 0;

	for (const r of calls) {
		const g = gexContribution(r.gamma, r.open_interest, spot); // positive
		callGexByStrike.set(r.strike, (callGexByStrike.get(r.strike) ?? 0) + g);
		totalOi += r.open_interest ?? 0;
	}
	for (const r of puts) {
		const g = gexContribution(r.gamma, r.open_interest, spot); // magnitude
		putGexByStrike.set(r.strike, (putGexByStrike.get(r.strike) ?? 0) + g);
		totalOi += r.open_interest ?? 0;
	}

	// call_wall = strike with max positive call-gamma, AT OR ABOVE spot (resistance).
	// put_wall  = strike with max |put-gamma|, AT OR BELOW spot (support).
	// Conditioning on the spot side is what makes the support/resistance reading
	// meaningful — without it, a name whose gamma is densest near a far-from-current
	// ATM (IPO / post-drop names) gets a "put-wall" ABOVE spot, which is nonsense.
	let callWall: WallStrike | null = null;
	for (const [strike, gex] of callGexByStrike) {
		if (gex <= 0) continue;
		if (strike < spot) continue; // resistance lives at/above spot
		if (!callWall || gex > callWall.gex) callWall = { strike, gex };
	}
	let putWall: WallStrike | null = null;
	for (const [strike, mag] of putGexByStrike) {
		if (mag <= 0) continue;
		if (strike > spot) continue; // support lives at/below spot
		if (!putWall || mag > Math.abs(putWall.gex)) putWall = { strike, gex: -mag };
	}

	const sumCalls = [...callGexByStrike.values()].reduce((a, b) => a + b, 0);
	const sumPuts = [...putGexByStrike.values()].reduce((a, b) => a + b, 0);
	const netGex = sumCalls - sumPuts;
	const regime: Regime = netGex > 0 ? "positive/stabilizing" : "negative/amplifying";

	// spot relative to the structural band [put_wall (support), call_wall (resistance)].
	let spotPosition: SpotPosition = "unknown";
	if (putWall && spot < putWall.strike) spotPosition = "below_put_wall";
	else if (callWall && spot > callWall.strike) spotPosition = "above_call_wall";
	else if (putWall || callWall) spotPosition = "between";

	const confidence =
		totalOi < THIN_OI_THRESHOLD
			? `low — thin OI (total ${totalOi} < ${THIN_OI_THRESHOLD}); walls/GEX have limited predictive weight on thin single names (SpotGamma)`
			: "normal";

	// Merge per-strike for a sorted breakdown.
	const strikes = new Set<number>([...callGexByStrike.keys(), ...putGexByStrike.keys()]);
	const byStrike = [...strikes]
		.sort((a, b) => a - b)
		.map((strike) => {
			const call_gex = callGexByStrike.get(strike) ?? 0;
			const put_gex = -(putGexByStrike.get(strike) ?? 0);
			return { strike, call_gex, put_gex, net: call_gex + put_gex };
		});

	// Naive gamma-flip: cumulative net signed GEX swept by ascending strike;
	// first crossing from <0 to ≥0 (puts dominate below, calls above). Interpolate
	// the price between the two bracketing strikes. spot² is a common positive
	// factor → does not affect the crossing location.
	const crossings: number[] = [];
	let cum = 0;
	let prevStrike: number | null = null;
	let prevCum: number | null = null;
	for (const row of byStrike) {
		const newCum = cum + row.net;
		if (prevCum !== null && prevStrike !== null && prevCum < 0 && newCum >= 0) {
			const denom = newCum - prevCum;
			crossings.push(denom === 0 ? row.strike : prevStrike + (row.strike - prevStrike) * (0 - prevCum) / denom);
		}
		cum = newCum;
		prevCum = cum;
		prevStrike = row.strike;
	}
	// Pick the crossing NEAREST spot; a flip far from spot (>FLIP_MAX_DIST_PCT) is
	// not an actionable pivot (naive method can cross at a far low-strike cluster)
	// → report null rather than mislead.
	let gammaFlip: number | null = null;
	if (crossings.length > 0) {
		const nearest = crossings.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a));
		if (Math.abs(nearest - spot) / spot <= FLIP_MAX_DIST_PCT) gammaFlip = nearest;
	}

	let spotVsFlip: SpotVsFlip = null;
	if (gammaFlip !== null) {
		if (Math.abs(spot - gammaFlip) / spot <= NEAR_FLIP_PCT) spotVsFlip = "near";
		else if (spot > gammaFlip) spotVsFlip = "above";
		else spotVsFlip = "below";
	}

	return {
		spot,
		call_wall: callWall,
		put_wall: putWall,
		net_gex: netGex,
		regime,
		spot_position: spotPosition,
		gamma_flip: gammaFlip,
		spot_vs_flip: spotVsFlip,
		total_oi: totalOi,
		by_strike: byStrike,
		assumption: GEX_ASSUMPTION,
		confidence,
	};
}
