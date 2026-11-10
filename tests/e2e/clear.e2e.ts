import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { on, reply } from "./fake-model.ts";
import { closeBrowser, sayInPage, story, waitStatus } from "./harness.ts";

after(closeBrowser);

const lines = (page: Page) => page.locator(".thread > .line");
const bar = (page: Page) => page.locator(".cleared-bar");

async function showsOnlyTheBar(page: Page) {
	await bar(page).waitFor();
	assert.match(await bar(page).innerText(), /已清屏 · .*显示之前的/);
	assert.equal(await lines(page).count(), 0);
}

test("清屏：两个页面都打开，一边点清屏两边都清空并出现细线；点细线只在这一页展开；重载、新浏览器和重启宿主后仍是清屏后的样子", (t) =>
	story(
		t,
		{
			router: [
				on("Router 回答查天气", /^\[对话\][\s\S]*查天气/, (c) => [reply(c, "好的，去查了。")]),
				on("Router 回答清屏后的话", /^\[对话\][\s\S]*明天呢/, (c) => [reply(c, "明天晴。")]),
			],
		},
		async ({ step, host, open }) => {
			let second!: Page;
			await step("页面说「查天气」，幕僚长回答", async (page) => {
				await sayInPage(page, "查天气");
				await page.locator(".line.router .bubble", { hasText: "好的，去查了。" }).waitFor();
			});
			await step("打开第二个页面，看到同样的对话", async () => {
				second = await open(host.url);
				await waitStatus(second, "connected");
				await second.locator(".line.router .bubble", { hasText: "好的，去查了。" }).waitFor();
			});
			await step("第一个页面点清屏，两个页面都清空并出现细线", async (page) => {
				await page.click("#clear");
				await showsOnlyTheBar(page);
				await showsOnlyTheBar(second);
				assert.equal(await page.locator("#clear").isDisabled(), true, "对话空了，清屏按钮不可点");
			});
			await step("第二个页面点细线，只在这一页展开被清掉的行", async (page) => {
				await bar(second).click();
				await second.locator(".earlier .line .bubble", { hasText: "查天气" }).waitFor();
				assert.match(await bar(second).innerText(), /收起/);
				assert.equal(await page.locator(".earlier .line").count(), 0);
				assert.equal(await lines(second).count(), 0, "展开的行不算对话里的行");
			});
			await step("重载页面和新开的浏览器都只有细线", async (page) => {
				await page.reload();
				await waitStatus(page, "connected");
				await showsOnlyTheBar(page);
				const fresh = await open(host.url);
				await waitStatus(fresh, "connected");
				await showsOnlyTheBar(fresh);
			});
			await step("重启宿主后页面自己连回来，仍只有细线", async (page) => {
				await host.restart();
				await waitStatus(page, "connected");
				await showsOnlyTheBar(page);
			});
			await step("清屏后新说的话出现在细线下面", async (page) => {
				await sayInPage(page, "明天呢");
				await page.locator(".line.router .bubble", { hasText: "明天晴。" }).waitFor();
				assert.equal(await lines(page).count(), 2);
				const below = await page.evaluate(() => {
					const top = document.querySelector(".cleared-bar")!;
					return [...document.querySelectorAll(".thread > .line")].every((l) => top.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING);
				});
				assert.equal(below, true);
			});
		},
		{ fixedPort: true },
	));

test("清屏后问「刚才那件事」，幕僚长这一轮的模型请求里仍有清屏前那句话", (t) =>
	story(
		t,
		{
			router: [
				on("Router 回答查天气", /^\[对话\][\s\S]*查天气/, (c) => [reply(c, "好的，去查了。")]),
				on("Router 回答刚才那件事", /^\[对话\][\s\S]*刚才那件事呢/, (c) => [reply(c, "你刚才问的是天气。")]),
			],
		},
		async ({ step, fake }) => {
			await step("页面说「查天气」，幕僚长回答", async (page) => {
				await sayInPage(page, "查天气");
				await page.locator(".line.router .bubble", { hasText: "好的，去查了。" }).waitFor();
			});
			await step("点清屏", async (page) => {
				await page.click("#clear");
				await bar(page).waitFor();
			});
			await step("问「刚才那件事呢」，幕僚长回答", async (page) => {
				await sayInPage(page, "刚才那件事呢");
				await page.locator(".line.router .bubble", { hasText: "你刚才问的是天气。" }).waitFor();
			});
			await step("这一轮的模型请求里仍有清屏前那句话", async () => {
				const asked = fake.exchanges.find((e) => e.steps.includes("Router 回答刚才那件事"));
				assert.ok(asked, "幕僚长收到了清屏后的那句话");
				assert.ok(!asked.cards.some((card) => card.includes("查天气")), "清屏后那张卡片本身不带清屏前的话");
				assert.ok(asked.userTexts.some((text) => text.includes("查天气")), `请求里的使用者消息：${JSON.stringify(asked.userTexts)}`);
			});
		},
	));

test("发出的话上屏后被清屏，确认又丢了，页面仍显示已发送，不让用户重发", (t) =>
	story(
		t,
		{ router: [on("Router 回答买咖啡", /^\[对话\][\s\S]*买咖啡/, (c) => [reply(c, "收到咖啡。")])] },
		async ({ step }) => {
			await step("宿主收到「买咖啡」，页面等不到确认；这句话上屏后点清屏", async (page) => {
				let release!: () => void;
				const held = new Promise<void>((done) => (release = done));
				await page.route("**/say?*", async (route) => {
					await route.fetch();
					await held;
					await route.abort().catch(() => {});
				});
				await page.fill("#composer", "买咖啡");
				await page.click("#send");
				await page.locator(".thread > .line.user .bubble", { hasText: "买咖啡" }).waitFor();
				await page.click("#clear");
				await bar(page).waitFor();
				await page.waitForFunction(() => document.getElementById("say-status")?.dataset.state !== "sending", null, { timeout: 10_000 });
				release();
				await page.unroute("**/say?*");
				const state = await page.evaluate(() => document.getElementById("say-status")!.dataset.state);
				assert.equal(state, "delivered", `输入框：${JSON.stringify(await page.inputValue("#composer"))}`);
				assert.equal(await page.inputValue("#composer"), "");
			});
		},
	));

test("清屏是输入框下方状态文字右端的下划线文字，对话栏上方没有标题行，点它仍能清屏", (t) =>
	story(
		t,
		{ router: [on("Router 回答查天气", /^\[对话\][\s\S]*查天气/, (c) => [reply(c, "好的，去查了。")])] },
		async ({ step }) => {
			const clear = (page: Page) => page.getByRole("main", { name: "对话" }).getByRole("button", { name: "清屏" });
			await step("页面说「查天气」，幕僚长回答", async (page) => {
				await sayInPage(page, "查天气");
				await page.locator(".line.router .bubble", { hasText: "好的，去查了。" }).waitFor();
			});
			await step("清屏在输入框下方，和状态文字同一行、在它右边", async (page) => {
				const layout = await clear(page).evaluate((button) => {
					const box = (el: Element) => el.getBoundingClientRect();
					const status = document.getElementById("say-status")!;
					const composer = document.querySelector(".composer")!;
					return {
						inSayForm: button.closest("form#say") !== null,
						sameRow: button.parentElement === status.parentElement,
						rightOfStatus: box(button).left >= box(status).right,
						belowComposer: box(button).top >= box(composer).bottom,
					};
				});
				assert.deepEqual(layout, { inSayForm: true, sameRow: true, rightOfStatus: true, belowComposer: true });
			});
			await step("清屏看起来是下划线文字：没有边框，背景透明", async (page) => {
				const look = await clear(page).evaluate((button) => {
					const style = getComputedStyle(button);
					return { underline: style.textDecorationLine.includes("underline"), border: style.borderTopWidth, background: style.backgroundColor };
				});
				assert.deepEqual(look, { underline: true, border: "0px", background: "rgba(0, 0, 0, 0)" });
			});
			await step("对话栏上方没有标题行，对话直接从栏顶开始", async (page) => {
				const first = await page.evaluate(() => document.querySelector("main")!.firstElementChild!.id);
				assert.equal(first, "conversation");
			});
			await step("点清屏，对话清空并出现细线", async (page) => {
				await clear(page).click();
				await showsOnlyTheBar(page);
			});
		},
	));
