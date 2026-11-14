/**
 * Only this feed writes the module's technical-analysis database. It scans a copy and renames the
 * copy into place on success, so a reader sees the whole old database or the whole new one.
 */
import { spawn } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { installedTa } from "../../ta.ts";
import { listedSymbols, type WatchRow } from "../../watchlist.ts";

interface Input {
	/** `ta`: a node script that stands in for the venv's `ta` (fixtures and tests). `now`: a fixed time for this tick. */
	settings: { baseUrl: string; scanSeconds: number; signals: { rules: string[] }; ta?: string; now?: string };
	cursor: string | null;
	rows: { watchlist?: WatchRow[] };
}

/** The last scan that was swapped in: the New York date of the `now` it scanned at, and the symbols it scanned. */
type Cursor = { date: string; symbols: string[] };

type TaError = { symbol?: string; error: { code: string; message?: string } };
/** The fields of ta's `new_signals` rows (`record_signal` at the pinned commit) that a trigger carries. */
type TaSignal = { symbol: string; rule_id: string; timeframe: string; kind: string; direction: string; data_end_ms: number; price: number | null };
type ScanReply = { skipped: true } | { skipped?: false; new_signals: TaSignal[]; errors: TaError[] };

const BENCHMARKS = ["QQQ", "SPY"];
const MAX_WATCHLIST = 30;
/** ta-trading's `normalize_symbol` at the pinned commit; `ta scan` rejects the whole call over one symbol that fails it. */
const TA_SYMBOL = /^[A-Z]{1,10}(?:\.[A-Z]{1,2})?$/;
/** `ta scan` needs the close plus its 15-minute data delay. */
const AFTER_CLOSE_MS = 16 * 60_000;
/** Bars came through and only the dividend refresh failed, so the symbol did not fail. */
const WARNING_ONLY = "DIVIDENDS_UNAVAILABLE";
const GUIDE = "docs/modules/stock-ta.md";
const DAY_MS = 86_400_000;

const NEW_YORK = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const newYorkDate = (ms: number): string => NEW_YORK.format(new Date(ms));

/**
 * One trigger per signal of the session just scanned, on a watchlist symbol, whose rule the settings name. The first
 * scan of an empty database is a two-year backfill, so it sends none; a missed evening's signals stay unsent too.
 */
function signalNotices(signals: readonly TaSignal[], rules: readonly string[], watchlist: readonly string[], tradingDate: string) {
	return signals
		.filter((s) => rules.includes(s.rule_id) && watchlist.includes(s.symbol) && newYorkDate(s.data_end_ms) === tradingDate)
		.map((s) => ({
			id: `signal:${s.symbol}:${s.rule_id}:${s.timeframe}:${tradingDate}:${s.direction}`,
			thread: `signal:${s.symbol}:${tradingDate}`,
			fields: { symbol: s.symbol, rule: s.rule_id, kind: s.kind, direction: s.direction, timeframe: s.timeframe, date: tradingDate, price: s.price === null ? "—" : String(s.price) },
		}));
}

const sameSymbols = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function readCursor(text: string | null): Cursor | undefined {
	try {
		return text === null ? undefined : (JSON.parse(text) as Cursor);
	} catch {
		return undefined;
	}
}

class Late extends Error {}

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
			if (late) return fail(new Late(`超时：ta ${sub} 到了扫描时限还没结束，停掉了，旧数据库没动`));
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

/** `ta calendar` answers one date at a time, so walk back to the latest session whose close is old enough to scan. */
async function lastSessionNow(ta: Ta, tickMs: number): Promise<string> {
	const [y, m, d] = newYorkDate(tickMs).split("-").map(Number) as [number, number, number];
	for (let back = 0; back < 10; back++) {
		const date = new Date(Date.UTC(y, m - 1, d) - back * DAY_MS).toISOString().slice(0, 10);
		const day = (await runTa(ta, "calendar", { date })) as { is_trading_day?: boolean; close?: string | null };
		const scanAt = day.is_trading_day && day.close ? Date.parse(day.close) + AFTER_CLOSE_MS : Infinity;
		if (scanAt <= tickMs) return new Date(scanAt).toISOString();
	}
	throw new Error("ta calendar 往前 10 天都没找到收盘过的交易日");
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

export default async function scan(input: Input) {
	const tickMs = input.settings.now === undefined ? Date.now() : Date.parse(input.settings.now);
	const listed = listedSymbols(input.rows.watchlist ?? []);
	const { valid, rejected } = splitByTaRule(listed);
	const picked = valid.slice(0, MAX_WATCHLIST);
	const symbols = [...picked, ...BENCHMARKS.filter((s) => !picked.includes(s))];
	const last = readCursor(input.cursor);
	if (last !== undefined && last.date === newYorkDate(tickMs) && sameSymbols(last.symbols, symbols)) return { records: [] };

	const key = process.env.POLYGON_API_KEY ?? "";
	if (key === "") throw new Error(`没有设置 POLYGON_API_KEY，这一拍没扫：在宿主的密钥文件里加一行 POLYGON_API_KEY=<你的 Massive/Polygon 密钥>，见 ${GUIDE}`);
	const dir = join(process.env.PSA_MODULE_DATA ?? "", "files", "ta");
	mkdirSync(dir, { recursive: true });
	const live = join(dir, "ta.sqlite");
	const next = `${live}.next`;
	// A leftover rollback journal would silently roll the fresh copy back when ta opens it.
	const dropCopy = () => [next, `${next}-journal`, `${next}.scan.lock`].forEach((path) => rmSync(path, { force: true }));
	const ta = taOf(input.settings, key, next);
	const startedAt = new Date().toISOString();
	const hadLive = existsSync(live);
	const now = hadLive ? new Date(tickMs).toISOString() : await lastSessionNow(ta, tickMs);

	dropCopy();
	try {
		if (hadLive) copyFileSync(live, next, constants.COPYFILE_FICLONE);
		const tradingDate = newYorkDate(Date.parse(now));
		const note = noteOf(listed, valid, rejected);
		const row = (outcome: "换上" | "失败", newSignals: number, errors: string) => ({
			id: `${tradingDate}@${startedAt}`,
			startedAt,
			tradingDate,
			outcome,
			symbols: symbols.length,
			watchlist: listed.length,
			newSignals,
			...(errors !== "" && { errors }),
			...(note !== undefined && { note }),
		});
		let reply: ScanReply;
		try {
			reply = (await runTa(ta, "scan", { mode: "daily", symbols, now })) as ScanReply;
		} catch (error) {
			if (error instanceof Late) return { records: [row("失败", 0, error.message)] };
			throw error;
		}
		if (reply.skipped) return { records: [] };
		// ta exits 0 when the network is down, so success is read from the per-symbol errors, never the exit code.
		const failed = new Set(reply.errors.filter((e) => e.error.code !== WARNING_ONLY).map((e) => e.symbol));
		const swapped = symbols.some((s) => !failed.has(s));
		if (swapped) renameSync(next, live);
		const record = row(swapped ? "换上" : "失败", reply.new_signals.length, errorLine(reply.errors));
		if (!swapped) return { records: [record] };
		const notices = hadLive ? signalNotices(reply.new_signals, input.settings.signals.rules, picked, tradingDate) : [];
		return { records: [record], notices, cursor: JSON.stringify({ date: tradingDate, symbols } satisfies Cursor) };
	} finally {
		dropCopy();
	}
}
