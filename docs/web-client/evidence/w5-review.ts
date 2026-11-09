// W5 review screenshots: a real host and Workers on the fake model, the toy-market module, and headless Chromium at 1440×900.
// Usage: node --import ./src/pi-runtime.mjs docs/web-client/evidence/w5-review.ts <scratch dir>
// The state lives under <scratch dir>; PSA_STATE_DIR is a short symlink to it because host.sock must fit in sun_path.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { FakeModel, on, openTicket, reply, report, worker, type ToolCall } from "../../../tests/e2e/fake-model.ts";
import { REPO, fakeAgentEnv, fakeModels, runSync, startHost, stopAllGroups } from "../../../tests/e2e/harness.ts";

const scratch = process.argv[2];
if (!scratch) throw new Error("用法：w5-review.ts <临时目录>");
const MEDIA = join(REPO, "docs/web-client/media");
const root = mkdtempSync(join(scratch, "w5-review-"));
const link = join(mkdtempSync(join(tmpdir(), "psa-w5-")), "s");
const stateDir = join(root, "s");
mkdirSync(stateDir);
symlinkSync(stateDir, link);
cpSync(join(REPO, "modules/toy-market"), join(root, "modules/toy-market"), { recursive: true });

const NOTES = { minutes: "整理本周三次例会的纪要", weather: "查明天上海的天气", market: "核实 TOYX 的这次波动" };
const finish = (summary: string) => on(`收尾：${summary}`, /^\[Router 备注/, () => [report("ready", summary)]);
const progress = (...lines: string[]) => lines.map((l) => report("progress", l));
const noteAll = (card: string): ToolCall[] => [...card.matchAll(/(tkt_[\w-]+)「/g)].map(([, ticketId]) => ({ name: "note", args: { ticketId, text: "使用者说可以收尾了" } }));

const fake = await FakeModel.start({
	router: [
		on("开纪要", /^\[对话\][\s\S]*纪要/, (c) => [openTicket(c, "整理本周例会纪要", NOTES.minutes), reply(c, "已安排助手整理纪要")]),
		on("开天气", /^\[对话\][\s\S]*天气/, (c) => [openTicket(c, "查明天上海天气", NOTES.weather), reply(c, "已安排助手查天气")]),
		on("开行情", /^\[候选触发\][\s\S]*toy-market/, (c) => [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "rule", ruleId: "toy-market/big-move", triggerId: c.match(/trg_[\w-]+/)?.[0], title: "核实 TOYX 跌 5.2%", brief: NOTES.market }] } }]),
		on("转交纪要补充", /^\[对话\][\s\S]*使用者：纪要里的行动项/, (c) => [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: c.match(/trg_[\w-]+/)?.[0], ticketId: c.match(/(tkt_[\w-]+)「整理本周例会纪要」/)?.[1] }] } }]),
		on("直接回答", /^\[对话\][\s\S]*使用者：你在吗/, (c) => [reply(c, "在，两位助手正在处理。")]),
		on("收尾", /^\[对话\][\s\S]*收尾/, (c) => [...noteAll(c), reply(c, "已通知三位助手收尾")]),
		on("转述纪要", /^\[Worker 汇报\][\s\S]*行动项/, (c) => [reply(c, "纪要整理好了，共 14 条行动项")]),
		on("转述天气", /^\[Worker 汇报\][\s\S]*小雨/, (c) => [reply(c, "明天多云转小雨，12 到 17 度")]),
		on("转述行情", /^\[Worker 汇报\][\s\S]*TOYX/, (c) => [reply(c, "TOYX 跌 5.2% 属实，成交量偏低")]),
	],
	workers: [
		worker(NOTES.minutes, on("纪要", /^\[任务说明\]/, () => progress("读完周一纪要", "读完周三纪要", "读完周五纪要", "合并重复的行动项", "按负责人分组")), on("纪要补充", /^\[使用者的话/, () => progress("已按负责人重新排序")), finish("纪要已整理，共 14 条行动项")),
		worker(NOTES.weather, on("天气", /^\[任务说明\]/, () => progress("查到明天多云转小雨")), finish("明天多云转小雨，12 到 17 度")),
		worker(NOTES.market, on("行情", /^\[任务说明\]/, () => progress("读取 TOYX 最近报价", "对比昨日收盘")), finish("TOYX 跌 5.2% 属实，成交量偏低")),
	],
}, "");
const env = { ...fakeAgentEnv(fake, join(root, "pi")), PSA_STATE_DIR: link };
const shots: string[] = [];
const report_: string[] = [];
const browser = await chromium.launch();
try {
	const host = await startHost({ models: fakeModels, stateDir: link, logFile: join(root, "host.log"), config: { webPort: 0, modulesDirs: [join(root, "modules")] }, env });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.setDefaultTimeout(15_000);
	await page.goto(host.url.href);
	await page.waitForFunction(() => document.querySelector("#status")?.getAttribute("data-status") === "connected");

	const chips = (n: number) => page.waitForFunction((n) => document.querySelectorAll("#helpers .helper-chip").length === n, n);
	const say = async (text: string) => {
		await page.fill("#composer", text);
		await page.click("#send");
		await page.waitForFunction(() => document.getElementById("say-status")?.dataset.state === "delivered");
	};
	const shoot = async (slug: string) => {
		const size = await page.evaluate(() => ({ scroll: document.scrollingElement!.scrollHeight, inner: innerHeight }));
		assert.equal(size.scroll, size.inner, `${slug}：整页高 ${size.scroll}，窗口高 ${size.inner}`);
		for (const theme of ["light", "dark"]) {
			await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
			await page.waitForTimeout(150);
			const file = join(MEDIA, `w5-review-${slug}-${theme}.png`);
			await page.screenshot({ path: file });
			shots.push(file);
		}
		report_.push(`${slug}: ${(await page.locator("#helpers").innerText()).replace(/\s+/g, " ")}`);
	};

	await say("帮我整理本周三次例会的纪要");
	await say("查一下明天上海的天气");
	await chips(2);
	await page.locator("#steps").waitFor({ state: "attached" });
	await page.waitForTimeout(1500);
	await shoot("two-helpers");

	const routeUnder = (text: string) => page.locator(".line.user", { hasText: text }).locator(".route");
	await page.locator("#left .card", { hasText: "按负责人分组" }).waitFor();
	await say("纪要里的行动项按负责人排一下");
	await routeUnder("纪要里的行动项").filter({ hasText: /^已交给 .+（整理本周例会纪要）$/ }).waitFor();
	await say("你在吗");
	await routeUnder("你在吗").filter({ hasText: "幕僚长直接回答" }).waitFor();
	await routeUnder("帮我整理本周三次例会的纪要").filter({ hasText: /^已开新任务「整理本周例会纪要」 · / }).waitFor();
	report_.push(`去向：${(await page.locator(".line.user .route").allInnerTexts()).join(" | ")}`);
	await shoot("routing");

	const feed = runSync(["modules/toy-market/feed.ts", "TOYX", "-5.2", "12"], { ...process.env, ...env });
	assert.equal(feed.status, 0, feed.stderr);
	await chips(3);
	await page.locator("#helpers .helper-chip", { hasText: "副幕僚长 #3" }).waitFor();
	await page.waitForTimeout(1500);
	await shoot("market-helper");

	await page.locator("#helpers .helper-chip", { hasText: "副幕僚长 #1" }).click();
	await page.locator("#how-life").waitFor();
	await page.locator("#steps .step", { hasText: "按负责人分组" }).waitFor();
	await shoot("open-how");

	await say("三件事都可以收尾了");
	await chips(0);
	await page.locator("#helpers .total", { hasText: "今日 3 位" }).waitFor();
	await page.locator("#how-life", { hasText: "结束" }).waitFor();
	await page.locator(".line.router", { hasText: "TOYX 跌 5.2% 属实" }).waitFor();
	await page.waitForTimeout(500);
	await shoot("done");

	report_.push(`执行过程头部：${await page.locator("#how-helper").innerText()} | ${await page.locator("#how-life").innerText()}`);
	report_.push(`假模型剩余：${JSON.stringify(fake.leftovers())}`);
} finally {
	await browser.close();
	const left = await stopAllGroups();
	await fake.close();
	rmSync(join(link, ".."), { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
	console.log([...report_, ...shots, `残留进程组：${left.join(", ") || "无"}`].join("\n"));
}
