/**
 * The IV series of one symbol, read back from the iv feed's `iv-snapshots` and solved from each day's contract close with the
 * same formula (tools/vol and feeds/vol-alerts share it). Only rows of `methodology` count; a day without a usable row is left out.
 */
import { DatabaseSync } from "node:sqlite";
import { dataDbPath } from "./data-db.ts";
import { impliedVolPut } from "./iv.ts";
import { dteOn } from "./iv-history.ts";

type SnapshotRow = { trade_date: string; strike: number | null; expiry: string | null; contract_close: number | null; underlying_close: number | null; data_status: string | null };

export type IvPoint = { date: string; iv: number; expiry: string };
/** `series`: oldest first. `closes`: the underlying's close by date, also on days whose IV is missing. */
export type IvSeries = { series: IvPoint[]; closes: Record<string, number> };

export function readIvSeries(symbol: string, methodology: string): IvSeries {
	const empty = { series: [], closes: {} };
	const file = dataDbPath();
	if (file === undefined) return empty;
	const db = new DatabaseSync(file, { readOnly: true });
	let rows: SnapshotRow[];
	try {
		if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'iv-snapshots'`).get() === undefined) return empty;
		rows = db.prepare(`SELECT trade_date, strike, expiry, contract_close, underlying_close, data_status FROM "iv-snapshots" WHERE symbol = ? AND methodology = ? ORDER BY trade_date, "_id"`).all(symbol, methodology) as SnapshotRow[];
	} finally {
		db.close();
	}
	const byDate = new Map(rows.filter((r) => typeof r.trade_date === "string").map((r) => [r.trade_date, r]));
	const dates = [...byDate.keys()].sort();
	const series = dates.flatMap((date) => {
		const r = byDate.get(date)!;
		if (r.data_status !== "ok" || r.contract_close === null || r.underlying_close === null || r.strike === null || r.expiry === null) return [];
		const iv = impliedVolPut(r.contract_close, r.underlying_close, r.strike, dteOn(date, r.expiry));
		return iv === null ? [] : [{ date, iv, expiry: r.expiry }];
	});
	const closes = Object.fromEntries(dates.flatMap((date) => {
		const c = byDate.get(date)!.underlying_close;
		return c !== null && c > 0 ? [[date, c]] : [];
	}));
	return { series, closes };
}
