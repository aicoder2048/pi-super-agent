import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { importBrokerCsv } from "../../docs/modules/examples/option-ta/broker-import.ts";
import { PACKAGE } from "../helpers/option-ta-ledger-db.ts";

/** The samples and their accounts are made up. */
const FIXTURES = join(PACKAGE, "tools/import/fixtures");
const accounts = JSON.parse(readFileSync(join(FIXTURES, "account-aliases.sample.json"), "utf8")).accounts
	.map((a: Record<string, unknown>) => ({ ...a, aliases: JSON.stringify(a.aliases) }));
const JPM = readFileSync(join(FIXTURES, "jpm-sample.csv"), "utf8");
const ETRADE = readFileSync(join(FIXTURES, "etrade-sample.csv"), "utf8");
const DAY = "2026-11-17";
const KEY = "DIA261030P00470000:STO:2026-10-27:JPM-NORT-4411";
const CONTRACT = { underlying: "DIA", option_symbol: "DIA261030P00470000", right: "put", strike: 470, expiry: "2026-10-30", multiplier: 100 };
type Row = Record<string, unknown>;

/** A fill the mail feed wrote after #197: registered name, original short code kept, no fees or settle date known. */
const mailed = (_id: number, cum: number, qty: number): Row => ({
	_id, ...CONTRACT, instrument: JSON.stringify(CONTRACT), record_type: "FILL", fill_id: `${KEY}:cum${cum}`, order_key: KEY, account_ref: "JPM-NORT-4411",
	account_alias_seen: "NORTx4411", source_message_id: "msg-fictional-1", side: "STO", qty, cum_qty: cum, price: "1.1500", trade_date: "2026-10-27",
	settle_date: null, commission: null, fees: null, order_id: null, partial_fill: cum === 20 ? "false" : "true", source: "broker-email",
});
const run = (fills: Row[], csv = JPM, broker: "jpm" | "etrade" = "jpm") => importBrokerCsv({ broker, csv, import_date: DAY, fills, accounts });
const stored = (rows: Row[], from: number) => rows.map((r, i) => ({ ...r, _id: from + i }));
const mine = (out: ReturnType<typeof run>) => out.fills.filter((f: Row) => String(f.fill_id ?? "").startsWith(KEY));

test("邮件按登记名记的成交缺费用：导出补齐——冲销旧行、写替代行，替代行换键并保留邮件短码；再导一次什么都不写", () => {
	const history = [mailed(1, 20, 20)];
	const first = run(history);
	const rows = mine(first);
	assert.deepEqual(rows.map((r) => [r.record_type, r.fill_id]), [["REVERSAL", `${KEY}:cum20:reversed-by-export`], ["FILL", `${KEY}:cum20:export`]]);
	const replacement = rows[1]!;
	assert.equal(replacement.commission, "60.0000");
	assert.equal(replacement.fees, "0.4200");
	assert.equal(replacement.settle_date, "2026-10-28");
	assert.equal(replacement.account_alias_seen, "NORTx4411");
	assert.equal(replacement.source_message_id, "msg-fictional-1");
	assert.deepEqual(first.needs_confirmation.filter((n: Row) => n.line === 4), []);
	const again = run([...history, ...stored(first.fills, 100)]);
	assert.deepEqual(again.fills, []);
	assert.deepEqual(again.needs_confirmation.filter((n: Row) => n.reason === "conflict"), []);
});

test("邮件分两笔记的部分成交（cum5 + cum20）：导出合并的一行对上，冲销两行、写一行替代；再导不冲突", () => {
	const history = [mailed(1, 5, 5), mailed(2, 20, 15)];
	const first = run(history);
	const rows = mine(first);
	assert.deepEqual(rows.map((r) => [r.record_type, r.fill_id]), [
		["REVERSAL", `${KEY}:cum5:reversed-by-export`], ["REVERSAL", `${KEY}:cum20:reversed-by-export`], ["FILL", `${KEY}:cum20:export`],
	]);
	assert.equal(rows[2]!.qty, 20);
	const again = run([...history, ...stored(first.fills, 100)]);
	assert.deepEqual(again.fills, []);
	assert.deepEqual(again.needs_confirmation.filter((n: Row) => n.reason === "conflict"), []);
});

test("导出最后一天之后的成交不在导出时段内，不报缺失", () => {
	const later = { ...mailed(1, 20, 20), fill_id: "DIA261127P00470000:STO:2026-11-10:JPM-NORT-4411:cum20", order_key: "DIA261127P00470000:STO:2026-11-10:JPM-NORT-4411", option_symbol: "DIA261127P00470000", expiry: "2026-11-27", trade_date: "2026-11-10" };
	const out = run([later]);
	assert.deepEqual(out.needs_confirmation.filter((n: Row) => n.reason === "missing-from-export"), []);
	assert.ok(out.reconciliation.some((r: Row) => r.id === later.fill_id && r.action === "outside-export-window"), JSON.stringify(out.reconciliation));
});

test("核实为零的费用写 0，不留空：eTrade 成交与交割、JPM 到期事件", () => {
	const etrade = run([], ETRADE, "etrade").fills.filter((f: Row) => f.record_type === "FILL");
	assert.ok(etrade.length > 0);
	for (const f of etrade) assert.equal(f.fees, "0.0000", JSON.stringify(f));
	const events = run([]).fills.filter((f: Row) => f.record_type === "EVENT");
	assert.ok(events.length > 0);
	for (const e of events) assert.deepEqual([e.commission, e.fees], ["0.0000", "0.0000"], JSON.stringify(e));
});

test("手动记过同合约同账户的到期、但日期不同：不再写第二条 EVENT，进待确认", () => {
	const manual = { _id: 1, ...CONTRACT, option_symbol: "DIA261023P00475000", strike: 475, expiry: "2026-10-23", record_type: "EVENT", type: "EXPIRE", event_id: "manual-expire-1", event_date: "2026-10-26", trade_date: "2026-10-26", qty: 20, account_ref: "JPM-NORT-4411", source: "manual" };
	const out = run([manual]);
	assert.deepEqual(out.fills.filter((f: Row) => f.record_type === "EVENT" && f.account_ref === "JPM-NORT-4411"), []);
	assert.ok(out.needs_confirmation.some((n: Row) => n.reason === "conflict" && n.line === 7), JSON.stringify(out.needs_confirmation));
});

test("eTrade 免责声明里有裸引号，不让整份文件作废", () => {
	const csv = ETRADE.replace("EXAMPLE TRADING from", 'EXAMPLE "TRADING" from');
	assert.notEqual(csv, ETRADE);
	assert.equal(run([], csv, "etrade").fills.length, run([], ETRADE, "etrade").fills.length);
});

test("库里有空行也不抛错", () => {
	assert.doesNotThrow(() => importBrokerCsv({ broker: "jpm", csv: JPM, import_date: DAY, fills: [null], accounts: [...accounts, null] }));
});
