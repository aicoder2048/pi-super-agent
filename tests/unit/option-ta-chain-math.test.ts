import assert from "node:assert/strict";
import test from "node:test";
import { assignmentTouchProb, DEFAULT_EXTRINSIC_FLOORS, exDivCallVerdict, extrinsicGauge, putCarryCostVerdict } from "../../docs/modules/examples/option-ta/assignment-risk.ts";
import { classifyDeliverable, coverableContracts } from "../../docs/modules/examples/option-ta/contract-deliverable.ts";
import { IV_SERIES_TENOR, ivPercentile, ivRank, selectAtmContract, type ContractData } from "../../docs/modules/examples/option-ta/iv-history.ts";
import { gexContribution, netGammaWalls } from "../../docs/modules/examples/option-ta/net-gamma-walls.ts";
import { maxPain, oiTermStructure } from "../../docs/modules/examples/option-ta/oi-term-structure.ts";
import { bsPutPrice, bsShortPutAssignProb } from "../../docs/modules/examples/option-ta/options-math.ts";
import { DTE_MAX, NEAR_PCT, pinRiskCheck } from "../../docs/modules/examples/option-ta/pin-risk-check.ts";
import { classifyIvHvRatio, hv20, IV_HV_BANDS } from "../../docs/modules/examples/option-ta/vol-regime.ts";

const near = (actual: number | null | undefined, expected: number, eps = 1e-9) =>
	assert.ok(actual != null && Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)), `expected ${expected} ± ${eps}, got ${actual}`);

test("GEX 墙：put 墙只在正股价下方，call 墙只在上方", () => {
	near(gexContribution(0.01, 1000, 100), 1e7);
	assert.equal(gexContribution(0.02, null, 100), 0);
	const res = netGammaWalls({
		spot: 180,
		calls: [
			{ strike: 200, gamma: 0.02, open_interest: 2000 },
			{ strike: 220, gamma: 0.01, open_interest: 1000 },
		],
		puts: [
			{ strike: 100, gamma: 0.02, open_interest: 3000 },
			{ strike: 95, gamma: 0.03, open_interest: 11000 },
			{ strike: 250, gamma: 0.05, open_interest: 99999 },
		],
	});
	assert.equal(res.put_wall?.strike, 95);
	assert.equal(res.call_wall?.strike, 200);
	assert.ok(res.net_gex < 0);
	assert.equal(res.regime, "negative/amplifying");
	assert.equal(res.spot_position, "between");
	assert.equal(res.confidence, "normal");
	assert.match(res.assumption, /dealer/i);
	const thin = netGammaWalls({ spot: 50, calls: [{ strike: 60, gamma: 0.02, open_interest: 400 }], puts: [{ strike: 40, gamma: 0.02, open_interest: 400 }] });
	assert.equal(thin.total_oi, 800);
	assert.match(thin.confidence, /low/i);
});

test("GEX 翻转点：累计净 GEX 由负转正的价位", () => {
	const legs = { calls: [{ strike: 160, gamma: 0.01, open_interest: 1000 }], puts: [{ strike: 140, gamma: 0.01, open_interest: 1000 }] };
	const below = netGammaWalls({ spot: 150, ...legs });
	near(below.gamma_flip, 160);
	assert.equal(below.spot_vs_flip, "below");
	assert.equal(netGammaWalls({ spot: 159, ...legs }).spot_vs_flip, "near");
	const none = netGammaWalls({ spot: 150, calls: legs.calls, puts: [] });
	assert.equal(none.gamma_flip, null);
	assert.equal(none.spot_vs_flip, null);
});

test("OI 期限结构：P/C 比、最大痛点、跨到期 OI 墙", () => {
	assert.equal(maxPain([{ strike: 100, open_interest: 20 }], [{ strike: 120, open_interest: 10 }]), 100);
	assert.equal(maxPain([], []), null);
	const ts = oiTermStructure(
		[
			{
				expiration: "E1",
				calls: [{ strike: 100, open_interest: 100, volume: 10 }],
				puts: [
					{ strike: 90, open_interest: 200, volume: 30 },
					{ strike: 100, open_interest: 50, volume: 5 },
				],
			},
			{
				expiration: "E2",
				calls: [{ strike: 100, open_interest: 50, volume: 0 }],
				puts: [
					{ strike: 90, open_interest: 100, volume: 0 },
					{ strike: 100, open_interest: 150, volume: 0 },
					{ strike: 110, open_interest: null, volume: null },
				],
			},
		],
		181.69,
	);
	const [e1, e2] = ts.by_expiry;
	assert.equal(e1!.put_oi, 250);
	assert.equal(e1!.call_oi, 100);
	assert.equal(e1!.pc_oi, 2.5);
	assert.equal(e1!.put_vol, 35);
	assert.equal(e1!.max_pain, 100);
	assert.equal(e2!.pc_oi, 5);
	assert.equal(e2!.put_oi, 250);
	const k90 = ts.aggregate_walls.find((w) => w.strike === 90)!;
	const k100 = ts.aggregate_walls.find((w) => w.strike === 100)!;
	assert.equal(k90.put_oi, 300);
	assert.deepEqual([k100.put_oi, k100.call_oi], [200, 150]);
	assert.equal(ts.top_put_walls[0]!.strike, 90);
	assert.equal(ts.spot, 181.69);
});

test("到期临近的门槛按说明书：到期日当天、离行权价不到 3%", () => {
	assert.equal(NEAR_PCT, 0.03);
	assert.equal(DTE_MAX, 0);
	const pinned = pinRiskCheck({ spot: 100, short_strike: 102, side: "call", dte: 0, oi_at_strike: 5000 });
	assert.equal(pinned.pin_risk, true);
	assert.equal(pinned.magnet, true);
	near(pinned.distance_pct, 0.02);
	assert.equal(pinRiskCheck({ spot: 100, short_strike: 97.1, side: "put", dte: 0, oi_at_strike: 0 }).pin_risk, true, "2.9% 算贴近");
	assert.equal(pinRiskCheck({ spot: 100, short_strike: 103, side: "call", dte: 0, oi_at_strike: 0 }).near_atm, false, "正好 3% 不算「不到 3%」");
	assert.equal(pinRiskCheck({ spot: 100, short_strike: 102, side: "call", dte: 1, oi_at_strike: 5000 }).pin_risk, false, "不是到期日");
	const lowOi = pinRiskCheck({ spot: 100, short_strike: 102, side: "call", dte: 0, oi_at_strike: 100 });
	assert.equal(lowOi.pin_risk && !lowOi.magnet, true);
	const share = pinRiskCheck({ spot: 100, short_strike: 102, side: "call", dte: 0, oi_at_strike: 800, total_chain_oi: 5000 });
	assert.equal(share.high_oi && share.magnet, true, "占全链 OI 一成以上算高 OI");
	assert.ok(pinned.note.length > 0);
});

test("交割物：没有证据按 100 股，声明或调整后缀才标非标准", () => {
	const bare = classifyDeliverable({ underlying: "NVDA" });
	assert.deepEqual([bare.shares_per_contract, bare.standard, bare.provenance, bare.flag], [100, true, "assumed_standard", null]);
	assert.equal(classifyDeliverable({ underlying: "NVDA", sharesPerContract: 100 }).provenance, "declared");
	assert.equal(coverableContracts(300).contracts, 3);
	assert.equal(coverableContracts(99).contracts, 0);
	assert.equal(coverableContracts(0).contracts, 0);
	const frac = classifyDeliverable({ underlying: "SNEX", sharesPerContract: 150 });
	assert.equal(frac.standard, false);
	assert.equal(frac.shares_per_contract, 150);
	assert.ok(frac.flag?.includes("150"));
	const refused = coverableContracts(300, frac);
	assert.equal(refused.contracts, null, "非标准交割物不折算张数");
	assert.equal(refused.flag, frac.flag);
	assert.equal(coverableContracts(1000, classifyDeliverable({ underlying: "BYND", sharesPerContract: 4 })).contracts, null);
	const bynd1 = classifyDeliverable({ underlying: "BYND", optionRoot: "BYND1" });
	assert.deepEqual([bynd1.standard, bynd1.provenance, bynd1.shares_per_contract], [false, "root_suffix_inferred", null]);
	assert.ok(bynd1.flag?.includes("BYND1"));
	assert.equal(classifyDeliverable({ underlying: "SNEX", optionRoot: "SNEX2" }).standard, false);
	assert.equal(classifyDeliverable({ underlying: "BYND", optionRoot: "BYND" }).standard, true);
	assert.equal(classifyDeliverable({ underlying: "SPX7", optionRoot: "SPX7" }).standard, true, "代码本身以数字结尾");
	assert.equal(classifyDeliverable({ underlying: "SPX7", optionRoot: "SPX71" }).standard, false);
	assert.equal(classifyDeliverable({ underlying: "NVDA", optionRoot: "BYND1" }).standard, true);
	for (const garbage of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(classifyDeliverable({ underlying: "NVDA", sharesPerContract: garbage }).provenance, "assumed_standard");
	}
	assert.equal(classifyDeliverable({ underlying: "", optionRoot: "1" }).standard, true);
});

test("剩余时间价值：提前指派的第一道指标", () => {
	const itm = extrinsicGauge("put", 95, 100, 6.2)!;
	near(itm.intrinsic, 5);
	near(itm.extrinsic, 1.2);
	near(itm.extrinsic_pct, 1.2 / 6.2);
	assert.equal(itm.low_extrinsic, false);
	near(extrinsicGauge("call", 108, 100, 8.3)!.extrinsic, 0.3);
	assert.equal(extrinsicGauge("put", 95, 100, null), null);
	assert.equal(extrinsicGauge("put", null, 100, 6.2), null);
	assert.equal(extrinsicGauge("put", 95, 100, 0), null);
	const stale = extrinsicGauge("put", 90, 100, 9.4)!;
	assert.equal(stale.extrinsic === 0 && stale.low_extrinsic, true);
	assert.equal(extrinsicGauge("put", 90, 100, 10.02)!.low_extrinsic, true, "低于 0.05 美元");
	assert.equal(extrinsicGauge("put", 71, 100, 30)!.low_extrinsic, true, "低于中间价的 5%");
	assert.equal(extrinsicGauge("put", 71, 100, 30, { abs: 0.05, pct: 0.02 })!.low_extrinsic, false);
	assert.deepEqual(DEFAULT_EXTRINSIC_FLOORS, { abs: 0.05, pct: 0.05 });
});

test("除息提前指派：股息高过剩余时间价值就是 high", () => {
	const base = { expiration: "2026-06-26", exDate: "2026-06-15", dividendPerShare: 0.77, extrinsic: 0.3 };
	assert.equal(exDivCallVerdict(base).verdict, "high");
	assert.equal(exDivCallVerdict({ ...base, extrinsic: 1.5 }).verdict, "watch");
	assert.equal(exDivCallVerdict({ ...base, extrinsic: 0.77 }).verdict, "watch");
	assert.equal(exDivCallVerdict({ ...base, exDate: "2026-07-02" }).verdict, "clear");
	assert.equal(exDivCallVerdict({ ...base, exDate: "2026-06-26" }).verdict, "high", "到期日当天除息也算");
	assert.equal(exDivCallVerdict({ ...base, exDate: null }).verdict, "clear");
	assert.equal(exDivCallVerdict({ ...base, dividendPerShare: null }).verdict, null);
	assert.equal(exDivCallVerdict({ ...base, extrinsic: null }).verdict, null);
});

test("put 持有成本：剩余时间价值低于 K×r×天数/365 就是 high", () => {
	const base = { strike: 100, dte: 30, shortRate: 0.05, extrinsic: 0.3 };
	assert.equal(putCarryCostVerdict(base).verdict, "high");
	near(putCarryCostVerdict(base).carryCost, 100 * 0.05 * (30 / 365));
	assert.equal(putCarryCostVerdict({ ...base, extrinsic: 0.5 }).verdict, "watch");
	assert.equal(putCarryCostVerdict({ ...base, shortRate: null }).verdict, null);
	assert.equal(putCarryCostVerdict({ ...base, shortRate: 0 }).verdict, null);
	assert.equal(putCarryCostVerdict({ ...base, extrinsic: null }).verdict, null);
	const expiring = putCarryCostVerdict({ strike: 100, dte: 0, shortRate: 0.05, extrinsic: 0.01 });
	assert.equal(expiring.verdict, "watch");
	near(expiring.carryCost, 0);
});

test("触及行权价概率：价外按首达公式，价内或平值是 1", () => {
	near(assignmentTouchProb("put", 100, 95, 0.4, 7), 0.35446, 1e-5);
	near(assignmentTouchProb("call", 100, 110, 0.3, 14), 0.104764, 1e-5);
	near(assignmentTouchProb("put", 100, 90, 0.6, 21), 0.464115, 1e-5);
	assert.equal(assignmentTouchProb("put", 95, 100, 0.4, 7), 1);
	assert.equal(assignmentTouchProb("call", 112, 110, 0.3, 14), 1);
	assert.equal(assignmentTouchProb("put", 100, 100, 0.4, 7), 1);
	assert.ok(assignmentTouchProb("put", 100, 95, 0.4, 7)! >= bsShortPutAssignProb(100, 95, 0.4, 7));
	assert.equal(assignmentTouchProb("put", null, 95, 0.4, 7), null);
	assert.equal(assignmentTouchProb("put", 100, 95, null, 7), null);
	assert.equal(assignmentTouchProb("put", 100, 95, 0, 7), null);
});

const DAYS = ["2025-06-02", "2025-06-03", "2025-06-04", "2025-06-05", "2025-06-06", "2025-06-09", "2025-06-10"];
const dte = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const contract = (strike: number, expiration: string, skipDay?: string): ContractData => ({
	ticker: `FIXA-${strike}-${expiration}`,
	strike,
	expiration,
	bars: Object.fromEntries(DAYS.filter((d) => d !== skipDay).map((d) => [d, bsPutPrice(100, strike, 0.35, dte(d, expiration))])),
});

test("选平值合约：期限带内最近的到期日，当天有成交、离正股价最近的行权价", () => {
	assert.deepEqual(IV_SERIES_TENOR, { min: 21, max: 45 });
	const contracts = [contract(95, "2025-07-03"), contract(100, "2025-07-03", "2025-06-04"), contract(105, "2025-07-03"), contract(100, "2025-07-18")];
	const pick = selectAtmContract(contracts, "2025-06-02", 100);
	assert.deepEqual([pick?.strike, pick?.expiration], [100, "2025-07-03"]);
	assert.equal(selectAtmContract(contracts, "2025-06-02", 100, { min: 40, max: 45 }), null);
	assert.equal(selectAtmContract(contracts, "2025-06-04", 100)?.strike, 95, "那天没成交就换最近的，平手取低行权价");
	assert.equal(selectAtmContract(contracts, "2025-06-02", 104)?.strike, 105);
	assert.equal(selectAtmContract([], "2025-06-02", 100), null);
});

test("IV rank 和百分位：rank 被尖峰压扁，百分位不会", () => {
	const calm = [0.3, 0.31, 0.32, 0.33, 0.34, 0.35, 0.36, 0.37, 0.38, 0.4];
	near(ivRank(0.35, calm), 0.5);
	near(ivPercentile(0.35, calm), 0.5);
	near(ivRank(0.45, calm), 1);
	const spiked = [...calm, 2.0];
	near(ivRank(0.36, spiked), (0.36 - 0.3) / (2.0 - 0.3));
	near(ivPercentile(0.36, spiked), 6 / 11);
	assert.equal(ivRank(0.3, [0.3]), null);
	assert.equal(ivRank(0.3, [0.3, 0.3]), null);
	assert.equal(ivPercentile(0.3, []), null);
});

test("HV20：最近 20 个对数收益的样本标准差 × √252，不够 21 个收盘价回 null", () => {
	const days = Array.from({ length: 21 }, (_, i) => `2025-06-${String(i + 1).padStart(2, "0")}`);
	const closes = Object.fromEntries(days.map((d, i) => [d, i % 2 === 0 ? 100 : 100 * Math.exp(0.05)]));
	const expected = 0.05 * Math.sqrt(20 / 19) * Math.sqrt(252);
	near(hv20(closes, days, days[20]!), expected);
	assert.equal(hv20(closes, days.slice(0, 10), days[9]!), null);
	const days41 = Array.from({ length: 41 }, (_, i) => `2025-07-${String(i + 1).padStart(2, "0")}`);
	const closes41 = Object.fromEntries(days41.map((d, i) => [d, i % 2 === 0 ? 100 : 100 * Math.exp(0.05)]));
	near(hv20(closes41, days41, days41[20]!), expected, 1e-9);
});

test("IV/HV 分档：0.85、1.0、1.15、1.4", () => {
	assert.deepEqual(IV_HV_BANDS, { cheap: 0.85, slightlyCheap: 1.0, fair: 1.15, rich: 1.4 });
	assert.equal(classifyIvHvRatio(0.8, 1.0), "cheap");
	assert.equal(classifyIvHvRatio(0.9, 1.0), "slightly_cheap");
	assert.equal(classifyIvHvRatio(1.1, 1.0), "fair");
	assert.equal(classifyIvHvRatio(1.3, 1.0), "rich");
	assert.equal(classifyIvHvRatio(1.5, 1.0), "very_rich");
	assert.equal(classifyIvHvRatio(0.5, 0), null);
	assert.equal(classifyIvHvRatio(null, 1), null);
});
