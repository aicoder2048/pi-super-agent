/**
 * Stores CBOE's daily VIX, VIX9D and VIX3M closes in `vix-closes` (knowledge/vol-regime): the first run backfills a year, then
 * each session once CBOE's history file has it. Massive and Finnhub on the user's plans do not serve the VIX; CBOE's public
 * history files need no key. The cursor holds each index's last stored session, so a session is stored once and a gap (the host
 * was off) is filled from the same file.
 */
import { newYorkDate, requestSignal } from "../../feed-fetch.ts";
import { isTradingDay, regularCloseAt, shiftDate } from "../../market-days.ts";
import { parseCboeHistory, VIX_INDICES, type VixIndex } from "../../vix.ts";

/** CBOE publishes the day's close in the evening; trying from 30 minutes after the close costs one small request per index per beat until it is there. */
export const VIX_AFTER_CLOSE_MS = 30 * 60_000;
export const BACKFILL_CALENDAR_DAYS = 365;
/** Past this long after a session's close without its row, the feed says so: CBOE is late or the file moved. */
const LATE_MS = 18 * 60 * 60_000;
const FAILURES_BEFORE_PROBLEM = 3;
const SOURCE = "CBOE";

interface Input {
	settings: { baseUrl: string };
	cursor: string | null;
	now: string;
}
type Cursor = { done: Partial<Record<VixIndex, string>>; failures: number };
type Row = { id: string; ticker: VixIndex; trade_date: string; open: number; high: number; low: number; close: number; source: string; fetched_at: string };
type Problem = { id: string; text: string };

/** A reply the feed cannot use: HTTP error, timeout, no connection, a file that is not CBOE's history. */
export class CboeError extends Error {}

const failing = (reason: string): Problem => ({ id: "data-down", text: `连着 ${FAILURES_BEFORE_PROBLEM} 轮取不到 CBOE 的 VIX 历史（最近一次：${reason}），已存的不受影响，恢复后从停下的交易日接着存` });
const late = (date: string, missing: string[]): Problem => ({ id: "not-ready", text: `${date} 收盘 18 小时后 CBOE 的历史文件里还没有 ${missing.join("、")} 那天的收盘，VIX 档位和期限结构停在之前；CBOE 补上后自动存` });

const closeOf = (date: string) => regularCloseAt(Date.parse(`${date}T17:00:00Z`));

/** The latest session whose close is VIX_AFTER_CLOSE_MS behind `tickMs`. */
function lastSession(tickMs: number): string {
	for (let date = newYorkDate(tickMs), back = 0; back < 10; date = shiftDate(date, -1), back++) {
		if (isTradingDay(date) && closeOf(date) + VIX_AFTER_CLOSE_MS <= tickMs) return date;
	}
	throw new Error("往前 10 天都没找到收盘过的交易日");
}

function readCursor(text: string | null): Cursor {
	try {
		const saved = text === null ? undefined : (JSON.parse(text) as Partial<Cursor>);
		return { done: saved?.done ?? {}, failures: typeof saved?.failures === "number" ? saved.failures : 0 };
	} catch {
		return { done: {}, failures: 0 };
	}
}

async function history(baseUrl: string, index: VixIndex): Promise<string> {
	let reply: Response;
	try {
		reply = await fetch(`${baseUrl}/${index}_History.csv`, { redirect: "follow", signal: requestSignal() });
	} catch (error) {
		throw new CboeError((error as Error).name === "TimeoutError" ? "CBOE 15 秒没有应答" : "连不上 CBOE");
	}
	if (!reply.ok) throw new CboeError(`CBOE 返回 HTTP ${reply.status}`);
	return reply.text();
}

export default async function vix(input: Input) {
	const tickMs = Date.parse(input.now);
	const target = lastSession(tickMs);
	const cursor = readCursor(input.cursor);
	const due = VIX_INDICES.filter((index) => (cursor.done[index] ?? "") < target);
	if (due.length === 0) return { records: [], cursor: JSON.stringify(cursor satisfies Cursor) };

	const floor = shiftDate(target, -BACKFILL_CALENDAR_DAYS);
	const fetchedAt = new Date(tickMs).toISOString();
	const records: Row[] = [];
	let problem: Problem | undefined;
	let failed = false;
	try {
		for (const index of due) {
			let closes;
			try {
				closes = parseCboeHistory(await history(input.settings.baseUrl, index));
			} catch (error) {
				throw error instanceof CboeError ? error : new CboeError((error as Error).message);
			}
			const after = cursor.done[index] ?? shiftDate(floor, -1);
			for (const c of closes) {
				// CBOE's VIX file also has rows for some market holidays (after-hours values); VIX9D and VIX3M do not.
				if (c.date <= after || c.date > target || !isTradingDay(c.date)) continue;
				records.push({ id: `${index}:${c.date}`, ticker: index, trade_date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, source: SOURCE, fetched_at: fetchedAt });
				cursor.done[index] = c.date;
			}
		}
		cursor.failures = 0;
	} catch (error) {
		if (!(error instanceof CboeError)) throw error;
		failed = true;
		cursor.failures++;
		if (cursor.failures >= FAILURES_BEFORE_PROBLEM) problem = failing(error.message);
	}
	// Judged by the oldest session still missing, so a session CBOE never filled keeps the problem up after the next close.
	const firstMissing = (index: VixIndex) => {
		const done = cursor.done[index];
		if (done === undefined) return target;
		let d = shiftDate(done, 1);
		while (!isTradingDay(d)) d = shiftDate(d, 1);
		return d;
	};
	const overdue = VIX_INDICES.filter((index) => (cursor.done[index] ?? "") < target).map((index) => ({ index, date: firstMissing(index) })).filter((m) => tickMs > closeOf(m.date) + LATE_MS);
	// A failed request is not CBOE being late; it is counted above and reported after three in a row.
	if (!failed && overdue.length > 0) {
		const oldest = overdue.map((m) => m.date).sort()[0]!;
		problem = late(oldest, overdue.filter((m) => m.date === oldest).map((m) => m.index));
	}
	return { records, cursor: JSON.stringify(cursor satisfies Cursor), ...(problem && { problem }) };
}
