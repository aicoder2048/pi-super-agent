import assert from "node:assert/strict";
import test from "node:test";
import * as host from "../../src/sources/market/session.ts";
import * as optionTa from "../../docs/modules/examples/option-ta/market-days.ts";
import * as stockTa from "../../docs/modules/examples/stock-ta/market-days.ts";

test("stock-ta、option-ta 的 market-days.ts 和宿主的 session.ts 对每个时刻给出相同的美东日期、时段和时刻：每年改提前收盘日表时两处都要改", () => {
	const HALF_HOUR = 30 * 60_000;
	for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2029, 0, 1); ms += HALF_HOUR) {
		const { nyDate, phase } = host.sessionAt(ms);
		assert.deepEqual(stockTa.sessionAt(ms), { nyDate, phase }, new Date(ms).toISOString());
		assert.equal(stockTa.nyTime(ms), host.nyTime(ms));
		assert.deepEqual(optionTa.sessionAt(ms), { nyDate, phase }, new Date(ms).toISOString());
		assert.equal(optionTa.nyTime(ms), host.nyTime(ms));
		assert.equal(optionTa.regularCloseAt(ms), host.sessionAt(ms).closeAt, new Date(ms).toISOString());
	}
});

test("option-ta 的交易日和假日表与 stock-ta 的一致：每年补假日表时两处都要改", () => {
	for (let date = "2025-01-01"; date <= optionTa.CALENDAR_THROUGH; date = optionTa.shiftDate(date, 1)) assert.equal(optionTa.isTradingDay(date), stockTa.isTradingDay(date), date);
	assert.ok(optionTa.HOLIDAYS.has("2026-11-26") && optionTa.HOLIDAYS.has("2028-12-25"));
});

test("假日和提前收盘日表到期前 90 天就让测试失败：补上下一年的 NYSE 日历", () => {
	const today = new Date().toISOString().slice(0, 10);
	assert.ok(today <= optionTa.shiftDate(optionTa.CALENDAR_THROUGH, -90), `market-days.ts 的日历只到 ${optionTa.CALENDAR_THROUGH}，宿主 session.ts、stock-ta 和 option-ta 的 market-days.ts 一起补上下一年`);
});
