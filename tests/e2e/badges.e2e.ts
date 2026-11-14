import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { REPO, closeBrowser, contrastOf, packageFiles, showScreen, story } from "./harness.ts";

after(closeBrowser);

const SHOTS = process.env.PSA_BADGE_SHOTS ?? join(REPO, "tests/e2e/.out/badges");
mkdirSync(SHOTS, { recursive: true });
const FIXTURE = join(REPO, "tests/fixtures/modules/private-line");
const HANDLER = `export default (input) => ({ alerts: input.items.map((i) => ({ id: i.id, text: i.text, at: new Date().toISOString(), push: "badge", key: i.key })) });\n`;
const FILES = { ...packageFiles(FIXTURE, "private-line"), "modules/private-line/feeds/inbox/index.ts": HANDLER };
const HOSTILE = "AMD · <img src=x onerror=\"document.title='pwned'\"> 逆大盘：AMD +2.10%，QQQ -1.00%";

const modules = (page: Page) => page.locator("#modules");
async function openModules(page: Page, details: boolean): Promise<void> {
	await showScreen(page, "overview");
	await page.locator("#tab-modules").click();
	const more = page.locator("#modules .more");
	if ((await more.getAttribute("aria-expanded")) !== String(details)) await more.click();
}

test("页面标记：模块卡按 key 列出当天的标记，同一个 key 换成新的，不进对话；文字照原样显示不当 HTML；窄屏、深色", (t) =>
	story(
		t,
		{ router: [], workers: [] },
		async ({ step, stateDir, host, open }) => {
			await step("打开模块，feed 交回三个标记（NVDA 来了两次）", async (page) => {
				await page.setViewportSize({ width: 1280, height: 1400 });
				await openModules(page, true);
				const card = page.locator('#modules .card.module[data-module="private-line"]');
				await card.locator("button.switch").click();
				await card.locator(".state", { hasText: /^运行中/ }).waitFor({ timeout: 5000 });
				const inbox = join(stateDir, "inbox", "private-line", "inbox");
				mkdirSync(inbox, { recursive: true });
				writeFileSync(join(inbox, "001.json"), JSON.stringify({ id: "b-1", key: "NVDA", text: "NVDA · 开盘跳空 +3.40%" }));
				writeFileSync(join(inbox, "002.json"), JSON.stringify({ id: "b-2", key: "AMD", text: HOSTILE }));
				writeFileSync(join(inbox, "003.json"), JSON.stringify({ id: "b-3", key: "NVDA", text: "NVDA · 开盘跳空 +3.40% · 盘中曾涨 +3.60%，现在跌 -0.40%" }));
				await card.locator(".badges-head", { hasText: "今日标记 · 2" }).waitFor({ timeout: 15_000 });
				await page.waitForFunction(() => document.querySelector('#modules .card.module[data-module="private-line"] .badges li:last-child')?.textContent?.includes("盘中曾涨"), undefined, { timeout: 15_000 });
				assert.deepEqual(await card.locator(".badges li").allTextContents(), [HOSTILE, "NVDA · 开盘跳空 +3.40% · 盘中曾涨 +3.60%，现在跌 -0.40%"]);
				assert.equal(await modules(page).locator("img").count(), 0, "标记里的尖括号没变成元素");
				assert.notEqual(await page.title(), "pwned");
				assert.doesNotMatch((await page.locator("#conversation").textContent()) ?? "", /开盘跳空/, "标记不进对话");
				await modules(page).screenshot({ path: join(SHOTS, "badges-card.png") });
			});
			await step("收起的模块栏里也看得到标记", async (page) => {
				await openModules(page, false);
				assert.deepEqual(await page.locator("#modules .module-row-wrap .badges li").allTextContents(), [HOSTILE, "NVDA · 开盘跳空 +3.40% · 盘中曾涨 +3.60%，现在跌 -0.40%"]);
				await modules(page).screenshot({ path: join(SHOTS, "badges-rows.png") });
			});
			await step("390 像素宽：标记折行，没有横向滚动", async () => {
				const narrow = await open(host.url, { context: { viewport: { width: 390, height: 844 } } });
				for (const details of [false, true]) {
					await openModules(narrow, details);
					await narrow.locator("#modules .badges li").first().waitFor();
					const widths = await narrow.evaluate(() => ({
						scroll: document.documentElement.scrollWidth,
						client: document.documentElement.clientWidth,
						rightmost: Math.max(...[...document.querySelectorAll("#modules .badges *")].map((n) => n.getBoundingClientRect().right)),
					}));
					assert.ok(widths.scroll <= widths.client && widths.rightmost <= widths.client, JSON.stringify(widths));
					await narrow.screenshot({ path: join(SHOTS, `badges-phone-${details ? "card" : "rows"}.png`) });
				}
			});
			await step("深色主题：标记的字对比度不低于 4.5 比 1", async () => {
				const dark = await open(host.url, { context: { colorScheme: "dark", viewport: { width: 390, height: 844 } } });
				await openModules(dark, true);
				await dark.locator("#modules .badges li").first().waitFor();
				const ratios: Record<string, number> = {};
				for (const selector of [".card.module .badges .badges-head", ".card.module .badges li"]) ratios[selector] = await contrastOf(dark, selector);
				writeFileSync(join(SHOTS, "badges-dark.txt"), `${JSON.stringify(ratios, null, 2)}\n`);
				for (const [selector, ratio] of Object.entries(ratios)) assert.ok(ratio >= 4.5, `${selector} ${ratio.toFixed(2)}`);
				await dark.screenshot({ path: join(SHOTS, "badges-dark.png") });
			});
		},
		{ files: FILES },
	));
