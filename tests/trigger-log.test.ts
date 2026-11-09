import assert from "node:assert/strict";
import test from "node:test";
import { formatTriggerLog } from "../src/cli/trigger-log.ts";
import type { Trigger } from "../src/kernel/types.ts";

const trigger = (over: Partial<Trigger>): Trigger => ({
	id: "trg_1", source: "toy-market", externalId: "x", sender: "feed", body: "TOYX 价格 93.6，涨跌 -6.4%",
	occurredAt: 0, receivedAt: Date.parse("2026-11-08T19:06:00"), disposition: "opened_ticket", dispositionDetail: null, ...over,
});

test("触发日志用中文写出每条触发的去向，带来源、时间和正文开头", () => {
	const text = formatTriggerLog([
		trigger({ disposition: "ignored" }),
		trigger({ id: "trg_2", disposition: "delivered", dispositionDetail: null }),
		trigger({ id: "trg_3", disposition: "opened_ticket", dispositionDetail: "tkt_9" }),
		trigger({ id: "trg_4", disposition: "handed_over", dispositionDetail: "tkt_8" }),
		trigger({ id: "trg_5", disposition: "router_ignored", dispositionDetail: "噪音" }),
		trigger({ id: "trg_6", disposition: "to_router" }),
	]);
	for (const word of ["被程序过滤", "直达订阅的任务", "开了任务 tkt_9", "转交给 tkt_8", "Router 忽略：噪音", "等 Router 处理"]) assert.ok(text.includes(word), word);
	assert.match(text, /toy-market/);
	assert.match(text, /TOYX 价格/);
});

test("正文很长时截断，一条触发占一行", () => {
	const text = formatTriggerLog([trigger({ body: "很长的正文".repeat(50) })]);
	assert.equal(text.split("\n").length, 1);
	assert.ok([...text].length < 160);
});
