import assert from "node:assert/strict";
import test, { after } from "node:test";
import { on, openTicket, reply, report, worker } from "./fake-model.ts";
import { closeBrowser, sayInPage, story } from "./harness.ts";

after(closeBrowser);

const LONG = { title: "整理长清单", brief: "逐条汇报四十次进度" };
const SHORT = { title: "查天气", brief: "汇报一次进度后等待" };
const PROGRESS_STEPS = 40;
const LONG_ASK = `整理长清单：\n${Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 项`).join("\n")}`;

test("两个助手同时在岗：页头两枚小卡，点小卡打开执行过程和生命周期；对话和执行过程很长时整页不滚动", (t) =>
	story(
		t,
		{
			router: [
				on("Router 开长任务", /^\[对话\][\s\S]*长清单/, (c) => [openTicket(c, LONG.title, LONG.brief), reply(c, "已安排")]),
				on("Router 开短任务", /^\[对话\][\s\S]*天气/, (c) => [openTicket(c, SHORT.title, SHORT.brief), reply(c, "已安排")]),
			],
			workers: [
				worker(LONG.brief, on("长任务汇报", /^\[任务说明\]/, () => Array.from({ length: PROGRESS_STEPS }, (_, i) => report("progress", `第 ${i + 1} 条已整理`)))),
				worker(SHORT.brief, on("短任务汇报", /^\[任务说明\]/, () => [report("progress", "正在查")])),
			],
		},
		async ({ step }) => {
			await step("页面投递两件事", async (page) => {
				await sayInPage(page, LONG_ASK);
				await sayInPage(page, "查一下天气");
			});
			await step("点开长任务，执行过程出现全部步骤", async (page) => {
				await page.locator("#left .card", { hasText: LONG.title }).first().click();
				await page.locator("#steps .step", { hasText: `第 ${PROGRESS_STEPS} 条已整理` }).waitFor();
			});
			await step("你的每条消息右侧都有你的头像", async (page) => {
				const lines = await page.locator(".line.user").evaluateAll((nodes) =>
					nodes.map((n) => {
						const avatar = n.querySelector(":scope > .avatar.you");
						const bubble = n.querySelector(".bubble")!.getBoundingClientRect();
						return { avatar: !!avatar, right: avatar ? avatar.getBoundingClientRect().left >= bubble.right : false, hidden: avatar?.getAttribute("aria-hidden"), sr: n.querySelector(".bubble > .sr")?.textContent };
					}),
				);
				assert.equal(lines.length, 2);
				for (const line of lines) assert.deepEqual(line, { avatar: true, right: true, hidden: "true", sr: "你：" });
			});
			await step("对话和执行过程很长时整页不滚动，三栏占满窗口", async (page) => {
				const size = await page.evaluate(() => ({ scroll: document.scrollingElement!.scrollHeight, inner: innerHeight }));
				assert.equal(size.scroll, size.inner, `整页高 ${size.scroll}，窗口高 ${size.inner}`);
			});
			await step("页头出现两枚小卡，名字不同", async (page) => {
				const chips = page.locator("#helpers .helper-chip");
				await page.waitForFunction(() => document.querySelectorAll("#helpers .helper-chip").length === 2);
				const names = await chips.locator(".name").allTextContents();
				assert.equal(new Set(names).size, 2, names.join("、"));
				assert.match(await page.locator("#helpers .total").textContent() ?? "", /^今日 2 位 · \S+ tokens$/);
			});
			await step("点小卡，右栏打开那个任务，头部写助手全名和生命周期", async (page) => {
				const chip = page.locator("#helpers .helper-chip", { hasText: "对话助手 #2" });
				const name = await chip.locator(".name").textContent();
				await chip.click();
				await page.locator("#how-title", { hasText: SHORT.title }).waitFor();
				assert.equal(await page.locator("#how-helper").textContent(), `${name} · 对话助手 #2`);
				assert.match(await page.locator("#how-life").textContent() ?? "", /^开始 \d\d:\d\d · 进行中 · 用时 .+ · 模型 worker · 工具 \d+ 次 · tokens 入 \S+ \/ 出 \S+$/);
				const size = await page.evaluate(() => ({ scroll: document.scrollingElement!.scrollHeight, inner: innerHeight }));
				assert.equal(size.scroll, size.inner, `加上助手条后整页高 ${size.scroll}，窗口高 ${size.inner}`);
			});
		},
	));
