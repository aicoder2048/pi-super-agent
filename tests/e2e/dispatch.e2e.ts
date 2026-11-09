import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { dispatch, on, openTicket, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, groupAlive, sayInPage, sleep, story, waitStatus } from "./harness.ts";

after(closeBrowser);

const TASK = { title: "NVDA 为什么跌", brief: "弄清 NVDA 今天为什么跌" };
const WEATHER = { title: "查天气", brief: "查明天的天气" };
const ASK = "NVDA 今天为什么跌";
const FOLLOW_UP = "追问一句：支撑位在哪";
const MARKET_TASK = "看 NVDA 今天的盘面：跌幅、量能、大盘对比";
const NEWS_TASK = "查 NVDA 今天有没有重大新闻";
const SUPPORT_TASK = "追问：按你刚才看的盘面，支撑位在哪";
const MARKET_REPLY = "## 结论\n**个股领跌**：NVDA 跌 4.2%，SPY 只跌 0.8%。\n- 量能是 20 日均量的 1.8 倍\n<script>document.title = '被注入'</script>";
const NEWS_REPLY = "没有重大新闻，只有一条听证会的旧闻。";
const SUPPORT_REPLY = "接着上次的盘面：支撑位在 172 附近。";
const REPORT = "个股领跌，没有新的利空消息。";
const WORKING_MS = 2500;

const STATE_FILES = {
	"agents/market.md": "---\nname: market-analyst\ntitle: 行情分析师\ndescription: 看盘面、量能和大盘对比\ntools: read, lookup, web_get\n---\n你是行情分析师。\n",
	"agents/news.md": "---\nname: news-researcher\ntitle: 新闻研究员\ndescription: 查新闻、核对报道来源\n---\n你是新闻研究员。\n",
	"teams.yaml": "看盘队:\n  description: 看盘面、查新闻\n  members:\n    - market-analyst\n    - news-researcher\n",
};

const openOnTeam = (card: string, team: string): ToolCall => {
	const call = openTicket(card, TASK.title, TASK.brief);
	return { ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, team })) } };
};
const handOverTo = (title: string) => (card: string): ToolCall[] => {
	const ticketId = card.match(new RegExp(`(tkt_[\\w-]+)「${title}」`))?.[1];
	return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: card.match(/trg_[\w-]+/)?.[0], ticketId }] } }];
};
const sorted = (names: string[]) => [...names].sort();

test("看盘队的助手把一个问题并行派给两位成员再合成一份答复；追问时同一位成员接着上次的话答；默认团队的助手没有派活工具", (t) =>
	story(
		t,
		{
			router: [
				on("Router 把问题交给看盘队", /^\[对话\][\s\S]*为什么跌/, (c) => [openOnTeam(c, "看盘队"), reply(c, "已交给看盘队")]),
				on("Router 把追问交给同一个任务", /^\[对话\][\s\S]*追问/, handOverTo(TASK.title)),
				on("Router 开天气任务", /^\[对话\][\s\S]*天气/, (c) => [openTicket(c, WEATHER.title, WEATHER.brief), reply(c, "已安排")]),
			],
			workers: [
				worker(
					TASK.brief,
					on("助手同时派给两位成员", /^\[任务说明\]/, () => [dispatch("market-analyst", MARKET_TASK), dispatch("news-researcher", NEWS_TASK)]),
					on("助手收到行情分析师的回复", /^\[成员回复\] 成员回复 · 行情分析师（market-analyst） · 完成[\s\S]*个股领跌/, () => []),
					on("助手收到新闻研究员的回复后合成", /^\[成员回复\] 成员回复 · 新闻研究员（news-researcher） · 完成[\s\S]*没有重大新闻/, () => [report("progress", REPORT)]),
					on("助手把追问派给行情分析师", /^\[使用者的话/, () => [dispatch("market-analyst", SUPPORT_TASK)]),
					on("助手转述追问的回复", /^\[成员回复\][\s\S]*接着上次的盘面/, () => [report("progress", "支撑位在 172 附近。")]),
				),
				worker(
					MARKET_TASK,
					on("行情分析师回复", /^\[派活\] 行情分析师\n看 NVDA/, () => MARKET_REPLY, WORKING_MS),
					on("行情分析师接着上次回答追问", /^\[派活\] 行情分析师\n追问/, () => SUPPORT_REPLY),
				),
				worker(NEWS_TASK, on("新闻研究员回复", /^\[派活\] 新闻研究员\n/, () => NEWS_REPLY, WORKING_MS)),
				worker(WEATHER.brief, on("天气任务汇报", /^\[任务说明\]/, () => [report("progress", "正在查")])),
			],
		},
		async ({ step, fake, stateDir }) => {
			let helperName = "";
			await step("页面问一个要两方面判断的问题，助手是四字名加团队名", async (page) => {
				await sayInPage(page, ASK);
				const chip = page.locator("#helpers .helper-chip", { hasText: "看盘队 #1" });
				await chip.waitFor();
				helperName = (await chip.locator(".name").textContent()) ?? "";
				assert.equal([...helperName].length, 4, helperName);
			});
			await step("助手小卡下同时出现两位成员，只写职称", async (page) => {
				const members = page.locator("#helpers .helper-slot", { hasText: "看盘队 #1" }).locator(".member-chip");
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip.running").length === 2);
				assert.deepEqual(sorted(await members.allTextContents()), sorted(["行情分析师", "新闻研究员"]));
				assert.match(await page.locator("#helpers .helper-chip", { hasText: "看盘队 #1" }).getAttribute("aria-label") ?? "", /成员：/);
			});
			await step("执行过程里两次派活各是一步，成员还在做时写进行中", async (page) => {
				await page.locator("#helpers .helper-chip", { hasText: "看盘队 #1" }).click();
				await page.locator("#how-title", { hasText: TASK.title }).waitFor();
				await page.locator("#steps .step.pending", { hasText: "行情分析师 · 进行中" }).waitFor();
				await page.locator("#steps .step.pending", { hasText: "新闻研究员 · 进行中" }).waitFor();
			});
			await step("两位做完后小卡下的成员消失，助手的名字不变，答复是助手合成的一份", async (page) => {
				await page.locator("#left .card", { hasText: REPORT }).waitFor();
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip").length === 0);
				assert.equal(await page.locator("#helpers .helper-chip", { hasText: "看盘队 #1" }).locator(".name").textContent(), helperName);
				assert.equal(await page.locator("#how-helper").textContent(), `${helperName} · 看盘队 #1`);
			});
			await step("展开一步派活：成员职称、任务、状态、用量和回复；回复按安全的 Markdown 显示，里面的标签只是文字", async (page) => {
				const market = page.locator("#steps .step", { hasText: "行情分析师 · 完成" });
				await market.locator("summary", { hasText: "派活明细" }).click();
				assert.match(await market.locator(".dispatch-head").textContent() ?? "", /^行情分析师 · 完成 · \d+ tokens$/);
				assert.equal(await market.locator(".dispatch-task").textContent(), `任务：${MARKET_TASK}`);
				const answer = market.locator(".dispatch-reply");
				assert.equal(await answer.locator("strong").textContent(), "个股领跌");
				assert.equal(await answer.locator(".md-h").textContent(), "结论");
				assert.equal(await answer.locator("li").count(), 1);
				assert.equal(await answer.locator("script").count(), 0, "成员回复里的标签不变成元素");
				assert.match(await answer.textContent() ?? "", /<script>document\.title = '被注入'<\/script>/);
				assert.doesNotMatch(await answer.textContent() ?? "", /\*\*/);
				assert.notEqual(await page.title(), "被注入");
				const news = page.locator("#steps .step", { hasText: "新闻研究员 · 完成" });
				await news.locator("summary", { hasText: "派活明细" }).click();
				assert.equal(await news.locator(".dispatch-reply").textContent(), NEWS_REPLY);
				assert.doesNotMatch(await page.locator("#steps .dispatch").first().textContent() ?? "", /market-analyst|news-researcher/, "明细只写职称");
			});
			await step("追问一句，同一位成员接着上次的话答", async (page) => {
				await sayInPage(page, FOLLOW_UP);
				await page.locator("#left .card", { hasText: "支撑位在 172 附近。" }).waitFor();
				const steps = page.locator("#steps .step", { hasText: "行情分析师 · 完成" });
				await page.waitForFunction(() => [...document.querySelectorAll("#steps .step-detail")].filter((n) => n.textContent === "行情分析师 · 完成").length === 2);
				await steps.last().locator("summary", { hasText: "派活明细" }).click();
				assert.equal(await steps.last().locator(".dispatch-reply").textContent(), SUPPORT_REPLY);
			});
			await step("每位成员在这个任务里只有一份会话，放在任务目录的 team/<成员> 下", async () => {
				const [ticket] = readdirSync(join(stateDir, "workers")).filter((id) => readdirSync(join(stateDir, "workers", id)).includes("team"));
				const sessions = (member: string) => readdirSync(join(stateDir, "workers", ticket, "team", member)).filter((f) => f.endsWith(".jsonl"));
				assert.deepEqual(sorted(readdirSync(join(stateDir, "workers", ticket, "team"))), ["market-analyst", "news-researcher"]);
				assert.equal(sessions("market-analyst").length, 1, "两次派活接在同一份会话上");
				assert.equal(sessions("news-researcher").length, 1);
			});
			await step("成员的用量计入任务：执行过程头部的 token 数等于助手和成员每次模型请求之和", async (page) => {
				const requests = fake.exchanges.filter((e) => e.model === "worker").length;
				assert.match(await page.locator("#how-life").textContent() ?? "", new RegExp(`tokens 入 ${requests * 10} / 出 ${requests * 5}$`));
			});
			await step("模型看到的工具：看盘队的助手有 dispatch_agent，成员没有汇报、交回和派活，行情分析师只有自己列的那几个；默认团队的助手没有 dispatch_agent", async (page) => {
				await sayInPage(page, "查一下天气");
				await page.locator("#left .card", { hasText: "正在查" }).waitFor();
				const toolsOf = (conversation: string) => fake.exchanges.find((e) => e.conversation === conversation)!.tools;
				assert.ok(toolsOf(TASK.brief).includes("dispatch_agent"));
				assert.ok(toolsOf(TASK.brief).includes("report") && toolsOf(TASK.brief).includes("bash"), "助手保留自己的工具");
				assert.deepEqual(sorted(toolsOf(MARKET_TASK)), ["lookup", "read", "web_get"]);
				assert.deepEqual(sorted(toolsOf(NEWS_TASK)), sorted(["read", "bash", "edit", "write", "grep", "find", "ls", "web_get", "lookup"]));
				assert.ok(!toolsOf(WEATHER.brief).includes("dispatch_agent"));
				assert.deepEqual(sorted(toolsOf(WEATHER.brief)), sorted(toolsOf(TASK.brief).filter((name) => name !== "dispatch_agent")), "除了派活，两种助手的工具一样");
			});
		},
		{ files: STATE_FILES, config: { dispatchTimeoutSeconds: 30 } },
	));

const HEARING_TASK = "查黄仁勋听证会的报道";
const DATE_TASK = "接着查：听证会是哪天";
const stopTicket = (title: string) => (card: string): ToolCall[] => [{ name: "route", args: { decisions: [{ kind: "stop", ticketId: card.match(new RegExp(`(tkt_[\\w-]+)「${title}」`))?.[1] }] } }];

test("派过一次后重启宿主再追问，成员仍接着上次的会话；派活中叫停任务，成员进程和它起的命令一起结束", (t) =>
	story(
		t,
		{
			router: [
				on("Router 把问题交给看盘队", /^\[对话\][\s\S]*听证会/, (c) => [openOnTeam(c, "看盘队"), reply(c, "已交给看盘队")]),
				on("Router 把追问交给同一个任务", /^\[对话\][\s\S]*哪天/, handOverTo(TASK.title)),
				on("Router 叫停任务", /^\[对话\][\s\S]*停掉/, stopTicket(TASK.title)),
			],
			workers: [
				worker(
					TASK.brief,
					on("助手派给新闻研究员", /^\[任务说明\]/, () => [dispatch("news-researcher", HEARING_TASK)]),
					on("助手汇报第一次的回复", /^\[成员回复\][\s\S]*三家媒体/, () => [report("progress", "三家媒体有报道。")]),
					on("重启后助手再派给新闻研究员", /^\[使用者的话/, () => [dispatch("news-researcher", DATE_TASK)]),
				),
				worker(
					HEARING_TASK,
					on("新闻研究员回复", /^\[派活\] 新闻研究员\n查黄仁勋/, () => "三家媒体有报道。"),
					on("重启后新闻研究员接着上次，跑一条不会结束的命令", /^\[派活\] 新闻研究员\n接着查/, () => [{ name: "bash", args: { command: "echo $PPID > member.pid; sleep 300" } }]),
				),
			],
		},
		async ({ step, host, stateDir }) => {
			const pidFile = () => {
				const [ticket] = readdirSync(join(stateDir, "workers"));
				return join(stateDir, "workers", ticket, "member.pid");
			};
			let memberGroup = 0;
			await step("问一句，成员答完，助手汇报", async (page) => {
				await sayInPage(page, "看下黄仁勋听证会的新闻");
				await page.locator("#left .card", { hasText: "三家媒体有报道。" }).waitFor();
			});
			await step("重启宿主，页面连回来", async (page) => {
				await host.restart();
				await waitStatus(page, "connected");
			});
			await step("追问一句，同一位成员接着重启前的会话干活，小卡下写它的职称", async (page) => {
				await sayInPage(page, "听证会是哪天");
				await page.locator("#helpers .member-chip.running", { hasText: "新闻研究员" }).waitFor();
				for (let waited = 0; waited < 8000 && !(existsSync(pidFile()) && readFileSync(pidFile(), "utf8").trim()); waited += 50) await sleep(50);
				memberGroup = Number(readFileSync(pidFile(), "utf8"));
				assert.ok(memberGroup > 0 && groupAlive(memberGroup), `成员进程组 ${memberGroup} 在运行`);
				const [ticket] = readdirSync(join(stateDir, "workers"));
				assert.equal(readdirSync(join(stateDir, "workers", ticket, "team", "news-researcher")).filter((f) => f.endsWith(".jsonl")).length, 1, "重启前后是同一份会话");
			});
			await step("叫停任务：成员进程组整个结束，执行过程里那次派活写已停止，小卡消失", async (page) => {
				await page.locator("#left .card", { hasText: TASK.title }).first().click();
				await page.locator("#steps .step.pending", { hasText: "新闻研究员 · 进行中" }).waitFor();
				await sayInPage(page, "停掉这个任务");
				await page.locator("#steps .step.pending", { hasText: "已停止" }).waitFor();
				for (let waited = 0; waited < 5000 && groupAlive(memberGroup); waited += 50) await sleep(50);
				assert.equal(groupAlive(memberGroup), false, `成员进程组 ${memberGroup} 还活着`);
				await page.waitForFunction(() => document.querySelectorAll("#helpers .helper-chip").length === 0);
			});
		},
		{ files: STATE_FILES, config: { dispatchTimeoutSeconds: 60 }, fixedPort: true },
	));
