/**
 * The market's volatility regime from CBOE's VIX, VIX9D and VIX3M daily closes (knowledge/vol-regime): the VIX level band, the
 * term structure and the VIX's one-year percentile. The vix feed stores the closes in `vix-closes`; tools/vol reads them back.
 */
import { DatabaseSync } from "node:sqlite";
import { dataDbPath } from "./data-db.ts";

export const VIX_INDICES = ["VIX", "VIX9D", "VIX3M"] as const;
export type VixIndex = (typeof VIX_INDICES)[number];

/**
 * Lower bounds of each VIX level band, from the user's WatchAndLearn notes: under 15 calm, 15 to 20 normal, above 25 starting
 * to get nervous, around 35 panic, above 50 crisis. The notes leave 20 to 25 unnamed; it is called 偏高 here.
 */
export const VIX_LEVELS = { normal: 15, elevated: 20, nervous: 25, panic: 35, crisis: 50 } as const;
/** The seller's risk line in the notes: VIX breaking above it is the preset point to close short premium. */
export const VIX_SELLER_RISK_LINE = VIX_LEVELS.panic;
export const VIX_PERCENTILE_DAYS = 365;

export function vixLevel(close: number): string {
	if (close >= VIX_LEVELS.crisis) return "危机";
	if (close >= VIX_LEVELS.panic) return "恐慌";
	if (close >= VIX_LEVELS.nervous) return "开始紧张";
	if (close >= VIX_LEVELS.elevated) return "偏高";
	if (close >= VIX_LEVELS.normal) return "正常";
	return "平静";
}

/** Contango when the 3-month VIX is above the 30-day one; at or below it the curve is inverted (the market sees trouble near). */
export const isInverted = (vix: number, vix3m: number): boolean => vix >= vix3m;

export type Close = { date: string; open: number; high: number; low: number; close: number };

/** CBOE's `DATE,OPEN,HIGH,LOW,CLOSE` history with MM/DD/YYYY dates; rows that do not parse are skipped. Throws when the header is not that. */
export function parseCboeHistory(text: string): Close[] {
	const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
	if (lines[0]?.trim().toUpperCase() !== "DATE,OPEN,HIGH,LOW,CLOSE") throw new Error(`CBOE 的历史文件表头不是 DATE,OPEN,HIGH,LOW,CLOSE：${(lines[0] ?? "").slice(0, 60)}`);
	return lines.slice(1).flatMap((line) => {
		const [date, ...prices] = line.split(",");
		const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date?.trim() ?? "");
		const [open, high, low, close] = prices.map(Number);
		if (m === null || prices.length !== 4 || ![open, high, low, close].every((n) => Number.isFinite(n) && n! > 0)) return [];
		return [{ date: `${m[3]}-${m[1]}-${m[2]}`, open: open!, high: high!, low: low!, close: close! }];
	});
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export type VixSeries = Record<VixIndex, Map<string, number>>;

/** Each index's closes by date from `vix-closes`; empty when the vix feed has stored nothing yet. */
export function readVixSeries(): VixSeries {
	const series = Object.fromEntries(VIX_INDICES.map((i) => [i, new Map<string, number>()])) as VixSeries;
	const file = dataDbPath();
	if (file === undefined) return series;
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vix-closes'`).get() === undefined) return series;
		const rows = db.prepare(`SELECT ticker, trade_date, close FROM "vix-closes" ORDER BY trade_date, "_id"`).all() as { ticker: string; trade_date: string; close: number | null }[];
		for (const row of rows) {
			const map = series[row.ticker as VixIndex];
			if (map !== undefined && typeof row.close === "number" && row.close > 0) map.set(row.trade_date, row.close);
		}
		return series;
	} finally {
		db.close();
	}
}

export type MarketRegime =
	| { status: "NO_DATA"; reason: string }
	| {
			status: "OK";
			date: string;
			vix: number;
			level: string;
			vix9d: number | null;
			vix3m: number | null;
			term: "正常（远月高于近月）" | "倒挂" | null;
			vix_over_vix3m: number | null;
			vix_percentile_1y: number | null;
			days: number;
			source: string;
			note?: string;
	  };

/**
 * The regime on the VIX's latest stored session. The term structure compares that same session's VIX3M (and shows VIX9D); a
 * missing one leaves the term empty, never compared across days. The percentile is the share of the past year's closes below it.
 */
export function marketRegime(series: VixSeries): MarketRegime {
	const dates = [...series.VIX.keys()].sort();
	const date = dates.at(-1);
	if (date === undefined) return { status: "NO_DATA", reason: "vix-closes 里还没有 VIX 收盘：vix feed 每个交易日收盘后从 CBOE 取，第一次回填一年。VIX 档位、期限结构没算" };
	const vix = series.VIX.get(date)!;
	const vix9d = series.VIX9D.get(date) ?? null;
	const vix3m = series.VIX3M.get(date) ?? null;
	const window = dates.filter((d) => d > addDays(date, -VIX_PERCENTILE_DAYS)).map((d) => series.VIX.get(d)!);
	return {
		status: "OK",
		date,
		vix,
		level: vixLevel(vix),
		vix9d,
		vix3m,
		term: vix3m === null ? null : isInverted(vix, vix3m) ? "倒挂" : "正常（远月高于近月）",
		vix_over_vix3m: vix3m === null ? null : r4(vix / vix3m),
		vix_percentile_1y: window.length < 2 ? null : r4(window.filter((v) => v < vix).length / window.length),
		days: window.length,
		source: "CBOE 每日收盘（VIX、VIX9D、VIX3M 历史文件）",
		...(vix3m === null && { note: `${date} 的 VIX3M 还没有，期限结构没比` }),
	};
}
