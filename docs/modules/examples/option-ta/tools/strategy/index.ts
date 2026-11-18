import { assignmentTouchProb } from "../../assignment-risk.ts";
import { computeCcYield } from "../../cc-yield.ts";
import { classifyDeliverable, STANDARD_SHARES_PER_CONTRACT } from "../../contract-deliverable.ts";
import { impliedVolCall, impliedVolPut } from "../../iv.ts";
import { recommendLimitPrice, recommendNetLimitPrice } from "../../limit-price.ts";
import { scoreLiquidity, type LiquidityTier } from "../../liquidity.ts";
import { portfolioGreeks } from "../../portfolio-greeks.ts";
import { bsShortCallAssignProb, bsShortPutAssignProb } from "../../options-math.ts";
import { ROLL_PENNY_FRACTION, rollCreditGate, type RollCreditVerdict } from "../../roll-credit-gate.ts";
import {
	expiryPLBearCallSpread,
	expiryPLBearPutSpread,
	expiryPLBullCallSpread,
	expiryPLBullPutSpread,
	expiryPLLongCall,
	expiryPLLongPut,
	expiryPLShortCall,
	expiryPLShortPut,
} from "../../scenario-pl.ts";
import { creditSpreadEconomics, cspEconomics, debitSpreadEconomics, longOptionEconomics, type StrategyEconomics } from "../../strategy-economics.ts";

type Action = "sell" | "buy";
type Right = "put" | "call";
type Role = "close" | "open";

type Leg = {
	action: Action;
	type: Right;
	strike: number;
	expiration: string;
	contracts: number;
	price: number;
	bid: number | null;
	ask: number | null;
	iv: number | null;
	open_interest: number | null;
	volume: number | null;
	role: Role | null;
	dte: number;
};

type Input = {
	kind?: unknown;
	legs?: unknown;
	spot?: unknown;
	asof?: unknown;
	scenario_prices?: unknown;
	cost_basis?: unknown;
};

type Ctx = { legs: Leg[]; spot: number | null; costBasis: number | null };

/** A single-expiry strategy in dollars for the whole order; `plAt` is the whole order's P/L at expiry. */
type Economics = {
	capital: number;
	max_profit: number | null;
	max_loss: number;
	breakeven: number;
	annualized_return: number | null;
	plAt: (spot: number) => number;
	assumption?: string;
};

class Invalid extends Error {}

const ROLL_KINDS = ["Calendar", "Diagonal", "Combo"] as const;
type RollKind = (typeof ROLL_KINDS)[number];

const SHARES = STANDARD_SHARES_PER_CONTRACT;
const money = (n: number) => Math.round(n * 100) / 100;
const ratio = (n: number | null) => (n === null ? null : Math.round(n * 10000) / 10000);

const TIER_LABEL: Record<LiquidityTier, string> = { liquid: "好", thin: "偏薄", poor: "差", illiquid: "很差" };

const VERDICT_NOTE: Record<RollCreditVerdict, string> = {
	ROLL_OK: "净收为正，且不低于平仓成本的门槛比例",
	ROLL_FOR_PENNIES: "净收为正，但低于平仓成本的门槛比例：为一点净收延长风险，通常不值",
	DO_NOT_ROLL_TAKE_LOSS: "净付或打平：Roll 只是把亏损往后挪，按纪律不 Roll，认亏或接股",
};

const ASSUMPTIONS = [
	"BS 公式按利率 0、无股息算",
	"被指派概率是到期时落在价内的概率，不含提前指派；到期日当天按日算不出，留空",
	"金额按每张 100 股算，不含手续费",
	"参考价不是可成交承诺，也不是下单指令",
];

function scale(e: StrategyEconomics, contracts: number, plPerShare: (s: number) => number): Economics {
	return {
		capital: e.capital * contracts,
		max_profit: e.max_profit === null ? null : e.max_profit * contracts,
		max_loss: e.max_loss * contracts,
		breakeven: e.breakeven,
		annualized_return: e.annualized_roc,
		plAt: (s) => plPerShare(s) * SHARES * contracts,
	};
}

function single(action: Action, type: Right, economics: (leg: Leg, ctx: Ctx) => Economics) {
	return (ctx: Ctx): Economics => {
		const [leg] = ctx.legs;
		if (ctx.legs.length !== 1 || leg!.action !== action || leg!.type !== type) {
			throw new Invalid(`这种策略要一条腿：${action === "sell" ? "卖" : "买"} ${type}`);
		}
		return economics(leg!, ctx);
	};
}

function vertical(ctx: Ctx, credit: boolean): Economics {
	const [a, b] = ctx.legs;
	if (ctx.legs.length !== 2 || a!.type !== b!.type || a!.action === b!.action) throw new Invalid("垂直价差要两条腿：同类型，一卖一买");
	if (a!.expiration !== b!.expiration) throw new Invalid("垂直价差的两条腿要同一个到期日");
	if (a!.contracts !== b!.contracts) throw new Invalid("垂直价差的两条腿张数要一样");
	const sell = a!.action === "sell" ? a! : b!;
	const buy = a!.action === "sell" ? b! : a!;
	const type = sell.type;
	const width = Math.abs(sell.strike - buy.strike);
	if (width === 0) throw new Invalid("垂直价差两条腿的行权价不能一样");
	const sellNearer = type === "put" ? sell.strike > buy.strike : sell.strike < buy.strike;
	if (sellNearer !== credit) {
		throw new Invalid(credit ? "贷方价差的卖腿要比买腿更靠近平值；这组腿是借方价差" : "借方价差的买腿要比卖腿更靠近平值；这组腿是贷方价差");
	}
	if (credit) {
		const net = sell.price - buy.price;
		const e = creditSpreadEconomics(width, net, sell.dte, sell.strike, type);
		if (e.bad_quote || !(net > 0)) throw new Invalid(`净收 ${money(net)} 要大于 0、小于宽度 ${width}，报价有问题`);
		const pl = type === "put" ? (s: number) => expiryPLBullPutSpread(sell.strike, buy.strike, net, s) : (s: number) => expiryPLBearCallSpread(sell.strike, buy.strike, net, s);
		return scale(e, sell.contracts, pl);
	}
	const debit = buy.price - sell.price;
	const e = debitSpreadEconomics(width, debit, buy.dte, buy.strike, type);
	if (e.bad_quote) throw new Invalid(`净付 ${money(debit)} 要大于 0、小于宽度 ${width}，报价有问题`);
	const pl = type === "call" ? (s: number) => expiryPLBullCallSpread(buy.strike, sell.strike, debit, s) : (s: number) => expiryPLBearPutSpread(buy.strike, sell.strike, debit, s);
	return scale(e, buy.contracts, pl);
}

function coveredCall(leg: Leg, ctx: Ctx): Economics {
	const reference = ctx.costBasis ?? ctx.spot ?? leg.strike;
	const basis = ctx.costBasis !== null ? "持股成本" : ctx.spot !== null ? "现价（没给持股成本）" : "行权价（没给持股成本和现价）";
	const shares = leg.contracts * SHARES;
	const y = computeCcYield({ strike: leg.strike, premium: leg.price, dte: leg.dte, cost_basis: ctx.costBasis ?? undefined, current_price: ctx.spot ?? undefined, contracts: leg.contracts });
	return {
		capital: reference * shares,
		max_profit: (leg.strike - reference + leg.price) * shares,
		max_loss: (reference - leg.price) * shares,
		breakeven: reference - leg.price,
		annualized_return: y === null ? null : (y.annualized_yield_on_cost ?? y.annualized_yield_on_strike),
		plAt: (s) => expiryPLShortCall(leg.strike, leg.price, s, reference) * shares,
		assumption: `CC 的正股按${basis} ${reference} 算；年化只算权利金，以${ctx.costBasis !== null ? "持股成本" : "行权价"}为分母`,
	};
}

function longOption(leg: Leg, type: Right): StrategyEconomics {
	const e = longOptionEconomics(leg.strike, leg.price, leg.dte, type);
	if (e.bad_quote) throw new Invalid("买入的权利金要大于 0，报价有问题");
	return e;
}

const STRATEGIES: Record<string, (ctx: Ctx) => Economics> = {
	CSP: single("sell", "put", (leg) => scale(cspEconomics(leg.strike, leg.price, leg.dte), leg.contracts, (s) => expiryPLShortPut(leg.strike, leg.price, s))),
	CC: single("sell", "call", coveredCall),
	"long-put": single("buy", "put", (leg) => scale(longOption(leg, "put"), leg.contracts, (s) => expiryPLLongPut(leg.strike, leg.price, s))),
	"long-call": single("buy", "call", (leg) => scale(longOption(leg, "call"), leg.contracts, (s) => expiryPLLongCall(leg.strike, leg.price, s))),
	"credit-vertical": (ctx) => vertical(ctx, true),
	"debit-vertical": (ctx) => vertical(ctx, false),
};

const KINDS = [...Object.keys(STRATEGIES), ...ROLL_KINDS];

function rollKindOf(legs: Leg[]): RollKind {
	const close = legs.filter((leg) => leg.role === "close");
	const open = legs.filter((leg) => leg.role === "open");
	if (close.length === 0 || open.length === 0 || close.length + open.length !== legs.length) throw new Invalid("Roll 的每条腿都要写 role：旧腿 close，新腿 open，两样都要有");
	const mixed = (side: Leg[]) => side.some((leg) => leg.action !== side[0]!.action);
	if (mixed(close) || mixed(open)) throw new Invalid("第一版只算单腿仓位的 Roll：旧腿方向一致、新腿方向一致；价差的 Roll 还不支持");
	const closeAction = close[0]!.action;
	if (close.some((leg) => leg.action !== closeAction) || open.some((leg) => leg.action === closeAction)) {
		throw new Invalid("Roll 的旧腿和新腿方向要相反：卖方是买回旧腿、卖出新腿，买方是卖出旧腿、买入新腿");
	}
	if (close.length !== open.length) return "Combo";
	const order = (a: Leg, b: Leg) => a.type.localeCompare(b.type) || a.strike - b.strike;
	const sortedOpen = [...open].sort(order);
	const pairs = [...close].sort(order).map((leg, i) => [leg, sortedOpen[i]!] as const);
	if (pairs.some(([c, o]) => c.type !== o.type)) throw new Invalid("Roll 的新旧腿要同类型（put 换 put，call 换 call）");
	if (pairs.some(([c, o]) => c.contracts !== o.contracts)) return "Combo";
	if (pairs.some(([c, o]) => c.strike !== o.strike)) return "Diagonal";
	if (pairs.every(([c, o]) => o.expiration > c.expiration)) return "Calendar";
	throw new Invalid("新腿和旧腿行权价、张数一样，到期日也没往后换，不是 Roll");
}

const cash = (legs: Leg[]) => legs.reduce((sum, leg) => sum + (leg.action === "sell" ? 1 : -1) * leg.price * SHARES * leg.contracts, 0);

function roll(legs: Leg[], kind: RollKind) {
	const type = rollKindOf(legs);
	if (type !== kind) throw new Invalid(`这组腿是 ${type} Roll，不是 ${kind}`);
	const close = legs.filter((leg) => leg.role === "close");
	const open = legs.filter((leg) => leg.role === "open");
	const net = cash(legs);
	const closeCost = Math.abs(cash(close));
	const shortRoll = close[0]!.action === "buy";
	const gate = shortRoll ? rollCreditGate(net, closeCost) : null;
	return {
		type,
		close_cash: money(cash(close)),
		open_cash: money(cash(open)),
		net: money(net),
		verdict: gate?.verdict ?? null,
		verdict_note: gate === null ? "买方 Roll 本来就多半净付，不套净收门槛" : VERDICT_NOTE[gate.verdict],
		penny_threshold: shortRoll ? money(ROLL_PENNY_FRACTION * closeCost) : null,
	};
}

function reference(legs: Leg[]) {
	if (legs.some((leg) => leg.bid === null || leg.ask === null)) return { price: null, total: null, note: "有腿缺 bid 或 ask，没算参考价" };
	if (legs.length === 1) {
		const leg = legs[0]!;
		const rec = recommendLimitPrice({ bid: leg.bid!, ask: leg.ask!, side: leg.action });
		if (rec === null) return { price: null, total: null, note: "报价无效（bid 为 0 或高于 ask），没算参考价" };
		const signed = leg.action === "sell" ? rec.limit : -rec.limit;
		return { price: signed, total: money(signed * SHARES * leg.contracts), note: `价差 ${rec.band}：每股参考价，正数是收，负数是付` };
	}
	const unit = Math.min(...legs.map((leg) => leg.contracts));
	const rec = recommendNetLimitPrice({ legs: legs.map((leg) => ({ bid: leg.bid!, ask: leg.ask!, side: leg.action, ratio: leg.contracts / unit })) });
	if (rec === null) return { price: null, total: null, note: "报价无效（bid 为 0、交叉，或净价不到一个 tick），没算参考价" };
	return { price: rec.netLimit, total: money(rec.netLimit * SHARES * unit), note: `净价差 ${rec.band}：每组的每股净参考价，正数是收，负数是付；整单 ${unit} 组` };
}

/** The four checks' numbers for the position the order leaves: a Roll's closing legs are gone after it. Needs the underlying price. */
function greeksOf(legs: Leg[], spot: number | null, kind: string) {
	if (spot === null || !(spot > 0)) return { status: "NO_SPOT", reason: "没给 spot（正股价），整单的 Delta、Gamma、Theta、Vega 和 IV ±10 点压力测试没算" };
	const rolling = (ROLL_KINDS as readonly string[]).includes(kind);
	const kept = rolling ? legs.filter((leg) => leg.role === "open") : legs;
	// A CC is covered by stock: its shares carry Delta 1 each, or a net-long position reads as short.
	const stock = kind === "CC" ? kept.reduce((n, leg) => n + leg.contracts * SHARES, 0) : 0;
	const result = portfolioGreeks(kept.map((leg) => ({ ...leg, iv: ivOf(leg, spot), shares: SHARES })), spot, stock);
	return { ...result, ...(rolling && { scope: "只算 Roll 之后留下的新腿，不含持有的正股" }) };
}

/** The leg's IV: given, else solved from its price (as legReport does). */
function ivOf(leg: Leg, spot: number): number | null {
	if (leg.iv !== null && leg.iv > 0) return leg.iv;
	return leg.dte > 0 ? (leg.type === "put" ? impliedVolPut : impliedVolCall)(leg.price, spot, leg.strike, leg.dte) : null;
}

function legReport(leg: Leg, spot: number | null, rolling: boolean) {
	const solve = leg.type === "put" ? impliedVolPut : impliedVolCall;
	const given = leg.iv !== null && leg.iv > 0 ? leg.iv : null;
	const solved = given === null && spot !== null && leg.dte > 0 ? solve(leg.price, spot, leg.strike, leg.dte) : null;
	const iv = given ?? solved;
	const shortOpen = leg.action === "sell" && (!rolling || leg.role === "open");
	const assign = leg.type === "put" ? bsShortPutAssignProb : bsShortCallAssignProb;
	const priced = shortOpen && spot !== null && iv !== null && leg.dte > 0;
	const assignment = priced ? assign(spot, leg.strike, iv, leg.dte) : null;
	const touch = priced ? assignmentTouchProb(leg.type, spot, leg.strike, iv, leg.dte) : null;
	const quoted = leg.bid !== null || leg.ask !== null || leg.open_interest !== null || leg.volume !== null;
	const mid = leg.bid !== null && leg.ask !== null ? (leg.bid + leg.ask) / 2 : leg.price;
	const liq = quoted ? scoreLiquidity({ bid: leg.bid, ask: leg.ask, mid, open_interest: leg.open_interest, volume: leg.volume }) : null;
	return {
		action: leg.action,
		type: leg.type,
		strike: leg.strike,
		expiration: leg.expiration,
		contracts: leg.contracts,
		role: leg.role,
		price: leg.price,
		dte: leg.dte,
		iv: ratio(iv),
		iv_source: given !== null ? "给定" : solved !== null ? "自算" : "无数据",
		assignment_probability: ratio(assignment),
		touch_probability: ratio(touch),
		liquidity: liq === null ? null : { score: ratio(liq.composite), tier: TIER_LABEL[liq.tier], nbbo: liq.nbbo_status === "live" ? "有报价" : "缺报价" },
	};
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (text: string) => DATE.test(text) && !Number.isNaN(Date.parse(text)) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const todayInNewYork = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const blank = (value: unknown) => value === undefined || value === null || value === "";

function optionalNumber(value: unknown, what: string): number | null {
	if (blank(value)) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Invalid(`${what}要是不小于 0 的数，收到 ${JSON.stringify(value)}`);
	return value;
}

function parseJson(text: unknown, what: string): unknown {
	if (typeof text !== "string") throw new Invalid(`${what}要是 JSON 文本`);
	try {
		return JSON.parse(text);
	} catch {
		throw new Invalid(`${what}不是合法的 JSON`);
	}
}

function parseLeg(raw: unknown, index: number, asof: string): Leg {
	const at = `第 ${index + 1} 条腿`;
	if (typeof raw !== "object" || raw === null) throw new Invalid(`${at}要是一个对象`);
	const leg = raw as Record<string, unknown>;
	const action = leg["action"];
	const type = leg["type"];
	const strike = leg["strike"];
	const expiration = leg["expiration"];
	const contracts = leg["contracts"] ?? 1;
	const role = leg["role"] ?? null;
	if (action !== "sell" && action !== "buy") throw new Invalid(`${at}的 action 要是 sell 或 buy`);
	if (type !== "put" && type !== "call") throw new Invalid(`${at}的 type 要是 put 或 call`);
	if (typeof strike !== "number" || !(strike > 0)) throw new Invalid(`${at}的 strike 要是正数`);
	if (typeof expiration !== "string" || !realDate(expiration)) throw new Invalid(`${at}的 expiration 要写成 YYYY-MM-DD`);
	const dte = days(asof, expiration);
	if (dte < 0) throw new Invalid(`${at}在 ${expiration} 已经到期，早于 ${asof}`);
	if (typeof contracts !== "number" || !Number.isInteger(contracts) || contracts <= 0) throw new Invalid(`${at}的 contracts 要是正整数`);
	if (role !== null && role !== "close" && role !== "open") throw new Invalid(`${at}的 role 要是 close 或 open`);
	const bid = optionalNumber(leg["bid"], `${at}的 bid `);
	const ask = optionalNumber(leg["ask"], `${at}的 ask `);
	if (bid !== null && ask !== null && bid > ask) throw new Invalid(`${at}的 bid ${bid} 高于 ask ${ask}，报价交叉`);
	const price = optionalNumber(leg["price"], `${at}的 price `) ?? (bid !== null && ask !== null && bid > 0 && ask > 0 ? (bid + ask) / 2 : null);
	if (price === null) throw new Invalid(`${at}没有 price，也没有能取中间价的 bid 和 ask`);
	return {
		action,
		type,
		strike,
		expiration,
		contracts,
		price,
		bid,
		ask,
		iv: optionalNumber(leg["iv"], `${at}的 iv `),
		open_interest: optionalNumber(leg["open_interest"], `${at}的 open_interest `),
		volume: optionalNumber(leg["volume"], `${at}的 volume `),
		role,
		dte,
	};
}

function adjustedFlag(rawLegs: unknown[]): string | null {
	for (const raw of rawLegs) {
		const declared = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["shares_per_contract"] : undefined;
		if (blank(declared)) continue;
		if (typeof declared !== "number" || !Number.isFinite(declared) || declared <= 0) throw new Invalid(`shares_per_contract 要是正数，收到 ${JSON.stringify(declared)}`);
		const deliverable = classifyDeliverable({ underlying: "", sharesPerContract: declared });
		if (!deliverable.standard) return deliverable.flag;
	}
	return null;
}

function compute(input: Input) {
	const kind = input.kind;
	if (typeof kind !== "string" || !KINDS.includes(kind)) throw new Invalid(`kind 要是 ${KINDS.join("、")} 之一`);
	const asof = blank(input.asof) ? todayInNewYork() : input.asof;
	if (typeof asof !== "string" || !realDate(asof)) throw new Invalid("asof 要写成 YYYY-MM-DD");
	const rawLegs = parseJson(input.legs, "legs ");
	if (!Array.isArray(rawLegs) || rawLegs.length === 0) throw new Invalid("legs 要是至少一条腿的数组");
	const flag = adjustedFlag(rawLegs);
	if (flag !== null) return { status: "ADJUSTED_CONTRACT", reason: flag };
	const legs = rawLegs.map((raw, i) => parseLeg(raw, i, asof));
	const spot = optionalNumber(input.spot, "spot ");
	const costBasis = optionalNumber(input.cost_basis, "cost_basis ");
	if (costBasis === 0) throw new Invalid("cost_basis 要大于 0；不知道就不填");
	const scenarios = blank(input.scenario_prices) ? [] : parseJson(input.scenario_prices, "scenario_prices ");
	if (!Array.isArray(scenarios) || scenarios.some((s) => typeof s !== "number" || !Number.isFinite(s) || s < 0)) throw new Invalid("scenario_prices 要是不小于 0 的数组成的数组");

	const rolling = (ROLL_KINDS as readonly string[]).includes(kind);
	const rolled = rolling ? roll(legs, kind as RollKind) : null;
	const economics = rolling ? null : STRATEGIES[kind]!({ legs, spot, costBasis });
	const net = cash(legs);
	const ref = reference(legs);
	return {
		status: "OK",
		kind,
		asof,
		dte: rolling ? null : legs[0]!.dte,
		net_premium: money(net),
		net_direction: Math.abs(net) < 0.005 ? "持平" : net > 0 ? "净收" : "净付",
		reference_price: ref.price,
		reference_total: ref.total,
		reference_note: ref.note,
		capital: economics === null ? null : money(economics.capital),
		max_profit: economics === null || economics.max_profit === null ? null : money(economics.max_profit),
		max_loss: economics === null ? null : money(economics.max_loss),
		breakeven: economics === null ? null : money(economics.breakeven),
		annualized_return: ratio(economics?.annualized_return ?? null),
		roll: rolled,
		legs: legs.map((leg) => legReport(leg, spot, rolling)),
		expiry_pl: economics === null ? null : (scenarios as number[]).map((s) => ({ spot: s, pl: money(economics.plAt(s)) })),
		greeks: greeksOf(legs, spot, kind),
		assumptions: [...ASSUMPTIONS, ...(economics?.assumption ? [economics.assumption] : []), ...(rolling ? ["Roll 只算这一次的净收付；新仓位的成本和盈亏平衡要连同整条交易链看账本"] : [])],
	};
}

export default function strategy(input: Input) {
	try {
		return compute(input ?? {});
	} catch (error) {
		if (error instanceof Invalid) return { status: "INVALID_INPUT", reason: error.message };
		throw error;
	}
}
