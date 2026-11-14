import assert from "node:assert/strict";
import test from "node:test";
import * as host from "../../src/sources/market/session.ts";
import * as stockTa from "../../docs/modules/examples/stock-ta/market-days.ts";

test("stock-ta 的 market-days.ts 和宿主的 session.ts 对每个时刻给出相同的美东日期、时段和时刻：每年改提前收盘日表时两处都要改", () => {
	const HALF_HOUR = 30 * 60_000;
	for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2029, 0, 1); ms += HALF_HOUR) {
		const { nyDate, phase } = host.sessionAt(ms);
		assert.deepEqual(stockTa.sessionAt(ms), { nyDate, phase }, new Date(ms).toISOString());
		assert.equal(stockTa.nyTime(ms), host.nyTime(ms));
	}
});
