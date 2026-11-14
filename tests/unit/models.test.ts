import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MODELS, parseModelRef } from "../../src/models.ts";

test("默认模型都能解析，且都不是 anthropic", () => {
	for (const ref of Object.values(DEFAULT_MODELS)) assert.notEqual(parseModelRef(ref).provider, "anthropic");
});

test("任何写法的 anthropic 提供方都被拒绝", () => {
	for (const ref of ["anthropic/claude-opus-5-5", "Anthropic/claude-haiku-5-5", "ANTHROPIC/x"]) {
		assert.throws(() => parseModelRef(ref), /禁用/);
	}
});

test("经其它提供方转接的 Claude 模型也被拒绝", () => {
	for (const ref of [
		"amazon-bedrock/anthropic.claude-opus-4-1-20250805-v1:0",
		"vercel-ai-gateway/anthropic/claude-opus-4.5",
		"openrouter/~anthropic/claude-sonnet-latest",
		"cloudflare-ai-gateway/claude-sonnet-4-5",
		"github-copilot/Claude-Sonnet-4",
		" anthropic/claude-opus-5-5",
	]) {
		assert.throws(() => parseModelRef(ref), /禁用/, ref);
	}
});

test("缺少提供方的写法被拒绝", () => {
	assert.throws(() => parseModelRef("gpt-6.1-sol"), /provider\/id/);
});
