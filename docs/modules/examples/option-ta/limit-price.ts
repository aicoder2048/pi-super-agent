// 出处：theta app/src/lib/limit-price.ts @ 6f43df0b82d3755724208859b5ccfb7f280c611b
/**
 * limit-price.ts — 期权建议限价(adv-recommended-limit-price,用户立项 2026-07-02)。
 *
 * ADV 报价除 mid 外给一个「大概率成交又不白让钱」的限价建议。craft:
 * 限价单从 mid 向成交方向让步,让多少取决于 spread 相对宽度 ——
 *   - tight(spread ≤5% of mid):penny 级市场,mid 常能成交 → 不让。
 *   - normal(≤15%):让 25% 的 half-spread。
 *   - wide(>15%):流动性差,让 40% 的 half-spread。
 * sell(STO,要 credit)向 bid 让;buy(BTC,付 debit)向 ask 让。
 * tick 取整(US 期权惯例近似:premium ≥$3 → $0.05,以下 $0.01;可 override),
 * 最终夹取回 [bid, ask]。
 *
 * 边界:这是**执行价建议**,不是交易信号 —— 方向/张数/strike 由既有流程与人定。
 * 守卫:crossed / bid≤0 / 非有限 → null(无真实市场时不臆造一个数)。
 *
 * 多腿 net 模式(limit-price-multileg-net):roll / 价差实际以**一张 net 单票**下单,
 * 复杂单执行成本低于逐腿(Li/Musto/Pearson SSRN 4389665)→ `recommendNetLimitPrice`
 * 对整组腿算一个 net 限价,逐腿 mid 仍保留在 perLeg(叠加,不替换逐腿口径)。
 *
 * frictionPctOfMid = halfSpread / |mid|:quoted half-spread 是**上界**,实付 effective
 * 常更低(Muravyev & Pearson SSRN 2580548)。客观事实字段,不判有利/不利。
 */

export type LimitSide = "sell" | "buy";

export interface LimitPriceRec {
	/** 建议限价($/share,tick 取整、[bid,ask] 内)。 */
	limit: number;
	/** 参考 mid($/share)。 */
	mid: number;
	/** spread 相对宽度 = (ask − bid) / mid。 */
	spreadPct: number;
	band: "tight" | "normal" | "wide";
	/** 一句话理由(渲染进 ADV 用)。 */
	rationale: string;
	/** 摩擦占比 = half-spread / |mid|(quoted 上界口径)。 */
	frictionPctOfMid: number;
}

/** 分档让步比例(占 half-spread)。 */
function concession(spreadPct: number): { band: LimitPriceRec["band"]; k: number } {
	if (spreadPct <= 0.05) return { band: "tight", k: 0 };
	if (spreadPct <= 0.15) return { band: "normal", k: 0.25 };
	return { band: "wide", k: 0.4 };
}

/** US 期权 tick 近似:≥$3 → $0.05,以下 $0.01。 */
function defaultTick(price: number): number {
	return price >= 3 ? 0.05 : 0.01;
}

export function recommendLimitPrice(params: {
	bid: number;
	ask: number;
	side: LimitSide;
	/** 覆盖默认 tick(如 penny-program 全档 0.01)。 */
	tick?: number;
}): LimitPriceRec | null {
	const { bid, ask, side } = params;
	if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
	if (bid <= 0 || ask <= 0 || bid > ask) return null; // 无真实买盘 / crossed → 不臆造

	const mid = (bid + ask) / 2;
	const half = (ask - bid) / 2;
	const spreadPct = mid > 0 ? (ask - bid) / mid : 0;
	const { band, k } = concession(spreadPct);

	const raw = side === "sell" ? mid - k * half : mid + k * half;
	const tick = params.tick ?? defaultTick(mid);
	// nearest-tick 取整后夹回 [bid, ask](粗 tick 可能越界)。
	const rounded = Math.round(raw / tick) * tick;
	const limit = Number(Math.min(ask, Math.max(bid, rounded)).toFixed(4));

	const pct = (spreadPct * 100).toFixed(1);
	const rationale =
		band === "tight"
			? `spread ${pct}%(tight)→ mid 附近可成交,限价 = mid`
			: `spread ${pct}%(${band})→ 从 mid 向${side === "sell" ? " bid" : " ask"} 让 ${(k * 100).toFixed(0)}% half-spread 换成交概率`;

	return {
		limit,
		mid: Number(mid.toFixed(4)),
		spreadPct: Number(spreadPct.toFixed(4)),
		band,
		rationale,
		frictionPctOfMid: Number((mid > 0 ? half / mid : 0).toFixed(4)),
	};
}

export interface NetLeg {
	bid: number;
	ask: number;
	/** sell = 收 credit(net 里记 +),buy = 付 debit(记 −)。 */
	side: LimitSide;
	/** 腿比例(缺省 1)。 */
	ratio?: number;
}

export interface NetLimitPriceRec {
	/** 建议 net 限价($/share,有符号:+ = 收 net credit,− = 付 net debit)。 */
	netLimit: number;
	/** net mid = Σ signed(mid_i × ratio_i)。 */
	netMid: number;
	/** net half-spread = Σ(half_i × ratio_i)—— 保守上界(假设每条腿都付各自 half)。 */
	netHalfSpread: number;
	/** = 2·netHalfSpread / |netMid|。 */
	spreadPct: number;
	band: LimitPriceRec["band"];
	direction: "credit" | "debit";
	/** 各腿按不利端合成的 net(夹取下界)。 */
	netWorst: number;
	/** 各腿按有利端合成的 net(夹取上界)。 */
	netBest: number;
	frictionPctOfMid: number;
	rationale: string;
	perLeg: Array<{ side: LimitSide; ratio: number; bid: number; ask: number; mid: number }>;
}

export function recommendNetLimitPrice(params: {
	legs: NetLeg[];
	/** 覆盖默认 tick(对 |net mid| 取默认)。 */
	tick?: number;
}): NetLimitPriceRec | null {
	const { legs } = params;
	if (!Array.isArray(legs) || legs.length === 0) return null;

	let netMid = 0;
	let netHalf = 0;
	let netWorst = 0;
	let netBest = 0;
	const perLeg: NetLimitPriceRec["perLeg"] = [];
	for (const leg of legs) {
		const { bid, ask, side } = leg;
		const ratio = leg.ratio ?? 1;
		// 任一腿无真实市场 → 整组不臆造
		if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
		if (bid <= 0 || ask <= 0 || bid > ask) return null;
		if (!Number.isFinite(ratio) || ratio <= 0) return null;
		const mid = (bid + ask) / 2;
		const sign = side === "sell" ? 1 : -1;
		netMid += sign * mid * ratio;
		netHalf += ((ask - bid) / 2) * ratio;
		// sell 腿最差成交在 bid、最好在 ask;buy 腿反之
		netWorst += side === "sell" ? bid * ratio : -ask * ratio;
		netBest += side === "sell" ? ask * ratio : -bid * ratio;
		perLeg.push({ side, ratio, bid, ask, mid: Number(mid.toFixed(4)) });
	}

	const absMid = Math.abs(netMid);
	const tick = params.tick ?? defaultTick(absMid);
	// 平价 roll(|net| < 1 tick):spreadPct 分母无意义,宁缺
	if (absMid < tick) return null;

	const spreadPct = (2 * netHalf) / absMid;
	const { band, k } = concession(spreadPct);
	// 收 credit 向少收让 / 付 debit 向多付让 —— 有符号口径下都是 net 往下让
	const raw = netMid - k * netHalf;
	const rounded = Math.round(raw / tick) * tick;
	const netLimit = Number(Math.min(netBest, Math.max(netWorst, rounded)).toFixed(4));
	const direction = netMid > 0 ? "credit" : "debit";

	const pct = (spreadPct * 100).toFixed(1);
	const rationale =
		band === "tight"
			? `net spread ${pct}%(tight)→ net mid 附近可成交,限价 = net mid`
			: `net spread ${pct}%(${band})→ 从 net mid 向${direction === "credit" ? "少收" : "多付"}让 ${(k * 100).toFixed(0)}% net half-spread 换成交概率`;

	return {
		netLimit,
		netMid: Number(netMid.toFixed(4)),
		netHalfSpread: Number(netHalf.toFixed(4)),
		spreadPct: Number(spreadPct.toFixed(4)),
		band,
		direction,
		netWorst: Number(netWorst.toFixed(4)),
		netBest: Number(netBest.toFixed(4)),
		frictionPctOfMid: Number((netHalf / absMid).toFixed(4)),
		rationale,
		perLeg,
	};
}
