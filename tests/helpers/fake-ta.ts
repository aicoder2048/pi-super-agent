import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ScanPlan =
	| { kind: "ok"; rows?: number; signals?: number }
	| { kind: "partial"; failing: string[] }
	| { kind: "down" }
	| { kind: "dividends" }
	| { kind: "skip" }
	| { kind: "exit" }
	| { kind: "sleep" };

export type TaCall = { cmd: string; input: Record<string, unknown>; key?: string; base?: string; db?: string; seen: { next: string | null; journal: boolean; lock: boolean } };

const FAKE_TA = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
let text = "";
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text || "{}");
const cmd = process.argv[2];
const db = process.env.TA_DB_PATH;
const sha = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);
appendFileSync(config.log, JSON.stringify({ cmd, input, key: process.env.MASSIVE_API_KEY, base: process.env.MASSIVE_BASE_URL, db, seen: { next: db ? sha(db) : null, journal: existsSync(db + "-journal"), lock: existsSync(db + ".scan.lock") } }) + "\\n");
const out = (value) => console.log(JSON.stringify(value));
if (cmd === "calendar") {
	const day = new Date(input.date + "T12:00:00Z").getUTCDay();
	const trading = day >= 1 && day <= 5;
	out({ date: input.date, is_trading_day: trading, open: trading ? input.date + "T14:30:00+00:00" : null, close: trading ? input.date + "T21:00:00+00:00" : null, delay_minutes: 15 });
	process.exit(0);
}
const plan = config.scan;
const invalid = input.symbols.find((s) => !/^[A-Z]{1,10}(?:\\.[A-Z]{1,2})?$/.test(String(s).trim().toUpperCase().replaceAll("-", ".")));
if (invalid !== undefined) {
	console.error(JSON.stringify({ error: { code: "INVALID_SYMBOL", message: "标的代码格式无效。" } }));
	process.exit(1);
}
const symbols = input.symbols;
const write = (rows) => {
	const store = new DatabaseSync(db);
	store.exec("CREATE TABLE IF NOT EXISTS bars (symbol TEXT, n INTEGER)");
	const insert = store.prepare("INSERT INTO bars VALUES (?, ?)");
	store.exec("BEGIN");
	for (let i = 0; i < rows; i++) insert.run(symbols[i % symbols.length], i);
	store.exec("COMMIT");
	store.close();
};
const error = (symbol, code) => ({ symbol, error: { code, message: code === "MARKET_UNAVAILABLE" ? "行情服务不可用。" : "日线数据无效。", hint: "稍后重试。" } });
if (plan.kind === "exit") {
	write(3);
	console.error(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "内部错误。" } }));
	process.exit(2);
}
if (plan.kind === "sleep") {
	write(3);
	await new Promise((done) => setTimeout(done, 60_000));
}
if (plan.kind === "skip") {
	out({ scan_id: 1, symbol_count: 0, new_signals: [], errors: [], skipped: true, reason: "纽约日期不是交易日。", next_scan: "2026-11-16T21:15:30+00:00" });
	process.exit(0);
}
write(plan.rows ?? symbols.length);
const errors = plan.kind === "dividends" ? symbols.map((s) => ({ symbol: s, error: { code: "DIVIDENDS_UNAVAILABLE", message: "分红不可用，当前仅拆股复权。" } })) : plan.kind === "down" ? symbols.map((s) => error(s, "MARKET_UNAVAILABLE")) : plan.kind === "partial" ? plan.failing.map((s) => error(s, "MARKET_DATA_INVALID")) : [];
if (plan.kind === "ok") errors.push({ symbol: "QQQ", error: { code: "DIVIDENDS_UNAVAILABLE", message: "分红更新不可用，使用已缓存分红。" } });
out({ scan_id: 1, symbol_count: symbols.length, new_signals: Array.from({ length: plan.signals ?? 0 }, (_, i) => ({ id: i })), errors });
`;

/** Reads its plan from the config.json beside it, since the feed passes it no env of ours. */
export function fakeTa(dir: string, plan: ScanPlan = { kind: "ok" }) {
	mkdirSync(dir, { recursive: true });
	const log = join(dir, "calls.log");
	const script = join(dir, "ta.mjs");
	writeFileSync(script, FAKE_TA);
	const setPlan = (scan: ScanPlan) => writeFileSync(join(dir, "config.json"), JSON.stringify({ log, scan }));
	setPlan(plan);
	const calls = (): TaCall[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
	return { script, setPlan, calls, scans: () => calls().filter((c) => c.cmd === "scan") };
}
