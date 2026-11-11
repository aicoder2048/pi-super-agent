import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { Locator } from "playwright-core";
import { on, openTicket, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, sayInPage, story } from "./harness.ts";

after(closeBrowser);

const NEWS = { title: "听证会新闻", brief: "汇总黄仁勋听证会的新闻" };
const DIGEST = { title: "今日新闻摘要", brief: "整理今天的新闻摘要" };
const WEATHER = { title: "查天气", brief: "查明天的天气" };

const STATE_FILES = {
	"modules/news/module.json": JSON.stringify({ name: "news", title: "新闻", description: "查新闻、核对报道来源", team: "新闻队" }),
	"modules/news/agents/news.md": "---\nname: news-researcher\ntitle: 新闻研究员\ndescription: 查新闻、核对报道来源\n---\n你是新闻研究员。\n",
};

const openInNews = (card: string, task: { title: string; brief: string }): ToolCall => {
	const call = openTicket(card, task.title, task.brief);
	return { ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain: "news" })) } };
};

const face = async (scope: Locator) => {
	const node = scope.locator(".face");
	assert.equal(await node.count(), 1);
	return { text: await node.textContent(), tint: (await node.getAttribute("class"))?.match(/tint-\d/)?.[0], kind: await node.getAttribute("data-kind"), crowns: await node.locator(".crown").count() };
};

test("同一个任务的头像在卡片、助手条和执行过程头部是同一个字、同一种颜色；领队方形带冠标，对话助手圆形；读屏跳过头像；领队独自完成的卡片底部没有成员头像", (t) =>
	story(
		t,
		{
			router: [
				on("Router 把听证会交给新闻队", /^\[对话\][\s\S]*听证会/, (c) => [openInNews(c, NEWS), reply(c, "已交给新闻队")]),
				on("Router 把摘要交给新闻队", /^\[对话\][\s\S]*摘要/, (c) => [openInNews(c, DIGEST), reply(c, "已交给新闻队")]),
				on("Router 转告摘要", /^\[Worker 汇报\][\s\S]*今天没有大新闻/, (c) => [reply(c, "今天没有大新闻")]),
				on("Router 开天气任务", /^\[对话\][\s\S]*天气/, (c) => [openTicket(c, WEATHER.title, WEATHER.brief), reply(c, "已安排")]),
			],
			workers: [
				worker(NEWS.brief, on("听证会任务汇报", /^\[任务说明\]/, () => [report("progress", "找到三条新闻")])),
				worker(DIGEST.brief, on("领队自己做完摘要", /^\[任务说明\]/, () => [report("ready", "今天没有大新闻")])),
				worker(WEATHER.brief, on("天气任务汇报", /^\[任务说明\]/, () => [report("progress", "正在查")])),
			],
		},
		async ({ step }) => {
			await step("页面投递三件事", async (page) => {
				await sayInPage(page, "看下黄仁勋听证会的新闻");
				await sayInPage(page, "整理一份今日新闻摘要");
				await sayInPage(page, "查一下天气");
				await page.locator("#done .card", { hasText: DIGEST.title }).waitFor({ state: "attached" });
				await page.waitForFunction(() => document.querySelectorAll("#helpers .helper-chip").length === 2);
			});
			for (const [task, role, kind, crowns] of [[NEWS, "新闻队领队 #1", "leader", 1], [WEATHER, "对话助手 #1", "helper", 0]] as const) {
				await step(`${task.title}：卡片头部、助手条小卡和执行过程头部是同一个头像，取名字的第一个字`, async (page) => {
					const chip = page.locator("#helpers .helper-chip", { hasText: role });
					const name = (await chip.locator(".name").textContent()) ?? "";
					const expected = { text: [...name][0], kind, crowns };
					const card = await face(page.locator("#left .card", { hasText: task.title }).locator(".head"));
					assert.deepEqual({ ...card, tint: undefined }, { ...expected, tint: undefined }, "卡片头部");
					assert.match(card.tint ?? "", /^tint-\d$/);
					assert.deepEqual(await face(chip), card, "助手条小卡");
					await chip.click();
					await page.locator("#how-title", { hasText: task.title }).waitFor();
					assert.deepEqual(await face(page.locator("#how-badge")), card, "执行过程头部");
				});
			}
			await step("领队独自完成的任务：卡片底部只有「领队独自完成」，没有成员头像", async (page) => {
				const card = page.locator("#done .card", { hasText: DIGEST.title });
				assert.equal(await card.locator(".crew").textContent(), "领队独自完成");
				assert.equal(await card.locator(".crew .face").count(), 0);
				assert.equal(await card.locator(".head .face").getAttribute("data-kind"), "leader");
			});
			await step("每个头像都对读屏隐藏，名字行和步骤说明里没有头像", async (page) => {
				const faces = page.locator(".face");
				assert.equal(await faces.count(), 6, "三张卡片、两枚小卡和执行过程头部");
				assert.deepEqual([...new Set(await faces.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-hidden"))))], ["true"]);
				assert.equal(await page.locator(".by .face, .step-detail .face, #how-helper .face").count(), 0);
			});
		},
		{ files: STATE_FILES },
	));
