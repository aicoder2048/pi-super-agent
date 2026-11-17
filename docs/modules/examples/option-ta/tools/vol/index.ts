import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dataDbPath } from "../../data-db.ts";
import { addDays, MARKET_NOTE, nyParts, nyStamp, parseChain, type ChainRow } from "../../chain-rows.ts";
import { impliedVolPut } from "../../iv.ts";
import { dteOn, ivPercentile, ivRank, IV_SERIES_TENOR } from "../../iv-history.ts";
import { fail, MarketError, MISSING_KEY, prevClose, query, REQUEST_LIMIT_MS, snapshotPages } from "../../massive.ts";
import { isTicker } from "../../symbols.ts";
import { classifyIvHvRatio, hv20 } from "../../vol-regime.ts";

/** Term structure: the expiry nearest each of these calendar-day targets. */
const TERM_TARGET_DAYS = [7, 30, 60, 90] as const;
const TERM_WINDOW_DAYS = 100;
/** Strike bands around the previous close: narrow for at-the-money puts across expiries, wide for one expiry's skew. */
const TERM_STRIKE_BAND = 0.02;
/** At least this many dollars each side, so a $5 strike grid still has a strike near the money. */
const TERM_STRIKE_MIN_HALF_WIDTH = 5;
const SKEW_STRIKE_BAND = 0.2;
const SKEW_DELTA = 0.25;
const RANK_WINDOW_DAYS = 365;

const CLASS_LABEL: Record<string, string> = { cheap: "便宜", slightly_cheap: "略便宜", fair: "合理", rich: "偏贵", very_rich: "很贵" };

const UNITS = "IV、HV、rank、百分位、偏斜都是小数（0.2163 是 21.63%）；ratio 是 IV 除以 HV20；dte 是到到期日美东 16:00 的日历天数；正股价的延迟见 underlying.delay";

const r4 = (n: number | null) => (n === null ? null : Math.round(n * 10000) / 10000);
const pick = (row: ChainRow) => ({ contract: row.contract, expiry: row.expiry, dte: row.dte, strike: row.strike, iv: row.iv, iv_source: row.iv_source });

export default async function vol(input: Record<string, unknown>) {
	try {
		const symbol = typeof input["symbol"] === "string" ? input["symbol"].trim().toUpperCase() : "";
		if (!isTicker(symbol)) fail("INVALID_INPUT", "symbol 要是美股或 ETF 代码，例如 SPY");
		const nowMs = input["now"] === undefined ? Date.now() : Date.parse(String(input["now"]));
		if (Number.isNaN(nowMs)) fail("INVALID_INPUT", "now 要是 ISO 8601 时间，只在回放时填");
		const key = process.env["POLYGON_API_KEY"] ?? "";
		if (key === "") fail("NO_KEY", MISSING_KEY);
		const signal = AbortSignal.timeout(REQUEST_LIMIT_MS);
		const today = nyParts(nowMs).date;
		const close = await prevClose(symbol, key, signal);
		const halfWidth = Math.max(close * TERM_STRIKE_BAND, TERM_STRIKE_MIN_HALF_WIDTH);
		const termPages = await snapshotPages(query(symbol, [
			["contract_type", "put"],
			["expiration_date.gte", today],
			["expiration_date.lte", addDays(today, TERM_WINDOW_DAYS)],
			["strike_price.gte", Math.floor(close - halfWidth)],
			["strike_price.lte", Math.ceil(close + halfWidth)],
		]), key, signal);
		const term = parseChain(symbol, termPages.rows, nowMs);
		if (term.rows.length === 0) fail("NO_DATA", `行情服务没有 ${symbol} 平值附近的标准 put，算不了波动率`);
		const spot = term.underlying?.price ?? close;
		const atmByExpiry = atTheMoney(term.rows, spot);
		const inBand = [...atmByExpiry.values()].find((row) => row.dte >= IV_SERIES_TENOR.min && row.dte <= IV_SERIES_TENOR.max && row.iv !== null) ?? null;
		// A gap past the strike filter leaves only edge strikes; an edge strike is not at the money.
		const offCentre = inBand !== null && Math.abs(inBand.strike - spot) > halfWidth;
		const atm = offCentre ? null : inBand;
		const atmNote = atm !== null ? undefined
			: offCentre ? `正股价 ${spot} 离上一交易日收盘 ${close} 太远，取回的行权价里没有平值的，平值 IV、IV/HV 和偏斜没算`
			: termPages.truncated ? `期权链超过分页上限，没取全；取到的部分里 ${IV_SERIES_TENOR.min} 到 ${IV_SERIES_TENOR.max} 天内没有带 IV 的到期日，平值 IV、IV/HV 和偏斜没算`
			: `${IV_SERIES_TENOR.min} 到 ${IV_SERIES_TENOR.max} 天内没有带 IV 的到期日，平值 IV、IV/HV 和偏斜没算`;
		const skewPages = atm === null ? null : await snapshotPages(query(symbol, [
			["expiration_date", atm.expiry],
			["strike_price.gte", Math.floor(close * (1 - SKEW_STRIKE_BAND))],
			["strike_price.lte", Math.ceil(close * (1 + SKEW_STRIKE_BAND))],
		]), key, signal);
		const history = readHistory(symbol);
		const hv = history.status === "OK" ? history.hv20 : null;
		const ratio = atm?.iv != null && hv !== null && hv > 0 ? atm.iv / hv : null;
		return {
			status: "OK",
			symbol,
			fetched_at: nyStamp(nowMs),
			market: term.market,
			...(term.market === "休市" && { market_note: MARKET_NOTE }),
			underlying: term.underlying,
			atm: atm === null ? null : pick(atm),
			...(atmNote !== undefined && { atm_note: atmNote }),
			iv_hv: { hv20: hv, ratio: r4(ratio), class: ratio === null ? null : CLASS_LABEL[classifyIvHvRatio(atm!.iv, hv)!]! },
			term: termStructure(atmByExpiry),
			...(new Set(termStructure(atmByExpiry).map((t) => t.iv_source)).size > 1 && { term_note: "期限结构里有的 IV 是供应方的、有的是自算的，口径不同，比较时看 iv_source" }),
			skew: skewPages === null ? null : skew(parseChain(symbol, skewPages.rows, nowMs).rows, atm!.expiry),
			history,
			truncated: termPages.truncated || (skewPages?.truncated ?? false),
			units: UNITS,
		};
	} catch (error) {
		if (error instanceof MarketError) return error.failure;
		throw error;
	}
}

/** Per expiry, the put whose strike is nearest the underlying price; ties go to the lower strike, as selectAtmContract does. */
function atTheMoney(rows: readonly ChainRow[], spot: number): Map<string, ChainRow> {
	const best = new Map<string, ChainRow>();
	for (const row of rows) {
		if (row.right !== "put") continue;
		const held = best.get(row.expiry);
		const d = Math.abs(row.strike - spot) - (held === undefined ? Infinity : Math.abs(held.strike - spot));
		if (d < 0 || (d === 0 && row.strike < held!.strike)) best.set(row.expiry, row);
	}
	return new Map([...best].sort(([a], [b]) => a.localeCompare(b)));
}

function termStructure(atm: Map<string, ChainRow>) {
	const rows = [...atm.values()];
	const chosen = new Set(TERM_TARGET_DAYS.map((target) => rows.reduce((a, b) => (Math.abs(b.dte - target) < Math.abs(a.dte - target) ? b : a))));
	return rows.filter((row) => chosen.has(row)).map(pick);
}

function skew(rows: readonly ChainRow[], expiry: string) {
	const nearest = (right: "put" | "call", target: number) =>
		rows.filter((r) => r.expiry === expiry && r.right === right && r.delta !== null && r.iv !== null).reduce<ChainRow | null>((a, b) => (a === null || Math.abs(b.delta! - target) < Math.abs(a.delta! - target) ? b : a), null);
	const side = (row: ChainRow | null) => (row === null ? null : { contract: row.contract, strike: row.strike, delta: row.delta, iv: row.iv, iv_source: row.iv_source, greeks_source: row.greeks_source });
	const put = nearest("put", -SKEW_DELTA), call = nearest("call", SKEW_DELTA);
	// Spec「行情取数规则」: provider and self-computed values are not compared with each other.
	const comparable = put !== null && call !== null && put.iv_source === call.iv_source;
	return {
		expiry,
		target_delta: SKEW_DELTA,
		put: side(put),
		call: side(call),
		put_minus_call: comparable ? r4(put.iv! - call.iv!) : null,
		...(put !== null && call !== null && !comparable && { note: "put 和 call 的 IV 一边是供应方的、一边是自算的，不相减" }),
	};
}

type SnapshotRow = { trade_date: string; strike: number | null; expiry: string | null; contract_close: number | null; underlying_close: number | null; data_status: string | null };

/** The iv feed's methodology tag; rows of another methodology are a different series and never mix in. */
const methodology = (): string => JSON.parse(readFileSync(new URL("../../feeds/iv/feed.json", import.meta.url), "utf8")).settings.methodology;

function readHistory(symbol: string) {
	const tag = methodology();
	const none = { status: "NO_HISTORY", methodology: tag, reason: `iv-snapshots 里还没有 ${symbol} 的 IV 原始输入：标的加进期权自选后，iv feed 回填一年，之后每天收盘后存一行。IV rank、百分位和 HV20 没算` };
	const file = dataDbPath();
	if (file === undefined) return none;
	const db = new DatabaseSync(file, { readOnly: true });
	let rows: SnapshotRow[];
	try {
		if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'iv-snapshots'`).get() === undefined) return none;
		rows = db.prepare(`SELECT trade_date, strike, expiry, contract_close, underlying_close, data_status FROM "iv-snapshots" WHERE symbol = ? AND methodology = ? ORDER BY trade_date, "_id"`).all(symbol, tag) as SnapshotRow[];
	} finally {
		db.close();
	}
	const byDate = new Map(rows.filter((r) => typeof r.trade_date === "string").map((r) => [r.trade_date, r]));
	const series = [...byDate.values()].flatMap((r) => {
		if (r.data_status !== "ok" || r.contract_close === null || r.underlying_close === null || r.strike === null || r.expiry === null) return [];
		const iv = impliedVolPut(r.contract_close, r.underlying_close, r.strike, dteOn(r.trade_date, r.expiry));
		return iv === null ? [] : [{ date: r.trade_date, iv }];
	});
	if (series.length === 0) return none;
	const latest = series.at(-1)!;
	const window = series.filter((p) => p.date >= addDays(latest.date, -RANK_WINDOW_DAYS)).map((p) => p.iv);
	const closes = Object.fromEntries([...byDate].flatMap(([date, r]) => (r.underlying_close !== null && r.underlying_close > 0 ? [[date, r.underlying_close]] : [])));
	return {
		status: "OK",
		methodology: tag,
		days: window.length,
		from: series.find((p) => p.date >= addDays(latest.date, -RANK_WINDOW_DAYS))!.date,
		to: latest.date,
		latest_iv: r4(latest.iv),
		iv_rank: r4(ivRank(latest.iv, window)),
		iv_percentile: r4(ivPercentile(latest.iv, window)),
		hv20: r4(hv20(closes, Object.keys(closes).sort(), [...byDate.keys()].sort().at(-1)!)),
	};
}
