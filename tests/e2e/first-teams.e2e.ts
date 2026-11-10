import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after } from "node:test";
import { ids } from "../helpers/fakes.ts";
import { FINNHUB_KEY_NAMES, KEY_NAMES } from "../../src/sources/market/key.ts";
import { dispatch, on, openTicket, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, REPO, sayInPage, story } from "./harness.ts";

after(closeBrowser);

const BRIEF = "核实 NVDA 跌 6.1% 是个股还是大盘行情，技术面在什么位置";
const MARKET_TASK = "NVDA 今天跌 6.1%，和 SPY、QQQ、半导体板块比是个股还是大盘行情？";
const TECH_TASK = "NVDA 日线技术面现在在什么位置？";
const MARKET_REPLY = "结论：个股行情，SPY 只跌 0.8%。来源和时间：quote，报价 15:42 ET（延迟）。";
const REPORT = "**个股领跌**并跌破 50 日均线；报价 15:42 ET（延迟）。行情分析师、技术分析师参与。";
const PI = { title: "写 Pi 扩展", brief: "说明怎么给 Pi 写一个注册工具的扩展" };
const PI_TASK = "给一个注册自定义工具的最小 Pi 扩展";
const DESK_SKILL = "看盘队的共同做法";
const PI_SKILL = "Pi专家队的派活做法";
const WORKING_MS = 2500;
const NO_MARKET_KEYS = Object.fromEntries([...KEY_NAMES, ...FINNHUB_KEY_NAMES].map((name) => [name, ""]));

const openByBigMove = (card: string): ToolCall => ({
	name: "route",
	args: { decisions: [{ kind: "open_ticket", basis: "rule", ruleId: "us-market/big-move", triggerId: ids(card, "trg"), threads: [card.match(/线程 (thr_\S+)/)?.[1]], title: "核实 NVDA 大跌", brief: BRIEF }] },
});
const openInPiPi = (card: string): ToolCall => {
	const call = openTicket(card, PI.title, PI.brief);
	return { ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain: "pi-pi" })) } };
};
const toolsOf = (fake: { exchanges: { conversation: string; tools: string[] }[] }, conversation: string) => [...fake.exchanges.find((e) => e.conversation === conversation)!.tools].sort();

test("仓库自带的两支队伍：大波动规则开的任务归看盘队，助手派给行情分析师和技术分析师，三者都带着看盘模块的技能，成员只有自己列的只读工具；问 Pi 扩展怎么写的任务归 Pi专家队，助手带着 Pi 模块的技能派给扩展专家，专家不能执行命令", (t) =>
	story(
		t,
		{
			router: [
				on("Router 按大波动规则开任务，不填领域", /^\[候选触发\][\s\S]*来源 us-market[\s\S]*NVDA/, (c) => [openByBigMove(c)]),
				on("Router 把 Pi 的问题交给 pi-pi 领域", /^\[对话\][\s\S]*扩展/, (c) => [openInPiPi(c), reply(c, "已交给 Pi专家队")]),
				on("Router 转告", /^\[Worker 汇报\][\s\S]*跌破 50 日均线/, (c) => [reply(c, "NVDA 跌 6.1%，个股领跌并跌破 50 日均线")]),
			],
			workers: [
				worker(
					BRIEF,
					on("助手同时派给两位成员", /^\[任务说明\]/, () => [dispatch("market-analyst", MARKET_TASK), dispatch("technical-analyst", TECH_TASK)]),
					on("助手收到行情分析师的回复", /^\[成员回复\] 成员回复 · 行情分析师（market-analyst） · 完成[\s\S]*个股行情/, () => []),
					on("助手收到技术分析师的回复后汇报", /^\[成员回复\] 成员回复 · 技术分析师（technical-analyst） · 完成/, () => [report("ready", REPORT)]),
				),
				worker(MARKET_TASK, on("行情分析师回复", /^\[派活\] 行情分析师\n/, () => MARKET_REPLY, WORKING_MS)),
				worker(TECH_TASK, on("技术分析师用 lookup 查过以后回复", /^\[派活\] 技术分析师\n/, () => [{ name: "lookup", args: { source: "us-market", op: "session", args: {} } }], WORKING_MS)),
				worker(
					PI.brief,
					on("Pi 助手汇报进度并派给扩展专家", /^\[任务说明\]/, () => [report("progress", "正在查扩展文档"), dispatch("ext-expert", PI_TASK)]),
					on("Pi 助手收到扩展专家的回复", /^\[成员回复\] 成员回复 · Pi 扩展专家（ext-expert） · 完成/, () => []),
				),
				worker(PI_TASK, on("扩展专家回复", /^\[派活\] Pi 扩展专家\n/, () => "结论：用 pi.registerTool()。", WORKING_MS)),
			],
		},
		async ({ step, fake, cli }) => {
			await step("投递一条 us-market 的大波动行情，任务是四字名加「看盘队 #1」", async (page) => {
				await cli(["src/cli/drop.ts", "us-market", "NVDA", "NVDA 价格 168.2，涨跌 -6.1%，成交量是均量的 3 倍"]);
				const chip = page.locator("#helpers .helper-chip", { hasText: "看盘队 #1" });
				await chip.waitFor({ timeout: 20_000 });
				const name = (await chip.locator(".name").textContent()) ?? "";
				assert.equal([...name].length, 4, name);
			});
			await step("助手小卡下列出行情分析师和技术分析师", async (page) => {
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip.running").length === 2);
				const labels = await page.locator("#helpers .member-chip").allTextContents();
				assert.deepEqual(labels.map((l) => l.split(" · ")[0]).sort(), ["技术分析师", "行情分析师"]);
			});
			await step("幕僚长转告助手汇总的结论", async (page) => {
				await page.locator(".line.router .bubble", { hasText: "跌破 50 日均线" }).waitFor({ timeout: 20_000 });
			});
			await step("助手和两位成员的提示词里都有看盘模块的技能；成员的提示词是它自己的分工", () => {
				for (const conversation of [BRIEF, MARKET_TASK, TECH_TASK]) assert.ok(fake.systemPromptOf(conversation).includes(DESK_SKILL), conversation);
				assert.ok(fake.systemPromptOf(MARKET_TASK).includes("你是看盘队的行情分析师"));
				assert.ok(fake.systemPromptOf(TECH_TASK).includes("你是看盘队的技术分析师"));
				assert.ok(fake.systemPromptOf(BRIEF).includes("market-analyst · 行情分析师"), "助手的名册里有成员");
			});
			await step("模型看到的工具：助手能派活，成员只有自己列的那几个", () => {
				assert.deepEqual(toolsOf(fake, MARKET_TASK), ["lookup", "read", "web_get"]);
				assert.deepEqual(toolsOf(fake, TECH_TASK), ["lookup", "read"]);
				assert.ok(toolsOf(fake, BRIEF).includes("dispatch_agent"));
			});
			await step("问 Pi 扩展怎么写：任务是「Pi专家队 #1」，助手的名册是九位 Pi 专家，带 Pi 模块的技能，不带看盘模块的", async (page) => {
				await sayInPage(page, "Pi 的扩展怎么写");
				await page.locator("#helpers .helper-chip", { hasText: "Pi专家队 #1" }).waitFor();
				await page.locator("#left .card", { hasText: "正在查扩展文档" }).waitFor();
				const prompt = fake.systemPromptOf(PI.brief);
				assert.equal(prompt.match(/^- [a-z]+-expert · /gm)?.length, 9);
				assert.ok(prompt.includes("ext-expert · Pi 扩展专家"));
				assert.ok(prompt.includes(PI_SKILL));
				assert.ok(!prompt.includes(DESK_SKILL));
			});
			await step("助手派给扩展专家：专家带着 Pi 模块的技能，模型看到的工具只有读文件和读网页", async (page) => {
				await page.locator("#helpers .member-chip", { hasText: "Pi 扩展专家" }).waitFor();
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip.running").length === 0);
				assert.ok(fake.systemPromptOf(PI_TASK).includes(PI_SKILL));
				assert.deepEqual(toolsOf(fake, PI_TASK), ["find", "grep", "ls", "read", "web_get"]);
			});
		},
		{ config: { modulesDirs: [join(REPO, "modules")], dispatchTimeoutSeconds: 30 }, env: NO_MARKET_KEYS },
	));
