import assert from "node:assert/strict";
import test from "node:test";
import { WorkerEventTranslator } from "../src/host/worker-events.ts";

function record() {
	const calls: unknown[][] = [];
	const events = {
		turnStarted: () => calls.push(["turnStarted"]),
		toolCalled: () => calls.push(["toolCalled"]),
		usage: (u: unknown) => calls.push(["usage", u]),
		settled: (error?: string) => calls.push(["settled", error]),
		exited: () => calls.push(["exited"]),
		transcript: () => {},
	};
	return { calls, translator: new WorkerEventTranslator(events, "openai-codex") };
}

test("Pi 的 RPC 事件变成看板计数：工具调用一次记一次，token 按输入加缓存和输出累计", () => {
	const { calls, translator } = record();
	translator.feed({ type: "agent_start" });
	translator.feed({ type: "tool_execution_start", toolName: "bash" });
	translator.feed({ type: "message_end", message: { role: "assistant", provider: "deepseek", usage: { input: 100, cacheRead: 20, output: 30 } } });
	translator.feed({ type: "agent_settled" });
	assert.deepEqual(calls, [
		["turnStarted"],
		["toolCalled"],
		["usage", { provider: "deepseek", tokensIn: 120, tokensOut: 30 }],
		["settled", undefined],
	]);
});

test("一轮以模型错误结束时，settled 带上错误信息；下一轮开始时清掉", () => {
	const { calls, translator } = record();
	translator.feed({ type: "agent_start" });
	translator.feed({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limit" } });
	translator.feed({ type: "agent_settled" });
	translator.feed({ type: "agent_start" });
	translator.feed({ type: "agent_settled" });
	assert.deepEqual(calls.filter((c) => c[0] === "settled"), [["settled", "429 rate limit"], ["settled", undefined]]);
});

test("没有 provider 的用量记到默认提供方；非助手消息不计用量", () => {
	const { calls, translator } = record();
	translator.feed({ type: "message_end", message: { role: "assistant", usage: { input: 5, output: 1 } } });
	translator.feed({ type: "message_end", message: { role: "user", usage: { input: 999, output: 999 } } });
	assert.deepEqual(calls, [["usage", { provider: "openai-codex", tokensIn: 5, tokensOut: 1 }]]);
});
