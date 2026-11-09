import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import test, { after } from "node:test";
import { on, openTicket, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, sayInPage, story } from "./harness.ts";

after(closeBrowser);

const NEWS = { title: "NVDA 新闻", brief: "汇总 NVDA 今天的新闻" };
const FIRST = "查一下 NVDA 今天的新闻";
const SECOND = "看下黄仁勋听证会的新闻";

const handOverTo = (title: string) => (card: string): ToolCall[] => {
	const ticketId = card.match(new RegExp(`(tkt_[\\w-]+)「${title}」`))?.[1];
	const triggerId = card.match(/trg_[\w-]+/)?.[0];
	return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId, ticketId }] } }];
};

const routeUnder = (page: Page, text: string) => page.locator(".line.user", { hasText: text }).locator(".route");

test("幕僚长把第二句交给第一句开的任务：两句话下面各写去向，点去向打开那个任务；小卡只有状态点", (t) =>
	story(
		t,
		{
			router: [
				on("Router 开新闻任务", /^\[对话\][\s\S]*NVDA 今天的新闻/, (c) => [openTicket(c, NEWS.title, NEWS.brief), reply(c, "已安排")]),
				on("Router 转交听证会", /^\[对话\][\s\S]*听证会/, handOverTo(NEWS.title)),
			],
			workers: [
				worker(
					NEWS.brief,
					on("新闻任务汇报", /^\[任务说明\]/, () => [report("progress", "找到三条新闻")]),
					on("收到转交的话", /^\[使用者的话/, () => [report("progress", "加上听证会的新闻")]),
				),
			],
		},
		async ({ step }) => {
			await step("页面投递第一句，下面写已开新任务", async (page) => {
				await sayInPage(page, FIRST);
				await routeUnder(page, FIRST).filter({ hasText: /^已开新任务「NVDA 新闻」 · \S+ · 副幕僚长 #1$/ }).waitFor();
				await page.locator("#left .card", { hasText: "找到三条新闻" }).waitFor();
			});
			await step("页面投递第二句，幕僚长转交后下面写已交给", async (page) => {
				await sayInPage(page, SECOND);
				await routeUnder(page, SECOND).filter({ hasText: /^已交给 \S+ · 副幕僚长 #1（NVDA 新闻）$/ }).waitFor();
				const routes = await page.locator(".line.user .route").allTextContents();
				assert.equal(routes.length, 2, routes.join(" | "));
			});
			await step("点去向，右栏打开那个任务的执行过程", async (page) => {
				await routeUnder(page, SECOND).click();
				await page.locator("#how-title", { hasText: NEWS.title }).waitFor();
				await page.locator("#steps .step", { hasText: "加上听证会的新闻" }).first().waitFor();
			});
			await step("小卡只有状态点，没有任务图标", async (page) => {
				const chip = page.locator("#helpers .helper-chip").first();
				await chip.waitFor();
				assert.match(await chip.locator(".dot").textContent() ?? "", /^[●◐○]$/);
				assert.equal(await chip.locator("svg, .helper").count(), 0);
			});
		},
	));
