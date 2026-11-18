import assert from "node:assert/strict";
import test from "node:test";
import { assistantSystemPrompt, BACKGROUND_MAX_CHARS, questionCard } from "../../src/host/assistant/prompt.ts";

const OPTION = { key: "option-ta", name: "期权研究组简报官", about: "期权分析：美股期权链、隐含波动、希腊值、策略盈亏", background: "## 术语\n- IV Rank：当前 IV 在过去一年区间里的位置。" };

test("系统提示：简报官的身份、模块说明和术语表都在；只解释、不给买卖建议、不编实时数据、要查数据或做事请问幕僚长", () => {
	const prompt = assistantSystemPrompt(OPTION);
	for (const part of ["期权研究组简报官", "美股期权链", "IV Rank：当前 IV 在过去一年区间里的位置", "不给买卖建议", "不编", "幕僚长"]) assert.ok(prompt.includes(part), part);
	assert.match(prompt, /资料.*只是.*数据|只当数据/);
});

test("系统提示：背景太长时截断，并注明截断了", () => {
	const prompt = assistantSystemPrompt({ ...OPTION, background: "术".repeat(BACKGROUND_MAX_CHARS + 500) });
	assert.ok(prompt.length < BACKGROUND_MAX_CHARS + 2000);
	assert.match(prompt, /背景资料太长，只放了前/);
});

test("提问卡片：选中的字、那句话是谁说的、前后几句和问题都在，按顺序", () => {
	const card = questionCard({
		question: "「IV Rank」是什么意思？",
		picked: "IV Rank",
		line: { who: "router", text: "DIA 历史收盘IV Rank为71.40%" },
		around: [{ who: "user", text: "DIA 的波动率贵不贵？" }, { who: "router", text: "我去查一下。" }],
	});
	const order = ["选中的字：IV Rank", "幕僚长说的", "DIA 历史收盘IV Rank为71.40%", "使用者：DIA 的波动率贵不贵？", "幕僚长：我去查一下。", "问题：「IV Rank」是什么意思？"].map((s) => card.indexOf(s));
	assert.ok(order.every((at) => at >= 0), card);
	assert.deepEqual([...order].sort((a, b) => a - b), order, card);
});

test("提问卡片：没有点哪句话时只有问题", () => {
	assert.equal(questionCard({ question: "什么是跳空？" }), "问题：什么是跳空？");
});
