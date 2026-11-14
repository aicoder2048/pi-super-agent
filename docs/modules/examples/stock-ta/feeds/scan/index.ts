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
import { readHits, writeHits, type Hit } from "../../hits.ts";
import { isTradingDay, regularCloseAt, shiftDate } from "../../market-days.ts";
import { installedTa } from "../../ta.ts";
import { parseRuleLevels, quietAt, type LevelRow } from "../../watch-rules.ts";
import { listedSymbols, type WatchRow } from "../../watchlist.ts";
import { close, type TaSignal } from "./close.ts";

interface Input {
	/** `ta`: a node script that stands in for the venv's `ta` (fixtures and tests). `now`: a fixed time for this tick. */
	settings: { baseUrl: string; scanSeconds: number; ta?: string; now?: string };
	cursor: string | null;
	rows: { watchlist?: WatchRow[]; "rule-levels"?: LevelRow[] };
	now: string;
}

/** The session last scanned and swapped in, the symbols it scanned, and the hits graded on it. */
type Cursor = { date: string; symbols: string[]; hits?: Hit[] };

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

/** Grades the session's own signals on the watchlist: ta's first scan of an empty database backfills two years, and those are never graded. */
function grade(input: Input, signals: readonly Signal[], picked: readonly string[], date: string, earlier: readonly Hit[], tickMs: number, dataDir: string) {
	let bars: Parameters<typeof close>[0]["bars"] = {};
	try {
		bars = readDaily(dataDir, picked, date, BARS) ?? {};
	} catch {
		// A database without the daily bars table leaves the rules computed from bars off; ta's own signals still grade.
	}
	return close({
		date,
		at: new Date(closeOf(date)).toISOString(),
		symbols: picked,
		signals: signals.filter((s) => s.timeframe === "1d" && newYorkDate(s.data_end_ms) === date),
		bars,
		earlier: [...readHits(dataDir, date, "quotes"), ...earlier],
		levels: parseRuleLevels(input.rows["rule-levels"] ?? []).levels,
		quiet: quietAt(tickMs, false),
	});
}

export default async function scan(input: Input) {
	const tickMs = Date.parse(input.settings.now ?? input.now);
	const listed = listedSymbols(input.rows.watchlist ?? []);
	const { valid, rejected } = splitByTaRule(listed);
	const picked = valid.slice(0, MAX_WATCHLIST);
	const symbols = [...picked, ...BENCHMARKS.filter((s) => !picked.includes(s))];
	const last = readCursor(input.cursor);
	const session = lastSession(tickMs);
	if (last !== undefined && last.date === session && sameSymbols(last.symbols, symbols)) return { records: [] };

	const key = process.env.POLYGON_API_KEY ?? "";
	if (key === "") return { records: [], problem: NO_KEY };
	const dataDir = process.env.PSA_MODULE_DATA ?? "";
	const dir = join(dataDir, "files", "ta");
	mkdirSync(dir, { recursive: true });
	const live = join(dir, "ta.sqlite");
	const next = `${live}.next`;
	// A leftover rollback journal would silently roll the fresh copy back when ta opens it.
	const dropCopy = () => [next, `${next}-journal`, `${next}.scan.lock`].forEach((path) => rmSync(path, { force: true }));
	const startedAt = new Date().toISOString();
	const note = noteOf(listed, valid, rejected);
	const row = (outcome: "换上" | "失败", newSignals: number, errors: string) => ({
		id: `${session}@${startedAt}`,
		startedAt,
		tradingDate: session,
		outcome,
		symbols: symbols.length,
		watchlist: listed.length,
		newSignals,
		...(errors !== "" && { errors }),
		...(note !== undefined && { note }),
	});
	try {
		const ta = taOf(input.settings, key, next);
		const hadLive = existsSync(live);
		// ta scans the New York date of `now`: a tick on a later date (a weekend, past midnight) asks for the session it missed.
		const now = newYorkDate(tickMs) === session ? new Date(tickMs).toISOString() : new Date(closeOf(session) + TA_AFTER_CLOSE_MS).toISOString();
		dropCopy();
		if (hadLive) copyFileSync(live, next, constants.COPYFILE_FICLONE);
		const reply = (await runTa(ta, "scan", { mode: "daily", symbols, now })) as ScanReply;
		if (reply.skipped) return { records: [] };
		// ta exits 0 when the network is down, so success is read from the per-symbol errors, never the exit code.
		const failed = new Set(reply.errors.filter((e) => e.error.code !== WARNING_ONLY).map((e) => e.symbol));
		const swapped = symbols.some((s) => !failed.has(s));
		const record = row(swapped ? "换上" : "失败", reply.new_signals.length, errorLine(reply.errors));
		if (!swapped) return { records: [record], problem: SCAN_FAILED };
		renameSync(next, live);
		const earlier = last?.date === session ? (last.hits ?? []) : [];
		const graded = hadLive ? grade(input, reply.new_signals, picked, session, earlier, tickMs, dataDir) : { hits: [], alerts: [], notices: [] };
		const hits = [...earlier, ...graded.hits];
		let problem: Problem | undefined;
		try {
			if (hits.length > 0) writeHits(dataDir, "scan", session, hits);
		} catch (error) {
			problem = hitsFile(error);
		}
		return { records: [record], alerts: graded.alerts, notices: graded.notices, cursor: JSON.stringify({ date: session, symbols, hits } satisfies Cursor), ...(problem && { problem }) };
	} catch (error) {
		return { records: [row("失败", 0, error instanceof Error ? error.message : String(error))], problem: SCAN_FAILED };
	} finally {
		dropCopy();
	}
}
