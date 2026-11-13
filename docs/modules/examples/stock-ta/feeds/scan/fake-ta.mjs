// Stands in for the venv's `ta` in this feed's fixture: answers `calendar` and `scan` without the network.
import { DatabaseSync } from "node:sqlite";

let text = "";
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text || "{}");
if (process.argv[2] === "calendar") {
	const weekday = new Date(`${input.date}T12:00:00Z`).getUTCDay();
	const trading = weekday >= 1 && weekday <= 5;
	console.log(JSON.stringify({ date: input.date, is_trading_day: trading, close: trading ? `${input.date}T21:00:00+00:00` : null }));
} else {
	const db = new DatabaseSync(process.env.TA_DB_PATH);
	db.exec("CREATE TABLE IF NOT EXISTS bars (symbol TEXT)");
	const insert = db.prepare("INSERT INTO bars VALUES (?)");
	db.exec("BEGIN");
	for (const symbol of input.symbols) insert.run(symbol);
	db.exec("COMMIT");
	db.close();
	console.log(JSON.stringify({ scan_id: 1, symbol_count: input.symbols.length, new_signals: [], errors: [] }));
}
