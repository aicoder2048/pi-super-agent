// 出处：theta app/src/lib/iv-crush.ts @ 404254dee0078bfe8a35d7efdbf3c949bde9bfe7
/**
 * iv-crush — pure earnings vol-crush projection for earnings_iv_crush. Isolates the
 * vol contribution (spot held constant): post-event IV = current_iv × (1 − crush%),
 * then BS-prices the option PRE (full DTE, current IV) vs POST (post-event DTE, crushed
 * IV); crush = pre − post (positive = the short captures it). BS pricing is reused from
 * options-math (already smoke-covered); this module owns the orchestration.
 */
import { bsCallPrice, bsPutPrice } from "./options-math.ts";

export interface IvCrushParams {
	side: "put" | "call";
	spot: number;
	strike: number;
	/** Pre-event IV (decimal). */
	current_iv: number;
	/** Fraction of IV crushed post-event. Default 0.35. */
	historical_crush_pct?: number;
	days_to_earnings: number;
	/** DTE remaining AFTER the print. */
	post_event_dte: number;
	contracts?: number;
}

export interface IvCrushResult {
	post_event_iv: number;
	total_dte: number;
	pre_event_price: number;
	post_event_price: number;
	crush_per_share: number;
	crush_per_contract: number;
	crush_total: number;
	/** Short-side capital: strike×100 (put) or spot×100 (call). */
	capital: number;
	yield_on_capital: number;
	contracts: number;
}

/**
 * Returns null on invalid inputs: current_iv ≤ 0, total DTE ≤ 0, or crush% outside [0, 1).
 */
export function computeIvCrush(p: IvCrushParams): IvCrushResult | null {
	const crushPct = p.historical_crush_pct ?? 0.35;
	const contracts = p.contracts ?? 1;
	const totalDte = p.days_to_earnings + p.post_event_dte;
	if (p.current_iv <= 0 || totalDte <= 0) return null;
	if (crushPct < 0 || crushPct >= 1) return null;

	const postIv = p.current_iv * (1 - crushPct);
	const priceBs = p.side === "put" ? bsPutPrice : bsCallPrice;
	// Spot assumed unchanged through the print (vol-only model). PRE uses the full DTE at
	// current IV; POST uses the post-event DTE at the crushed IV.
	const preEventPrice = priceBs(p.spot, p.strike, p.current_iv, totalDte);
	const postEventPrice = priceBs(p.spot, p.strike, postIv, p.post_event_dte);
	const crushPerShare = preEventPrice - postEventPrice;
	const crushPerContract = crushPerShare * 100;
	const capital = p.side === "put" ? p.strike * 100 : p.spot * 100;

	return {
		post_event_iv: postIv,
		total_dte: totalDte,
		pre_event_price: preEventPrice,
		post_event_price: postEventPrice,
		crush_per_share: crushPerShare,
		crush_per_contract: crushPerContract,
		crush_total: crushPerContract * contracts,
		capital,
		yield_on_capital: crushPerContract / capital,
		contracts,
	};
}
