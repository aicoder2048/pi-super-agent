/**
 * The user's holdings (docs/modules/stock-ta-rules-design.md section 9), without IO: one row per symbol where the latest row wins,
 * and the three holding rules as one table. Every holding state is the price at or below a line; a rule hits on the day the price
 * enters its state, and the close-of-day digest carries one line a day while it stays there.
 */
export type HoldingRow = { id: string; fields: { readonly [field: string]: unknown } };
/** `pct`: how far below cost, as a positive magnitude. */
export type Stop = { price: number } | { pct: number };
export type Holding = { symbol: string; cost: number; boughtAt?: string; stop?: Stop; quantity?: number };
export type HoldingRuleId = "stop-loss" | "drawdown" | "below-cost";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const set = (v: unknown) => v !== null && v !== undefined && v !== "";
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function holdingOf(symbol: string, fields: HoldingRow["fields"]): Holding | undefined {
	const { cost, boughtAt, stopPrice, stopPct, quantity } = fields;
	if (!positive(cost)) return undefined;
	if (set(stopPrice) && !positive(stopPrice)) return undefined;
	if (set(stopPct) && !(typeof stopPct === "number" && Math.abs(stopPct) > 0 && Math.abs(stopPct) < 100)) return undefined;
	if (set(boughtAt) && !(typeof boughtAt === "string" && DATE.test(boughtAt))) return undefined;
	const stop: Stop | undefined = set(stopPrice) ? { price: stopPrice as number } : set(stopPct) ? { pct: Math.abs(stopPct as number) } : undefined;
	return {
		symbol,
		cost,
		...(set(boughtAt) && { boughtAt: boughtAt as string }),
		...(stop && { stop }),
		...(typeof quantity === "number" && Number.isFinite(quantity) && { quantity }),
	};
}

/**
 * The latest row per symbol wins: one with `removedAt` drops the symbol unchecked, one that does not parse goes to `bad` and does
 * not apply. Only symbols in `listed` count, so a symbol taken off the watchlist keeps its row but is no longer watched.
 */
export function parseHoldings(rows: readonly HoldingRow[], listed: readonly string[]): { holdings: Map<string, Holding>; bad: string[] } {
	const latest = new Map<string, HoldingRow>();
	for (const row of [...rows].sort((x, y) => Number(x.id) - Number(y.id))) {
		const symbol = String(row.fields["symbol"] ?? "").trim().toUpperCase();
		if (symbol !== "") latest.set(symbol, row);
	}
	const holdings = new Map<string, Holding>();
	const bad: string[] = [];
	for (const [symbol, row] of latest) {
		if (!listed.includes(symbol) || set(row.fields["removedAt"])) continue;
		const holding = holdingOf(symbol, row.fields);
		if (holding === undefined) bad.push(row.id);
		else holdings.set(symbol, holding);
	}
	return { holdings, bad: bad.sort((x, y) => Number(x) - Number(y)) };
}

/** Today's prices the holding rules read. */
export type Today = { prevClose: number; price: number; low: number; high: number };
/** A holding that entered a rule's state: the line, the price that crossed it, and for drawdown the peak it is measured from. */
export type Entry = { rule: HoldingRuleId; holding: Holding; threshold: number; line: number; price: number; peak: number | undefined; today: Today };

type Spec = {
	/** Where the line is; undefined when the rule has nothing to measure from (drawdown without a peak). */
	line(h: Holding, threshold: number, peak: number | undefined): number | undefined;
	/** The price an entry today is judged by. */
	price(t: Today): number;
	/** A stop counts at the line; the other states begin below it. */
	touch: boolean;
	/** For other lines' 同日 list, which can reach a trigger: no number at all, so no cost, stop, peak or drawdown. */
	fact(e: Entry): string;
	/** The line to the user directly, numbers included, after the symbol and before the price. */
	head(e: Entry): string;
	/** The head of the trigger, which the Router reads: no cost, stop or peak. */
	notice: string;
	/** The digest's word for a state still under way: 「仍在止损线下」. */
	state: string;
};

const money = (n: number) => n.toFixed(2);
const peakName = (h: Holding) => (h.boughtAt !== undefined ? "建仓以来的高点" : "52 周高点");
const drop = (e: Entry) => (1 - e.price / e.peak!) * 100;
function stopSource(h: Holding, threshold: number): string {
	if (h.stop === undefined) return `没设止损线，按成本 ${money(h.cost)} 的 -${threshold}%`;
	return "price" in h.stop ? "你设的止损价" : `你设的成本 ${money(h.cost)} 的 -${h.stop.pct}%`;
}

// A stop order fills on a touch, so the stop looks at the day's low; drawdown looks at the price, since the low may come before the high.
export const HOLDING_RULES: Readonly<Record<HoldingRuleId, Spec>> = {
	"stop-loss": {
		line: (h, threshold) => (h.stop === undefined ? h.cost * (1 - threshold / 100) : "price" in h.stop ? h.stop.price : h.cost * (1 - h.stop.pct / 100)),
		price: (t) => t.low,
		touch: true,
		fact: () => "触到止损线",
		head: (e) => `触到你的止损线 ${money(e.line)}（${stopSource(e.holding, e.threshold)}）。当天最低 ${money(e.today.low)}`,
		notice: "触到你的止损线",
		state: "止损线下",
	},
	drawdown: {
		line: (_, threshold, peak) => (peak === undefined ? undefined : peak * (1 - threshold / 100)),
		price: (t) => t.price,
		touch: true,
		fact: () => "从持仓高点回撤到回撤线",
		head: (e) => `从${e.holding.boughtAt !== undefined ? "" : " "}${peakName(e.holding)} ${money(e.peak!)} 回撤 ${drop(e).toFixed(2)}%`,
		notice: "从持仓高点回撤到你的回撤线",
		state: "回撤线下",
	},
	"below-cost": {
		line: (h, threshold) => h.cost * (1 - threshold / 100),
		price: (t) => t.price,
		touch: false,
		fact: () => "跌破成本价",
		head: (e) => `跌破你的成本价 ${money(e.holding.cost)}${e.threshold > 0 ? ` 的 -${e.threshold}%（${money(e.line)}）` : ""}`,
		notice: "跌破你的成本价",
		state: "成本价下",
	},
};

// Prices are cents and lines are products of them, so a price exactly on a line can compute a hair off it.
const EPSILON = 1e-9;
const under = (spec: Spec, price: number, line: number) => (spec.touch ? price <= line + EPSILON : price < line - EPSILON);

/**
 * The rule's entry today: not in its state at yesterday's close (drawdown with yesterday's peak), in it now. `peakBefore` is the
 * highest daily high the holding measures from, through yesterday; today's peak adds today's high.
 */
export function entered(rule: HoldingRuleId, holding: Holding, threshold: number, today: Today, peakBefore: number | null | undefined): Entry | undefined {
	const spec = HOLDING_RULES[rule];
	const before = peakBefore ?? undefined;
	const peak = before === undefined ? undefined : Math.max(before, today.high);
	const [yesterday, now] = [spec.line(holding, threshold, before), spec.line(holding, threshold, peak)];
	if (yesterday === undefined || now === undefined || under(spec, today.prevClose, yesterday)) return undefined;
	const price = spec.price(today);
	return under(spec, price, now) ? { rule, holding, threshold, line: now, price, peak, today } : undefined;
}

/**
 * The digest's line for states that began on an earlier day: a rule counts when both yesterday's and today's close are in its
 * state (on the entry day the hit itself is in the digest). `thresholds` names the rules that run, `peaks` the peak through
 * yesterday and through today.
 */
export function stillIn(holding: Holding, thresholds: Readonly<Partial<Record<HoldingRuleId, number>>>, closes: readonly [number, number], peaks: readonly [number | undefined, number | undefined]): string | undefined {
	const states = (Object.keys(HOLDING_RULES) as HoldingRuleId[]).filter((rule) => {
		const threshold = thresholds[rule];
		if (threshold === undefined) return false;
		const spec = HOLDING_RULES[rule];
		return [0, 1].every((i) => {
			const line = spec.line(holding, threshold, peaks[i]);
			return line !== undefined && under(spec, closes[i]!, line);
		});
	});
	return states.length === 0 ? undefined : `${holding.symbol} 仍在${states.map((rule) => HOLDING_RULES[rule].state).join("、")}`;
}

/** The key a holding's peak is cached under: a new `boughtAt` measures from a new start. */
export const peakKey = (h: Pick<Holding, "symbol" | "boughtAt">) => `${h.symbol}@${h.boughtAt ?? ""}`;
