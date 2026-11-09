import assert from "node:assert/strict";
import test, { after } from "node:test";
import { consult, expert, on, openTicket, reply, report, worker } from "./fake-model.ts";
import { closeBrowser, sayInPage, story } from "./harness.ts";

after(closeBrowser);

const TITLE = "NVDA 为什么跌";
const BRIEF = "查 NVDA 今天下跌的原因，合成一份答复";
const MARKET_Q = "NVDA 今天的盘面和成交量说明什么？";
const NEWS_Q = "过去 24 小时有哪些可能导致 NVDA 下跌的新闻？";
const ANSWER_MS = 2500;

const roles = {
	"market.md": "---\nname: market-analyst\ntitle: 行情分析师\ndescription: 看涨跌、异动和成交量\ntools: web_get\n---\n你是行情分析师。\n",
	"news.md": "---\nname: news-researcher\ntitle: 新闻研究员\ndescription: 查新闻、核对报道来源\n---\n你是新闻研究员。\n",
};

test("副幕僚长同时请教两位专家：助手条在它的小卡里列出正在回答的专家，执行过程里会诊是一步，展开看到每位的问题和回答", (t) =>
	story(
		t,
		{
			router: [
				on("Router 开任务", /^\[对话\][\s\S]*NVDA/, (c) => [openTicket(c, TITLE, BRIEF), reply(c, "已安排副幕僚长")]),
				on("Router 转告", /^\[Worker 汇报\][\s\S]*放量下跌/, (c) => [reply(c, "NVDA 放量下跌，主因是出口限制的新闻")]),
			],
			workers: [
				worker(
					BRIEF,
					on("副幕僚长会诊", /^\[任务说明\]/, () => [consult({ expert: "market-analyst", question: MARKET_Q }, { expert: "news-researcher", question: NEWS_Q })]),
					on("副幕僚长合成", /^\[会诊结果\][\s\S]*放量下跌 4%[\s\S]*出口限制/, () => [report("ready", "放量下跌，主因是出口限制的新闻（行情分析师、新闻研究员）")]),
				),
				expert(MARKET_Q, "行情分析师回答", "放量下跌 4%，成交量是 20 日均量的两倍。", ANSWER_MS),
				expert(NEWS_Q, "新闻研究员回答", "路透社 09:30 报道新的出口限制。", ANSWER_MS),
			],
		},
		async ({ step }) => {
			await step("页面投递问题", (page) => sayInPage(page, "NVDA 今天为什么跌？"));
			await step("助手条在副幕僚长的小卡里列出两位正在回答的专家", async (page) => {
				const chip = page.locator("#helpers .helper-chip", { hasText: "副幕僚长 #1" });
				await chip.locator(".expert-chip", { hasText: "行情分析师 ◐" }).waitFor();
				await chip.locator(".expert-chip", { hasText: "新闻研究员 ◐" }).waitFor();
				assert.match(await chip.getAttribute("aria-label") ?? "", /正在请教 行情分析师、新闻研究员/);
				const strip = await page.locator("#helpers").boundingBox();
				const header = await page.locator("header").boundingBox();
				assert.ok(strip && header && strip.height < 60, `助手条高 ${strip?.height}`);
				await chip.click();
				await page.locator("#steps .step", { hasText: "请教 2 位专家" }).waitFor();
			});
			await step("专家答完后小卡里的专家消失", (page) =>
				page.waitForFunction(() => document.querySelectorAll("#helpers .expert-chip").length === 0, undefined, { timeout: 15_000 }));
			await step("执行过程里会诊是一步（等待时已点开小卡），展开看到每位专家的问题、回答和用量", async (page) => {
				const consultStep = page.locator("#steps .step", { hasText: "会诊" }).first();
				await consultStep.locator(".step-detail", { hasText: "行情分析师、新闻研究员" }).waitFor();
				await consultStep.locator("summary", { hasText: "会诊明细" }).click();
				await consultStep.locator(".expert-head", { hasText: /^行情分析师 · 已回答 · \S+ tokens$/ }).waitFor();
				await consultStep.locator(".expert-q", { hasText: `问：${NEWS_Q}` }).waitFor();
				await consultStep.locator(".expert-a", { hasText: "路透社 09:30 报道新的出口限制。" }).waitFor();
				assert.doesNotMatch(await consultStep.locator(".consult").textContent() ?? "", /market-analyst|news-researcher/, "会诊明细只写职称");
			});
			await step("幕僚长转告合成的答复", (page) => page.locator(".line.router", { hasText: "出口限制" }).waitFor());
		},
		{ roles },
	));
