// Brand review screenshots: a real host and Worker on the fake model, headless Chromium, light and dark, 1440×900 and 390 wide.
// Usage: node --import ./src/pi-runtime.mjs docs/web-client/evidence/brand-review.ts <scratch dir>
// The state lives under <scratch dir>; PSA_STATE_DIR is a short symlink to it because host.sock must fit in sun_path.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { FakeModel, on, openTicket, reply, report, worker } from "../../../tests/e2e/fake-model.ts";
import { REPO, fakeAgentEnv, fakeModels, startHost, stopAllGroups } from "../../../tests/e2e/harness.ts";

const scratch = process.argv[2];
if (!scratch) throw new Error("用法：brand-review.ts <临时目录>");
const MEDIA = join(REPO, "docs/web-client/media");
const root = mkdtempSync(join(scratch, "brand-review-"));
const link = join(mkdtempSync(join(tmpdir(), "psa-br-")), "s");
const stateDir = join(root, "s");
mkdirSync(stateDir);
symlinkSync(stateDir, link);

const BRIEF = "跟进 NVDA 今日新闻";
const MANY = 30;
const fake = await FakeModel.start({
	router: [
		on("开新闻任务", /^\[对话\][\s\S]*NVDA/, (c) => [openTicket(c, "跟进 NVDA 今日新闻", BRIEF), reply(c, "已安排助手跟进 NVDA 今天的新闻，有**重要变化**时通知你。")]),
		on("直接回答", /^\[对话\][\s\S]*你在吗/, (c) => [reply(c, "在。一位助手正在跟进 NVDA 的新闻。")]),
		on("转述汇报", /^\[Worker 汇报\][\s\S]*听证会/, (c) => [reply(c, "NVDA 今天的主要新闻是黄仁勋出席听证会，盘中跌 2.1%。")]),
	],
	workers: [worker(BRIEF, on("新闻", /^\[任务说明\]/, () => [report("progress", "读完三篇报道"), report("ready", "主要新闻是黄仁勋出席听证会，盘中跌 2.1%")]))],
}, "");
const env = { ...fakeAgentEnv(fake, join(root, "pi")), PSA_STATE_DIR: link };
const shots: string[] = [];
const notes: string[] = [];
const browser = await chromium.launch();

const noPageScroll = async (page: Page, slug: string) => {
	const size = await page.evaluate(() => ({ scroll: document.scrollingElement!.scrollHeight, inner: innerHeight, wide: document.scrollingElement!.scrollWidth, width: innerWidth }));
	assert.equal(size.scroll, size.inner, `${slug}：整页高 ${size.scroll}，窗口高 ${size.inner}`);
	assert.equal(size.wide, size.width, `${slug}：整页宽 ${size.wide}，窗口宽 ${size.width}`);
};
const everyUserLineHasAvatar = (page: Page) =>
	page.locator(".line.user").evaluateAll((nodes) =>
		nodes.every((n) => {
			const avatar = n.querySelector(":scope > .avatar.you");
			return !!avatar && avatar.getBoundingClientRect().left >= n.querySelector(".bubble")!.getBoundingClientRect().right;
		}),
	);
const setTheme = async (page: Page, theme: "light" | "dark" | "system") => {
	await page.evaluate((t) => (t === "system" ? delete document.documentElement.dataset.theme : (document.documentElement.dataset.theme = t)), theme);
	await page.waitForTimeout(150);
};
const shoot = async (target: Page | ReturnType<Page["locator"]>, slug: string) => {
	const file = join(MEDIA, `brand-review-${slug}.png`);
	await target.screenshot({ path: file });
	shots.push(file);
};

try {
	const host = await startHost({ models: fakeModels, stateDir: link, logFile: join(root, "host.log"), config: { webPort: 0 }, env });
	const open = async (viewport: { width: number; height: number }, scale = 1) => {
		const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
		const page = await context.newPage();
		page.setDefaultTimeout(15_000);
		await page.goto(host.url.href);
		await page.waitForFunction(() => document.querySelector("#status")?.getAttribute("data-status") === "connected");
		return page;
	};
	const say = async (page: Page, text: string) => {
		await page.fill("#composer", text);
		await page.click("#send");
		await page.waitForFunction(() => document.getElementById("say-status")?.dataset.state === "delivered");
	};

	const page = await open({ width: 1440, height: 900 });
	assert.equal(await page.title(), "白宫 · Pi Super Agent");
	assert.equal(await page.locator("header .brand").innerText(), "白宫\nPi Super Agent · 你的 24 小时幕僚");
	await say(page, "帮我盯一下 NVDA 今天的新闻");
	await page.locator(".line.router", { hasText: "已安排助手" }).waitFor();
	await say(page, "你在吗");
	await page.locator(".line.router", { hasText: "一位助手正在跟进" }).waitFor();
	await page.locator(".line.router", { hasText: "黄仁勋出席听证会" }).waitFor();
	await page.waitForTimeout(500);
	assert.ok(await everyUserLineHasAvatar(page), "你的每条消息右侧有头像");
	await noPageScroll(page, "desktop");
	for (const theme of ["light", "dark"] as const) {
		await setTheme(page, theme);
		await shoot(page, theme);
		await shoot(page.locator("header"), `header-${theme}`);
	}
	await setTheme(page, "system");
	await page.emulateMedia({ colorScheme: "dark" });
	await page.waitForTimeout(150);
	await shoot(page, "system-dark");
	await page.emulateMedia({ colorScheme: "light" });

	const zoom = await open({ width: 1440, height: 900 }, 2);
	await setTheme(zoom, "light");
	await zoom.locator(".line.user", { hasText: "你在吗" }).waitFor();
	await shoot(zoom.locator(".thread"), "avatar");
	await zoom.context().close();

	for (const theme of ["light", "dark"] as const) {
		const phone = await open({ width: 390, height: 844 });
		await setTheme(phone, theme);
		await phone.locator(".line.user", { hasText: "你在吗" }).waitFor();
		await phone.locator(".line.router").last().scrollIntoViewIfNeeded();
		await phone.waitForTimeout(200);
		const wide = await phone.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth);
		assert.equal(wide, 0, `390 宽 ${theme}：多出 ${wide}px 横向滚动`);
		const overlap = await phone.evaluate(() => document.querySelector("#say")!.getBoundingClientRect().bottom - document.querySelector("#how")!.getBoundingClientRect().top);
		assert.ok(overlap <= 0, `390 宽 ${theme}：对话压住执行过程 ${overlap}px`);
		const header = await phone.locator("header").boundingBox();
		assert.ok(header && header.width <= 390, "页头不超出窗口");
		await shoot(phone, `phone-${theme}`);
		await phone.context().close();
	}

	const icon = new URL("/icon.svg", host.url).href;
	const sheet = await browser.newPage({ viewport: { width: 420, height: 200 } });
	await sheet.setContent(`<body style="margin:0;font:12px system-ui">${["#ffffff", "#15161a"].map((bg) => `<div style="background:${bg};padding:16px;display:flex;gap:24px;align-items:center">${[16, 32, 64].map((n) => `<img src="${icon}" width="${n}" height="${n}">`).join("")}</div>`).join("")}</body>`);
	await sheet.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
	await shoot(sheet, "favicon");
	await sheet.close();

	for (let i = 1; i <= MANY; i++) await say(page, `第 ${i} 句：补充一点背景`);
	await page.waitForFunction((n) => document.querySelectorAll(".line.user").length === n, MANY + 2);
	await setTheme(page, "light");
	assert.ok(await everyUserLineHasAvatar(page), "很多条消息时每条都有头像");
	await noPageScroll(page, "many");
	await shoot(page, "many");
	notes.push(`你的消息 ${await page.locator(".line.user").count()} 条，头像 ${await page.locator(".line.user > .avatar.you").count()} 个`);
	notes.push(`假模型剩余：${JSON.stringify(fake.leftovers().unused)}`);
} finally {
	await browser.close();
	const left = await stopAllGroups();
	await fake.close();
	rmSync(join(link, ".."), { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
	console.log([...notes, ...shots, `残留进程组：${left.join(", ") || "无"}`].join("\n"));
}
