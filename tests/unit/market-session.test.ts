import assert from "node:assert/strict";
import test from "node:test";
import { inPollWindow, nextPollDelay, sessionAt } from "../../src/sources/market/session.ts";

const at = (iso: string) => Date.parse(iso);

test("交易时段：美东 9:30 前是盘前，9:30 到 16:00 是常规时段，16:00 后是盘后", () => {
	assert.equal(sessionAt(at("2026-11-09T14:29:59Z")).phase, "pre");
	const open = sessionAt(at("2026-11-09T14:30:00Z"));
	assert.deepEqual(open, { nyDate: "2026-11-09", weekend: false, phase: "regular", openAt: at("2026-11-09T14:30:00Z"), closeAt: at("2026-11-09T21:00:00Z"), previousSessionMinutes: 390 });
	assert.equal(sessionAt(at("2026-11-09T21:00:00Z")).phase, "post");
});

test("交易时段：夏令时开盘是 13:30Z，冬令时是 14:30Z", () => {
	assert.equal(sessionAt(at("2026-07-15T13:30:00Z")).phase, "regular");
	assert.equal(sessionAt(at("2026-07-15T13:29:00Z")).phase, "pre");
	assert.equal(sessionAt(at("2026-11-09T13:30:00Z")).phase, "pre");
});

test("交易时段：日期按纽约算，美东深夜在 UTC 已是第二天；周末全天休市", () => {
	assert.deepEqual(
		{ nyDate: sessionAt(at("2026-11-10T04:30:00Z")).nyDate, phase: sessionAt(at("2026-11-10T04:30:00Z")).phase },
		{ nyDate: "2026-11-09", phase: "closed" },
	);
	assert.equal(sessionAt(at("2026-11-07T15:00:00Z")).phase, "closed");
});

test("轮询窗口：工作日开盘到收盘后 20 分钟（延迟行情），周末不轮询", () => {
	assert.equal(inPollWindow(at("2026-11-09T14:30:00Z")), true);
	assert.equal(inPollWindow(at("2026-11-09T21:15:00Z")), true);
	assert.equal(inPollWindow(at("2026-11-09T21:21:00Z")), false);
	assert.equal(inPollWindow(at("2026-11-09T14:29:00Z")), false);
	assert.equal(inPollWindow(at("2026-11-07T15:00:00Z")), false);
});

test("下次轮询：窗口内按周期，开盘前等到开盘，其余最多睡 15 分钟", () => {
	assert.equal(nextPollDelay(at("2026-11-09T15:00:00Z"), 60), 60_000);
	assert.equal(nextPollDelay(at("2026-11-09T14:25:00Z"), 60), 5 * 60_000);
	assert.equal(nextPollDelay(at("2026-11-06T21:21:00Z"), 60), 15 * 60_000);
	assert.equal(nextPollDelay(at("2026-11-07T15:00:00Z"), 60), 15 * 60_000);
});

test("提前收盘日（NYSE 2026-11-27 等）13:00 收盘：之后是盘后，轮询窗口到 13:20；下一个交易日记得前一日只有 210 分钟", () => {
	const half = sessionAt(at("2026-11-27T19:01:00Z"));
	assert.deepEqual([half.phase, half.closeAt], ["post", at("2026-11-27T18:00:00Z")]);
	assert.equal(sessionAt(at("2026-12-24T17:59:00Z")).phase, "regular");
	assert.equal(sessionAt(at("2027-11-26T18:30:00Z")).phase, "post");
	assert.equal(inPollWindow(at("2026-11-27T18:15:00Z")), true);
	assert.equal(inPollWindow(at("2026-11-27T18:21:00Z")), false);
	assert.deepEqual(
		["2026-11-30T15:00:00Z", "2026-12-28T15:00:00Z", "2026-11-09T15:00:00Z"].map((iso) => sessionAt(at(iso)).previousSessionMinutes),
		[210, 210, 390],
	);
});
