import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bsPutPrice } from "../../docs/modules/examples/option-ta/options-math.ts";

/**
 * Synthetic `iv-snapshots` rows for SPY with known IVs, so a test can derive the expected rank, percentile and HV20 from
 * these lists instead of from the code under test. Run this file to rewrite the vol tool's committed fixture database.
 */
export const METHODOLOGY = "option-ta-iv-close-v1";
export const KNOWN_IV = [0.18, 0.19, 0.2, 0.22, 0.25, 0.3, 0.28, 0.26, 0.24, 0.22, 0.21, 0.2, 0.19, 0.18, 0.17, 0.16, 0.15, 0.16, 0.17, 0.18, 0.19, 0.2, 0.21, 0.22, 0.23];
export const DAILY_RETURN = [0, 0.01, -0.005, 0.012, -0.008, 0.004, -0.011, 0.007, 0.003, -0.002, 0.009, -0.006, 0.005, -0.01, 0.006, 0.002, -0.004, 0.008, -0.007, 0.011, -0.003, 0.001, 0.004, -0.009, 0.006];
/** The day whose contract had no daily bar: its IV is not in the series, its underlying close still is. */
export const NO_DATA_INDEX = 5;
export const TRADE_DATES = weekdaysEndingOn("2026-11-16", KNOWN_IV.length);
export const CLOSES = DAILY_RETURN.reduce<number[]>((all, r, i) => [...all, i === 0 ? 700 : all[i - 1]! * Math.exp(r)], []);

function weekdaysEndingOn(last: string, count: number): string[] {
	const out: string[] = [];
	for (let t = Date.parse(`${last}T00:00:00Z`); out.length < count; t -= 86_400_000) {
		const day = new Date(t).getUTCDay();
		if (day !== 0 && day !== 6) out.unshift(new Date(t).toISOString().slice(0, 10));
	}
	return out;
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function historyRows() {
	const rows = TRADE_DATES.map((trade_date, i) => {
		const underlying_close = CLOSES[i]!;
		const strike = Math.round(underlying_close);
		const ok = i !== NO_DATA_INDEX;
		return {
			symbol: "SPY",
			trade_date,
			option_symbol: `O:SPY${addDays(trade_date, 30).slice(2).replaceAll("-", "")}P${String(strike * 1000).padStart(8, "0")}`,
			strike,
			expiry: addDays(trade_date, 30),
			contract_close: ok ? Math.round(bsPutPrice(underlying_close, strike, KNOWN_IV[i]!, 30) * 1e6) / 1e6 : null,
			underlying_close,
			methodology: METHODOLOGY,
			data_status: ok ? "ok" : "no-data",
		};
	});
	const older = { ...rows[0]!, trade_date: "2026-09-01", expiry: "2026-10-01", contract_close: 40, methodology: "option-ta-iv-close-v0", data_status: "ok" };
	const other = { ...rows.at(-1)!, symbol: "QQQ", contract_close: 60 };
	return [older, ...rows, other];
}

export function writeHistory(dataDir: string) {
	mkdirSync(dataDir, { recursive: true });
	const file = join(dataDir, "data.db");
	rmSync(file, { force: true });
	const db = new DatabaseSync(file);
	try {
		db.exec(`CREATE TABLE "iv-snapshots" ("_id" INTEGER PRIMARY KEY, "_from" TEXT NOT NULL, "_sources" TEXT, "symbol" TEXT, "trade_date" TEXT, "option_symbol" TEXT, "strike" REAL, "expiry" TEXT, "contract_close" REAL, "underlying_close" REAL, "quote_midpoint" REAL, "quote_at" TEXT, "fetched_at" TEXT, "source" TEXT, "methodology" TEXT, "data_status" TEXT, "reason" TEXT)`);
		const insert = db.prepare(`INSERT INTO "iv-snapshots" ("_from", "symbol", "trade_date", "option_symbol", "strike", "expiry", "contract_close", "underlying_close", "methodology", "data_status") VALUES ('feed:iv', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		for (const r of historyRows()) insert.run(r.symbol, r.trade_date, r.option_symbol, r.strike, r.expiry, r.contract_close, r.underlying_close, r.methodology, r.data_status);
	} finally {
		db.close();
	}
}

if (import.meta.main) writeHistory(new URL("../../docs/modules/examples/option-ta/tools/vol/fixtures/history/", import.meta.url).pathname);
