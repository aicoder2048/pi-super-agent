import assert from "node:assert/strict";
import test from "node:test";
import * as page from "../../src/web/view.mjs";

const line = (id: string, role: "user" | "assistant", text: string, state = "done") => ({ id, role, at: 1, expert: "期权研究组简报官", text, state }) as const;
const snapshot = (assistant?: unknown[]) => ({ type: "snapshot", conversation: [], cleared: null, board: [], today: undefined, duty: undefined, helpers: undefined, routes: {}, dispatching: {}, memberCap: null, watching: [], modules: [], alerts: [], ...(assistant && { assistant }) }) as never;

test("简报官（ADR-0033）：快照带来问答；新帧按编号更新正在长的回答；清空帧清掉；每种只报告「简报官」这一块", () => {
	const view = page.emptyView();
	assert.ok(page.applyMessage(view, snapshot([line("q1", "user", "什么是 IV？"), line("a1", "assistant", "", "streaming")]), 0).includes("assistant"));
	assert.deepEqual([...view.assistant.values()].map((l) => l.text), ["什么是 IV？", ""]);
	assert.deepEqual(page.applyMessage(view, { type: "assistant", line: line("a1", "assistant", "IV 是隐含", "streaming") } as never, 0), ["assistant"]);
	page.applyMessage(view, { type: "assistant", line: line("a1", "assistant", "IV 是隐含波动率。") } as never, 0);
	assert.deepEqual([...view.assistant.values()].map((l) => [l.text, l.state]), [["什么是 IV？", "done"], ["IV 是隐含波动率。", "done"]]);
	assert.deepEqual(page.applyMessage(view, { type: "assistant_cleared" } as never, 0), ["assistant"]);
	assert.equal(view.assistant.size, 0);
});

test("简报官：没有简报官的宿主发来的快照不带 assistant，页面照常，简报官页是空的", () => {
	const view = page.emptyView();
	page.applyMessage(view, snapshot(), 0);
	assert.equal(view.assistant.size, 0);
});

test("右栏多一个「简报官」标签，数字是答完的回答条数；点「问简报官」切到简报官页，手机上切到概况", () => {
	const view = page.emptyView();
	page.applyMessage(view, snapshot([line("q1", "user", "?"), line("a1", "assistant", "好")]), 0);
	const tab = page.overviewTabs(view, page.firstPanel()).find((t) => t.key === "assistant");
	assert.deepEqual(tab && { label: tab.label, count: tab.count }, { label: "简报官", count: 1 });
	const asked = page.panelStep({ ...page.firstPanel(), place: "chat" }, { kind: "ask" });
	assert.deepEqual([asked.showing, asked.last, asked.place], ["assistant", "assistant", "overview"]);
	assert.equal(page.savedPanel(page.panelText(asked), new Set()).showing, "assistant");
});

test("问简报官 预填的问题：选了字问这几个字在这句话里指什么；没选字问整句", () => {
	assert.equal(page.suggestedQuestion("IV Rank"), "「IV Rank」是什么意思？在这句话里指什么？");
	assert.equal(page.suggestedQuestion(null), "这句话是什么意思？里面的术语和数字怎么理解？");
});

test("选中的字：去掉首尾空白、换行并成一个空格；空的不算；太长截到 500 字", () => {
	assert.equal(page.pickedText("  期限结构\n倒挂 "), "期限结构 倒挂");
	assert.equal(page.pickedText(" \n "), null);
	assert.equal(page.pickedText("长".repeat(600))!.length, 500);
});

test("问简报官的正文：带句子编号和选中的字；没点句子时只有问题", () => {
	assert.deepEqual(JSON.parse(page.askBody("「跳空」是什么？", { lineId: "rpl_1", picked: "跳空" })), { question: "「跳空」是什么？", lineId: "rpl_1", picked: "跳空" });
	assert.deepEqual(JSON.parse(page.askBody("什么是 IV？", null)), { question: "什么是 IV？" });
	assert.deepEqual(JSON.parse(page.askBody("这句话呢？", { lineId: "rpl_2", picked: null })), { question: "这句话呢？", lineId: "rpl_2" });
});
