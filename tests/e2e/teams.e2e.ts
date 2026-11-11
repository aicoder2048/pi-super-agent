import assert from "node:assert/strict";
import test, { after } from "node:test";
import { on, openTicket, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, sayInPage, story } from "./harness.ts";

after(closeBrowser);

const NEWS = { title: "听证会新闻", brief: "汇总黄仁勋听证会的新闻" };
const WEATHER = { title: "查天气", brief: "查明天的天气" };

const STATE_FILES = {
	"modules/news/module.json": JSON.stringify({ name: "news", title: "新闻", description: "查新闻、核对报道来源", team: "新闻队" }),
	"modules/news/agents/news.md": "---\nname: news-researcher\ntitle: 新闻研究员\ndescription: 查新闻、核对报道来源\n---\n你是新闻研究员。\n",
};

const openInDomain = (card: string, domain: string): ToolCall => {
	const call = openTicket(card, NEWS.title, NEWS.brief);
	return { ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain })) } };
};

test("状态目录的 modules/ 里放一个带成员的新闻模块：幕僚长把新闻交给它，助手是四字名加团队名；别的事仍是两字名的对话助手", (t) =>
	story(
		t,
		{
			router: [
				on("Router 把新闻交给新闻队", /^\[对话\][\s\S]*听证会/, (c) => [openInDomain(c, "news"), reply(c, "已交给新闻队")]),
				on("Router 开天气任务", /^\[对话\][\s\S]*天气/, (c) => [openTicket(c, WEATHER.title, WEATHER.brief), reply(c, "已安排")]),
			],
			workers: [
				worker(NEWS.brief, on("新闻任务汇报", /^\[任务说明\]/, () => [report("progress", "找到三条新闻")])),
				worker(WEATHER.brief, on("天气任务汇报", /^\[任务说明\]/, () => [report("progress", "正在查")])),
			],
		},
		async ({ step }) => {
			await step("页面投递两件事，各有一枚小卡", async (page) => {
				await sayInPage(page, "看下黄仁勋听证会的新闻");
				await sayInPage(page, "查一下天气");
				await page.waitForFunction(() => document.querySelectorAll("#helpers .helper-chip").length === 2);
			});
			await step("新闻任务的小卡、卡片、去向和执行过程头部都是「四字名 · 新闻队领队 #1」，卡片和头部写领队还没派活", async (page) => {
				const chip = page.locator("#helpers .helper-chip", { hasText: "新闻队领队 #1" });
				const name = (await chip.locator(".name").textContent()) ?? "";
				assert.equal([...name].length, 4, name);
				const card = page.locator("#left .card", { hasText: NEWS.title });
				assert.equal(await card.locator(".by").textContent(), `${name} · 新闻队领队 #1`);
				assert.equal(await card.locator(".crew").textContent(), "暂未派活");
				assert.equal(await page.locator(".line.user", { hasText: "听证会" }).locator(".route").textContent(), `已开新任务「${NEWS.title}」 · ${name} · 新闻队领队 #1`);
				await chip.click();
				await page.locator("#how-title", { hasText: NEWS.title }).waitFor();
				assert.equal(await page.locator("#how-helper").textContent(), `${name} · 新闻队领队 #1 · 暂未派活`);
			});
			await step("天气任务没有领域，小卡是两字名加「对话助手 #1」", async (page) => {
				const chip = page.locator("#helpers .helper-chip", { hasText: "对话助手 #1" });
				const name = (await chip.locator(".name").textContent()) ?? "";
				assert.equal([...name].length, 2, name);
				assert.equal(await page.locator("#left .card", { hasText: WEATHER.title }).locator(".by").textContent(), `${name} · 对话助手 #1`);
			});
		},
		{ files: STATE_FILES },
	));
