// 出处：theta app/src/lib/iv-history.ts @ 404254dee0078bfe8a35d7efdbf3c949bde9bfe7（只取 selectAtmContract、ivRank、ivPercentile；buildIvSeries 吃 theta 回测数据，不搬。ContractData 出自 app/src/backtest/types.ts，dteOn 出自 app/src/backtest/entry.ts 和 app/src/positions.ts 的 dteFrom）
/** One option contract's daily closes. A missing day means no trade that day. */
export interface ContractData {
	ticker: string;
	strike: number;
	/** YYYY-MM-DD */
	expiration: string;
	/** trading day → close (per share). */
	bars: Record<string, number>;
}

/** Calendar days from `date` to `expiration`, both YYYY-MM-DD, in UTC. */
export function dteOn(date: string, expiration: string): number {
	return Math.round((Date.parse(`${expiration}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
}

/** Tenor band for the "front-month-ish" ATM series (matches the live
 *  fetch_front_month_atm_iv window in get_volatility.py). */
export const IV_SERIES_TENOR = { min: 21, max: 45 };

/**
 * Pick the contract whose IV represents the day: nearest expiration inside
 * the tenor band, then the strike closest to spot WITH a trade that day.
 * Deterministic: ties break to the lower strike.
 */
export function selectAtmContract(
	contracts: ContractData[],
	date: string,
	spot: number,
	tenor: { min: number; max: number } = IV_SERIES_TENOR,
): ContractData | null {
	const candidates = contracts.filter((c) => {
		const dte = dteOn(date, c.expiration);
		return dte >= tenor.min && dte <= tenor.max && c.bars[date] != null;
	});
	if (candidates.length === 0) return null;
	const nearestExp = candidates.map((c) => c.expiration).sort()[0]!;
	const atExp = candidates.filter((c) => c.expiration === nearestExp);
	atExp.sort((a, b) => {
		const d = Math.abs(a.strike - spot) - Math.abs(b.strike - spot);
		return d !== 0 ? d : a.strike - b.strike;
	});
	return atExp[0]!;
}

/** IV rank: (current − min) / (max − min) over the window. Sensitive to a
 *  single spike — report it WITH the percentile, never alone. */
export function ivRank(current: number, series: number[]): number | null {
	if (series.length < 2) return null;
	const lo = Math.min(...series);
	const hi = Math.max(...series);
	if (hi - lo < 1e-12) return null;
	return Math.min(1, Math.max(0, (current - lo) / (hi - lo)));
}

/** IV percentile: share of window days strictly below current — robust to
 *  spikes (one outlier shifts it by 1/n, not by rescaling the range). */
export function ivPercentile(current: number, series: number[]): number | null {
	if (series.length === 0) return null;
	return series.filter((v) => v < current).length / series.length;
}
