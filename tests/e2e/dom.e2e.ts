import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { on, openTicket, reply, report, worker } from "./fake-model.ts";
import { closeBrowser, sayInPage, story, waitStatus } from "./harness.ts";

after(closeBrowser);

const HTML = `<img src=x onerror="window.__psaXss=1"><b>粗</b>`;
const BRIEF = "什么都不做，汇报无需处理";

/** Records every #status change from now on, so a quick disconnect and reconnect is still seen. */
const watchStatus = (page: Page) =>
	page.evaluate(() => {
		const el = document.querySelector("#status")!;
		const seen: string[] = ((window as any).__statusSeen = [el.getAttribute("data-status")!]);
		new MutationObserver(() => seen.push(el.getAttribute("data-status")!)).observe(el, { attributes: true, attributeFilter: ["data-status"] });
	});
const statusSeen = (page: Page) => page.evaluate(() => (window as any).__statusSeen as string[]);

test("对话和看板里的 HTML 原样显示，不执行", (t) =>
	story(
		t,
		{
			router: [on("Router 开任务并回 HTML", /^\[对话\]/, (c) => [openTicket(c, HTML, BRIEF), reply(c, HTML)])],
			workers: [worker(BRIEF, on("Worker 无需处理", /^\[任务说明\]/, () => [report("no_action", "无事可做")]))],
		},
		async ({ step }) => {
			await step("页面投递一段 HTML", (page) => sayInPage(page, HTML));
			await step("幕僚长的回复原样显示", (page) => page.locator(".line.router .bubble", { hasText: HTML }).waitFor());
			await step("看板标题原样显示", (page) => page.locator("#left .card .title", { hasText: HTML }).first().waitFor({ state: "attached" }));
			await step("没有生成 img 或 b 元素，onerror 没有执行", async (page) => {
				assert.equal(await page.locator("#conversation img, #conversation b, #left img, #left b").count(), 0);
				assert.equal(await page.evaluate(() => (window as any).__psaXss), undefined);
			});
		},
	));

test("宿主在同一状态目录重启，页面沿用同一个 token 自己连回来", (t) =>
	story(
		t,
		{ router: [] },
		async ({ step, host }) => {
			const before = host.url.href;
			await step("重启宿主，网址不变", async (page) => {
				await watchStatus(page);
				assert.equal((await host.restart()).href, before);
			});
			await step("页面断开后自己回到已连接", async (page) => {
				await waitStatus(page, "connected");
				const seen = await statusSeen(page);
				assert.ok(seen.includes("disconnected"), `状态变化：${seen.join(" → ")}`);
			});
		},
		{ fixedPort: true },
	));

test("web-token-rotate 换过 token 再重启，旧页面显示链接已失效，新网址能连上", (t) =>
	story(
		t,
		{ router: [] },
		async ({ step, host, open, cli }) => {
			const before = host.url.href;
			let fresh!: URL;
			await step("换 token 后重启宿主", async () => {
				await cli(["src/cli/web-token-rotate.ts"]);
				fresh = await host.restart();
				assert.notEqual(fresh.href, before);
			});
			await step("旧页面显示链接已失效", (page) => waitStatus(page, "expired"));
			await step("新网址能连上", async () => waitStatus(await open(fresh), "connected"));
		},
		{ fixedPort: true },
	));

test("宿主卡死时页面离开已连接，恢复后回来", (t) =>
	story(
		t,
		{ router: [] },
		async ({ step, host }) => {
			await step("冻住宿主进程组，页面时钟快进 36 秒", async (page) => {
				host.freeze();
				await page.clock.fastForward(36_000);
			});
			await step("页面显示连接中断", (page) => waitStatus(page, "disconnected"));
			await step("解冻后重新连上", async (page) => {
				host.thaw();
				await page.clock.fastForward(2_000);
				await waitStatus(page, "connected");
			});
		},
		{ fakeClock: true },
	));
