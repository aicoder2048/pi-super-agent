// 出处：theta app/src/backtest/vol-regime.ts @ 404254dee0078bfe8a35d7efdbf3c949bde9bfe7（只取 hv20、classifyIvHvRatio；分档写成命名常量 IV_HV_BANDS）
/**
 * Upper bounds (exclusive) of each IV/HV ratio class. theta had 0.85 / 1.0 / 1.15 / 1.4; they now follow the user's WatchAndLearn
 * notes (knowledge/vol-regime): under 0.8 cheap, about 1 fair, above 1.2 rich, 2 extreme. 0.95 splits "about 1" from slightly cheap.
 */
export const IV_HV_BANDS = { cheap: 0.8, slightlyCheap: 0.95, fair: 1.2, rich: 2.0 } as const;

/**
 * The four quadrants of the notes need "is IV high or low": both the one-year IV percentile and IV/HV20 must agree. Rich is the
 * notes' percentile above 80 with IV/HV at least 1.2; cheap mirrors it at percentile 20 and IV/HV under 0.8.
 */
export const RICH_PERCENTILE = 0.8;
export const RICH_RATIO = IV_HV_BANDS.fair;
export const CHEAP_PERCENTILE = 0.2;
export const CHEAP_RATIO = IV_HV_BANDS.cheap;

export type Quadrant = "偏贵" | "偏便宜" | "中间" | "信号不一致";

/** null when either input is missing. */
export function ivQuadrant(percentile: number | null, ratio: number | null): Quadrant | null {
	if (percentile === null || ratio === null) return null;
	const high = [percentile >= RICH_PERCENTILE, ratio >= RICH_RATIO];
	const low = [percentile <= CHEAP_PERCENTILE, ratio < CHEAP_RATIO];
	if (high.every(Boolean)) return "偏贵";
	if (low.every(Boolean)) return "偏便宜";
	if ((high[0] && low[1]) || (low[0] && high[1])) return "信号不一致";
	return "中间";
}

/** What the notes say each quadrant means for a buyer and a seller; information, not an order. */
export const QUADRANT_HINT: Record<Quadrant, string> = {
	偏贵: "期权偏贵：偏卖方的环境，卖要分批、带保护（比如价差）；买方避免，一定要买就用价差",
	偏便宜: "期权偏便宜：偏买方的环境，买远月、平值附近；卖方避免，收的权利金太少",
	中间: "不贵不便宜：按方向和事件选结构",
	信号不一致: "IV 分位和 IV/HV 一个说贵一个说便宜：先看是不是事件（财报）或最近一段异常波动拉偏了其中一个",
};

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
