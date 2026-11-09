import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after } from "node:test";
import { ids } from "../helpers/fakes.ts";
import { FINNHUB_KEY_NAMES, KEY_NAMES } from "../../src/sources/market/key.ts";
import { consult, expert, on, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, REPO, story } from "./harness.ts";

after(closeBrowser);

const BRIEF = "核实 NVDA 跌 6.1% 的原因和技术面位置";
const HINTED_BRIEF = `${BRIEF}\n\n规则 us-market/big-move 建议请教的专家：market-analyst、technical-analyst、news-researcher`;
const MARKET_Q = "NVDA 今天跌 6.1%，和 SPY、QQQ、半导体板块比是个股还是大盘行情？";
const TECH_Q = "NVDA 日线技术面现在在什么位置？";
const ANSWER_MS = 2500;

const openRuleTicket = (card: string): ToolCall => ({
	name: "route",
	args: { decisions: [{ kind: "open_ticket", basis: "rule", ruleId: "us-market/big-move", triggerId: ids(card, "trg"), threads: [card.match(/线程 (thr_\S+)/)?.[1]], title: "核实 NVDA 大跌", brief: BRIEF }] },
});

test("看盘模块的大波动触发：副幕僚长按规则提示请教行情分析师和技术分析师，页面展开看到两位的回答", (t) =>
	story(
		t,
		{
			router: [
				on("Router 按大波动规则开任务", /^\[候选触发\][\s\S]*来源 us-market[\s\S]*NVDA/, (c) => [openRuleTicket(c)]),
				on("Router 转告", /^\[Worker 汇报\][\s\S]*跌破 50 日均线/, (c) => [reply(c, "NVDA 跌 6.1%，个股领跌并跌破 50 日均线")]),
			],
			workers: [
				worker(
					HINTED_BRIEF,
					on("副幕僚长会诊", /^\[任务说明\]/, () => [consult({ expert: "market-analyst", question: MARKET_Q }, { expert: "technical-analyst", question: TECH_Q })]),
					on("副幕僚长合成", /^\[会诊结果\][\s\S]*SPY 只跌 0\.8%[\s\S]*sma50/, () => [report("ready", "个股领跌并跌破 50 日均线（行情分析师、技术分析师）")]),
				),
				expert(MARKET_Q, "行情分析师回答", "个股行情：SPY 只跌 0.8%，报价时间 15:42 ET（延迟）。", ANSWER_MS),
				expert(TECH_Q, "技术分析师回答", "收盘价跌破 sma50 172.4，rsi14 38。", ANSWER_MS),
			],
		},
		async ({ step, cli }) => {
			await step("投递一条 us-market 的大波动行情", () => cli(["src/cli/drop.ts", "us-market", "NVDA", "NVDA 价格 168.2，涨跌 -6.1%，成交量是均量的 3 倍"]));
			await step("助手条在副幕僚长的小卡里列出行情分析师和技术分析师", async (page) => {
				const chip = page.locator("#helpers .helper-chip", { hasText: "副幕僚长 #1" });
				await chip.locator(".expert-chip", { hasText: "行情分析师 ◐" }).waitFor({ timeout: 20_000 });
				await chip.locator(".expert-chip", { hasText: "技术分析师 ◐" }).waitFor();
				await chip.click();
			});
			await step("执行过程里展开会诊，两位专家的问题和回答都在", async (page) => {
				const consultStep = page.locator("#steps .step", { hasText: "会诊" }).first();
				await consultStep.locator(".step-detail", { hasText: "行情分析师、技术分析师" }).waitFor({ timeout: 15_000 });
				await consultStep.locator(".expert-head", { hasText: /^技术分析师 · 已回答/ }).first().waitFor({ state: "attached", timeout: 15_000 });
				await consultStep.locator("summary", { hasText: "会诊明细" }).click();
				await consultStep.locator(".expert-q", { hasText: `问：${MARKET_Q}` }).waitFor();
				await consultStep.locator(".expert-a", { hasText: "报价时间 15:42 ET（延迟）" }).waitFor();
				await consultStep.locator(".expert-a", { hasText: "跌破 sma50 172.4" }).waitFor();
				assert.doesNotMatch(await consultStep.locator(".consult").textContent() ?? "", /market-analyst|technical-analyst/, "会诊明细只写职称");
			});
			await step("幕僚长转告合成的答复", (page) => page.locator(".line.router", { hasText: "跌破 50 日均线" }).waitFor());
		},
		{
			config: { modulesDirs: [join(REPO, "modules")] },
			env: Object.fromEntries([...KEY_NAMES, ...FINNHUB_KEY_NAMES].map((k) => [k, ""])),
		},
	));
