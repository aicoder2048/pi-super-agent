import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { on, reply } from "./fake-model.ts";
import { closeBrowser, sayInPage, story, waitStatus } from "./harness.ts";

after(closeBrowser);

const composer = (page: Page) => page.locator("#composer");
const press = (page: Page, key: string) => composer(page).press(key);
const caret = (page: Page) => composer(page).evaluate((box: HTMLTextAreaElement) => ({ start: box.selectionStart, end: box.selectionEnd, length: box.value.length }));
const shows = async (page: Page, text: string) => {
	assert.equal(await composer(page).inputValue(), text);
	const at = await caret(page);
	assert.deepEqual([at.start, at.end], [at.length, at.length], "光标在末尾");
};

test("输入框历史：↑ 往回翻自己发过的话，↓ 往新的翻、越过最新一句回到草稿；多行草稿中间按 ↑ 只移光标；改了字从头翻；重载后还在", (t) =>
	story(
		t,
		{
			router: [
				on("Router 回答查天气", /^\[对话\][\s\S]*查天气/, (c) => [reply(c, "明天多云。")]),
				on("Router 回答改成 B", /^\[对话\][\s\S]*改成 B/, (c) => [reply(c, "收到，改成 B。")]),
			],
		},
		async ({ step }) => {
			await step("先后发「查天气」和「改成 B」", async (page) => {
				await sayInPage(page, "查天气");
				await page.locator(".line.router .bubble", { hasText: "明天多云。" }).waitFor();
				await sayInPage(page, "改成 B");
				await page.locator(".line.router .bubble", { hasText: "收到，改成 B。" }).waitFor();
				assert.equal(await composer(page).inputValue(), "");
			});
			await step("写了半句「没写完」，按两次 ↑ 依次是「改成 B」「查天气」，再按 ↑ 停在最早一句", async (page) => {
				await composer(page).fill("没写完");
				await press(page, "ArrowUp");
				await shows(page, "改成 B");
				await press(page, "ArrowUp");
				await shows(page, "查天气");
				await press(page, "ArrowUp");
				assert.equal(await composer(page).inputValue(), "查天气");
			});
			await step("按两次 ↓ 依次是「改成 B」和原来的草稿「没写完」，再按 ↓ 不变", async (page) => {
				await press(page, "ArrowDown");
				await shows(page, "改成 B");
				await press(page, "ArrowDown");
				await shows(page, "没写完");
				await press(page, "ArrowDown");
				assert.equal(await composer(page).inputValue(), "没写完");
			});
			await step("三行的草稿，光标在中间一行时 ↑ 只把光标移到第一行；在第一行再按 ↑ 才翻历史，↓ 回到三行草稿", async (page) => {
				const draft = "第一行\n第二行\n第三行";
				await composer(page).fill(draft);
				await composer(page).evaluate((box: HTMLTextAreaElement) => box.setSelectionRange(5, 5));
				await press(page, "ArrowUp");
				assert.equal(await composer(page).inputValue(), draft);
				assert.ok((await caret(page)).start <= 3, "光标到了第一行");
				await press(page, "ArrowUp");
				await shows(page, "改成 B");
				await press(page, "ArrowDown");
				await shows(page, draft);
			});
			await step("翻到「改成 B」后改成「改成 B 吧」，再按 ↑ 从最新一句重新翻，↓ 回到改过的字", async (page) => {
				await composer(page).fill("");
				await press(page, "ArrowUp");
				await shows(page, "改成 B");
				await composer(page).pressSequentially(" 吧");
				await press(page, "ArrowUp");
				await shows(page, "改成 B");
				await press(page, "ArrowDown");
				await shows(page, "改成 B 吧");
			});
			await step("重载页面后，空输入框按 ↑ 仍是「改成 B」", async (page) => {
				await page.reload();
				await waitStatus(page, "connected");
				await page.locator(".line.user", { hasText: "改成 B" }).waitFor();
				await composer(page).focus();
				await press(page, "ArrowUp");
				await shows(page, "改成 B");
			});
		},
	));
