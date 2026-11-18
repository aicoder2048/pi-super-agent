/**
 * Chain structure for tools/chain's oi, gex, max-pain and unusual-volume operations, on top of the theta ports net-gamma-walls.ts
 * and oi-term-structure.ts. Pure: it reads parsed chain rows and the underlying price. Every result is structure information,
 * not a trade signal, and says so.
 */
import type { ChainRow } from "./chain-rows.ts";
import { netGammaWalls, NEAR_FLIP_PCT, THIN_OI_THRESHOLD } from "./net-gamma-walls.ts";
import { oiTermStructure } from "./oi-term-structure.ts";

/** Walls listed by OI, each side. */
export const TOP_WALLS = 8;
/** GEX strikes shown around the underlying price; the walls and totals use every strike. */
export const GEX_STRIKES_SHOWN = 12;
/**
 * Unusual volume: today's volume at least this many times the open interest (OI is the previous session's close), and at least
 * UNUSUAL_MIN_VOLUME contracts so a 3-lot on a 1-lot OI does not count. Volume above OI means most of it cannot be closing
 * existing positions, the usual "unusual options activity" reading.
 */
export const UNUSUAL_VOLUME_OI_RATIO = 2;
export const UNUSUAL_MIN_VOLUME = 500;
export const UNUSUAL_TOP = 15;

const OI_NOTE = "未平仓量是前一交易日收盘后交易所公布的数，盘中不更新；只是持仓结构，不是交易信号";
const MAX_PAIN_NOTE = "最大痛点是到期时期权买方总赔付最少的行权价，只按未平仓量算；成交薄、上市不久的标的上不可靠，不是价格目标";
const GEX_NOTE =
	"GEX 的正负是模型估计：假设做市商整体是公众未平仓的对手方（卖出了公众买的期权），真实的做市商仓位看不到。call 墙是正股上方 call gamma 最集中的行权价，常被当作软阻力；put 墙是下方 put gamma 最集中的，常被当作软支撑，跌破后反而可能加速。只是结构信息，不是交易信号";
const VOLUME_NOTE = "成交量是这个交易日到取数时刻的累计；量比未平仓量大说明多半是新开仓，看不出是买是卖、开还是平，只是线索，不是信号";
const VOLUME_CLOSED_NOTE = "休市：成交量是上一个交易日的全天，未平仓可能已经含这一天的成交，「量比未平仓大」的意思弱一些；看不出是买是卖、开还是平，只是线索，不是信号";
/** netGammaWalls gives Γ × OI × 100 × S², the dollar delta change for a 100% move; reported per 1% move, the usual quoting. */
const PER_ONE_PERCENT = 0.01;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const pct = (from: number, to: number) => r4((to - from) / from);

function byExpiry(rows: readonly ChainRow[]) {
	const groups = new Map<string, { calls: ChainRow[]; puts: ChainRow[] }>();
	for (const row of rows) {
		const g = groups.get(row.expiry) ?? { calls: [], puts: [] };
		(row.right === "call" ? g.calls : g.puts).push(row);
		groups.set(row.expiry, g);
	}
	return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([expiration, g]) => ({ expiration, ...g }));
}

const missingOi = (rows: readonly ChainRow[]) => rows.filter((r) => r.open_interest === null).length;

/** A max pain over no open interest is just the lowest strike; it is null instead. */
const painOf = (e: { put_oi: number; call_oi: number; max_pain: number | null }) => (e.put_oi + e.call_oi > 0 ? e.max_pain : null);

export function oiStructure(rows: readonly ChainRow[], spot: number | null) {
	const groups = byExpiry(rows);
	const t = oiTermStructure(groups, spot, Number.MAX_SAFE_INTEGER);
	const callVolume = new Map(groups.map((g) => [g.expiration, g.calls.reduce((a, r) => a + (r.volume ?? 0), 0)]));
	const side = (w: { strike: number; put_oi: number; call_oi: number }) => ({ strike: w.strike, put_oi: w.put_oi, call_oi: w.call_oi, vs_spot: spot === null ? null : pct(spot, w.strike) });
	// Like gex's walls: support is put OI at or below the underlying, resistance call OI at or above it. Without a price, none.
	const below = spot === null ? [] : t.aggregate_walls.filter((w) => w.strike <= spot && w.put_oi > 0).sort((a, b) => b.put_oi - a.put_oi || b.strike - a.strike);
	const above = spot === null ? [] : t.aggregate_walls.filter((w) => w.strike >= spot && w.call_oi > 0).sort((a, b) => b.call_oi - a.call_oi || a.strike - b.strike);
	return {
		by_expiry: t.by_expiry.map((e) => ({ expiry: e.expiration, put_oi: e.put_oi, call_oi: e.call_oi, pc_oi: e.pc_oi === null ? null : r4(e.pc_oi), put_volume: e.put_vol, call_volume: callVolume.get(e.expiration) ?? 0, max_pain: painOf(e) })),
		put_walls_below: below.slice(0, TOP_WALLS).map(side),
		call_walls_above: above.slice(0, TOP_WALLS).map(side),
		rows_without_oi: missingOi(rows),
		note: OI_NOTE,
	};
}

export function maxPainByExpiry(rows: readonly ChainRow[], spot: number | null) {
	const t = oiTermStructure(byExpiry(rows), spot, TOP_WALLS);
	return {
		by_expiry: t.by_expiry.map((e) => ({
			expiry: e.expiration,
			max_pain: painOf(e),
			vs_spot: painOf(e) === null || spot === null ? null : pct(spot, painOf(e)!),
			put_oi: e.put_oi,
			call_oi: e.call_oi,
		})),
		rows_without_oi: missingOi(rows),
		note: MAX_PAIN_NOTE,
	};
}

const REGIME = { "positive/stabilizing": "正 gamma：做市商对冲倾向压住波动", "negative/amplifying": "负 gamma：做市商对冲倾向放大波动" } as const;
const POSITION = { between: "在 put 墙和 call 墙之间", below_put_wall: "跌破 put 墙", above_call_wall: "涨过 call 墙", unknown: "没有墙可比" } as const;
const VS_FLIP = { above: "在翻转点上方", below: "在翻转点下方", near: `离翻转点不到 ${NEAR_FLIP_PCT * 100}%` } as const;

export function gexStructure(rows: readonly ChainRow[], spot: number) {
	const gammaRow = (r: ChainRow) => ({ strike: r.strike, gamma: r.gamma, open_interest: r.open_interest });
	const g = netGammaWalls({ spot, calls: rows.filter((r) => r.right === "call").map(gammaRow), puts: rows.filter((r) => r.right === "put").map(gammaRow) });
	const near = [...g.by_strike].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.strike - b.strike).slice(0, GEX_STRIKES_SHOWN).sort((a, b) => a.strike - b.strike);
	const usd = (n: number) => Math.round(n * PER_ONE_PERCENT);
	const wall = (w: { strike: number; gex: number } | null) => (w === null ? null : { strike: w.strike, gex: usd(w.gex), vs_spot: pct(spot, w.strike) });
	// No row with both a gamma and open interest: there is no exposure to sign, not a negative one.
	const measured = g.by_strike.some((s) => s.call_gex !== 0 || s.put_gex !== 0);
	return {
		call_wall: wall(g.call_wall),
		put_wall: wall(g.put_wall),
		net_gex: usd(g.net_gex),
		regime: measured ? REGIME[g.regime] : null,
		spot_position: POSITION[g.spot_position],
		gamma_flip: g.gamma_flip === null ? null : r2(g.gamma_flip),
		spot_vs_flip: g.spot_vs_flip === null ? null : VS_FLIP[g.spot_vs_flip],
		total_oi: g.total_oi,
		confidence: !measured ? "低：没有同时带 gamma 和未平仓的合约，GEX 算不出来" : g.total_oi < THIN_OI_THRESHOLD ? `低：未平仓合计 ${g.total_oi} 张，不到 ${THIN_OI_THRESHOLD}，墙和 GEX 参考价值有限` : "一般",
		near_spot: near.map((s) => ({ strike: s.strike, call_gex: usd(s.call_gex), put_gex: usd(s.put_gex), net: usd(s.net) })),
		rows_without_gamma: rows.filter((r) => r.gamma === null).length,
		gamma_self_computed: rows.filter((r) => r.gamma !== null && r.greeks_source === "自算").length,
		rows_without_oi: missingOi(rows),
		note: GEX_NOTE,
	};
}

export function unusualVolume(rows: readonly ChainRow[], market: "盘中" | "休市") {
	const hits = rows.flatMap((r) => {
		// A missing open interest is missing data, not a new contract: it is counted, not judged.
		const oi = r.open_interest;
		if (r.volume === null || oi === null || r.volume < UNUSUAL_MIN_VOLUME || r.volume < oi * UNUSUAL_VOLUME_OI_RATIO) return [];
		return [{ contract: r.contract, right: r.right, strike: r.strike, expiry: r.expiry, volume: r.volume, open_interest: oi, volume_oi: oi === null || oi === 0 ? null : r2(r.volume / oi), mid: r.mid, iv: r.iv, iv_source: r.iv_source, delta: r.delta }];
	});
	hits.sort((a, b) => b.volume - a.volume || a.contract.localeCompare(b.contract));
	return {
		threshold: { volume_oi: UNUSUAL_VOLUME_OI_RATIO, min_volume: UNUSUAL_MIN_VOLUME },
		contracts: hits.slice(0, UNUSUAL_TOP),
		more: Math.max(0, hits.length - UNUSUAL_TOP),
		rows_without_volume: rows.filter((r) => r.volume === null).length,
		rows_without_oi: missingOi(rows),
		note: market === "休市" ? VOLUME_CLOSED_NOTE : VOLUME_NOTE,
	};
}
