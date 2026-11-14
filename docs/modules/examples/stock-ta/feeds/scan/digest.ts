/**
 * The close-of-day digest (design section 8): one silent line, without IO, from the day's hits of both feeds. Hits of one symbol
 * on the day share one daily bar, so they merge into one segment (土拨鼠's 同根合并): a combo stands for its members, a band for
 * the lower band on its side, and whipsaw demotions fold into a count. The host takes a line of at most 1000 characters and no
 * line break, so segments that do not fit fold, lowest level first, into 「另有 n 条」.
 */
import type { Hit } from "../../hits.ts";
import { COMBOS, opensTask, WATCH_RULES } from "../../watch-rules.ts";

const LIMIT = 1000;
const GROUPS = new Set(["ta-key", "ta-other"]);
const isCombo = (h: Hit) => COMBOS.some((c) => c.id === h.rule);
const isBand = (h: Hit) => h.rule.startsWith("move-");
const label = (h: Hit) => (isBand(h) || isCombo(h) ? h.fact : h.fact.split("（")[0]!);
const titleOf = (h: Hit) => (GROUPS.has(h.rule) ? label(h) : (WATCH_RULES.find((r) => r.id === h.rule)?.title ?? label(h)));

type Segment = { text: string; rank: number; count: number };

/** A band on one side shows only its highest tier; a combo's members show as the combo. */
function shown(hits: readonly Hit[]): Hit[] {
	const listed = hits.filter((h) => h.level >= 1 && h.combo === undefined);
	return listed.filter((h) => !isBand(h) || !listed.some((o) => isBand(o) && o.lean === h.lean && o.rule > h.rule));
}

function segmentOf(symbol: string, hits: readonly Hit[]): Segment | undefined {
	const listed = shown(hits);
	const folds = [...new Map(hits.filter((h) => h.whipsaw !== undefined).map((h) => [titleOf(h), h.whipsaw!])).entries()].map(([title, flips]) => `${title}来回翻 ${flips} 次`);
	if (listed.length === 0 && folds.length === 0) return undefined;
	const named = (h: Hit) => (h.held && !opensTask(h) ? `${label(h)}（免打扰时留下）` : label(h));
	const [bull, bear, none] = (["bull", "bear", null] as const).map((lean) => listed.filter((h) => h.lean === lean).map(named));
	const split = bull!.length > 0 && bear!.length > 0;
	const parts = [
		...(split ? [`看多：${bull!.join("、")}`, `看空：${bear!.join("、")}`] : [[...bull!, ...bear!].join("、")].filter((p) => p !== "")),
		...(none!.length > 0 ? [none!.join("、")] : []),
		...(split ? [`多空分歧（看多 ${bull!.length} 条，看空 ${bear!.length} 条）`] : []),
	];
	const tasks = listed.filter(opensTask);
	if (tasks.some((h) => !h.held)) parts.push("已开任务");
	else if (tasks.length > 0) parts.push("免打扰时留下，现在补开任务");
	const head = parts.length > 0 ? parts.join("，") : "";
	const text = `${symbol} ${[head, ...folds].filter((p) => p !== "").join("，")}`;
	const rank = listed.length === 0 ? -1 : Math.max(...listed.map((h) => (opensTask(h) ? 9 : h.level)));
	return { text, rank, count: listed.length + folds.length };
}

/** Undefined when nothing above level 0 happened today. `states` are lines for states that began on an earlier day. */
export function digest(date: string, hits: readonly Hit[], states: readonly string[], scanFailed: boolean): string | undefined {
	if (!hits.some((h) => h.level >= 1)) return undefined;
	const symbols = [...new Set(hits.map((h) => h.symbol))].sort();
	const segments = symbols.flatMap((s) => segmentOf(s, hits.filter((h) => h.symbol === s)) ?? [])
		.concat(states.map((text) => ({ text, rank: 0, count: 1 })))
		.sort((a, b) => (b.rank === a.rank ? 0 : b.rank - a.rank));
	const ordered = [...segments.filter((s) => s.rank > 0), ...segments.filter((s) => s.rank === 0), ...segments.filter((s) => s.rank < 0)];
	const recorded = hits.filter((h) => h.level === 0).length;
	const tail = `${scanFailed ? "今天的日线扫描失败，收盘规则没有算。" : ""}${recorded > 0 ? `只记录的 ${recorded} 条，` : ""}问「今天有哪些信号」看全部。`;
	const head = `收盘小结 ${date.slice(5)}（美东）：`;
	const line = (kept: readonly Segment[], folded: number) => `${head}${[...kept.map((s) => s.text), ...(folded > 0 ? [`另有 ${folded} 条`] : [])].join("；")}。${tail}`;
	for (let keep = ordered.length; keep >= 0; keep--) {
		const text = line(ordered.slice(0, keep), ordered.slice(keep).reduce((n, s) => n + s.count, 0));
		if ([...text].length <= LIMIT) return text;
	}
	return [...line([], ordered.reduce((n, s) => n + s.count, 0))].slice(0, LIMIT).join("");
}
