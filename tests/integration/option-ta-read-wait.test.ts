import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readCollections } from "../../docs/modules/examples/option-ta/data-db.ts";
import { readIvSeries } from "../../docs/modules/examples/option-ta/iv-series.ts";
import { marketRegime, readVixSeries } from "../../docs/modules/examples/option-ta/vix.ts";

/** A child process holding SQLite's exclusive lock on `file` (rollback journal, as the host's data.db) for `ms`; resolves once it holds it. */
function holdLock(file: string, ms: number): Promise<{ done: Promise<void> }> {
	const child = spawn(process.execPath, ["-e", `
		const { DatabaseSync } = require("node:sqlite");
		const db = new DatabaseSync(${JSON.stringify(file)});
		db.exec("BEGIN EXCLUSIVE");
		console.log("locked");
		setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${ms});
	`], { stdio: ["ignore", "pipe", "inherit"] });
	const done = new Promise<void>((resolve) => child.on("exit", () => resolve()));
	return new Promise((resolve) => child.stdout.once("data", () => resolve({ done })));
}

test("option-ta 只读打开 data.db 时，宿主正在写（回滚日志的独占锁）就等它写完再读，不报 database is locked", async () => {
	const dir = mkdtempSync(join(tmpdir(), "option-ta-lock-"));
	const file = join(dir, "data.db");
	const saved = process.env["PSA_MODULE_DATA"];
	process.env["PSA_MODULE_DATA"] = dir;
	try {
		const db = new DatabaseSync(file);
		db.exec(`PRAGMA journal_mode = DELETE; CREATE TABLE "vix-closes" ("_id" INTEGER PRIMARY KEY, ticker TEXT, trade_date TEXT, close REAL); INSERT INTO "vix-closes" (ticker, trade_date, close) VALUES ('VIX', '2026-11-18', 24.56)`);
		db.exec(`CREATE TABLE "iv-snapshots" ("_id" INTEGER PRIMARY KEY, symbol TEXT, trade_date TEXT, strike REAL, expiry TEXT, contract_close REAL, underlying_close REAL, methodology TEXT, data_status TEXT)`);
		db.close();

		const bare = await holdLock(file, 800);
		assert.throws(() => new DatabaseSync(file, { readOnly: true }).prepare(`SELECT * FROM "vix-closes"`).all(), /locked/, "不等的话就是线上那个错");
		await bare.done;

		for (const read of [() => marketRegime(readVixSeries()).status, () => readIvSeries("SPY", "x").series.length, () => readCollections(["vix-closes"])["vix-closes"].length]) {
			const lock = await holdLock(file, 800);
			const started = Date.now();
			const result = read();
			assert.ok(Date.now() - started >= 300, "等到锁放开才读到");
			assert.ok(result === "OK" || result === 0 || result === 1, String(result));
			await lock.done;
		}
	} finally {
		if (saved === undefined) delete process.env["PSA_MODULE_DATA"];
		else process.env["PSA_MODULE_DATA"] = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});
