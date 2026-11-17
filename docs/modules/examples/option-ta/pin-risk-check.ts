// 出处：theta app/src/lib/pin-risk-check.ts @ 404254dee0078bfe8a35d7efdbf3c949bde9bfe7（门槛换成 option-ta 说明书的：到期日当天、离行权价不到 3%；OI 门槛仍是 theta 的）
/**
 * pin-risk-check — flags a short option leg at PIN RISK into expiration. Pure —
 * no I/O. Informational risk flag, NOT a trade signal, does NOT place orders.
 *
 * Pin risk (digest 2026-06-20 早指派/pin-risk):
 *   - A short leg closing right AT/NEAR its strike at expiration → assignment is
 *     UNCERTAIN (OCC Exercise-by-Exception auto-exercises ≥$0.01 ITM, but
 *     after-hours moves + the long holder's manual exercise/abandon make the
 *     outcome flip) → you can wake up with an unexpected, UNHEDGED stock
 *     position + weekend gap risk.
 *   - High open interest at the strike AMPLIFIES the pin (stocks cluster at
 *     high-OI strikes at expiration — MM delta-hedge rebalancing; Ni-Pearson-
 *     Poteshman 2004).
 *
 * Orthogonal to check_assignment_risk (continuous BS prob) and ex-div-call-check
 * (ex-dividend early assignment): this one is the discrete expiration-day
 * near-ATM uncertainty + the OI-magnet.
 */

/** |spot − strike| / spot below this → "near the money". option-ta spec: under 3% on expiration day (theta: at or below 1.5%). */
export const NEAR_PCT = 0.03;
/** dte at or below this → "expiring". option-ta spec checks on expiration day only (theta: 2). */
export const DTE_MAX = 0;
/** Absolute OI at the strike at or above this → high OI. */
export const OI_ABS = 1000;
/** OI at strike as a fraction of total-chain OI at or above this → high OI. */
export const OI_FRAC = 0.1;

export interface PinRiskInput {
	spot: number;
	short_strike: number;
	side: "put" | "call";
	dte: number;
	oi_at_strike: number | null;
	/** Optional total OI across the chain — enables the relative-OI branch. */
	total_chain_oi?: number | null;
}

export interface PinRiskResult {
	pin_risk: boolean;
	magnet: boolean;
	near_atm: boolean;
	expiring: boolean;
	high_oi: boolean;
	distance_pct: number;
	note: string;
}

const num = (x: number | null | undefined): number =>
	x == null || Number.isNaN(x) ? 0 : x;

export function pinRiskCheck(input: PinRiskInput): PinRiskResult {
	const { spot, short_strike, side, dte } = input;
	const oi = num(input.oi_at_strike);
	const total = num(input.total_chain_oi);

	const distance_pct = spot > 0 ? Math.abs(spot - short_strike) / spot : Infinity;
	const near_atm = distance_pct < NEAR_PCT;
	const expiring = dte <= DTE_MAX;
	const high_oi = oi >= OI_ABS || (total > 0 && oi / total >= OI_FRAC);

	const pin_risk = near_atm && expiring;
	const magnet = pin_risk && high_oi;

	const note = pin_risk
		? `pin risk: short ${side} 贴 strike(${(distance_pct * 100).toFixed(1)}% from spot)进到期(${dte}d)→ 指派不确定(OCC ≥$0.01 ITM 自动行权 + 盘后可翻 + 多头手动行权/弃权)+ 周末跳空风险${magnet ? ";high-OI strike 易被钉(pinning)" : ""}。`
		: `no pin risk(near_atm=${near_atm} expiring=${expiring})。`;

	return { pin_risk, magnet, near_atm, expiring, high_oi, distance_pct, note };
}
