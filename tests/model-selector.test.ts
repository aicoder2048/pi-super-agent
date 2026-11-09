import assert from "node:assert/strict";
import test from "node:test";
import { isQuotaError, ModelSelector } from "../src/model-selector.ts";

const primary = { provider: "openai-codex", id: "gpt-6.1-sol" };
const fallback = { provider: "deepseek", id: "deepseek-flash" };
const MIN = 60_000;

function selector(now = { t: 0 }) {
	return { now, s: new ModelSelector({ primary, fallback, probeEveryMs: 15 * MIN, clock: { now: () => now.t } }) };
}

test("额度或限流错误能被识别，其他错误不算", () => {
	for (const msg of ["429 Too Many Requests", "Rate limit reached", "You exceeded your current quota", "usage limit has been reached", "rate_limit_exceeded"]) {
		assert.ok(isQuotaError(msg), msg);
	}
	for (const msg of ["500 Internal Server Error", "invalid tool arguments", "context length exceeded"]) assert.ok(!isQuotaError(msg), msg);
});

test("Pi 的重试用完后，第一次最终的限流错误就切到回退模型，并且只要求通知一次", () => {
	const { s } = selector();
	assert.deepEqual(s.onError("429"), { switched: true, notify: true });
	assert.deepEqual(s.current(), { model: fallback, fellBack: true });
	assert.deepEqual(s.onError("429"), { switched: false });
});

test("非限流错误不切换模型", () => {
	const { s } = selector();
	assert.deepEqual(s.onError("500 Internal Server Error"), { switched: false });
	assert.deepEqual(s.current(), { model: primary, fellBack: false });
});

test("回退期间每 15 分钟在新一轮开始时试一次主模型，成功则切回", () => {
	const { s, now } = selector();
	for (let i = 0; i < 3; i++) s.onError("429");
	now.t += 14 * MIN;
	assert.deepEqual(s.forTurn(), { model: fallback, fellBack: true, probing: false });
	now.t += 1 * MIN;
	assert.deepEqual(s.forTurn(), { model: primary, fellBack: false, probing: true });
	s.onSuccess();
	assert.deepEqual(s.current(), { model: primary, fellBack: false });
});

test("试探主模型失败时立刻回到回退模型，15 分钟后再试，不再重复通知", () => {
	const { s, now } = selector();
	for (let i = 0; i < 3; i++) s.onError("429");
	now.t += 15 * MIN;
	s.forTurn();
	assert.deepEqual(s.onError("429"), { switched: true, notify: false });
	assert.equal(s.forTurn().probing, false);
	now.t += 15 * MIN;
	assert.equal(s.forTurn().probing, true);
});

test("切回主模型后再次限流回退，会再通知一次", () => {
	const { s, now } = selector();
	for (let i = 0; i < 3; i++) s.onError("429");
	now.t += 15 * MIN;
	s.forTurn();
	s.onSuccess();
	assert.deepEqual(s.onError("429"), { switched: true, notify: true });
});
