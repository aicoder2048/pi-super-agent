import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after } from "node:test";
import { ids } from "../helpers/fakes.ts";
import { FINNHUB_KEY_NAMES, KEY_NAMES } from "../../src/sources/market/key.ts";
import { dispatch, on, openTicket, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, REPO, packageFiles, sayInPage, story } from "./harness.ts";

after(closeBrowser);

const BAND_LINE = "NVDA 跌 -6.10%，到达 -5% 档。现价 168.20，报价 15:42 美东（延迟 15 分钟）。（规则 move-1，层级 5，做法 band-move）";
const BRIEF = "照 band-move 核实 NVDA 到 -5% 档：个股还是大盘，支撑阻力和趋势在哪";
const DESK_TASK = "NVDA 今天跌 6.1%，和 SPY、QQQ、半导体板块比是个股还是大盘行情？";
const STRUCTURE_TASK = "NVDA 日线的支撑阻力在哪？";
const TREND_TASK = "NVDA 日线的趋势和动量怎么样？";
const REPORT = "**个股领跌**并跌破 50 日均线；报价 15:42 美东（延迟 15 分钟）。这是技术分析，不是交易指令。";
const PI = { title: "写 Pi 扩展", brief: "说明怎么给 Pi 写一个注册工具的扩展" };
const PI_TASK = "给一个注册自定义工具的最小 Pi 扩展";
const BAND_SKILL = "领队先读这份：派哪三位";
const PI_SKILL = "Pi施工队的派活做法";
const WORKING_MS = 2500;
const NO_MARKET_KEYS = Object.fromEntries([...KEY_NAMES, ...FINNHUB_KEY_NAMES].map((name) => [name, ""]));

const openByBand = (card: string): ToolCall => ({
	name: "route",
	args: { decisions: [{ kind: "open_ticket", basis: "rule", ruleId: "stock-ta/watch-task", triggerId: ids(card, "trg"), threads: [card.match(/线程 (\S+)/)?.[1]], title: "核实 NVDA 到档", brief: BRIEF }] },
});
const openInPiPi = (card: string): ToolCall => {
	const call = openTicket(card, PI.title, PI.brief);
	return { ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain: "pi-pi" })) } };
};
const toolsOf = (fake: { exchanges: { conversation: string; tools: string[] }[] }, conversation: string) => [...fake.exchanges.find((e) => e.conversation === conversation)!.tools].sort();

test("技术分析研究组和仓库自带的 Pi施工队：stock-ta 到档触发开的任务归技术分析研究组，领队照 band-move 同时派给盘面、结构与形态、趋势与动量，四者都带着 stock-ta 的技能，成员只有自己列的工具；问 Pi 扩展怎么写的任务归 Pi施工队，领队带着 Pi 模块的技能派给扩展专家，专家不能执行命令", (t) =>
	story(
		t,
		{
			router: [
				on("Router 按 watch-task 规则开任务，不填领域", /^\[候选触发\][\s\S]*stock-ta\/quotes[\s\S]*NVDA/, (c) => [openByBand(c)]),
				on("Router 把 Pi 的问题交给 pi-pi 领域", /^\[对话\][\s\S]*扩展/, (c) => [openInPiPi(c), reply(c, "已交给 Pi施工队")]),
				on("Router 转告", /^\[Worker 汇报\][\s\S]*跌破 50 日均线/, (c) => [reply(c, "NVDA 跌 6.1%，个股领跌并跌破 50 日均线")]),
			],
			workers: [
				worker(
					BRIEF,
					on("领队一次同时派给三位", /^\[任务说明\]/, () => [dispatch("market-desk", DESK_TASK), dispatch("structure-pattern", STRUCTURE_TASK), dispatch("trend-momentum", TREND_TASK)]),
					on("领队收到盘面的回复", /^\[成员回复\] 成员回复 · 盘面（market-desk） · 完成/, () => []),
					on("领队收到结构与形态的回复", /^\[成员回复\] 成员回复 · 结构与形态（structure-pattern） · 完成/, () => []),
					on("领队收到趋势与动量的回复后汇报", /^\[成员回复\] 成员回复 · 趋势与动量（trend-momentum） · 完成/, () => [report("ready", REPORT)]),
				),
				worker(DESK_TASK, on("盘面回复", /^\[派活\] 盘面\n/, () => "结论：个股行情，SPY 只跌 0.8%。", WORKING_MS)),
				worker(STRUCTURE_TASK, on("结构与形态回复", /^\[派活\] 结构与形态\n/, () => "跌破 50 日均线，下一支撑 160。", WORKING_MS)),
				worker(TREND_TASK, on("趋势与动量回复", /^\[派活\] 趋势与动量\n/, () => "MACD 死叉，动量转弱。", WORKING_MS)),
				worker(
					PI.brief,
					on("Pi 领队汇报进度并派给扩展专家", /^\[任务说明\]/, () => [report("progress", "正在查扩展文档"), dispatch("ext-expert", PI_TASK)]),
					on("Pi 领队收到扩展专家的回复", /^\[成员回复\] 成员回复 · Pi 扩展专家（ext-expert） · 完成/, () => []),
				),
				worker(PI_TASK, on("扩展专家回复", /^\[派活\] Pi 扩展专家\n/, () => "结论：用 pi.registerTool()。", WORKING_MS)),
			],
		},
		async ({ step, fake, cli }) => {
			await step("打开 stock-ta，投递一条 stock-ta/quotes 的到档触发，任务是四字名加「技术分析研究组领队 #1」", async (page) => {
				await cli(["src/cli/module.ts", "on", "stock-ta"]);
				await page.locator("#tab-modules").click();
				await page.locator("#modules", { hasText: "运行中 3" }).waitFor({ timeout: 10_000 });
				await cli(["src/cli/drop.ts", "stock-ta/quotes", "NVDA:2026-11-13", BAND_LINE]);
				const chip = page.locator("#helpers .helper-chip", { hasText: "技术分析研究组领队 #1" });
				await chip.waitFor({ timeout: 20_000 });
				const name = (await chip.locator(".name").textContent()) ?? "";
				assert.equal([...name].length, 4, name);
			});
			await step("领队小卡下同时列出盘面、结构与形态、趋势与动量", async (page) => {
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip.running").length === 3);
				const labels = await page.locator("#helpers .member-chip").allTextContents();
				assert.deepEqual(labels.map((l) => l.split(" · ")[0]).sort(), ["盘面", "结构与形态", "趋势与动量"].sort());
			});
			await step("幕僚长转告领队汇总的结论", async (page) => {
				await page.locator(".line.router .bubble", { hasText: "跌破 50 日均线" }).waitFor({ timeout: 20_000 });
			});
			await step("领队和三位成员的提示词里都有 stock-ta 的技能；成员的提示词是它自己的分工", () => {
				for (const conversation of [BRIEF, DESK_TASK, STRUCTURE_TASK, TREND_TASK]) assert.ok(fake.systemPromptOf(conversation).includes(BAND_SKILL), conversation);
				assert.ok(fake.systemPromptOf(DESK_TASK).includes("你是技术分析研究组的盘面专家"));
				assert.ok(fake.systemPromptOf(STRUCTURE_TASK).includes("你是技术分析研究组的结构与形态专家"));
				assert.ok(fake.systemPromptOf(TREND_TASK).includes("你是技术分析研究组的趋势与动量专家"));
				assert.ok(fake.systemPromptOf(BRIEF).includes("market-desk · 盘面"), "领队的名册里有成员");
			});
			await step("模型看到的工具：来源开的任务，领队能派活、不能执行命令；成员只有自己列的 read 和 uses 换来的模块工具", () => {
				assert.deepEqual(toolsOf(fake, DESK_TASK), ["domain_tool", "read"]);
				assert.deepEqual(toolsOf(fake, STRUCTURE_TASK), ["data", "domain_tool", "knowledge", "read"]);
				assert.deepEqual(toolsOf(fake, TREND_TASK), ["data", "domain_tool", "knowledge", "read"]);
				assert.ok(toolsOf(fake, BRIEF).includes("dispatch_agent"));
				assert.ok(!toolsOf(fake, BRIEF).includes("bash"));
			});
			await step("问 Pi 扩展怎么写：任务是「Pi施工队领队 #1」，领队的名册是九位 Pi 专家，带 Pi 模块的技能，不带 stock-ta 的", async (page) => {
				await sayInPage(page, "Pi 的扩展怎么写");
				await page.locator("#helpers .helper-chip", { hasText: "Pi施工队领队 #1" }).waitFor();
				await page.locator("#left .card", { hasText: "正在查扩展文档" }).waitFor();
				const prompt = fake.systemPromptOf(PI.brief);
				assert.equal(prompt.match(/^- [a-z]+-expert · /gm)?.length, 9);
				assert.ok(prompt.includes("ext-expert · Pi 扩展专家"));
				assert.ok(prompt.includes(PI_SKILL));
				assert.ok(!prompt.includes(BAND_SKILL));
			});
			await step("领队派给扩展专家：专家带着 Pi 模块的技能，模型看到的工具只有读文件和读网页", async (page) => {
				await page.locator("#helpers .member-chip", { hasText: "Pi 扩展专家" }).waitFor();
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip.running").length === 0);
				assert.ok(fake.systemPromptOf(PI_TASK).includes(PI_SKILL));
				assert.deepEqual(toolsOf(fake, PI_TASK), ["find", "grep", "ls", "read", "web_get"]);
			});
		},
		// Without modulesDirs in config.json the host scans its default: the repo's modules/ plus the state dir's, where stock-ta is copied.
		{ files: packageFiles(join(REPO, "docs/modules/examples/stock-ta"), "stock-ta"), config: { modulesDirs: undefined, dispatchTimeoutSeconds: 30 }, env: NO_MARKET_KEYS },
	));
