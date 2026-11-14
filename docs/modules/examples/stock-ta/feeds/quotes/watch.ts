/**
 * The quotes feed's grading, without IO: one beat of fresh quotes in, the day's new hits and what to put in front of the user out.
 * Each hit is graded once, when it happens, from what is known by then (the table, the user's rule-levels, history up to
 * yesterday, the hits earlier today and on the past few trading days); later beats never change a recorded hit.
 */
import { nyTime, regularCloseAt, regularOpenAt } from "../../market-days.ts";
import { opened, resonate, type Hit } from "../../hits.ts";
import type { Quote } from "../../massive.ts";
import { COMBOS, effective, lineOf, opensTask, scopeOf, TIERS, VIXY, WATCH_RULES, WHIPSAW, type Effective, type Lean, type Level, type Line, type Plan, type RuleId, type RuleLevels, type WatchRule } from "../../watch-rules.ts";

export type Side = "up" | "down";
/** From the module's daily bars up to yesterday (bars.ts). A null field means too little history for it. */
export type History = { high52: number | null; low52: number | null; avgVolume20: number | null };

/** The quotes feed's own state for one New York date; `fired` holds the highest band per symbol and side. */
export type DayState = { date: string; fired: Record<string, Partial<Record<Side, number>>>; hits: Hit[] };
export const newDay = (date: string): DayState => ({ date, fired: {}, hits: [] });

export type Context = {
	levels: RuleLevels;
	history: Readonly<Record<string, History | null | undefined>>;
	/** Leans of whipsaw rules on the trading days before today inside the window, oldest first, keyed `<rule>:<symbol>`. */
	past: Readonly<Record<string, readonly Lean[]>>;
	quiet: boolean;
};
export type Alert = { id: string; text: string; at: string; fold?: { key: string; side: Side }; push?: "silent" };
/** `threadScope: "module"`: the module's feeds share the symbol's thread for the day, so a close-of-day hit joins the task a band opened. */
export type Notice = { id: string; thread: string; threadScope: "module"; fields: { line: string; rule: string; level: string; plan: Plan } };
export type Beat = { hits: Hit[]; alerts: Alert[]; notices: Notice[] };

// Prices are cents, so a move of exactly a band can compute a hair below it (609 / 600 → 1.4999…%).
const EPSILON = 1e-9;
const FIRST_HOUR_MS = 60 * 60_000;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
const moveOf = (q: Quote) => (q.price / q.prevClose - 1) * 100;
const leanOf = (move: number): Lean | null => (move > 0 ? "bull" : move < 0 ? "bear" : null);
const stamp = (q: Quote) => `报价时间 ${nyTime(Date.parse(q.at))} ET（延迟行情）。`;
const isIndex = (symbol: string) => scopeOf(symbol) === "index";

type Finding = { lean: Lean | null; fact: string };
type Seen = { history: History | null | undefined; qqq: Quote | undefined };
type Detect = (q: Quote, threshold: number, seen: Seen) => Finding | undefined;

/** One detector per rule that is not a move band; the table says where each runs and how much it tells the user. */
type QuotesRule = Extract<(typeof WATCH_RULES)[number], { feed: "quotes" }>["id"];
const DETECTORS: Record<Exclude<QuotesRule, "move-1" | "move-2">, Detect> = {
	volume(q, threshold, { history }) {
		const average = history?.avgVolume20;
		if (!average || q.volume === null) return undefined;
		const at = Date.parse(q.at);
		const open = regularOpenAt(at);
		if (at < open + FIRST_HOUR_MS) return undefined;
		const elapsed = Math.min(1, (at - open) / (regularCloseAt(at) - open));
		const pace = q.volume / (average * elapsed);
		return pace >= threshold - EPSILON ? { lean: leanOf(moveOf(q)), fact: `放量 ${pace.toFixed(1)} 倍（按已过的交易时段折算）` } : undefined;
	},
	"high-52w"(q, threshold, { history }) {
		const before = history?.high52;
		const high = q.dayHigh ?? q.price;
		return before && high > before * (1 + threshold / 100) ? { lean: "bull", fact: `创 52 周新高 ${high.toFixed(2)}（此前最高 ${before.toFixed(2)}）` } : undefined;
	},
	"low-52w"(q, threshold, { history }) {
		const before = history?.low52;
		const low = q.dayLow ?? q.price;
		return before && low < before * (1 - threshold / 100) ? { lean: "bear", fact: `创 52 周新低 ${low.toFixed(2)}（此前最低 ${before.toFixed(2)}）` } : undefined;
	},
	gap(q, threshold) {
		if (q.dayOpen === null) return undefined;
		const gap = (q.dayOpen / q.prevClose - 1) * 100;
		return Math.abs(gap) >= threshold - EPSILON ? { lean: leanOf(gap), fact: `开盘跳空 ${signed(gap)}%` } : undefined;
	},
	reversal(q, threshold) {
		const move = moveOf(q);
		const up = ((q.dayHigh ?? q.price) / q.prevClose - 1) * 100;
		const down = ((q.dayLow ?? q.price) / q.prevClose - 1) * 100;
		if (up >= threshold - EPSILON && move < 0) return { lean: "bear", fact: `盘中曾涨 ${signed(up)}%，现在跌 ${signed(move)}%` };
		if (-down >= threshold - EPSILON && move > 0) return { lean: "bull", fact: `盘中曾跌 ${signed(down)}%，现在涨 ${signed(move)}%` };
		return undefined;
	},
	"rel-strength"(q, threshold, { qqq }) {
		if (qqq === undefined) return undefined;
		const [own, market] = [moveOf(q), moveOf(qqq)];
		const opposite = (own > 0 && market < 0) || (own < 0 && market > 0);
		return opposite && Math.abs(own - market) >= threshold - EPSILON ? { lean: leanOf(own), fact: `逆大盘：${q.symbol} ${signed(own)}%，QQQ ${signed(market)}%` } : undefined;
	},
	"vixy-1": (q, threshold) => vixyRise(q, threshold),
	"vixy-2": (q, threshold) => vixyRise(q, threshold),
};

function vixyRise(q: Quote, threshold: number): Finding | undefined {
	const move = moveOf(q);
	return move >= threshold - EPSILON ? { lean: "bear", fact: `涨 ${signed(move)}%，到达 +${threshold}% 档` } : undefined;
}

type Delivery = { line: Line; plan?: Plan };
type Graded = { hit: Hit; delivery: Delivery; quote: Quote };

/**
 * Unrounded, so 4.996% stays under the 5% band. Tiers crossed in one beat give one line: the highest tier that puts a line in
 * front of the user names it, and it rings when any of them rings; a task opens when any of them opens one. A tier lowered to
 * level 0 never hides a lower tier. Each crossed tier is recorded as its own hit.
 */
function bands(day: DayState, q: Quote, ctx: Context, out: Beat): void {
	const move = moveOf(q);
	const side: Side = move >= 0 ? "up" : "down";
	const fired = day.fired[q.symbol]?.[side] ?? 0;
	const scope = scopeOf(q.symbol);
	const crossed = WATCH_RULES.filter((r) => r.id === "move-1" || r.id === "move-2")
		.map((rule) => effective(rule, q.symbol, scope, ctx.levels))
		.filter((e): e is Effective & { threshold: number } => e.threshold !== undefined && Math.abs(move) >= e.threshold - EPSILON && e.threshold > fired)
		.sort((x, y) => y.threshold - x.threshold);
	if (crossed.length === 0) return;
	day.fired[q.symbol] = { ...day.fired[q.symbol], [side]: crossed[0]!.threshold };
	const sign = side === "up" ? "+" : "-";
	const shown = crossed.filter((e) => e.line === "silent" || e.line === "ring");
	const task = crossed.find(opensTask);
	const lead = shown[0] ?? task;
	const band = (lead ?? crossed[0]!).threshold;
	const line = `${q.symbol} ${side === "up" ? "涨" : "跌"} ${move >= 0 ? "+" : ""}${move.toFixed(2)}%，到达 ${sign}${band}% 档。现价 ${q.price.toFixed(2)}，昨收 ${q.prevClose.toFixed(2)}。报价时间 ${nyTime(Date.parse(q.at))} ET（延迟行情）。`;
	const held = ctx.quiet && lead !== undefined;
	const lean: Lean = side === "up" ? "bull" : "bear";
	const market = isIndex(q.symbol) ? undefined : day.hits.find((h) => isIndex(h.symbol) && h.rule.startsWith("move-") && h.lean === lean && opened(h));
	for (const e of [...crossed].reverse()) {
		const hit: Hit = { id: `${e.rule.id}:${q.symbol}:${day.date}:${side}`, rule: e.rule.id, symbol: q.symbol, date: day.date, at: q.at, lean, fact: `到 ${sign}${e.threshold}% 档`, level: e.level, text: line, ...(held && { held: true as const }) };
		day.hits.push(hit);
		out.hits.push(hit);
	}
	if (lead === undefined || held) return;
	const id = `band:${q.symbol}:${day.date}:${side}${band}`;
	const push = shown.length === 0 ? null : shown.some((e) => e.line === "ring") ? "ring" : "silent";
	if (push !== null) out.alerts.push({ id, text: line, at: q.at, fold: { key: q.symbol, side }, ...(push === "silent" && { push: "silent" as const }) });
	if (task === undefined) return;
	const vixy = isIndex(q.symbol) ? day.hits.find((h) => h.rule === "vixy-1") : undefined;
	const note = market !== undefined ? `（大盘日：${market.symbol} 今天已${market.fact}，这只票并进指数的任务，汇报里逐只列出）` : vixy !== undefined ? `（VIXY 同日${vixy.fact}）` : "";
	out.notices.push({ id, thread: `${market?.symbol ?? q.symbol}:${day.date}`, threadScope: "module", fields: { line: `${line}${note}`, rule: task.rule.id, level: String(task.level), plan: task.rule.plan } });
}

function whipsawFlips(rule: WatchRule, symbol: string, lean: Lean | null, ctx: Context): number {
	if (!rule.whipsaw || lean === null) return 0;
	const leans = [...(ctx.past[`${rule.id}:${symbol}`] ?? []), lean];
	return leans.slice(1).filter((l, i) => l !== leans[i]).length;
}

/** `told`: rules whose facts the head already carries, left out of the 同日 list. */
function lineText(day: DayState, q: Quote, hit: Pick<Hit, "id" | "symbol">, head: string, why: readonly string[], told: readonly string[] = []): string {
	const others = day.hits.filter((h) => h.symbol === hit.symbol && h.id !== hit.id && !h.rule.startsWith("move-") && !told.includes(h.rule)).map((h) => h.fact);
	const move = moveOf(q);
	const context = others.length > 0 ? `同日：${[...new Set(others)].join("、")}。` : "";
	return `${head}。当天${move >= 0 ? "涨" : "跌"} ${signed(move)}%。${context}${why.map((w) => `${w}。`).join("")}${stamp(q)}`;
}

function rules(day: DayState, q: Quote, qqq: Quote | undefined, ctx: Context): Graded[] {
	const scope = scopeOf(q.symbol);
	const graded: Graded[] = [];
	// Hits in one beat happen together; grading the quieter ones first lets the louder one be the second hit that escalates.
	const ordered = WATCH_RULES.filter((r): r is Extract<(typeof WATCH_RULES)[number], { feed: "quotes" }> & { id: Exclude<QuotesRule, "move-1" | "move-2"> } => r.feed === "quotes" && r.id !== "move-1" && r.id !== "move-2").map((rule) => ({ rule, e: effective(rule, q.symbol, scope, ctx.levels) })).sort((a, b) => a.e.level - b.e.level);
	for (const { rule, e } of ordered) {
		const id = `${rule.id}:${q.symbol}:${day.date}`;
		if (e.threshold === undefined || day.hits.some((h) => h.id === id)) continue;
		const found = DETECTORS[rule.id](q, e.threshold, { history: ctx.history[q.symbol], qqq });
		if (found === undefined) continue;
		const base = { id, rule: rule.id, symbol: q.symbol, date: day.date, at: q.at, lean: found.lean, fact: found.fact };
		const flips = whipsawFlips(rule, q.symbol, found.lean, ctx);
		if (flips >= WHIPSAW.flips) {
			const hit: Hit = { ...base, level: 0, whipsaw: flips, text: lineText(day, q, base, `${q.symbol} ${rule.title}近 ${WHIPSAW.days} 个交易日反复 ${flips} 次（这次${found.fact}）`, []) };
			day.hits.push(hit);
			graded.push({ hit, delivery: { line: "none" }, quote: q });
			continue;
		}
		const combo = COMBOS.find((c) => (c.all as readonly string[]).includes(rule.id) && found.lean === c.lean && !day.hits.some((h) => h.id === `${c.id}:${q.symbol}:${day.date}`) && day.hits.some((h) => h.symbol === q.symbol && (c.all as readonly string[]).includes(h.rule) && h.rule !== rule.id && h.lean === c.lean));
		if (combo !== undefined) {
			const partner = day.hits.find((h) => h.symbol === q.symbol && (combo.all as readonly string[]).includes(h.rule) && h.rule !== rule.id)!;
			const member: Hit = { ...base, level: e.level, combo: combo.id, text: lineText(day, q, base, `${q.symbol} ${found.fact}`, []) };
			day.hits.push(member);
			const sameBeat = graded.find((g) => g.hit.id === partner.id);
			if (sameBeat !== undefined) sameBeat.delivery = { line: "none" };
			graded.push({ hit: member, delivery: { line: "none" }, quote: q });
			const comboBase = { id: `${combo.id}:${q.symbol}:${day.date}`, rule: combo.id, symbol: q.symbol, date: day.date, at: q.at, lean: combo.lean, fact: combo.title };
			const hit: Hit = { ...comboBase, level: combo.level, text: lineText(day, q, comboBase, `${q.symbol} ${combo.title}：${found.fact}，${partner.fact}`, [], combo.all) };
			day.hits.push(hit);
			graded.push({ hit, delivery: { line: combo.line, plan: combo.plan }, quote: q });
			continue;
		}
		const r = resonate(day.hits, { ...base, level: e.level, text: "" });
		const market = rule.id === "vixy-1" ? day.hits.find((h) => isIndex(h.symbol) && h.rule.startsWith("move-")) : undefined;
		const why = [r.why, market && `同日 ${market.symbol} 已${market.fact}`].filter((w): w is string => typeof w === "string");
		const hit: Hit = { ...base, level: r.level, ...(r.bumped && { bumped: true as const }), text: lineText(day, q, base, `${q.symbol} ${found.fact}`, why) };
		day.hits.push(hit);
		graded.push({ hit, delivery: { line: r.level === e.level ? e.line : lineOf(r.level, rule), plan: rule.plan }, quote: q });
	}
	for (const [lower, upper] of TIERS) {
		const low = graded.find((g) => g.hit.rule === lower);
		if (low !== undefined && graded.some((g) => g.hit.rule === upper)) low.delivery = { line: "none" };
	}
	return graded;
}

function deliver({ hit, delivery }: Graded, ctx: Context, out: Beat): void {
	out.hits.push(hit);
	const loud = delivery.line === "silent" || delivery.line === "ring";
	const task = opensTask(hit) && delivery.plan !== undefined;
	if (!loud && !task) return;
	if (ctx.quiet) {
		hit.held = true;
		return;
	}
	if (loud) out.alerts.push({ id: hit.id, text: hit.text, at: hit.at, ...(delivery.line === "silent" && { push: "silent" as const }) });
	if (task) out.notices.push({ id: hit.id, thread: `${hit.symbol}:${hit.date}`, threadScope: "module", fields: { line: hit.text, rule: hit.rule, level: String(hit.level), plan: delivery.plan! } });
}

/** Mutates `day`: its new hits are appended and the bands it reached are remembered. */
export function watch(day: DayState, quotes: readonly Quote[], ctx: Context): Beat {
	const out: Beat = { hits: [], alerts: [], notices: [] };
	const ordered = [...quotes.filter((q) => isIndex(q.symbol)), ...quotes.filter((q) => !isIndex(q.symbol))];
	for (const q of ordered) if (q.symbol !== VIXY) bands(day, q, ctx, out);
	const qqq = quotes.find((q) => q.symbol === "QQQ");
	for (const q of quotes) for (const g of rules(day, q, qqq, ctx)) deliver(g, ctx, out);
	return out;
}
