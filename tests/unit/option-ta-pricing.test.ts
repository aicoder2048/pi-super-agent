import assert from "node:assert/strict";
import test from "node:test";
import { touchProbFirstPassage } from "../../docs/modules/examples/option-ta/first-passage.ts";
import { impliedVolCall, impliedVolPut } from "../../docs/modules/examples/option-ta/iv.ts";
import {
	annualize,
	annualizeOrNull,
	BS_ASSUMPTIONS,
	bsCallPrice,
	bsPutPrice,
	bsShortCallAssignProb,
	bsShortPutAssignProb,
	normalCdf,
	spotForPremium,
} from "../../docs/modules/examples/option-ta/options-math.ts";

const near = (actual: number | null | undefined, expected: number, eps = 1e-9) =>
	assert.ok(actual != null && Math.abs(actual - expected) <= eps, `expected ${expected} ± ${eps}, got ${actual}`);

test("正态分布函数对得上查表值", () => {
	near(normalCdf(0), 0.5, 1e-7);
	near(normalCdf(0.1), 0.539827837277029, 1e-7);
	near(normalCdf(-1), 0.15865525393, 1e-7);
	near(normalCdf(1.96), 0.9750021048517795, 1e-7);
});

test("平值 BS 价格对得上教科书闭式解 S·(2N(σ√T/2)−1)，误差在正态近似的 1e-4 以内", () => {
	near(bsCallPrice(100, 100, 0.2, 365), 7.965567455405798, 1e-4);
	near(bsPutPrice(100, 100, 0.2, 365), 7.965567455405798, 1e-4);
});

test("利率和股息的假设写成常量：都是 0", () => {
	assert.deepEqual(BS_ASSUMPTIONS, { riskFreeRate: 0, dividendYield: 0 });
});

test("到期 0 天或 IV 0：价格等于内在价值", () => {
	assert.equal(bsCallPrice(110, 100, 0.3, 0), 10);
	assert.equal(bsPutPrice(90, 100, 0.3, 0), 10);
	assert.equal(bsCallPrice(90, 100, 0, 30), 0);
	assert.equal(bsPutPrice(90, 100, 0, 30), 10);
});

test("被指派概率：到期 0 天或 IV 0 时按价内价外给 0 或 1", () => {
	assert.equal(bsShortPutAssignProb(95, 100, 0.3, 0), 1);
	assert.equal(bsShortPutAssignProb(105, 100, 0, 30), 0);
	assert.equal(bsShortCallAssignProb(105, 100, 0.3, 0), 1);
	assert.equal(bsShortCallAssignProb(95, 100, 0, 30), 0);
});

test("被指派概率：S105 K100 IV40% 30 天的卖 put 是 N(−d2)", () => {
	near(bsShortPutAssignProb(105, 100, 0.4, 30), 0.3563914496637304, 1e-6);
	near(bsShortCallAssignProb(105, 100, 0.4, 30), 1 - 0.3563914496637304, 1e-6);
});

test("深度价内价外：价格不越界，概率贴近 0 和 1", () => {
	near(bsPutPrice(10, 100, 0.3, 30), 90, 1e-6);
	near(bsCallPrice(10, 100, 0.3, 30), 0, 1e-6);
	assert.ok(bsShortPutAssignProb(10, 100, 0.3, 30) > 0.999999);
	assert.ok(bsShortCallAssignProb(10, 100, 0.3, 30) < 1e-6);
});

test("年化：period × 365 ÷ 天数；资金或天数不为正时回 null", () => {
	near(annualize(0.02, 30), 0.02 * (365 / 30));
	assert.equal(annualizeOrNull(200, 10000, 0), null);
	assert.equal(annualizeOrNull(200, 10000, -3), null);
	assert.equal(annualizeOrNull(200, 0, 30), null);
	assert.equal(annualizeOrNull(200, -500, 30), null);
	assert.equal(annualizeOrNull(200, Number.NaN, 30), null);
	assert.equal(annualizeOrNull(200, 10000, 30), annualize(200 / 10000, 30));
});

test("put 反解 IV：往返还原，没有时间价值时回 null", () => {
	near(impliedVolPut(bsPutPrice(100, 97, 0.3, 11), 100, 97, 11), 0.3, 1e-6);
	near(impliedVolPut(bsPutPrice(90, 97, 0.6, 8), 90, 97, 8), 0.6, 1e-6);
	assert.equal(impliedVolPut(7, 90, 97, 8), null, "价格不高于内在价值");
	assert.equal(impliedVolPut(98, 100, 97, 8), null, "价格不低于行权价");
	assert.equal(impliedVolPut(1, 100, 97, 0), null, "到期 0 天");
	assert.equal(impliedVolPut(-1, 100, 97, 8), null, "负价格");
});

test("call 反解 IV：往返还原，没有时间价值或高过正股价时回 null", () => {
	near(impliedVolCall(bsCallPrice(100, 103, 0.3, 11), 100, 103, 11), 0.3, 1e-6);
	near(impliedVolCall(bsCallPrice(110, 97, 0.6, 8), 110, 97, 8), 0.6, 1e-6);
	assert.equal(impliedVolCall(13, 110, 97, 8), null, "价格不高于内在价值");
	assert.equal(impliedVolCall(111, 110, 97, 8), null, "价格不低于正股价");
	assert.equal(impliedVolCall(1, 100, 97, 0), null, "到期 0 天");
	assert.equal(impliedVolCall(Number.NaN, 100, 97, 8), null, "非数");
});

test("首达概率：d = 0.5、1、2 对得上 2·Φ(−d)", () => {
	const spot = 100;
	near(touchProbFirstPassage(spot, spot * Math.exp(0.05), 0.2, 0.25), 0.617075077451974, 1e-6);
	near(touchProbFirstPassage(spot, spot * Math.exp(0.1), 0.2, 0.25), 0.3173105078629141, 1e-6);
	near(touchProbFirstPassage(spot, spot * Math.exp(0.2), 0.2, 0.25), 0.0455002638963584, 1e-6);
	near(touchProbFirstPassage(spot, spot * Math.exp(-0.1), 0.2, 0.25), 0.3173105078629141, 1e-6);
	near(touchProbFirstPassage(spot, spot * Math.exp(0.1), 0.1, 1.0), 0.3173105078629141, 1e-6);
	near(touchProbFirstPassage(spot, spot * Math.exp(0.1), 0.4, 0.25), 0.617075077451974, 1e-6);
});

test("首达概率的退化情形", () => {
	const barrier = 100 * Math.exp(0.1);
	assert.equal(touchProbFirstPassage(100, 100, 0.2, 0.25), 1, "就在障碍上");
	assert.equal(touchProbFirstPassage(100, barrier, 0.2, 0), 0, "没有时间");
	assert.equal(touchProbFirstPassage(100, 100, 0.2, 0), 1);
	assert.equal(touchProbFirstPassage(100, barrier, 0, 0.25), 0, "没有波动");
	assert.equal(touchProbFirstPassage(0, barrier, 0.2, 0.25), 0, "正股价不为正");
});

function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}
const between = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);

function everyPoint(seed: number, point: (r: () => number) => string | undefined) {
	const r = lcg(seed);
	for (let i = 0; i < 250; i++) {
		const broken = point(r);
		assert.equal(broken, undefined, `点 ${i}: ${broken}`);
	}
}

test("put-call 平价（r=0）：C − P = S − K", () => {
	everyPoint(11, (r) => {
		const S = between(r, 5, 1000);
		const K = S * between(r, 0.5, 1.5);
		const iv = between(r, 0.05, 2.5);
		const dte = between(r, 1, 365);
		const lhs = bsCallPrice(S, K, iv, dte) - bsPutPrice(S, K, iv, dte);
		return Math.abs(lhs - (S - K)) <= 1e-7 * (S + K) ? undefined : `S=${S} K=${K} iv=${iv} dte=${dte} lhs=${lhs}`;
	});
});

test("单调：call 随正股价升、put 随正股价降，两者随 IV 和期限升", () => {
	everyPoint(13, (r) => {
		const S = between(r, 5, 1000);
		const dS = S * between(r, 0.01, 0.2);
		const K = S * between(r, 0.6, 1.4);
		const iv = between(r, 0.05, 1.5);
		const dte = between(r, 1, 300);
		const ok =
			bsCallPrice(S + dS, K, iv, dte) >= bsCallPrice(S, K, iv, dte) - 1e-9 &&
			bsPutPrice(S + dS, K, iv, dte) <= bsPutPrice(S, K, iv, dte) + 1e-9 &&
			bsCallPrice(S, K, iv * 1.1, dte) >= bsCallPrice(S, K, iv, dte) - 1e-9 &&
			bsPutPrice(S, K, iv, dte * 1.3) >= bsPutPrice(S, K, iv, dte) - 1e-9;
		return ok ? undefined : `S=${S} dS=${dS} K=${K} iv=${iv} dte=${dte}`;
	});
});

test("价格夹在内在价值和上界之间", () => {
	everyPoint(19, (r) => {
		const S = between(r, 5, 1000);
		const K = S * between(r, 0.5, 1.5);
		const iv = between(r, 0.05, 2.5);
		const dte = between(r, 1, 365);
		const C = bsCallPrice(S, K, iv, dte);
		const P = bsPutPrice(S, K, iv, dte);
		const eps = 1e-7 * (S + K);
		const ok = C >= Math.max(0, S - K) - eps && C <= S + eps && P >= Math.max(0, K - S) - eps && P <= K + eps;
		return ok ? undefined : `S=${S} K=${K} C=${C} P=${P}`;
	});
});

test("首达概率不低于到期价内概率", () => {
	everyPoint(37, (r) => {
		const S = between(r, 5, 1000);
		const H = S * Math.exp(between(r, 0.005, 0.4));
		const iv = between(r, 0.05, 1.5);
		const dte = between(r, 1, 180);
		const touch = touchProbFirstPassage(S, H, iv, dte / 365);
		const terminal = bsShortCallAssignProb(S, H, iv, dte);
		return touch >= terminal - 1e-9 ? undefined : `S=${S} H=${H} touch=${touch} terminal=${terminal}`;
	});
});

test("spotForPremium 往返：按反解出的正股价重新定价得回原权利金", () => {
	everyPoint(41, (r) => {
		const K = between(r, 20, 800);
		const iv = between(r, 0.1, 1.5);
		const dte = between(r, 2, 120);
		const p = bsCallPrice(K * between(r, 0.7, 1.3), K, iv, dte);
		if (p <= 0.005) return undefined;
		const sStar = spotForPremium("cc", p, K, iv, dte);
		if (sStar == null) return `够不着 K=${K} p=${p}`;
		return Math.abs(bsCallPrice(sStar, K, iv, dte) - p) <= 1e-4 * Math.max(1, p) ? undefined : `K=${K} p=${p} S*=${sStar}`;
	});
	assert.equal(spotForPremium("csp", 100, 100, 0.3, 30), null, "put 权利金不低于行权价时够不着");
});
