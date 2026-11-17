import assert from "node:assert/strict";
import test from "node:test";
import { shiftDate } from "../../docs/modules/examples/option-ta/market-days.ts";
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
	"ex-div-fires": [{ rule: "ex-div", push: "bell" }, { rule: "strike-crossed", push: "silent" }],
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

test("同一个仓位连着两拍，第二拍没有新的 id（宿主按 id 只发一次）", async () => {
	const first = await replay("watch", "ex-div-fires");
	const second = await replay("watch", "ex-div-fires", { change: (input) => ((input.now = "2026-11-19T15:05:00.000Z"), (input.cursor = first.output.cursor)) });
	const before = new Set(first.output.alerts.map((a: { id: string }) => a.id));
	assert.ok(second.output.alerts.length > 0);
	assert.ok(second.output.alerts.every((a: { id: string }) => before.has(a.id)), JSON.stringify(second.output.alerts));
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

const DAY_MS = 86_400_000;
/**
 * One beat of a fixture moved `days` later, with the underlying at `spot` and the cursor of the beat before: the quote's
 * timestamps and the earnings request's dates move with it, so the quote stays today's.
 */
function laterBeat(name: string, { days, spot, cursor, fills }: { days: number; spot: number; cursor?: string; fills?: (f: Record<string, unknown>) => void }) {
	return replay("watch", name, {
		change: (input) => {
			input.now = new Date(Date.parse(input.now) + days * DAY_MS).toISOString();
			input.cursor = cursor ?? null;
			for (const row of input.rows.fills) fills?.(row.fields);
		},
		respond: (responses) => {
			for (const [url, reply] of Object.entries(responses)) {
				const snapshot = reply?.results?.underlying_asset;
				if (snapshot) {
					snapshot.price = spot;
					snapshot.last_updated += days * DAY_MS * 1e6;
					reply.results.last_quote.last_updated += days * DAY_MS * 1e6;
				}
				const dates = url.match(/from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})/);
				if (dates) {
					delete responses[url];
					responses[url.replace(dates[1]!, shiftDate(dates[1]!, days)).replace(dates[2]!, shiftDate(dates[2]!, days))] = reply;
				}
			}
		},
	});
}
const crossed = (alerts: { id: string; push?: string }[]) => alerts.filter((a) => a.id.startsWith("strike-crossed:")).map((a) => ({ id: a.id, push: a.push === "silent" ? "silent" : "bell" }));

test("穿过行权价只在刚穿过的那天响：第二天还在价内不再提醒", async () => {
	const first = await laterBeat("strike-crossed-fires", { days: 0, spot: 99 });
	assert.deepEqual(crossed(first.output.alerts).map((a) => a.push), ["bell"]);
	const next = await laterBeat("strike-crossed-fires", { days: 1, spot: 98, cursor: first.output.cursor });
	assert.deepEqual(crossed(next.output.alerts), []);
});

test("回到价外以后再穿过算新的一次，换一天的 id 再响", async () => {
	const first = await laterBeat("strike-crossed-fires", { days: 0, spot: 99 });
	const back = await laterBeat("strike-crossed-fires", { days: 1, spot: 103, cursor: first.output.cursor });
	assert.deepEqual(crossed(back.output.alerts), []);
	const again = await laterBeat("strike-crossed-fires", { days: 4, spot: 99, cursor: back.output.cursor });
	const [alert] = crossed(again.output.alerts);
	assert.equal(alert?.push, "bell");
	assert.notEqual(alert?.id, crossed(first.output.alerts)[0]!.id);
});

test("到期日只以开盘离行权价不到 3% 响一次，穿过行权价和其余提醒改成静音", async () => {
	const out = await laterBeat("expiry-open-fires", { days: 0, spot: 99, fills: (f) => ((f["side"] = "STO"), (f["fill_id"] = String(f["fill_id"]).replace(":BTO:", ":STO:")), (f["order_key"] = String(f["order_key"]).replace(":BTO:", ":STO:"))) });
	assert.deepEqual(seen(out.output.alerts), [{ rule: "expiry-near", push: "silent" }, { rule: "expiry-open", push: "bell" }, { rule: "profit-80", push: "silent" }, { rule: "strike-crossed", push: "silent" }]);
});

test("同一仓位同一天最多响一次：前一天已经发过的提醒再出现不算今天响过", async () => {
	const first = await laterBeat("profit-80-fires", { days: 0, spot: 120 });
	assert.deepEqual(seen(first.output.alerts), [{ rule: "profit-80", push: "bell" }]);
	const next = await laterBeat("profit-80-fires", { days: 1, spot: 99, cursor: first.output.cursor });
	assert.deepEqual(crossed(next.output.alerts).map((a) => a.push), ["bell"]);
	const later = await laterBeat("profit-80-fires", { days: 1, spot: 99, cursor: next.output.cursor });
	const before = new Set(next.output.alerts.map((a: { id: string }) => a.id));
	assert.ok(later.output.alerts.every((a: { id: string }) => before.has(a.id)), "同一天下一拍没有新的 id");
});

test("旧格式 cursor（没有 sent）那一拍只认识已发的 id，不占当天的响铃：新出现的穿价照样响", async () => {
	const old = JSON.stringify({ date: "2026-11-18", decided: [], events: {}, failures: 0 });
	const out = await laterBeat("ex-div-fires", { days: 0, spot: 700, cursor: old });
	assert.deepEqual(crossed(out.output.alerts).map((a) => a.push), ["bell"]);
	assert.equal(JSON.parse(out.output.cursor).baseline, undefined);
});

test("某一拍正股价缺了，不清掉在价内的记录：第二天还在价内不重复响", async () => {
	const first = await laterBeat("strike-crossed-fires", { days: 0, spot: 99 });
	const gap = await replay("watch", "strike-crossed-fires", { change: (input) => ((input.now = "2026-11-19T15:05:00.000Z"), (input.cursor = first.output.cursor)), respond: (r) => { for (const reply of Object.values(r)) if (reply?.results?.underlying_asset) reply.results.underlying_asset.last_updated = 1; } });
	const next = await laterBeat("strike-crossed-fires", { days: 1, spot: 98, cursor: gap.output.cursor });
	assert.deepEqual(crossed(next.output.alerts), []);
});

test("同一标的的两个仓位各自有当天那一次响铃", async () => {
	const two = await replay("watch", "strike-crossed-fires", {
		change: (input) => {
			const second = structuredClone(input.rows.fills[0]);
			second.id = "9";
			for (const k of ["account_ref", "fill_id", "order_key"]) second.fields[k] = String(second.fields[k]).replace("acct-1", "acct-2");
			input.rows.fills.push(second);
		},
	});
	assert.deepEqual(crossed(two.output.alerts).map((a) => a.push), ["bell", "bell"]);
});

test("同一拍财报前 2 天和权利金八成都要响时，财报那条占响铃", async () => {
	const out = await replay("watch", "earnings-soon-fires", { respond: (r) => { for (const reply of Object.values(r)) if (reply?.results?.last_quote) Object.assign(reply.results.last_quote, { bid: 0.05, ask: 0.1, midpoint: 0.075 }); } });
	assert.deepEqual(seen(out.output.alerts).filter((a) => a.push === "bell").map((a) => a.rule), ["earnings-soon"]);
	assert.ok(seen(out.output.alerts).some((a) => a.rule === "profit-80" && a.push === "silent"), JSON.stringify(out.output.alerts));
});
