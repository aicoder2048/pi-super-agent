/**
 * Only this feed writes the module's technical-analysis database. It scans a copy and renames the
 * copy into place on success, so a reader sees the whole old database or the whole new one.
 * It ticks every five minutes and does the work once per session, after the close by its own calendar (early closes included);
 * the other ticks return at once.
 */
import { spawn } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { readDaily } from "../../bars.ts";
import { nextEarningsOf } from "../../earnings.ts";
import { readHits, tradingDaysBefore, writeHits, type Hit } from "../../hits.ts";
import { isTradingDay, regularCloseAt, shiftDate } from "../../market-days.ts";
import { installedTa } from "../../ta.ts";
import { COMBOS, effective, opensTask, parseRuleLevels, quietAt, ruleOf, scopeOf, WATCH_RULES, type LevelRow, type RuleLevels } from "../../watch-rules.ts";
import { listedSymbols, type WatchRow } from "../../watchlist.ts";
import { close, earningsFact, type Earnings, type Notice, type TaSignal } from "./close.ts";
import { digest, heldLine } from "./digest.ts";

interface Input {
	/** `ta`: a node script that stands in for the venv's `ta` (fixtures and tests). `now`: a fixed time for this tick. */
	settings: { baseUrl: string; finnhubBaseUrl: string; scanSeconds: number; ta?: string; now?: string };
	cursor: string | null;
	rows: { watchlist?: WatchRow[]; "rule-levels"?: LevelRow[] };
	now: string;
}

/**
 * The session the feed is on: the symbols its swapped-in scan covered (none yet when every try failed), the hits graded on it, the
 * lines for states that began earlier (earnings coming), whether the digest went out, and the ids of held hits (both feeds) already
 * sent. The digest goes out once; a scan that grades later in quiet hours still holds hits, released once quiet hours end. A cursor
 * without `hits` is from before phase 3; its session counts as scanned and digested, so a deploy does not send a late digest.
 */
type Cursor = { date: string; symbols: string[]; hits?: Hit[]; states?: string[]; digest?: true; released?: string[] };

type TaError = { symbol?: string; error: { code: string; message?: string } };
type Signal = TaSignal & { timeframe: string; data_end_ms: number };
type ScanReply = { skipped: true } | { skipped?: false; new_signals: Signal[]; errors: TaError[] };

const BENCHMARKS = ["QQQ", "SPY"];
const MAX_WATCHLIST = 30;
/** ta-trading's `normalize_symbol` at the pinned commit; `ta scan` rejects the whole call over one symbol that fails it. */
const TA_SYMBOL = /^[A-Z]{1,10}(?:\.[A-Z]{1,2})?$/;
/** `ta scan` needs the close plus its 15-minute data delay. */
const TA_AFTER_CLOSE_MS = 16 * 60_000;
/** The quotes feed runs 20 minutes past the close for the delayed last quotes; grading after it sees all of the day's quote hits. */
const SCAN_AFTER_CLOSE_MS = 20 * 60_000;
/** 200-day lines and a 14-day RSI need a little over 200 bars. */
const BARS = 260;
/** A digest that waited for a scan that never swapped in goes out at 17:30 New York time without the close rules. */
const DIGEST_ANYWAY_MS = 90 * 60_000;
/** An earnings state can begin on any of these trading days before the session and still be the same state. */
const EARNINGS_LOOKBACK = 10;
/** Bars came through and only the dividend refresh failed, so the symbol did not fail. */
const WARNING_ONLY = "DIVIDENDS_UNAVAILABLE";
const GUIDE = "docs/modules/stock-ta.md";
type Problem = { id: "no-key" | "scan-failed" | "hits-file"; text: string };
const NO_KEY: Problem = { id: "no-key", text: `没有设置 POLYGON_API_KEY，收盘后的日线扫描没跑，日线和信号不会更新：在宿主的密钥文件里加一行 POLYGON_API_KEY=<你的 Massive/Polygon 密钥>，见 ${GUIDE}` };
const SCAN_FAILED: Problem = { id: "scan-failed", text: "收盘后的日线扫描失败了，日线和信号没更新，旧数据照用，下一拍再试；原因写在扫描记录里，问「最近一次日线扫描怎么样」就能看到" };
const hitsFile = (error: unknown): Problem => ({ id: "hits-file", text: `收盘命中的文件没写成（${error instanceof Error ? error.message : String(error)}），提醒和触发照发，「今天有哪些信号」暂时看不到收盘的命中；下一次扫描再写` });

const NEW_YORK = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const newYorkDate = (ms: number): string => NEW_YORK.format(new Date(ms));

/** The session's close, from the module's own calendar: 16:00 New York time, 13:00 on an early-close day. */
const closeOf = (date: string) => regularCloseAt(Date.parse(`${date}T17:00:00Z`));

/** The latest session whose close is far enough behind `tickMs` to scan. */
function lastSession(tickMs: number): string {
	for (let date = newYorkDate(tickMs), back = 0; back < 10; date = shiftDate(date, -1), back++) {
		if (isTradingDay(date) && closeOf(date) + SCAN_AFTER_CLOSE_MS <= tickMs) return date;
	}
	throw new Error("往前 10 天都没找到收盘过的交易日");
}

const sameSymbols = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function readCursor(text: string | null): Cursor | undefined {
	try {
		return text === null ? undefined : (JSON.parse(text) as Cursor);
	} catch {
		return undefined;
	}
}

/** One deadline covers every `ta` run of the tick, so the handler fails with its own message before the feed's limit. */
type Ta = { command: string; args: string[]; env: NodeJS.ProcessEnv; deadline: number };

function runTa(ta: Ta, sub: string, input: unknown): Promise<unknown> {
	const limitMs = Math.max(0, ta.deadline - Date.now());
	return new Promise((done, fail) => {
		const child = spawn(ta.command, [...ta.args, sub], { env: ta.env });
		let stdout = "";
		let stderr = "";
		let late = false;
		const timer = setTimeout(() => {
			late = true;
			child.kill("SIGKILL");
		}, limitMs);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
		child.stdin.on("error", () => undefined);
		child.on("error", (error) => (clearTimeout(timer), fail(new Error(`起不来 ta ${sub}：${error.message}`))));
		child.on("close", (status) => {
			clearTimeout(timer);
			if (late) return fail(new Error(`超时：ta ${sub} 到了扫描时限还没结束，停掉了，旧数据库没动`));
			if (status !== 0) return fail(new Error(`ta ${sub} 退出码 ${status}：${stderr.trim().split("\n")[0] ?? ""}`.slice(0, 300)));
			try {
				done(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
			} catch {
				fail(new Error(`ta ${sub} 的输出不是 JSON`));
			}
		});
		child.stdin.end(JSON.stringify(input));
	});
}

function taOf(settings: Input["settings"], key: string, db: string): Ta {
	const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TA_DB_PATH: db, MASSIVE_API_KEY: key, MASSIVE_BASE_URL: settings.baseUrl };
	const deadline = Date.now() + settings.scanSeconds * 1000;
	if (settings.ta !== undefined) return { command: process.execPath, args: [resolve(settings.ta)], env, deadline };
	return { command: installedTa(), args: [], env, deadline };
}

const errorLine = (errors: readonly TaError[]) => errors.map((e) => `${e.symbol ?? "整体"}：${e.error.code} ${e.error.message ?? ""}`.trim()).join("；");

function splitByTaRule(listed: readonly string[]): { valid: string[]; rejected: string[] } {
	const valid = new Set<string>();
	const rejected: string[] = [];
	for (const symbol of listed) {
		const dotted = symbol.replaceAll("-", ".");
		if (TA_SYMBOL.test(dotted)) valid.add(dotted);
		else rejected.push(symbol);
	}
	return { valid: [...valid], rejected };
}

function noteOf(listed: readonly string[], valid: readonly string[], rejected: readonly string[]): string | undefined {
	const notes = [
		listed.length === 0 && "自选股是空的，只扫了 QQQ、SPY",
		rejected.length > 0 && `这些代码 ta 不认，没扫：${rejected.join("、")}`,
		valid.length > MAX_WATCHLIST && `自选股有 ${valid.length} 只，超过 ${MAX_WATCHLIST} 只的上限，这次没扫：${valid.slice(MAX_WATCHLIST).join("、")}`,
	].filter((note) => note !== false);
	return notes.length > 0 ? notes.join("；") : undefined;
}

/** Next earnings per stock on the watchlist; a symbol Finnhub cannot answer is left out (its rule waits for the next scan). */
async function earningsOf(input: Input, picked: readonly string[], date: string): Promise<{ earnings: Record<string, Earnings>; note?: string }> {
	const key = process.env.FINNHUB_API_KEY ?? "";
	if (key === "") return { earnings: {}, note: "没有 FINNHUB_API_KEY，财报临近没算" };
	const stocks = picked.filter((s) => scopeOf(s) === "stock");
	const found = await Promise.all(stocks.map((s) => nextEarningsOf(input.settings.finnhubBaseUrl, key, s, date).catch(() => undefined)));
	const failed = stocks.filter((_, i) => found[i] === undefined);
	const earnings = Object.fromEntries(found.flatMap((f) => (f !== undefined && "date" in f ? [[f.symbol, { date: f.date, time: f.time, tradingDays: f.tradingDays }]] : [])));
	return { earnings, ...(failed.length > 0 && { note: `Finnhub 没答上这些代码的财报日，财报临近这次没算它们：${failed.join("、")}` }) };
}

/** Lines for earnings states told on an earlier day and still under way, for the digest. */
function statesOf(earnings: Readonly<Record<string, Earnings>>, seen: readonly string[], levels: RuleLevels): string[] {
	return Object.entries(earnings).flatMap(([symbol, e]) => {
		const rule = effective(ruleOf("earnings"), symbol, scopeOf(symbol), levels);
		if (rule.level === 0 || rule.threshold === undefined || e.tradingDays > rule.threshold || !seen.includes(`earnings:${symbol}:${e.date}`)) return [];
		return [`${symbol} ${earningsFact(e)}`];
	});
}

/** Grades the session's own signals on the watchlist: ta's first scan of an empty database backfills two years, and those are never graded. */
async function grade(input: Input, signals: readonly Signal[], picked: readonly string[], date: string, earlier: readonly Hit[], quiet: boolean, dataDir: string) {
	let bars: Parameters<typeof close>[0]["bars"] = {};
	try {
		bars = readDaily(dataDir, picked, date, BARS) ?? {};
	} catch {
		// A database without the daily bars table leaves the rules computed from bars off; ta's own signals still grade.
	}
	const levels = parseRuleLevels(input.rows["rule-levels"] ?? []).levels;
	const seen = tradingDaysBefore(date, EARNINGS_LOOKBACK).flatMap((d) => readHits(dataDir, d, "scan").filter((h) => h.rule === "earnings").map((h) => h.id));
	const { earnings, note } = await earningsOf(input, picked, date);
	const graded = close({
		date,
		at: new Date(closeOf(date)).toISOString(),
		symbols: picked,
		signals: signals.filter((s) => s.timeframe === "1d" && newYorkDate(s.data_end_ms) === date),
		bars,
		earlier: [...readHits(dataDir, date, "quotes"), ...earlier],
		earnings,
		seen,
		levels,
		quiet,
	});
	return { ...graded, states: statesOf(earnings, seen, levels), note };
}

const planOf = (rule: string) => [...WATCH_RULES, ...COMBOS].find((r) => r.id === rule)?.plan;

/** Triggers quiet hours held back on the session, from both feeds, sent once quiet hours end (design section 4.4). */
function heldTasks(held: readonly Hit[]): Notice[] {
	return held.filter((h) => opensTask(h) && planOf(h.rule) !== undefined).map((h) => ({
		id: h.id,
		thread: `${h.symbol}:${h.date}`,
		threadScope: "module",
		fields: { line: `${h.text}（免打扰时段留下，收盘小结时补发）`, rule: h.rule, level: String(h.level), plan: planOf(h.rule)! },
	}));
}

export default async function scan(input: Input) {
	const tickMs = Date.parse(input.settings.now ?? input.now);
	const listed = listedSymbols(input.rows.watchlist ?? []);
	const { valid, rejected } = splitByTaRule(listed);
	const picked = valid.slice(0, MAX_WATCHLIST);
	const symbols = [...picked, ...BENCHMARKS.filter((s) => !picked.includes(s))];
	const last = readCursor(input.cursor);
	const session = lastSession(tickMs);
	const quiet = quietAt(tickMs, false);
	const dataDir = process.env.PSA_MODULE_DATA ?? "";
	const cursor: Cursor = last?.date !== session ? { date: session, symbols: [], hits: [] } : last.hits === undefined ? { ...last, hits: [], digest: true, released: readHits(dataDir, session, "quotes").filter((h) => h.held).map((h) => h.id) } : last;
	const dayHits = () => [...readHits(dataDir, session, "quotes"), ...(cursor.hits ?? [])];
	const unreleased = () => dayHits().filter((h) => h.held && !cursor.released?.includes(h.id));
	const scanned = sameSymbols(cursor.symbols, symbols);
	if (scanned && cursor.digest && (quiet || unreleased().length === 0)) return { records: [] };

	const key = process.env.POLYGON_API_KEY ?? "";
	if (key === "") return { records: [], problem: NO_KEY };
	const out: { records: object[]; alerts: { id: string; text: string; at: string; push?: "silent" }[]; notices: Notice[]; problem?: Problem } = { records: [], alerts: [], notices: [] };
	const swapped = scanned || (await scanOnce(input, { key, dataDir, session, symbols, picked, listed, valid, rejected, tickMs, quiet, cursor, out }));
	const due = swapped || tickMs >= closeOf(session) + DIGEST_ANYWAY_MS;
	if ((cursor.digest || due) && !quiet) {
		const held = unreleased();
		const at = new Date(tickMs).toISOString();
		const text = cursor.digest ? heldLine(session, held) : digest(session, dayHits(), cursor.states ?? [], !swapped);
		if (text !== undefined) out.alerts.push({ id: cursor.digest ? `held:${held[0]!.id}` : `digest:${session}`, text, at, push: "silent" });
		out.notices.push(...heldTasks(held));
		cursor.digest = true;
		cursor.released = [...(cursor.released ?? []), ...held.map((h) => h.id)];
	}
	return { ...out, cursor: JSON.stringify(cursor satisfies Cursor) };
}

type Scan = { key: string; dataDir: string; session: string; symbols: string[]; picked: string[]; listed: string[]; valid: string[]; rejected: string[]; tickMs: number; quiet: boolean; cursor: Cursor; out: { records: object[]; alerts: object[]; notices: Notice[]; problem?: Problem } };

/** Scans the session into a copy and swaps it in; on success grades the close into the cursor and `out`. True when it swapped in. */
async function scanOnce(input: Input, { key, dataDir, session, symbols, picked, listed, valid, rejected, tickMs, quiet, cursor, out }: Scan): Promise<boolean> {
	const dir = join(dataDir, "files", "ta");
	mkdirSync(dir, { recursive: true });
	const live = join(dir, "ta.sqlite");
	const next = `${live}.next`;
	// A leftover rollback journal would silently roll the fresh copy back when ta opens it.
	const dropCopy = () => [next, `${next}-journal`, `${next}.scan.lock`].forEach((path) => rmSync(path, { force: true }));
	const startedAt = new Date().toISOString();
	const notes = [noteOf(listed, valid, rejected)];
	const row = (outcome: "换上" | "失败", newSignals: number, errors: string) => {
		const note = notes.filter((n) => n !== undefined).join("；");
		return { id: `${session}@${startedAt}`, startedAt, tradingDate: session, outcome, symbols: symbols.length, watchlist: listed.length, newSignals, ...(errors !== "" && { errors }), ...(note !== "" && { note }) };
	};
	try {
		const ta = taOf(input.settings, key, next);
		const hadLive = existsSync(live);
		// ta scans the New York date of `now`: a tick on a later date (a weekend, past midnight) asks for the session it missed.
		const now = newYorkDate(tickMs) === session ? new Date(tickMs).toISOString() : new Date(closeOf(session) + TA_AFTER_CLOSE_MS).toISOString();
		dropCopy();
		if (hadLive) copyFileSync(live, next, constants.COPYFILE_FICLONE);
		const reply = (await runTa(ta, "scan", { mode: "daily", symbols, now })) as ScanReply;
		if (reply.skipped) return false;
		// ta exits 0 when the network is down, so success is read from the per-symbol errors, never the exit code.
		const failed = new Set(reply.errors.filter((e) => e.error.code !== WARNING_ONLY).map((e) => e.symbol));
		if (!symbols.some((s) => !failed.has(s))) {
			out.records.push(row("失败", reply.new_signals.length, errorLine(reply.errors)));
			out.problem = SCAN_FAILED;
			return false;
		}
		renameSync(next, live);
		if (hadLive) {
			const graded = await grade(input, reply.new_signals, picked, session, cursor.hits ?? [], quiet, dataDir);
			cursor.hits = [...(cursor.hits ?? []), ...graded.hits];
			cursor.states = graded.states;
			notes.push(graded.note);
			out.alerts.push(...graded.alerts);
			out.notices.push(...graded.notices);
		}
		out.records.push(row("换上", reply.new_signals.length, errorLine(reply.errors)));
		cursor.symbols = symbols;
		try {
			if ((cursor.hits ?? []).length > 0) writeHits(dataDir, "scan", session, cursor.hits!);
		} catch (error) {
			out.problem = hitsFile(error);
		}
		return true;
	} catch (error) {
		out.records.push(row("失败", 0, error instanceof Error ? error.message : String(error)));
		out.problem = SCAN_FAILED;
		return false;
	} finally {
		dropCopy();
	}
}
