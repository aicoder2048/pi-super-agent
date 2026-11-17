// 出处：theta app/src/tools/check-assignment-risk.ts @ 807317a4624856c625fb1b35647b4b390175fe2a（只取 assignmentTouchProb、extrinsicGauge、exDivCallVerdict、putCarryCostVerdict 四个纯函数；文件其余部分读 theta 的持仓和 Python sidecar，不搬）
import { touchProbFirstPassage } from "./first-passage.ts";

/** Default low-extrinsic floors: < $0.05/share OR < 5% of mid → flag. */
export const DEFAULT_EXTRINSIC_FLOORS = { abs: 0.05, pct: 0.05 };

export interface ExtrinsicGauge {
	intrinsic: number;
	/** max(0, mid − intrinsic) — remaining time value per share. */
	extrinsic: number;
	/** extrinsic / mid. */
	extrinsic_pct: number;
	/** Early exercise no longer burns meaningful time value. */
	low_extrinsic: boolean;
}

/**
 * P(spot touches the strike before expiry). Same σ and T = DTE/365 as the row's
 * P_BS, so P_touch ≥ P_BS holds on identical inputs. The shared formula is
 * distance-symmetric and blind to direction, so a strike already crossed
 * (ITM) or sat on (ATM) is a certain touch.
 */
export function assignmentTouchProb(
	side: "put" | "call",
	spot: number | null,
	strike: number,
	iv: number | null,
	dte: number,
): number | null {
	if (spot == null || !(spot > 0) || iv == null || !(iv > 0)) return null;
	const crossedOrAt = side === "put" ? spot <= strike : spot >= strike;
	if (crossedOrAt) return 1;
	return touchProbFirstPassage(spot, strike, iv, dte / 365);
}

/**
 * Remaining extrinsic value — the first-order EARLY-assignment gauge
 * (tastylive/OCC: "more extrinsic → less likely assigned"; the at-expiry
 * P_BS answers a different question). Pure; exported for the smoke.
 * Null when spot/mid are unusable — degrade, never NaN.
 */
export function extrinsicGauge(
	side: "put" | "call",
	spot: number | null,
	strike: number,
	mid: number | null,
	floors: { abs: number; pct: number } = DEFAULT_EXTRINSIC_FLOORS,
): ExtrinsicGauge | null {
	if (spot == null || !Number.isFinite(spot) || spot <= 0) return null;
	if (mid == null || !Number.isFinite(mid) || mid <= 0) return null;
	const intrinsic = side === "put" ? Math.max(0, strike - spot) : Math.max(0, spot - strike);
	const extrinsic = Math.max(0, mid - intrinsic);
	const extrinsicPct = extrinsic / mid;
	return {
		intrinsic,
		extrinsic,
		extrinsic_pct: extrinsicPct,
		low_extrinsic: extrinsic < floors.abs || extrinsicPct < floors.pct,
	};
}

export type ExDivVerdictTag = "high" | "watch" | "clear";

/**
 * Dividend early-assignment rule for ITM short calls (tastylive/OCC): when
 * an ex-div lands before (or ON — exercising the night before still captures
 * it) the option's expiration AND the dividend exceeds remaining extrinsic,
 * early exercise is RATIONAL for the holder → assignment risk is high.
 * Pure; exported for the smoke. Missing dividend amount or extrinsic →
 * verdict null (caller degrades to the old "check the calendar" hint —
 * never false-flag on absent data).
 */
export function exDivCallVerdict(input: {
	expiration: string;
	exDate: string | null;
	dividendPerShare: number | null;
	extrinsic: number | null;
}): { verdict: ExDivVerdictTag | null; reason: string } {
	const { expiration, exDate, dividendPerShare, extrinsic } = input;
	if (exDate == null) return { verdict: "clear", reason: "no upcoming ex-dividend" };
	if (exDate > expiration) return { verdict: "clear", reason: `next ex-div ${exDate} is after expiry ${expiration}` };
	if (dividendPerShare == null || !Number.isFinite(dividendPerShare)) {
		return { verdict: null, reason: `ex-div ${exDate} before expiry but dividend amount unavailable` };
	}
	if (extrinsic == null || !Number.isFinite(extrinsic)) {
		return { verdict: null, reason: `ex-div ${exDate} before expiry but extrinsic unavailable` };
	}
	if (dividendPerShare > extrinsic) {
		return {
			verdict: "high",
			reason: `dividend $${dividendPerShare.toFixed(2)} > extrinsic $${extrinsic.toFixed(2)} (ex-div ${exDate}) — early exercise is rational`,
		};
	}
	return {
		verdict: "watch",
		reason: `dividend $${dividendPerShare.toFixed(2)} ≤ extrinsic $${extrinsic.toFixed(2)} (ex-div ${exDate}) — recheck as extrinsic decays`,
	};
}

export type CarryCostVerdictTag = "high" | "watch";

/**
 * Carry-cost early-assignment rule for ITM short PUTS (CBOE/OCC) — the put-side
 * symmetric counterpart to exDivCallVerdict. A put holder's early-exercise
 * decision compares remaining extrinsic against the CARRY COST of holding the
 * strike in cash: `carry = strike × short_rate × DTE/365`. When extrinsic falls
 * below that carry cost, exercising NOW to free/earn interest on the strike cash
 * is rational → assignment risk is high. With rates at decade-highs this drives
 * deep-ITM put early exercise (CBOE "extrinsic vs carry cost on the strike").
 *
 * Pure; exported for the smoke. `shortRate` null/≤0 → verdict null (the caller
 * degrades to the fixed extrinsic floor — we NEVER fabricate a rate, same
 * injection discipline as net-liq). Missing extrinsic → null too. Note the
 * fixed extrinsic floor remains the catch-all; this adds the rate-aware
 * economic threshold when a rate IS supplied.
 */
export function putCarryCostVerdict(input: {
	strike: number;
	dte: number;
	shortRate: number | null;
	extrinsic: number | null;
}): { verdict: CarryCostVerdictTag | null; carryCost: number | null; reason: string } {
	const { strike, dte, shortRate, extrinsic } = input;
	if (shortRate == null || !Number.isFinite(shortRate) || shortRate <= 0) {
		return { verdict: null, carryCost: null, reason: "short_rate not provided — falling back to extrinsic floor" };
	}
	if (extrinsic == null || !Number.isFinite(extrinsic)) {
		return { verdict: null, carryCost: null, reason: "extrinsic unavailable" };
	}
	const carryCost = strike * shortRate * (Math.max(0, dte) / 365);
	if (extrinsic < carryCost) {
		return {
			verdict: "high",
			carryCost,
			reason: `extrinsic $${extrinsic.toFixed(2)} < carry cost $${carryCost.toFixed(2)} (K×r×DTE/365 @ ${pctUnsigned(shortRate, 1)}) — early exercise to capture interest is rational`,
		};
	}
	return {
		verdict: "watch",
		carryCost,
		reason: `extrinsic $${extrinsic.toFixed(2)} ≥ carry cost $${carryCost.toFixed(2)} (@ ${pctUnsigned(shortRate, 1)}) — recheck as extrinsic decays`,
	};
}

function pctUnsigned(n: number, digits = 1): string {
	return `${(n * 100).toFixed(digits)}%`;
}
