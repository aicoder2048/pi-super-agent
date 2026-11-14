/**
 * The scan feed's grading, without IO: the session's `ta` signals and complete daily bars in, the day's close-of-day hits and what
 * to put in front of the user out. It grades by the same table as the quotes feed, counts the quotes feed's hits of the day for
 * resonance, and grades each hit once: a hit already recorded today is never graded again.
 */
import { resonate, type Hit } from "../../hits.ts";
import { COMBOS, effective, lineOf, NOTES, opensTask, ruleOf, scopeOf, sideOf, taRow, WATCH_RULES, type Lean, type Line, type Plan, type RuleLevels, type WatchRule } from "../../watch-rules.ts";

/** The fields of `ta`'s `new_signals` rows (`record_signal` at the pinned commit) that grading reads. */
export type TaSignal = { symbol: string; rule_id: string; kind: string; direction: string; price: number | null; attention?: string | null; values?: Readonly<Record<string, unknown>> | null };
/** A complete daily bar from the module's database, oldest first; the last one is the session being graded. */
export type DailyBar = { date: string; close: number; volume: number };
/** `tradingDays`: trading days from the session to the earnings date, 0 when it is the session itself. */
export type Earnings = { date: string; time: string; tradingDays: number };

export type CloseInput = {
	/** The New York session date. */
	date: string;
	/** The session's close, the time of every hit. */
	at: string;
	/** The watchlist; only its individual stocks are graded. */
	symbols: readonly string[];
	/** `ta`'s new signals on the session date. */
	signals: readonly TaSignal[];
	bars: Readonly<Record<string, readonly DailyBar[] | undefined>>;
	/** Today's hits graded before this run: the quotes feed's, and this feed's own from an earlier run today. */
	earlier: readonly Hit[];
	/** The next earnings date per symbol, from Finnhub; a symbol without one is left out. */
	earnings?: Readonly<Record<string, Earnings>>;
	/** Ids of hits on the trading days before, so a state is told on the day it begins (one earnings date, one hit). */
	seen?: readonly string[];
	levels: RuleLevels;
	quiet: boolean;
};
export type Alert = { id: string; text: string; at: string; push?: "silent" };
export type Notice = { id: string; thread: string; threadScope: "module"; fields: { line: string; rule: string; level: string; plan: Plan } };
export type CloseResult = { hits: Hit[]; alerts: Alert[]; notices: Notice[] };

type Finding = { lean: Lean | null; fact: string };
/** 「财报还有 3 个交易日，11-17 盘后」, the same words in the hit and in the digest's line for a state still under way. */
export const earningsFact = (e: Earnings) => `${e.tradingDays === 0 ? "今天发财报" : `财报还有 ${e.tradingDays} 个交易日`}，${e.date.slice(5)} ${e.time}`;
type ScanRule = Extract<(typeof WATCH_RULES)[number], { feed: "scan" }>["id"];
/** The rows the module computes from daily bars; the rest are `ta`'s signals. */
type Computed = Extract<ScanRule, "volume-close" | "cross-50-200" | "rsi">;
type Detect = (bars: readonly DailyBar[], threshold: number) => Finding | undefined;

const VOLUME_DAYS = 20;
const RSI_DAYS = 14;
const average = (xs: readonly number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
/** Simple moving averages of the closes ending yesterday and today; undefined without `period + 1` bars. */
function smaPair(bars: readonly DailyBar[], period: number): [number, number] | undefined {
	if (bars.length < period + 1) return undefined;
	const closes = bars.map((b) => b.close);
	return [average(closes.slice(-period - 1, -1)), average(closes.slice(-period))];
}

/** Wilder's RSI(14) on yesterday's and today's close: the first average is a simple one, then each day weighs 13 to 1. */
function rsiPair(bars: readonly DailyBar[]): [number, number] | undefined {
	if (bars.length < RSI_DAYS + 2) return undefined;
	const changes = bars.slice(1).map((b, i) => b.close - bars[i]!.close);
	let gain = average(changes.slice(0, RSI_DAYS).map((c) => Math.max(c, 0)));
	let loss = average(changes.slice(0, RSI_DAYS).map((c) => Math.max(-c, 0)));
	const rsi = () => (gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
	const out: number[] = [rsi()];
	for (const c of changes.slice(RSI_DAYS)) {
		gain = (gain * (RSI_DAYS - 1) + Math.max(c, 0)) / RSI_DAYS;
		loss = (loss * (RSI_DAYS - 1) + Math.max(-c, 0)) / RSI_DAYS;
		out.push(rsi());
	}
	return [out.at(-2)!, out.at(-1)!];
}
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
const leanOf = (move: number): Lean | null => (move > 0 ? "bull" : move < 0 ? "bear" : null);
const moveOf = (bars: readonly DailyBar[]) => (bars.at(-1)!.close / bars.at(-2)!.close - 1) * 100;

const DETECTORS: Record<Computed, Detect> = {
	"volume-close"(bars, threshold) {
		const before = bars.slice(-VOLUME_DAYS - 1, -1);
		if (before.length < VOLUME_DAYS) return undefined;
		const ratio = bars.at(-1)!.volume / (before.reduce((sum, b) => sum + b.volume, 0) / VOLUME_DAYS);
		return ratio >= threshold ? { lean: leanOf(moveOf(bars)), fact: `收盘成交量是 20 日均量的 ${ratio.toFixed(1)} 倍` } : undefined;
	},
	"cross-50-200"(bars) {
		const [fast, slow] = [smaPair(bars, 50), smaPair(bars, 200)];
		if (fast === undefined || slow === undefined) return undefined;
		const values = `50 日 ${fast[1].toFixed(2)}，200 日 ${slow[1].toFixed(2)}`;
		if (fast[0] <= slow[0] && fast[1] > slow[1]) return { lean: "bull", fact: `50 日均线上穿 200 日均线（金叉，${values}）` };
		if (fast[0] >= slow[0] && fast[1] < slow[1]) return { lean: "bear", fact: `50 日均线下穿 200 日均线（死叉，${values}）` };
		return undefined;
	},
	// An RSI extreme warns of a stretch against the move, so it takes no side in resonance (design section 14).
	rsi(bars, threshold) {
		const pair = rsiPair(bars);
		if (pair === undefined) return undefined;
		const [before, now] = pair;
		const low = 100 - threshold;
		if (before < threshold && now >= threshold) return { lean: null, fact: `RSI(14) 上穿 ${threshold}（${now.toFixed(1)}）` };
		if (before > low && now <= low) return { lean: null, fact: `RSI(14) 下穿 ${low}（${now.toFixed(1)}）` };
		return undefined;
	},
};

/** 「收盘跌破 50 日线（收盘 97.00，50 日均线 98.50）」 for the moving-average crosses, `ta`'s own name for the rest. */
function factOf(s: TaSignal): string {
	const period = /^R-MA-2-(\d+)$/.exec(s.rule_id)?.[1];
	const [close, average] = [s.values?.["left"], s.values?.["right"]];
	if (period === undefined) return `${s.kind}（ta ${s.rule_id}）`;
	const crossed = `收盘${s.direction === "bullish" ? "站上" : "跌破"} ${period} 日线`;
	return typeof close === "number" && typeof average === "number" ? `${crossed}（收盘 ${close.toFixed(2)}，${period} 日均线 ${average.toFixed(2)}）` : crossed;
}

/** Why `ta` called the signal noise: its own whipsaw (土拨鼠's 来回翻), or too little to grade above it. */
function noiseOf(s: TaSignal): { why: string; flips?: number } {
	const whipsaw = s.values?.["whipsaw"] as { flips?: unknown } | undefined;
	const flips = typeof whipsaw?.flips === "number" ? whipsaw.flips : undefined;
	return flips === undefined ? { why: "ta 判为噪音" } : { why: `ta 判为噪音：近 12 根日线反复翻转 ${flips} 次`, flips };
}

/** `id`: a hit whose id is not `<key>:<symbol>:<date>`, such as one earnings date told once. */
type Candidate = { symbol: string; rule: WatchRule; key: string; finding: Finding; signal?: TaSignal; id?: string };

function candidates(input: CloseInput): Candidate[] {
	const listed = new Set(input.symbols);
	const fromTa = input.signals.filter((s) => listed.has(s.symbol)).map((s): Candidate => {
		const row = taRow(s.rule_id, s.direction);
		const key = row === "ta-key" || row === "ta-other" ? `${s.rule_id}:${sideOf(s.direction)}` : row;
		return { symbol: s.symbol, rule: ruleOf(row), key, finding: { lean: s.direction === "bullish" ? "bull" : s.direction === "bearish" ? "bear" : null, fact: factOf(s) }, signal: s };
	});
	const computed = input.symbols.flatMap((symbol) => {
		const bars = input.bars[symbol];
		if (bars === undefined || bars.length < 2 || bars.at(-1)!.date !== input.date) return [];
		return (Object.keys(DETECTORS) as Computed[]).flatMap((id): Candidate[] => {
			const threshold = effective(ruleOf(id), symbol, scopeOf(symbol), input.levels).threshold;
			const finding = threshold === undefined ? undefined : DETECTORS[id](bars, threshold);
			return finding === undefined ? [] : [{ symbol, rule: ruleOf(id), key: id, finding }];
		});
	});
	const earnings = input.symbols.flatMap((symbol): Candidate[] => {
		const next = input.earnings?.[symbol];
		const threshold = effective(ruleOf("earnings"), symbol, scopeOf(symbol), input.levels).threshold;
		if (next === undefined || threshold === undefined || next.tradingDays > threshold) return [];
		const fact = earningsFact(next);
		return [{ symbol, rule: ruleOf("earnings"), key: "earnings", finding: { lean: null, fact }, id: `earnings:${symbol}:${next.date}` }];
	});
	return [...fromTa, ...computed, ...earnings];
}

type Delivery = { line: Line; plan?: Plan };

export function close(input: CloseInput): CloseResult {
	const day: Hit[] = [...input.earlier];
	const out: CloseResult = { hits: [], alerts: [], notices: [] };
	const delivered = new Map<Hit, Delivery>();
	const record = (hit: Hit, delivery: Delivery) => (day.push(hit), out.hits.push(hit), delivered.set(hit, delivery));
	const stamp = `收盘日线 ${input.date.slice(5)}（美东）。`;
	const lineText = (hit: Pick<Hit, "id" | "symbol">, head: string, why: readonly string[], told: readonly string[] = []) => {
		const bars = input.bars[hit.symbol];
		const move = bars !== undefined && bars.length >= 2 && bars.at(-1)!.date === input.date ? moveOf(bars) : undefined;
		const others = day.filter((h) => h.symbol === hit.symbol && h.id !== hit.id && h.level >= 1 && !h.rule.startsWith("move-") && !told.includes(h.rule)).map((h) => h.fact);
		const today = move === undefined ? "" : `当天${move >= 0 ? "涨" : "跌"} ${signed(move)}%。`;
		const context = others.length > 0 ? `同日：${[...new Set(others)].join("、")}。` : "";
		return `${head}。${today}${context}${why.map((w) => `${w}。`).join("")}${stamp}`;
	};
	const all = candidates(input).map((c) => ({ c, e: effective(c.rule, c.symbol, scopeOf(c.symbol), input.levels) }))
		.filter(({ e }) => e.threshold !== undefined)
		.sort((x, y) => x.e.level - y.e.level);
	// Hits graded together happen together; the quieter ones go first so the louder one is the second hit that escalates.
	for (const { c, e } of all) {
		const id = c.id ?? `${c.key}:${c.symbol}:${input.date}`;
		if (day.some((h) => h.id === id) || input.seen?.includes(id)) continue;
		const base = { id, rule: c.rule.id, symbol: c.symbol, date: input.date, at: input.at, lean: c.finding.lean, fact: c.finding.fact, ...(c.signal && { signal: c.signal.rule_id }) };
		if (c.signal?.attention === "noise") {
			const noise = noiseOf(c.signal);
			record({ ...base, level: 0, ...(noise.flips !== undefined && { whipsaw: noise.flips }), text: lineText(base, `${c.symbol} ${c.finding.fact}`, [noise.why]) }, { line: "none" });
			continue;
		}
		const pair = (members: readonly string[], lean: (h: Hit) => boolean) => day.find((h) => h.symbol === c.symbol && members.includes(h.rule) && h.rule !== c.rule.id && lean(h));
		const combo = COMBOS.find((k) => (k.all as readonly string[]).includes(c.rule.id) && c.finding.lean === k.lean && !day.some((h) => h.id === `${k.id}:${c.symbol}:${input.date}`) && pair(k.all, (h) => h.lean === k.lean));
		if (combo !== undefined) {
			const partner = pair(combo.all, (h) => h.lean === combo.lean)!;
			if (out.hits.includes(partner)) (partner.combo = combo.id, delivered.set(partner, { line: "none" }));
			record({ ...base, level: e.level, combo: combo.id, text: lineText(base, `${c.symbol} ${c.finding.fact}`, []) }, { line: "none" });
			const comboBase = { id: `${combo.id}:${c.symbol}:${input.date}`, rule: combo.id, symbol: c.symbol, date: input.date, at: input.at, lean: combo.lean, fact: combo.title };
			record({ ...comboBase, level: combo.level, text: lineText(comboBase, `${c.symbol} ${combo.title}：${c.finding.fact}，${partner.fact}`, [], combo.all) }, { line: combo.line, plan: combo.plan });
			continue;
		}
		const note = NOTES.find((n) => (n.all as readonly string[]).includes(c.rule.id));
		const confirmed = note === undefined || c.finding.lean === null ? undefined : pair(note.all, (h) => h.lean === c.finding.lean);
		const r = resonate(day, { ...base, level: e.level, text: "" }, c.signal === undefined || c.signal.attention === "key");
		const why = [r.why, note && confirmed && `${note.note}（${confirmed.fact}）`].filter((w): w is string => typeof w === "string");
		record({ ...base, level: r.level, ...(r.bumped && { bumped: true as const }), text: lineText(base, `${c.symbol} ${c.finding.fact}`, why, confirmed ? [confirmed.rule] : []) }, { line: r.level === e.level ? e.line : lineOf(r.level, c.rule), plan: c.rule.plan });
	}
	for (const hit of out.hits) deliver(hit, delivered.get(hit)!, input.quiet, out);
	return out;
}

function deliver(hit: Hit, delivery: Delivery, quiet: boolean, out: CloseResult): void {
	const loud = delivery.line === "silent" || delivery.line === "ring";
	const task = opensTask(hit) && delivery.plan !== undefined;
	if (!loud && !task) return;
	if (quiet) {
		hit.held = true;
		return;
	}
	if (loud) out.alerts.push({ id: hit.id, text: hit.text, at: hit.at, ...(delivery.line === "silent" && { push: "silent" as const }) });
	if (task) out.notices.push({ id: hit.id, thread: `${hit.symbol}:${hit.date}`, threadScope: "module", fields: { line: hit.text, rule: hit.rule, level: String(hit.level), plan: delivery.plan! } });
}
