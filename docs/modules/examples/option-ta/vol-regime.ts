// 出处：theta app/src/backtest/vol-regime.ts @ 404254dee0078bfe8a35d7efdbf3c949bde9bfe7（只取 hv20、classifyIvHvRatio；分档写成命名常量 IV_HV_BANDS）
/** Upper bounds (exclusive) of each IV/HV ratio class; theta's thresholds, not yet confirmed by the user. */
export const IV_HV_BANDS = { cheap: 0.85, slightlyCheap: 1.0, fair: 1.15, rich: 1.4 } as const;

/**
 * Trailing annualized HV over `window` log returns ending at `asof` (inclusive).
 * Sample std (n−1) × √252. null until window+1 closes exist (no partial window).
 * Point-in-time: only days ≤ asof are used.
 */
export function hv20(
	underlying: Record<string, number>,
	tradingDays: string[],
	asof: string,
	window = 20,
): number | null {
	const closes = tradingDays
		.filter((d) => d <= asof)
		.map((d) => underlying[d])
		.filter((c): c is number => c != null && c > 0);
	if (closes.length < window + 1) return null;
	const rets: number[] = [];
	for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i]! / closes[i - 1]!));
	const w = rets.slice(-window);
	const mean = w.reduce((a, b) => a + b, 0) / w.length;
	const variance = w.reduce((a, b) => a + (b - mean) ** 2, 0) / (w.length - 1);
	return Math.sqrt(variance) * Math.sqrt(252);
}

/**
 * IV/HV ratio → variance-risk-premium class label. Same thresholds as python
 * get_volatility.classify_iv_hv_ratio. null when either input is missing or
 * HV ≤ 0 (→ caller falls back to the base hurdle, no overlay).
 */
export function classifyIvHvRatio(atmIv: number | null, hv: number | null): string | null {
	if (atmIv == null || hv == null || hv <= 0) return null;
	const r = atmIv / hv;
	if (r < IV_HV_BANDS.cheap) return "cheap";
	if (r < IV_HV_BANDS.slightlyCheap) return "slightly_cheap";
	if (r < IV_HV_BANDS.fair) return "fair";
	if (r < IV_HV_BANDS.rich) return "rich";
	return "very_rich";
}
