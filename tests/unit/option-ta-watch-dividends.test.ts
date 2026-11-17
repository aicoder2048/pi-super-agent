import assert from "node:assert/strict";
import test from "node:test";
import { nextDividend } from "../../docs/modules/examples/option-ta/dividends.ts";

const cd = (ex: string, frequency: unknown = 4, amount = 1.25) => ({ ex_dividend_date: ex, frequency, dividend_type: "CD", cash_amount: amount });

test("今天及以后有已宣布的除息，取最早的那次，不推算", () => {
	const rows = [cd("2027-03-19", 4, 1.3), cd("2026-12-18", 4, 1.2), cd("2026-09-18")];
	assert.deepEqual(nextDividend(rows, "2026-11-17"), { kind: "announced", exDate: "2026-12-18", amount: 1.2 });
});

test("今天就是除息日也算已宣布", () => {
	assert.deepEqual(nextDividend([cd("2026-11-17", 4, 0.5)], "2026-11-17"), { kind: "announced", exDate: "2026-11-17", amount: 0.5 });
});

test("没宣布时按最近一次 CD 加 12/frequency 个月推算（P1 的 SPY 样本：09-18 季度 → 12-18）", () => {
	const rows = [cd("2026-09-18", 4, 1.888834), cd("2026-06-18", 4, 1.903516)];
	assert.deepEqual(nextDividend(rows, "2026-11-17"), { kind: "expected", exDate: "2026-12-18", amount: 1.888834 });
});

test("推出来的日子休市就往前取最近的交易日（12-25 圣诞 → 12-24）", () => {
	assert.deepEqual(nextDividend([cd("2026-09-25")], "2026-11-17"), { kind: "expected", exDate: "2026-12-24", amount: 1.25 });
});

test("推出来还在今天之前就再加一个周期，直到不早于今天", () => {
	// 05-15 → 08-15（周六，取 08-14）→ 11-15（周日，取 11-13）都早于 11-17 → 2027-02-15（总统日休市，取 02-12）
	assert.deepEqual(nextDividend([cd("2026-05-15")], "2026-11-17"), { kind: "expected", exDate: "2027-02-12", amount: 1.25 });
});

test("月底加月份落在不存在的日子，取那个月最后一天再往前找交易日", () => {
	// 11-30 + 3 个月 = 2027-02-28（周日）→ 02-26
	assert.deepEqual(nextDividend([cd("2026-11-30")], "2026-12-01"), { kind: "expected", exDate: "2027-02-26", amount: 1.25 });
});

test("月度和年度频率按 1 个月和 12 个月推", () => {
	assert.equal((nextDividend([cd("2026-10-30", 12)], "2026-11-17") as { exDate: string }).exDate, "2026-11-30");
	assert.equal((nextDividend([cd("2026-03-20", 1)], "2026-11-17") as { exDate: string }).exDate, "2027-03-19");
});

test("不推算、标除息无数据：没有记录、最近一次不是 CD、frequency 缺或为 0 或不认", () => {
	for (const rows of [[], [{ ...cd("2026-09-18"), dividend_type: "SC" }, cd("2026-06-18")], [{ ex_dividend_date: "2026-09-18", dividend_type: "CD", cash_amount: 1 }], [cd("2026-09-18", 0)], [cd("2026-09-18", 3)]]) {
		assert.equal(nextDividend(rows, "2026-11-17").kind, "none", JSON.stringify(rows));
	}
});
