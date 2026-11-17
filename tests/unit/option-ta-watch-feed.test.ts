import assert from "node:assert/strict";
import test from "node:test";
import { replay } from "../helpers/option-ta-feed-replay.ts";

type Seen = { rule: string; push: "silent" | "bell" };
const seen = (alerts: { id: string; push?: string }[] = []): Seen[] => alerts.map((a) => ({ rule: a.id.split(":")[0]!, push: a.push === "silent" ? "silent" : "bell" })).sort((a, b) => a.rule.localeCompare(b.rule));

/** Each fixture and the alerts the build plan's thresholds call for on it (「已定的第一版范围」). */
const CASES: Record<string, Seen[]> = {
	"no-positions": [],
	"market-closed": [],
	"expiry-near-fires": [{ rule: "expiry-near", push: "silent" }],
	"expiry-near-quiet": [],
	"expiry-open-fires": [{ rule: "expiry-near", push: "silent" }, { rule: "expiry-open", push: "bell" }],
	"expiry-open-before-0945": [{ rule: "expiry-near", push: "silent" }],
	"expiry-open-quiet": [{ rule: "expiry-near", push: "silent" }],
	"strike-near-fires": [{ rule: "strike-near", push: "silent" }],
	"strike-crossed-fires": [{ rule: "strike-crossed", push: "bell" }],
	"strike-quiet": [],
	"profit-50-fires": [{ rule: "profit-50", push: "silent" }],
	"profit-80-fires": [{ rule: "profit-80", push: "bell" }],
	"profit-quiet": [],
	"earnings-before-expiry-fires": [{ rule: "earnings", push: "silent" }],
	"earnings-soon-fires": [{ rule: "earnings-soon", push: "bell" }],
	"earnings-quiet": [],
	"ex-div-fires": [{ rule: "ex-div", push: "bell" }, { rule: "strike-crossed", push: "bell" }],
	"ex-div-expected-fires": [{ rule: "ex-div-expected", push: "silent" }, { rule: "strike-crossed", push: "bell" }],
	"ex-div-quiet": [],
	"missing-data": [],
	"stale-quote": [],
	"http-429": [],
	"http-5xx-third-beat": [],
};

for (const [name, expected] of Object.entries(CASES)) {
	test(`watch 样例 ${name}：发出的提醒和门槛一致`, async () => {
		const { output } = await replay("watch", name);
		assert.deepEqual(seen(output.alerts), expected);
		assert.deepEqual(output.records, []);
	});
}

test("fills 为空、休市时不取任何数据", async () => {
	for (const name of ["no-positions", "market-closed"]) assert.deepEqual((await replay("watch", name)).fetched, [], name);
});

test("同一个仓位连着两拍，提醒的 id 一样（宿主按 id 只发一次）", async () => {
	const first = await replay("watch", "ex-div-fires");
	const second = await replay("watch", "ex-div-fires", { change: (input) => ((input.now = "2026-11-19T15:05:00.000Z"), (input.cursor = first.output.cursor)) });
	assert.deepEqual(second.output.alerts.map((a: { id: string }) => a.id), first.output.alerts.map((a: { id: string }) => a.id));
});

test("同一天第二拍不再取除息和财报，用 cursor 里当天的", async () => {
	const first = await replay("watch", "earnings-soon-fires");
	const second = await replay("watch", "earnings-soon-fires", { change: (input) => ((input.now = "2026-11-19T15:05:00.000Z"), (input.cursor = first.output.cursor)) });
	assert.deepEqual(second.fetched.filter((u) => !u.includes("/v3/snapshot/")), []);
	assert.deepEqual(seen(second.output.alerts), [{ rule: "earnings-soon", push: "bell" }]);
});

test("到期日只在 09:45 以后的第一次检查判断：那次没到 3%，后来再靠近也不响", async () => {
	const first = await replay("watch", "expiry-open-quiet");
	const later = await replay("watch", "expiry-open-fires", { change: (input) => ((input.now = "2026-11-20T15:10:00.000Z"), (input.cursor = first.output.cursor)) });
	assert.ok(!seen(later.output.alerts).some((a) => a.rule === "expiry-open"));
});

test("09:45 以前读到的是盘前价，那一拍不算第一次检查，09:45 以后照样判断", async () => {
	const early = await replay("watch", "expiry-open-before-0945");
	const later = await replay("watch", "expiry-open-fires", { change: (input) => (input.cursor = early.output.cursor) });
	assert.ok(seen(later.output.alerts).some((a) => a.rule === "expiry-open"));
});

test("请求失败一拍只记次数不报警，连着第三拍报警", async () => {
	const once = await replay("watch", "http-429");
	assert.equal(once.output.problem, undefined);
	assert.equal(JSON.parse(once.output.cursor).failures, 1);
	const third = await replay("watch", "http-5xx-third-beat");
	assert.equal(third.output.problem?.id, "data-down");
});

test("缺 POLYGON_API_KEY 回 problem，写明补 key 的命令", async () => {
	const { output, fetched } = await replay("watch", "profit-80-fires", { secrets: { FINNHUB_API_KEY: "fixture" } });
	assert.equal(output.problem?.id, "no-key");
	assert.match(output.problem.text, /just module secret option-ta POLYGON_API_KEY/);
	assert.deepEqual(fetched, []);
});

test("缺 FINNHUB_API_KEY 时不查财报，其余提醒照发，并回 problem", async () => {
	const { output, fetched } = await replay("watch", "profit-80-fires", { secrets: { POLYGON_API_KEY: "fixture" } });
	assert.equal(output.problem?.id, "no-finnhub-key");
	assert.ok(!fetched.some((u) => u.includes("finnhub")));
	assert.deepEqual(seen(output.alerts), [{ rule: "profit-80", push: "bell" }]);
});

test("没有仓位时缺 key 也不报警", async () => {
	assert.equal((await replay("watch", "no-positions", { secrets: {} })).output.problem, undefined);
});
