import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { on, reply, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, REPO, story } from "./harness.ts";

after(closeBrowser);

const SHOTS = process.env.PSA_WATCH_SHOTS ?? join(REPO, "tests/e2e/.out/watching");

const TITLE = "盯 AMD 今天的走势";
const THREAD = "thr_watch:AMD";
const ids = (card: string, prefix: string) => card.match(new RegExp(`${prefix}_[\\w-]+`))?.[0];
const openWatching = (card: string): ToolCall => ({
	name: "route",
	args: { decisions: [{ kind: "open_ticket", basis: "inference", triggerId: ids(card, "trg"), title: TITLE, brief: TITLE, threads: [THREAD] }] },
});
const waitingReport = (summary: string): ToolCall => ({ name: "report", args: { status: "ready", summary, waiting: true } });
const drop = (stateDir: string, id: string, body: string) => {
	mkdirSync(join(stateDir, "inbox"), { recursive: true });
	writeFileSync(join(stateDir, "inbox", `${id}.json`), JSON.stringify({ id, source: "watch", thread: "AMD", threadTitle: "AMD 今天的盯盘提醒", sender: "watch", body }));
};
const watchCard = (page: Page) => page.locator("#left section", { has: page.locator("h2", { hasText: /^盯着的事/ }) }).locator(".card");

test("盯着的事：做完一轮还订着线程的任务进「盯着的事」，写在等什么，有新汇报标「新」；追问引用幕僚长关于它的话；结束一键收进已完成，之后的消息不再交给它", (t) =>
	story(
		t,
		{
			router: [
				on("幕僚长为到档开任务并订线程", /^\[候选触发\][^\n]*来源 watch[\s\S]*AMD 冲到 260/, (c) => [openWatching(c)]),
				on("幕僚长转告第一轮", /^\[Worker 汇报\][\s\S]*放量站上 260/, (c) => [reply(c, "AMD 放量站上 260，我继续盯着。")]),
				on("幕僚长看到结束后的新消息，相关任务是无", /^\[候选触发\][^\n]*来源 watch[\s\S]*AMD 回落到 250\n相关任务：无/, () => "ok"),
			],
			workers: [worker(TITLE, on("助手做完一轮，还在等", /^\[任务说明\]/, () => [waitingReport("AMD 放量站上 260，后面的提醒继续看。")]))],
		},
		async ({ step, stateDir, cli, open, host }) => {
			await step("投递一条到档消息：任务进「盯着的事 · 1」，卡片写「在等：AMD 今天的盯盘提醒（watch）」，标着「新」，有追问和结束，没有停止", async (page) => {
				drop(stateDir, "amd-1", "AMD 冲到 260");
				await page.locator("#left h2", { hasText: "盯着的事 · 1" }).waitFor({ timeout: 20_000 });
				const card = watchCard(page);
				assert.equal(await card.locator(".title").textContent(), TITLE);
				assert.equal(await card.locator(".waits").textContent(), "在等：AMD 今天的盯盘提醒（watch）");
				assert.match((await card.locator(".why").textContent())!, /盯着$/);
				assert.equal(await card.locator(".unread").textContent(), "新");
				assert.deepEqual(await card.locator(".row button").allTextContents(), ["追问", "结束"]);
				assert.deepEqual(await page.locator("#left h2").allTextContents(), ["待你处理 · 0", "盯着的事 · 1", "进行中 · 0"]);
				await page.locator(".line.router .bubble", { hasText: "我继续盯着" }).waitFor({ timeout: 20_000 });
				mkdirSync(SHOTS, { recursive: true });
				await page.screenshot({ path: join(SHOTS, "watching-card.png") });
			});
			await step("打开这件事看执行过程，「新」就没了", async (page) => {
				await watchCard(page).click();
				await watchCard(page).locator(".unread").waitFor({ state: "detached" });
			});
			await step("点追问：引用条是幕僚长关于这件事说的最后一句，光标在输入框里", async (page) => {
				await watchCard(page).getByRole("button", { name: "追问" }).click();
				await page.locator("#quote-strip").waitFor();
				assert.match((await page.locator("#quote-strip .quote-text").textContent())!, /AMD 放量站上 260，我继续盯着/);
				assert.equal(await page.evaluate(() => document.activeElement?.id), "composer");
				await page.getByRole("button", { name: "取消引用" }).click();
			});
			await step("手机上在「待办」屏点追问：换到「对话」屏，引用条在输入框上方", async () => {
				const phone = await open(host.url, { context: { viewport: { width: 390, height: 844 } } });
				await phone.locator('#bottom button[data-place="todo"]').click();
				await watchCard(phone).getByRole("button", { name: "追问" }).click();
				await phone.waitForFunction(() => document.body.dataset.screen === "chat");
				await phone.locator("#quote-strip").waitFor();
				await phone.screenshot({ path: join(SHOTS, "watching-follow-up-phone.png") });
			});
			await step("点结束：不经过输入框，卡片离开盯着的事，进已完成", async (page) => {
				await watchCard(page).getByRole("button", { name: "结束" }).click();
				await page.locator("#left h2", { hasText: /^盯着的事/ }).waitFor({ state: "detached" });
				assert.equal(await page.inputValue("#composer"), "");
				await page.locator("#tab-done").click();
				await page.locator("#done .card", { hasText: TITLE }).waitFor();
			});
			await step("同一线程再来消息，不再交给结束了的任务，交给幕僚长", async () => {
				drop(stateDir, "amd-2", "AMD 回落到 250");
				const deadline = Date.now() + 20_000;
				let log = "";
				while (!/AMD 回落到 250/.test(log) && Date.now() < deadline) log = await cli(["src/cli/log.ts", "5"]);
				assert.match(log.split("\n").find((l) => l.includes("AMD 回落到 250")) ?? "", /等 Router 处理/);
			});
		},
	));
