import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { AssistantLine } from "../../src/client/protocol.ts";
import { Assistant } from "../../src/host/assistant/assistant.ts";
import { forgetAssistantSessions, openAssistantSession } from "../../src/host/assistant/session.ts";
import type { Expert } from "../../src/host/assistant/prompt.ts";
import { openStore } from "../../src/kernel/store.ts";
import { until } from "../helpers/fakes.ts";

const OPTION: Expert = { key: "option-ta", name: "期权研究组简报官", about: "美股期权", background: "- IV Rank：当前 IV 在过去一年区间里的位置。" };
const HOST: Expert = { key: "host", name: "简报官", about: "白宫怎么用", background: "- 幕僚长：接你的话的那位。" };

type Seen = { system: string; texts: string[] };

async function world(t: TestContext, answer: (seen: Seen) => string | Error) {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-assistant-"));
	t.after(() => rmSync(stateDir, { recursive: true, force: true }));
	const faux = fauxProvider({ models: [{ id: "explainer" }, { id: "fallback" }] });
	const models: string[] = [];
	let current = "explainer";
	const seen: Seen[] = [];
	faux.setResponses(Array.from({ length: 50 }, () => (context: any, _o: unknown, _s: unknown, model: any) => {
		models.push(model.id);
		const messages = context.messages as any[];
		const texts = messages.filter((m) => m.role !== "system").map((m) => (typeof m.content === "string" ? m.content : m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")));
		const s = { system: JSON.stringify(messages.filter((m) => m.role === "system")), texts };
		seen.push(s);
		const out = answer(s);
		return out instanceof Error ? fauxAssistantMessage("", { stopReason: "error", errorMessage: out.message }) : fauxAssistantMessage(fauxText(out));
	}));
	const modelRuntime = await ModelRuntime.create({ authPath: join(stateDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const published: ({ type: "assistant"; line: AssistantLine } | { type: "assistant_cleared" })[] = [];
	const db = openStore(join(stateDir, "state.db"));
	t.after(() => db.close());
	const make = () => new Assistant({ db, open: (expert, fresh) => openAssistantSession({ modelRuntime, model: () => faux.getModel(current)!, stateDir, retry: { maxRetries: 1, baseDelayMs: 1 } }, expert, fresh), publish: (m) => published.push(m), log: () => {}, now: () => Date.now(), forget: () => forgetAssistantSessions(stateDir) });
	return { assistant: make(), make, seen, published, models, use: (id: string) => (current = id) };
}

const lastAnswer = (a: Assistant) => a.lines().filter((l) => l.role === "assistant").at(-1);

test("简报官：按那句话所属模块的简报官回答，系统提示里有身份和术语表，问题里有选中的字和原句；问答存下，推给网页", async (t) => {
	const { assistant, seen, published } = await world(t, () => "IV Rank 是当前 IV 在过去一年里的位置，85% 说明偏贵。");
	assistant.ask({ question: "「IV Rank」是什么意思？", picked: "IV Rank", line: { who: "router", text: "DIA 历史收盘IV Rank为71.40%" } }, OPTION);
	await until(() => lastAnswer(assistant)?.state === "done" || undefined, "回答完成");
	assert.match(seen[0]!.system, /期权研究组简报官/);
	assert.match(seen[0]!.system, /IV Rank：当前 IV 在过去一年区间里的位置/);
	assert.match(seen[0]!.texts.at(-1)!, /选中的字：IV Rank[\s\S]*DIA 历史收盘IV Rank为71\.40%[\s\S]*问题：「IV Rank」是什么意思？/);
	const lines = assistant.lines();
	assert.deepEqual(lines.map((l) => [l.role, l.expert, l.state]), [["user", "期权研究组简报官", "done"], ["assistant", "期权研究组简报官", "done"]]);
	assert.equal(lines[0]!.text, "「IV Rank」是什么意思？");
	assert.deepEqual(lines[0]!.about, { picked: "IV Rank", text: "DIA 历史收盘IV Rank为71.40%" });
	assert.equal(lines[1]!.text, "IV Rank 是当前 IV 在过去一年里的位置，85% 说明偏贵。");
	assert.ok(published.some((m) => m.type === "assistant" && m.line.role === "assistant" && m.line.state === "done"));
});

test("简报官：同一位简报官接着上一问回答；重启宿主后问答还在、会话也接得上", async (t) => {
	const { assistant, make, seen } = await world(t, (s) => `第 ${s.texts.length} 条消息`);
	assistant.ask({ question: "什么是 IV？" }, OPTION);
	await until(() => lastAnswer(assistant)?.state === "done" || undefined, "第一问");
	assistant.ask({ question: "那 HV 呢？" }, OPTION);
	await until(() => assistant.lines().length === 4 && lastAnswer(assistant)?.state === "done" || undefined, "第二问");
	assert.ok(seen[1]!.texts.some((x) => x.includes("什么是 IV？")), "第二问带着第一问");
	const again = make();
	assert.equal(again.lines().length, 4);
	again.ask({ question: "再说一遍 IV" }, OPTION);
	await until(() => again.lines().length === 6 && lastAnswer(again)?.state === "done" || undefined, "重启后");
	assert.ok(seen.at(-1)!.texts.some((x) => x.includes("那 HV 呢？")), "重启后接着原来的会话");
});

test("简报官：不同模块的话由不同简报官回答，各自一份会话", async (t) => {
	const { assistant, seen } = await world(t, () => "好");
	assistant.ask({ question: "幕僚长是谁？" }, HOST);
	await until(() => lastAnswer(assistant)?.state === "done" || undefined, "简报官");
	assistant.ask({ question: "IV 是什么？" }, OPTION);
	await until(() => assistant.lines().length === 4 && lastAnswer(assistant)?.state === "done" || undefined, "简报官");
	assert.match(seen[0]!.system, /简报官/);
	assert.match(seen[1]!.system, /期权研究组简报官/);
	assert.ok(!seen[1]!.texts.some((x) => x.includes("幕僚长是谁？")), "简报官的会话里没有简报官那一问");
	assert.deepEqual(assistant.lines().map((l) => l.expert), ["简报官", "简报官", "期权研究组简报官", "期权研究组简报官"]);
});

test("简报官：模型出错时这条回答标失败、说一句人话，下一问照常", async (t) => {
	let fail = true;
	const { assistant } = await world(t, () => (fail ? new Error("429 rate limited") : "好了"));
	assistant.ask({ question: "什么是跳空？" }, OPTION);
	await until(() => lastAnswer(assistant)?.state === "failed" || undefined, "失败");
	assert.match(lastAnswer(assistant)!.text, /没答上来/);
	fail = false;
	assistant.ask({ question: "什么是跳空？" }, OPTION);
	await until(() => assistant.lines().length === 4 && lastAnswer(assistant)?.state === "done" || undefined, "再问");
});

test("简报官：清空后问答没了、推一帧 assistant_cleared，再问从新会话开始", async (t) => {
	const { assistant, seen, published } = await world(t, () => "好");
	assistant.ask({ question: "什么是 IV？" }, OPTION);
	await until(() => lastAnswer(assistant)?.state === "done" || undefined, "第一问");
	assistant.clear();
	assert.deepEqual(assistant.lines(), []);
	assert.equal(published.at(-1)!.type, "assistant_cleared");
	assistant.ask({ question: "什么是 HV？" }, OPTION);
	await until(() => lastAnswer(assistant)?.state === "done" || undefined, "清空后");
	assert.ok(!seen.at(-1)!.texts.some((x) => x.includes("什么是 IV？")), "清空后的会话里没有之前的问答");
});

test("简报官跟着幕僚长的模型选择器走：选择器换了模型，下一问就用新模型", async (t) => {
	const { assistant, models, use } = await world(t, () => "好");
	assistant.ask({ question: "一" }, OPTION);
	await until(() => lastAnswer(assistant)?.state === "done" || undefined, "第一问");
	use("fallback");
	assistant.ask({ question: "二" }, OPTION);
	await until(() => assistant.lines().length === 4 && lastAnswer(assistant)?.state === "done" || undefined, "第二问");
	assert.deepEqual(models, ["explainer", "fallback"]);
});

test("清空后还没再问就重启宿主：重启后的会话不接清空前的问答", async (t) => {
	const { assistant, make, seen } = await world(t, () => "好");
	assistant.ask({ question: "清空前的问题" }, OPTION);
	await until(() => lastAnswer(assistant)?.state === "done" || undefined, "第一问");
	assistant.clear();
	const again = make();
	again.ask({ question: "重启后" }, OPTION);
	await until(() => lastAnswer(again)?.state === "done" || undefined, "重启后答");
	assert.ok(!seen.at(-1)!.texts.some((x) => x.includes("清空前的问题")));
});
