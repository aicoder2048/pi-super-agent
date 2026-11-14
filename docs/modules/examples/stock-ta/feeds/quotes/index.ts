import { readHistory } from "../../bars.ts";
import { pastLeans, writeHits } from "../../hits.ts";
import { isTradingDay, sessionAt } from "../../market-days.ts";
import { oneLine, snapshot, type Quote } from "../../massive.ts";
import { parseRuleLevels, quietAt, VIXY, WATCH_RULES, WHIPSAW, type Lean, type LevelRow } from "../../watch-rules.ts";
import { listedSymbols, type WatchRow } from "../../watchlist.ts";
import { newDay, watch, type DayState, type History } from "./watch.ts";

interface Input {
	settings: { baseUrl: string };
	rows: { watchlist?: WatchRow[]; "rule-levels"?: LevelRow[] };
	cursor: string | null;
	now: string;
}

/** The day's grading state (bands reached, hits) plus what the feed reads once a day: daily-bar history and whipsaw leans. */
type Cursor = DayState & { failures: number; lastQuote: { quotedAt: string | null; seenAt: string }; history: Record<string, History | null>; past: Record<string, Lean[]> };

type Problem = { id: "no-key" | "massive-down" | "stale" | "bad-level" | "hits-file"; text: string };
const GUIDE = "docs/modules/stock-ta.md";
const FAILURES_BEFORE_PROBLEM = 5;
const STALE_MS = 20 * 60_000;
const NO_KEY: Problem = { id: "no-key", text: `没有设置 POLYGON_API_KEY，报价没去取，到档提醒和你设的条件都不会响：在宿主的密钥文件里加一行 POLYGON_API_KEY=<你的 Massive/Polygon 密钥>，见 ${GUIDE}` };
const STALE: Problem = { id: "stale", text: `交易时段里 ${STALE_MS / 60_000} 分钟没有新的报价（行情本来就延迟 15 分钟，这是在那之外），到档提醒和你设的条件可能停了；Massive 可能在维护，或者套餐变了` };

const badLevel = (rows: readonly string[]): Problem => ({ id: "bad-level", text: `rule-levels 第 ${rows.join("、")} 行不生效：规则不在盯盘规则表里，或层级不在 0 到 6，或门槛不是 0 到 100 之间的数，或让某只票的第一档门槛不低于第二档；加一行同样的 rule 和 symbol 写上 removedAt 或写对的值就清掉；其余的改动照常算` });

const hitsFile = (error: unknown): Problem => ({ id: "hits-file", text: `当天命中的文件没写成（${error instanceof Error ? error.message : String(error)}），提醒和触发照发，「今天有哪些信号」暂时看不到最新的；下一轮再写` });

const KEY_REJECTED = /HTTP 40[13]\b/;

function massiveDown(error: Error): Problem {
	const reason = oneLine(error);
	const advice = KEY_REJECTED.test(reason) ? "密钥失效或套餐到期，不会自己好：检查宿主密钥文件里的 POLYGON_API_KEY" : "恢复后自动接着取";
	return { id: "massive-down", text: `连着 ${FAILURES_BEFORE_PROBLEM} 轮取不到报价（最近一次：${reason}），到档提醒和你设的条件都停了；${advice}，见 ${GUIDE}` };
}

/** Stale: a pre-market trade in the first snapshot, yesterday's quote on a holiday, a trade after an early close. */
function fresh(q: Quote, today: string): boolean {
	const session = sessionAt(Date.parse(q.at));
	return session.phase === "regular" && session.nyDate === today;
}

function cursorFor(raw: string | null, today: string, now: string, dataDir: string): Cursor {
	const saved = raw === null ? undefined : (JSON.parse(raw) as Partial<Cursor>);
	if (saved?.date === today) return { ...newDay(today), failures: 0, lastQuote: { quotedAt: null, seenAt: now }, history: {}, past: {}, ...saved };
	const past = pastLeans(dataDir, today, WHIPSAW.days, WATCH_RULES.filter((r) => "whipsaw" in r).map((r) => r.id));
	return { ...newDay(today), failures: 0, lastQuote: { quotedAt: null, seenAt: now }, history: {}, past };
}

function lastQuote(cursor: Cursor, quotes: readonly Quote[], now: string): Cursor["lastQuote"] {
	const newest = quotes.reduce<string | null>((max, q) => (max === null || q.at > max ? q.at : max), cursor.lastQuote.quotedAt);
	return newest === cursor.lastQuote.quotedAt ? cursor.lastQuote : { quotedAt: newest, seenAt: now };
}

/**
 * History is read once a day per symbol; a symbol added later in the day is read on its first beat. A database the scan has not
 * written yet, or one that will not open, leaves the history rules off for this beat and the bands running.
 */
function withHistory(cursor: Cursor, symbols: readonly string[], dataDir: string): void {
	const missing = symbols.filter((s) => !(s in cursor.history));
	if (missing.length === 0) return;
	try {
		Object.assign(cursor.history, readHistory(dataDir, missing, cursor.date) ?? {});
	} catch {
		return;
	}
}

export default async function quotes(input: Input) {
	const watched = [...new Set([...listedSymbols(input.rows.watchlist ?? []), "QQQ", "SPY"])];
	const symbols = [...watched, VIXY].sort();
	const key = process.env.POLYGON_API_KEY ?? "";
	if (key === "") return { records: [], problem: NO_KEY };
	const dataDir = process.env.PSA_MODULE_DATA ?? "";
	const nowMs = Date.parse(input.now);
	const session = sessionAt(nowMs);
	const today = session.nyDate;
	const cursor = cursorFor(input.cursor, today, input.now, dataDir);
	let snapped: Quote[];
	try {
		snapped = await snapshot(input.settings.baseUrl, key, symbols);
	} catch (error) {
		const failures = cursor.failures + 1;
		return { records: [], cursor: JSON.stringify({ ...cursor, failures }), ...(failures >= FAILURES_BEFORE_PROBLEM && { problem: massiveDown(error as Error) }) };
	}
	const quotes = snapped.filter((q) => fresh(q, today));
	cursor.failures = 0;
	cursor.lastQuote = lastQuote(cursor, quotes, input.now);
	const stale = session.phase === "regular" && isTradingDay(today) && nowMs - Date.parse(cursor.lastQuote.seenAt) >= STALE_MS;
	const { levels, bad } = parseRuleLevels(input.rows["rule-levels"] ?? []);
	if (quotes.length > 0) withHistory(cursor, quotes.map((q) => q.symbol), dataDir);
	const beat = watch(cursor, quotes, { levels, history: cursor.history, past: cursor.past, quiet: quietAt(nowMs, session.phase === "regular") });
	let written: Problem | undefined;
	try {
		if (cursor.hits.length > 0) writeHits(dataDir, "quotes", today, cursor.hits);
	} catch (error) {
		written = hitsFile(error);
	}
	const problem = stale ? STALE : bad.length > 0 ? badLevel(bad) : written;
	return {
		records: quotes.filter((q) => watched.includes(q.symbol)).map(({ dayClose: _c, dayOpen: _o, dayHigh: _h, dayLow: _l, ...q }) => ({ id: `${q.symbol}@${q.at}`, ...q })),
		alerts: beat.alerts,
		notices: beat.notices,
		cursor: JSON.stringify(cursor),
		...(problem && { problem }),
	};
}
