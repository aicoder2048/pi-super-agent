// 出处：theta app/src/lib/strategy-economics.ts @ 94c32859efcd8f8ff1df51e273f306e0a1bd4ef0（补了买方：longOptionEconomics、debitSpreadEconomics；max_profit 可为 null 表示无上限）
/**
 * strategy-economics — pure per-strategy economics for strategy_compare (the
 * "CSP vs Bull Put Spread vs Bear Call vs Naked Stock" comparison). The chain
 * (strikes/mids/deltas) is fetched in the tool; this module turns the chosen legs
 * into capital / max-profit / max-loss / annualized-ROC / breakeven. A wrong
 * max-loss on a defined-risk spread, or a wrong capital denominator, would mislead
 * the naked-vs-spread call — so it lives here behind an offline smoke.
 */
import { annualizeOrNull } from "./options-math.ts";

export interface StrategyEconomics {
	/** Capital at risk / margin requirement ($). */
	capital: number;
	/** null = unbounded (a long call). */
	max_profit: number | null;
	/** Worst-case loss ($). Naked short put / long stock = huge; credit spread = defined. */
	max_loss: number;
	/** null = 退化输入(capital ≤ 0 或 dte ≤ 0),算不出年化;显示「—」。 */
	annualized_roc: number | null;
	breakeven: number;
	/** 坏报价:信用价差 net credit ≥ width(交叉盘口/坏 mid)→ capital ≤ 0,不参与比较。 */
	bad_quote: boolean;
}

/** Cash-secured put: capital = strike × 100 (the cash set aside). Worst case = assigned
 *  and the stock goes to zero → lose (strike − premium) × 100. */
export function cspEconomics(strike: number, premium: number, dte: number): StrategyEconomics {
	const capital = strike * 100;
	const max_profit = premium * 100;
	const max_loss = (strike - premium) * 100;
	return { capital, max_profit, max_loss, annualized_roc: annualizeOrNull(max_profit, capital, dte), breakeven: strike - premium, bad_quote: false };
}

/**
 * Credit spread (bull put OR bear call) — identical economics, breakeven differs by
 * direction. `width` = |shortStrike − longStrike|, `netCredit` = shortMid − longMid (> 0).
 * Capital = the margin = (width − netCredit) × 100; max-loss is DEFINED at width×100 − maxProfit.
 * netCredit ≥ width 是不可能的真实报价 → bad_quote = true,ROC null。
 */
export function creditSpreadEconomics(
	width: number,
	netCredit: number,
	dte: number,
	shortStrike: number,
	kind: "put" | "call",
): StrategyEconomics {
	const capital = width * 100 - netCredit * 100;
	const max_profit = netCredit * 100;
	const max_loss = width * 100 - max_profit;
	const breakeven = kind === "put" ? shortStrike - netCredit : shortStrike + netCredit;
	return { capital, max_profit, max_loss, annualized_roc: annualizeOrNull(max_profit, capital, dte), breakeven, bad_quote: netCredit >= width };
}

/** Naked long stock (100 shares): capital = spot × 100; profit projected from an assumed
 *  appreciation `stockPct`; worst case = stock → 0 (lose the full capital). */
export function nakedStockEconomics(spot: number, stockPct: number, dte: number): StrategyEconomics {
	const capital = spot * 100;
	const max_profit = spot * stockPct * 100; // (spot×(1+pct) − spot) × 100
	return { capital, max_profit, max_loss: capital, annualized_roc: annualizeOrNull(max_profit, capital, dte), breakeven: spot, bad_quote: false };
}

/** Long put or call: capital and worst case are the premium paid. A long put's best case is
 *  the stock going to zero; a long call's is unbounded (max_profit null). Neither has a profit
 *  target to annualize, so annualized_roc is null. A premium that is not positive is a bad quote. */
export function longOptionEconomics(
	strike: number,
	premium: number,
	dte: number,
	kind: "put" | "call",
): StrategyEconomics {
	const capital = premium * 100;
	const max_profit = kind === "put" ? (strike - premium) * 100 : null;
	const breakeven = kind === "put" ? strike - premium : strike + premium;
	return { capital, max_profit, max_loss: capital, annualized_roc: null, breakeven, bad_quote: !(premium > 0) };
}

/**
 * Debit spread (bull call OR bear put). `width` = |longStrike − shortStrike|, `netDebit` =
 * longMid − shortMid (> 0). Capital and max loss are the debit; max profit = width − debit.
 * Like a long option it is a directional bet, so annualized_roc is null: annualizing the best
 * case over a small debit reads as a return the position is unlikely to earn.
 * A debit that is not positive or not below the width is a bad quote.
 */
export function debitSpreadEconomics(
	width: number,
	netDebit: number,
	dte: number,
	longStrike: number,
	kind: "put" | "call",
): StrategyEconomics {
	const capital = netDebit * 100;
	const max_profit = width * 100 - capital;
	const bad_quote = !(netDebit > 0) || netDebit >= width;
	const breakeven = kind === "call" ? longStrike + netDebit : longStrike - netDebit;
	return { capital, max_profit, max_loss: capital, annualized_roc: null, breakeven, bad_quote };
}
