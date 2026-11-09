import test, { after } from "node:test";
import { on, openTicket, reply, report, worker } from "./fake-model.ts";
import { closeBrowser, sayInPage, story } from "./harness.ts";

after(closeBrowser);

const TITLE = "读 example.com";
const BRIEF = "读 example.com 的标题，一句话汇报";

test("页面投递一句话，看板出现任务，点开看到 Worker 过程，幕僚长在对话里回复", (t) =>
	story(
		t,
		{
			router: [
				on("Router 开任务", /^\[对话\][\s\S]*读一下 example\.com/, (card) => [openTicket(card, TITLE, BRIEF), reply(card, "好的，已安排助手去读")]),
				on("Router 回复", /^\[Worker 汇报\][\s\S]*标题是 Example Domain/, (card) => [reply(card, "标题是 Example Domain")]),
			],
			workers: [worker(BRIEF, on("Worker 汇报", /^\[任务说明\]/, () => [report("ready", "标题是 Example Domain")]))],
		},
		async ({ step }) => {
			await step("页面投递触发", (page) => sayInPage(page, "读一下 example.com"));
			await step("看板出现任务", (page) => page.locator("#left .card", { hasText: TITLE }).first().waitFor({ state: "attached" }));
			await step("点开看 Worker 过程", async (page) => {
				await page.locator("#left .card", { hasText: TITLE }).first().click();
				await page.locator("#how-title", { hasText: TITLE }).waitFor();
				await page.locator("#steps .step", { hasText: "标题是 Example Domain" }).first().waitFor();
			});
			await step("Router 回复", (page) => page.locator(".line.router", { hasText: "标题是 Example Domain" }).waitFor());
		},
	));
