// 出处：theta app/src/lib/cc-yield.ts @ 3db2d93d2abe4ef97c9a999d4753eefbdc7b47ce
/**
 * cc-yield — pure covered-call yield math (the wheel's exit leg). Extracted from
 * the compute_cc_yield tool so the arithmetic (yield, annualization, breakeven,
 * max-profit-if-called, return-on-cost) is unit-testable offline. No network, no
 * Black-Scholes here — assignment probability stays in options-math / the tool.
 */
import { annualize } from "./options-math.ts";

export interface CcYieldParams {
	/** Call strike ($) — where shares get called away. */
	strike: number;
	/** Premium received per share ($). */
	premium: number;
	/** Days to expiration (calendar). */
	dte: number;
	/** Acquisition cost per share ($) — required for max-profit-if-called math. */
	cost_basis?: number;
	/** Current underlying spot ($) — breakeven-reference fallback. */
	current_price?: number;
	/** Number of contracts (default 1). */
	contracts?: number;
}

export interface CcYieldResult {
	contracts: number;
	shares: number;
	premium_total: number;
	yield_on_strike_period: number;
	annualized_yield_on_strike: number;
	/** null when cost_basis is absent or non-positive. */
	yield_on_cost_period: number | null;
	annualized_yield_on_cost: number | null;
	/** referenceCost − premium, where referenceCost = cost_basis ?? current_price ?? strike. */
	downside_breakeven: number;
	/** null when cost_basis is absent. Can be NEGATIVE (assignment locks in a loss). */
	max_profit_if_called: number | null;
	max_profit_return_on_cost: number | null;
}

/**
 * Compute the covered-call metrics. Returns null on invalid inputs
 * (requires strike > 0, premium >= 0, dte > 0).
 */
export function computeCcYield(p: CcYieldParams): CcYieldResult | null {
	const { strike, premium, dte } = p;
	if (strike <= 0 || premium < 0 || dte <= 0) return null;

	const contracts = p.contracts ?? 1;
	const shares = contracts * 100;
	const premiumTotal = premium * shares;

	const yieldOnStrike = premium / strike;
	const annualizedOnStrike = annualize(yieldOnStrike, dte);

	const hasCost = p.cost_basis !== undefined && p.cost_basis > 0;
	const yieldOnCost = hasCost ? premium / p.cost_basis! : null;
	const annualizedOnCost = yieldOnCost !== null ? annualize(yieldOnCost, dte) : null;

	// Downside breakeven: cost_basis is the truest reference, else spot, else strike.
	const referenceCost = p.cost_basis ?? p.current_price ?? strike;
	const downsideBreakeven = referenceCost - premium;

	// Max profit when called away — only meaningful if cost_basis is known.
	const maxProfit =
		p.cost_basis !== undefined ? (strike - p.cost_basis) * shares + premiumTotal : null;
	const maxProfitReturnOnCost = hasCost
		? (strike - p.cost_basis! + premium) / p.cost_basis!
		: null;

	return {
		contracts,
		shares,
		premium_total: premiumTotal,
		yield_on_strike_period: yieldOnStrike,
		annualized_yield_on_strike: annualizedOnStrike,
		yield_on_cost_period: yieldOnCost,
		annualized_yield_on_cost: annualizedOnCost,
		downside_breakeven: downsideBreakeven,
		max_profit_if_called: maxProfit,
		max_profit_return_on_cost: maxProfitReturnOnCost,
	};
}
