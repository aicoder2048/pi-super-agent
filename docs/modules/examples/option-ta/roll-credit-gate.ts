// 出处：theta app/src/lib/roll-credit-gate.ts @ 404254dee0078bfe8a35d7efdbf3c949bde9bfe7（门槛写成命名常量 ROLL_PENNY_FRACTION；删了一句 theta 使用者自己的账户情况）
/**
 * roll-credit-gate — tastylive's #1 roll discipline as a deterministic gate. You roll a
 * short premium position forward FOR A CREDIT; if the only available roll is a net DEBIT
 * (usually because the position is too far ITM), the objective signal is "don't roll —
 * take the loss", not "here's a roll plan". This turns that into a first-class verdict so
 * the roll tools / verdict can't quietly keep throwing debit after debit.
 *
 * Knobs (user-decided 2026-06-17):
 *   - net ≤ 0                     → DO_NOT_ROLL_TAKE_LOSS
 *   - 0 < net < pennyFrac·closeCost → ROLL_FOR_PENNIES (allowed, but warned — extending risk
 *                                     for a sliver of credit usually isn't worth it)
 *   - else                        → ROLL_OK
 * Pure. Doesn't change basis/breakeven math — only maps an already-computed net to a verdict.
 */

/** A positive roll netting less than this share of the close cost is "rolling for pennies". theta's value (its user, 2026-06-17); the option-ta user confirmed it on 2026-11-17. */
export const ROLL_PENNY_FRACTION = 0.1;

export type RollCreditVerdict = "ROLL_OK" | "ROLL_FOR_PENNIES" | "DO_NOT_ROLL_TAKE_LOSS";

export interface RollCreditResult {
	/** The net cash of the roll (open credit − close cost), echoed for the caller. */
	net_credit: number;
	verdict: RollCreditVerdict;
	reason: string;
}

function usd(n: number): string {
	const sign = n < 0 ? "−" : "";
	return `${sign}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

/**
 * Gate a contemplated roll by its net cash. `netCredit` = open credit − close cost (same
 * sign convention as find_roll_candidates' net_cash / plan_block_roll's net). `closeCost` =
 * the debit to buy back the current leg (used only for the pennies threshold). `pennyFrac`
 * defaults to 0.10 (a roll netting < 10% of the close cost is "rolling for pennies").
 */
export function rollCreditGate(
	netCredit: number,
	closeCost: number,
	pennyFrac = ROLL_PENNY_FRACTION,
): RollCreditResult {
	if (netCredit <= 0) {
		return {
			net_credit: netCredit,
			verdict: "DO_NOT_ROLL_TAKE_LOSS",
			reason: `roll 净额 ${usd(netCredit)} ≤ 0(付 debit / 打平)— 该认亏 / 接货,不 roll(rolling a debit = throwing good money after bad)`,
		};
	}
	if (closeCost > 0 && netCredit < pennyFrac * closeCost) {
		return {
			net_credit: netCredit,
			verdict: "ROLL_FOR_PENNIES",
			reason: `净 credit ${usd(netCredit)} < ${Math.round(pennyFrac * 100)}% of close cost ${usd(closeCost)} — rolling for pennies,延展风险通常不值;可 roll 但先确认值得`,
		};
	}
	return {
		net_credit: netCredit,
		verdict: "ROLL_OK",
		reason: `净 credit ${usd(netCredit)} > 0(且非 pennies)`,
	};
}
