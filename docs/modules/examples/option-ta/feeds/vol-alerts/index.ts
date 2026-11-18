/**
 * Opportunity alerts (option-ta v2 item 1, knowledge/vol-regime), after each session's close: a watchlist symbol whose options
 * just turned rich (seller's environment), the VIX closing up through 25 or 35, and the VIX term structure turning inverted.
 * The series come from the module's own `iv-snapshots` and `vix-closes`, read straight from data.db: `reads` would give only
 * the latest 500 rows. Only events on the latest sessions are posted, so a host that was off does not replay old ones.
 * A symbol turning rich and the VIX reaching 35 ring (the user, 2026-11-18); the rest are silent. Cheap options are not pushed;
 * tools/vol shows them. Every alert is information, not a trade signal.
 */
import { readFileSync } from "node:fs";
import { earningsOf, failedRequest, newYorkDate } from "../../feed-fetch.ts";
import { readIvSeries } from "../../iv-series.ts";
import { isTradingDay, regularCloseAt, shiftDate } from "../../market-days.ts";
import { richEntries, vixEvents, type RichEntry, type VixEvent } from "../../opportunity.ts";
import { isTicker } from "../../symbols.ts";
import { readVixSeries, vixLevel } from "../../vix.ts";

/** The iv feed stores a session from 30 minutes after its close; looking from 45 minutes gives it one beat. */
export const ALERT_AFTER_CLOSE_MS = 45 * 60_000;
/** Ids kept to post each alert once even if the host forgets; older ones fall off. */
const SENT_KEPT = 300;

interface Input {
	settings: { finnhubBaseUrl: string };
	cursor: string | null;
	rows: { watchlist?: WatchRow[] };
	now: string;
}
type WatchRow = { id: string; fields: { symbol?: unknown; removed_at?: unknown } };
type Alert = { id: string; text: string; at: string; push?: "silent" };
type Cursor = { sent: string[] };

const NOTICE = "只是信息，不是交易建议。";
const pct = (n: number) => `${Math.round(n * 100)}`;
const two = (n: number) => n.toFixed(2);
const closeOf = (date: string) => regularCloseAt(Date.parse(`${date}T17:00:00Z`));

/** The iv feed's methodology tag: rows of another methodology are another series. */
const methodology = (): string => JSON.parse(readFileSync(new URL("../iv/feed.json", import.meta.url), "utf8")).settings.methodology;

/** In the order symbols were first added; a symbol's latest row says whether it is removed (as the iv feed reads it). */
function listed(rows: readonly WatchRow[]): string[] {
	const removed = new Map<string, boolean>();
	for (const row of [...rows].sort((a, b) => Number(a.id) - Number(b.id))) {
		const symbol = String(row.fields.symbol ?? "").trim().toUpperCase();
		if (isTicker(symbol)) removed.set(symbol, Boolean(row.fields.removed_at));
	}
	return [...removed].filter(([, out]) => !out).map(([symbol]) => symbol);
}

/** The latest session closed ALERT_AFTER_CLOSE_MS ago, and the one before: events on either are recent enough to post. */
function recentSessions(tickMs: number): [string, string] {
	let date = newYorkDate(tickMs);
	while (!(isTradingDay(date) && closeOf(date) + ALERT_AFTER_CLOSE_MS <= tickMs)) date = shiftDate(date, -1);
	let before = shiftDate(date, -1);
	while (!isTradingDay(before)) before = shiftDate(before, -1);
	return [before, date];
}

function readCursor(text: string | null): Cursor {
	try {
		const saved = text === null ? undefined : (JSON.parse(text) as Partial<Cursor>);
		return { sent: Array.isArray(saved?.sent) ? saved.sent.filter((s): s is string => typeof s === "string") : [] };
	} catch {
		return { sent: [] };
	}
}

/** Whether the rich IV sits on an earnings date inside the contract's life: such IV collapses after the report. */
async function earningsLine(entry: RichEntry, symbol: string, baseUrl: string): Promise<string> {
	const key = process.env.FINNHUB_API_KEY ?? "";
	if (key === "") return "财报日没查（没有设置 FINNHUB_API_KEY），要自己分清这段高 IV 是不是财报撑的。";
	try {
		// From the rich session itself, reported or not: an after-close report that day is what lifted its IV.
		const date = await earningsOf(baseUrl, key, symbol, entry.date, true);
		if (date !== null && date <= entry.expiry) return `到 ${entry.expiry} 到期前有财报（${date}），这段高 IV 多半是财报撑的，财报后会坍塌。`;
		return `到 ${entry.expiry} 到期前没有已宣布的财报，偏贵不是财报撑的。`;
	} catch (error) {
		if (!failedRequest(error)) throw error;
		return `财报日没查到（${error.message}），要自己分清这段高 IV 是不是财报撑的。`;
	}
}

function vixAlert(e: VixEvent): Omit<Alert, "at"> {
	if (e.kind === "inverted") return { id: `vix-inverted:${e.date}`, text: `VIX 期限结构倒挂：${e.date} 收盘 VIX ${two(e.vix)}，不低于 VIX3M ${two(e.vix3m)}。市场认为近期有事，近月期权更贵。${NOTICE}`, push: "silent" };
	if (e.ring) return { id: `vix-${e.level}:${e.date}`, text: `VIX ${e.date} 收盘 ${two(e.vix)}，上穿 ${e.level}，进入「${vixLevel(e.vix)}」档，到了卖方风控线。笔记里的做法是已有卖方仓位考虑离场。${NOTICE}` };
	return { id: `vix-${e.level}:${e.date}`, text: `VIX ${e.date} 收盘 ${two(e.vix)}，上穿 ${e.level}，进入「${vixLevel(e.vix)}」档。期权整体变贵；笔记里的做法是卖方分批、带保护。${NOTICE}`, push: "silent" };
}

export default async function volAlerts(input: Input) {
	const tickMs = Date.parse(input.now);
	const recent = new Set(recentSessions(tickMs));
	const cursor = readCursor(input.cursor);
	const fresh = (id: string) => !cursor.sent.includes(id);
	const found: Omit<Alert, "at">[] = vixEvents(readVixSeries()).filter((e) => recent.has(e.date)).map(vixAlert).filter((a) => fresh(a.id));

	const tag = methodology();
	for (const symbol of listed(input.rows.watchlist ?? [])) {
		const { series, closes } = readIvSeries(symbol, tag);
		const entry = richEntries(series, closes).at(-1);
		// Only an entry on the symbol's latest stored session: a later session already moved on from it.
		if (entry === undefined || entry.date !== series.at(-1)?.date || !recent.has(entry.date)) continue;
		const id = `iv-rich:${symbol}:${entry.date}`;
		if (!fresh(id)) continue;
		const head = `${symbol} 期权偏贵：${entry.date} 收盘 IV ${pct(entry.iv)}%，在最近 ${entry.days} 个交易日里的 ${pct(entry.percentile)} 分位，IV/HV20 ${two(entry.ratio)}。`;
		const tail = "偏卖方的环境：笔记里的做法是卖方分批、带保护（比如价差），买方单腿要防 IV 坍塌。";
		found.push({ id, text: `${head}${await earningsLine(entry, symbol, input.settings.finnhubBaseUrl)}${tail}${NOTICE}` });
	}

	const at = new Date(tickMs).toISOString();
	cursor.sent = [...cursor.sent, ...found.map((a) => a.id)].slice(-SENT_KEPT);
	return { records: [], alerts: found.map((a) => ({ ...a, at })), cursor: JSON.stringify(cursor satisfies Cursor) };
}
