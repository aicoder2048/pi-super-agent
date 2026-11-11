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
const IMG = `<img src=x onerror="document.title='被注入'">`;
const MARKET_REPLY = `## 结论\n**个股领跌**：NVDA 跌 4.2%，SPY 只跌 0.8%。\n- 量能是 20 日均量的 1.8 倍\n\n| 指标 | 数值 |\n|--|--|\n| 跌幅 | **<b>4.2%</b>** |\n\n*<i>偏空</i>*，见 \`${IMG}\` 和 [<u>来源</u>](https://example.com/a)\n<script>document.title = '被注入'</script>`;
const NEWS_REPLY = "没有重大新闻，只有一条听证会的旧闻。";
const SUPPORT_REPLY = "接着上次的盘面：支撑位在 172 附近。";
const REPORT = "个股领跌，没有新的利空消息。";
const REPORT_MD = "**个股领跌**，没有新的利空消息。";
const WORKING_MS = 2500;
const BAR_HINT = "按时限折算，不是完成度";
const NEWS_COMMAND_S = 9;

const WATCH_MANIFEST = JSON.stringify({ name: "watch", title: "看盘", description: "看盘面、查新闻", team: "看盘队", tools: ["lookup"] });
const STATE_FILES = {
	"modules/watch/module.json": WATCH_MANIFEST,
	"modules/watch/agents/market.md": "---\nname: market-analyst\ntitle: 行情分析师\ndescription: 看盘面、量能和大盘对比\ntools: read, lookup, web_get\n---\n你是行情分析师。\n",
	"modules/watch/agents/news.md": "---\nname: news-researcher\ntitle: 新闻研究员\ndescription: 查新闻、核对报道来源\n---\n你是新闻研究员。\n",
};

const openInDomain = (card: string, domain: string): ToolCall => {
	const call = openTicket(card, TASK.title, TASK.brief);
	return { ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain })) } };
};
const handOverTo = (title: string) => (card: string): ToolCall[] => {
	const ticketId = card.match(new RegExp(`(tkt_[\\w-]+)「${title}」`))?.[1];
	return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: card.match(/trg_[\w-]+/)?.[0], ticketId }] } }];
};
const sorted = (names: string[]) => [...names].sort();

test("看盘队的领队把一个问题并行派给两位成员再合成一份答复；追问时同一位成员接着上次的话答；没有领域的助手没有派活工具", (t) =>
	story(
		t,
		{
			router: [
				on("Router 把问题交给看盘队", /^\[对话\][\s\S]*为什么跌/, (c) => [openInDomain(c, "watch"), reply(c, "已交给**看盘队**，稍等。")]),
				on("Router 把追问交给同一个任务", /^\[对话\][\s\S]*追问/, handOverTo(TASK.title)),
				on("Router 开天气任务", /^\[对话\][\s\S]*天气/, (c) => [openTicket(c, WEATHER.title, WEATHER.brief), reply(c, "已安排")]),
			],
			workers: [
				worker(
					TASK.brief,
					on("助手同时派给两位成员", /^\[任务说明\]/, () => [dispatch("market-analyst", MARKET_TASK), dispatch("news-researcher", NEWS_TASK)]),
					on("助手收到行情分析师的回复", /^\[成员回复\] 成员回复 · 行情分析师（market-analyst） · 完成[\s\S]*个股领跌/, () => []),
					on("助手收到新闻研究员的回复后合成", /^\[成员回复\] 成员回复 · 新闻研究员（news-researcher） · 完成[\s\S]*没有重大新闻/, () => [report("progress", REPORT_MD)]),
					on("助手把追问派给行情分析师", /^\[使用者的话/, () => [dispatch("market-analyst", SUPPORT_TASK)]),
					on("助手转述追问的回复", /^\[成员回复\][\s\S]*接着上次的盘面/, () => [report("progress", "支撑位在 172 附近。")]),
				),
				worker(
					MARKET_TASK,
					on("行情分析师回复", /^\[派活\] 行情分析师\n看 NVDA/, () => MARKET_REPLY, WORKING_MS),
					on("行情分析师接着上次回答追问", /^\[派活\] 行情分析师\n追问/, () => SUPPORT_REPLY),
				),
				worker(
					NEWS_TASK,
					on("新闻研究员先跑一条慢命令", /^\[派活\] 新闻研究员\n/, () => [{ name: "bash", args: { command: `sleep ${NEWS_COMMAND_S}; echo '[命令输出] 查完了'` } }]),
					on("新闻研究员回复", /^\[命令输出\] 查完了/, () => NEWS_REPLY),
				),
				worker(WEATHER.brief, on("天气任务汇报", /^\[任务说明\]/, () => [report("progress", "正在查")])),
			],
		},
		async ({ step, fake, stateDir }) => {
			let helperName = "";
			await step("页面问一个要两方面判断的问题，助手是四字名加「队名领队」", async (page) => {
				await sayInPage(page, ASK);
				const chip = page.locator("#helpers .helper-chip", { hasText: "看盘队领队 #1" });
				await chip.waitFor();
				helperName = (await chip.locator(".name").textContent()) ?? "";
				assert.equal([...helperName].length, 4, helperName);
			});
			await step("助手小卡下同时出现两位成员：职称、正在做什么、多久前有动静，不写英文名", async (page) => {
				const members = page.locator("#helpers .helper-slot", { hasText: "看盘队领队 #1" }).locator(".member-chip");
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip.running").length === 2);
				for (const label of await members.allTextContents()) assert.match(label, /^(行情分析师|新闻研究员) · .+ · (刚刚|\d+ 秒前|已 \d+ 秒)$/);
				assert.match(await page.locator("#helpers .helper-chip", { hasText: "看盘队领队 #1" }).getAttribute("aria-label") ?? "", /成员：/);
			});
			await step("执行过程里两次派活各是一步，成员还在做时写进行中", async (page) => {
				await page.locator("#helpers .helper-chip", { hasText: "看盘队领队 #1" }).click();
				await page.locator("#how-title", { hasText: TASK.title }).waitFor();
				await page.locator("#steps .step.pending", { hasText: "新闻研究员 · 进行中" }).waitFor();
			});
			await step("同一轮的两次派活并排成两条分支：各有头像、状态和「已用 N 秒 · 时限 …」，时限照配置写；进行中的带进度条，悬停写明按时限折算", async (page) => {
				const lanes = page.locator("#steps .lanes").first().locator(".lane");
				assert.equal(await lanes.count(), 2);
				assert.deepEqual(await lanes.locator(".face").allTextContents(), ["行", "新"], "分支上的头像和卡片底部的一样");
				const news = lanes.filter({ hasText: "新闻研究员" });
				await news.locator(".lane-time", { hasText: /^已用 \d+ 秒 · 时限 60 分钟$/ }).waitFor();
				assert.equal(await news.locator("[role=progressbar]").getAttribute("title"), BAR_HINT);
				assert.equal(await news.locator("[role=progressbar]").getAttribute("aria-label"), BAR_HINT);
				await lanes.filter({ hasText: "行情分析师" }).locator(".lane-time", { hasText: /^(已用|用时) \d+ 秒 · 时限 30 秒$/ }).waitFor();
			});
			await step("行情分析师先做完：它那一步马上写完成，新闻研究员还在进行中", async (page) => {
				await page.locator("#steps .step.ok", { hasText: "行情分析师 · 完成" }).waitFor();
				assert.equal(await page.locator("#steps .step.pending", { hasText: "新闻研究员 · 进行中" }).count(), 1, "整批还没回来");
				assert.equal(await page.locator("#steps .step-detail", { hasText: /^排队中$/ }).count(), 0, "没有不带职称的排队中");
			});
			await step("进行中的分支每秒往后数，不重画整个执行过程", async (page) => {
				const time = page.locator("#steps .lane", { hasText: "新闻研究员 · 进行中" }).locator(".lane-time");
				let ticked = false;
				for (let tries = 0; tries < 3 && !ticked; tries++) {
					const before = await time.evaluate((n) => ((n as HTMLElement & { tagged?: boolean }).tagged = true, n.textContent));
					await sleep(2100);
					const [tagged, after] = await time.evaluate((n) => [(n as HTMLElement & { tagged?: boolean }).tagged === true, n.textContent]);
					ticked = tagged && after !== before;
				}
				assert.ok(ticked, "两秒里同一个节点上的已用时间变了");
			});
			await step("新闻研究员在跑命令：小卡下写「新闻研究员 · 执行命令 · 已 N 秒」，展开派活看到它自己的步骤", async (page) => {
				await page.locator("#helpers .member-chip.running", { hasText: /^新闻研究员 · 执行命令 · 已 [5-9] 秒$/ }).waitFor();
				assert.equal(await page.locator("#helpers .member-chip").count(), 1, "做完的行情分析师不再列在小卡下");
				const news = page.locator("#steps .step", { hasText: "新闻研究员 · 进行中" });
				await news.locator("summary", { hasText: "派活明细" }).click();
				await news.locator(".member-step.pending", { hasText: "执行命令" }).waitFor();
			});
			await step("两位做完后小卡下的成员消失，助手的名字不变，答复是助手合成的一份", async (page) => {
				await page.locator("#left .card", { hasText: REPORT }).waitFor();
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip").length === 0);
				assert.equal(await page.locator("#helpers .helper-chip", { hasText: "看盘队领队 #1" }).locator(".name").textContent(), helperName);
				assert.equal(await page.locator("#how-helper").textContent(), `${helperName} · 看盘队领队 #1 · 派给 行情分析师、新闻研究员`);
				const card = page.locator("#left .card", { hasText: REPORT });
				assert.equal(await card.locator(".by").textContent(), `${helperName} · 看盘队领队 #1`);
				assert.equal(await card.locator(".crew-text").textContent(), "派给 行情分析师、新闻研究员");
				assert.deepEqual(await card.locator(".crew .face").allTextContents(), ["行", "新"]);
			});
			await step("幕僚长的话、任务卡上的结论和汇报那一步都按 Markdown 显示，不露出星号", async (page) => {
				const bubble = page.locator("#conversation .line.router .bubble", { hasText: "已交给" });
				assert.equal(await bubble.locator("strong").textContent(), "看盘队");
				assert.equal(await bubble.textContent(), "已交给看盘队，稍等。");
				const latest = page.locator("#left .card .latest", { hasText: REPORT });
				assert.equal(await latest.locator("strong").textContent(), "个股领跌");
				const reported = page.locator("#steps .step", { hasText: "汇报进度" }).locator(".step-detail");
				assert.equal(await reported.locator("strong").textContent(), "个股领跌");
				assert.equal(await reported.textContent(), REPORT);
				assert.deepEqual(await reported.evaluate((n) => [getComputedStyle(n).maxHeight, getComputedStyle(n).overflowY]), ["240px", "auto"], "长汇报按高度收住，在框里滚动");
			});
			await step("展开一步派活：成员职称、任务、状态、用量和回复；回复按安全的 Markdown 显示，里面的标签只是文字", async (page) => {
				const market = page.locator("#steps .step", { hasText: "行情分析师 · 完成" });
				await market.locator("summary", { hasText: "派活明细" }).click();
				assert.match(await market.locator(".dispatch-head").textContent() ?? "", /^行情分析师 · 完成 · \d+ tokens$/);
				assert.equal(await market.locator(".dispatch-task").textContent(), `任务：${MARKET_TASK}`);
				const answer = market.locator(".dispatch-reply");
				assert.deepEqual(await answer.locator("strong").allTextContents(), ["个股领跌", "<b>4.2%</b>"]);
				assert.equal(await answer.locator(".md-h").textContent(), "结论");
				assert.equal(await answer.locator("li").count(), 1);
				assert.deepEqual(await answer.locator("table th").allTextContents(), ["指标", "数值"]);
				assert.deepEqual(await answer.locator("table td").allTextContents(), ["跌幅", "<b>4.2%</b>"]);
				assert.equal(await answer.locator("em").textContent(), "<i>偏空</i>");
				assert.equal(await answer.locator("code").textContent(), IMG);
				assert.equal(await answer.locator("script, img, b, i, u, a").count(), 0, "成员回复里的标签不变成元素，粗体、斜体、代码、链接和表格里的也一样");
				assert.match(await answer.textContent() ?? "", /<u>来源<\/u>（https:\/\/example\.com\/a）/);
				assert.match(await answer.textContent() ?? "", /<script>document\.title = '被注入'<\/script>/);
				assert.doesNotMatch(await answer.textContent() ?? "", /\*\*/);
				assert.notEqual(await page.title(), "被注入");
				const news = page.locator("#steps .step", { hasText: "新闻研究员 · 完成" });
				assert.equal(await news.locator(".dispatch-reply").textContent(), NEWS_REPLY, "干活时展开的明细，做完后还开着");
				assert.deepEqual(await news.locator(".member-step.ok .member-step-title").allTextContents(), ["执行命令"], "成员自己的步骤做完后还在");
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
			await step("刷新页面后重新打开任务，三次派活的状态和回复还在（来自助手的会话记录）", async (page) => {
				await page.reload();
				await waitStatus(page, "connected");
				await page.locator("#helpers .helper-chip", { hasText: "看盘队领队 #1" }).click();
				await page.waitForFunction(() => [...document.querySelectorAll("#steps .step-detail")].filter((n) => n.textContent === "行情分析师 · 完成").length === 2);
				const news = page.locator("#steps .step", { hasText: "新闻研究员 · 完成" });
				await news.locator("summary", { hasText: "派活明细" }).click();
				assert.equal(await news.locator(".dispatch-reply").textContent(), NEWS_REPLY);
				assert.deepEqual(await news.locator(".member-step.ok .member-step-title").allTextContents(), ["执行命令"], "成员的步骤来自它自己的会话文件");
				assert.equal(await page.locator("#steps .lanes").first().locator(".lane").count(), 2, "刷新后同一轮仍并排成两条分支");
				const times = await page.locator("#steps .lane .lane-time").allTextContents();
				assert.equal(times.length, 3);
				for (const text of times) assert.match(text, /^用时 \d+ 秒 · 时限 (30 秒|60 分钟)$/);
				assert.equal(await page.locator("#steps [role=progressbar]").count(), 0, "做完的分支不带进度条");
			});
			await step("成员的用量计入任务：执行过程头部的 token 数等于助手和成员每次模型请求之和", async (page) => {
				const requests = fake.exchanges.filter((e) => e.model === "worker").length;
				assert.match(await page.locator("#how-life").textContent() ?? "", new RegExp(`tokens 入 ${requests * 10} / 出 ${requests * 5}$`));
			});
			await step("模型看到的工具：看盘队的助手有 dispatch_agent，成员没有汇报、交回和派活，行情分析师只有自己列的那几个；没有领域的助手没有 dispatch_agent", async (page) => {
				await sayInPage(page, "查一下天气");
				await page.locator("#left .card", { hasText: "正在查" }).waitFor();
				const toolsOf = (conversation: string) => fake.exchanges.find((e) => e.conversation === conversation)!.tools;
				assert.ok(toolsOf(TASK.brief).includes("dispatch_agent"));
				assert.ok(toolsOf(TASK.brief).includes("report") && toolsOf(TASK.brief).includes("bash"), "助手保留自己的工具");
				assert.deepEqual(sorted(toolsOf(MARKET_TASK)), ["lookup", "read", "web_get"]);
				assert.deepEqual(sorted(toolsOf(NEWS_TASK)), sorted(["read", "bash", "edit", "write", "grep", "find", "ls", "web_get", "lookup"]));
				assert.ok(!toolsOf(WEATHER.brief).includes("dispatch_agent"));
				assert.ok(toolsOf(TASK.brief).includes("lookup") && !toolsOf(WEATHER.brief).includes("lookup"), "只有领域开了 lookup 的助手能查数据");
				assert.deepEqual(sorted(toolsOf(WEATHER.brief)), sorted(toolsOf(TASK.brief).filter((name) => !["dispatch_agent", "lookup"].includes(name))), "除了派活和 lookup，两种助手的工具一样");
			});
		},
		{ files: STATE_FILES, config: { dispatchTimeoutSeconds: 30 } },
	));

const HEARING_TASK = "查黄仁勋听证会的报道";
const DATE_TASK = "接着查：听证会是哪天";
const AGAIN_TASK = "强杀之后再查一次：听证会是哪天";
const stopTicket = (title: string) => (card: string): ToolCall[] => [{ name: "route", args: { decisions: [{ kind: "stop", ticketId: card.match(new RegExp(`(tkt_[\\w-]+)「${title}」`))?.[1] }] } }];

test("派过一次后重启宿主再追问，成员仍接着上次的会话；派活中叫停任务，成员进程和它起的命令一起结束", (t) =>
	story(
		t,
		{
			router: [
				on("Router 把问题交给看盘队", /^\[对话\][\s\S]*听证会/, (c) => [openInDomain(c, "watch"), reply(c, "已交给看盘队")]),
				on("Router 把追问交给同一个任务", /^\[对话\][\s\S]*哪天/, handOverTo(TASK.title)),
				on("Router 叫停任务", /^\[对话\][\s\S]*停掉/, stopTicket(TASK.title)),
			],
			workers: [
				worker(
					TASK.brief,
					on("助手派给新闻研究员", /^\[任务说明\]/, () => [dispatch("news-researcher", HEARING_TASK)]),
					on("助手汇报第一次的回复", /^\[成员回复\][\s\S]*三家媒体/, () => [report("progress", "三家媒体有报道。")]),
					on("重启后助手再派给新闻研究员", /^\[使用者的话/, () => [dispatch("news-researcher", DATE_TASK)]),
					on("宿主被强杀又重启后，助手按恢复说明再派一次", /^\[恢复说明\]/, () => [dispatch("news-researcher", AGAIN_TASK)]),
				),
				worker(
					HEARING_TASK,
					on("新闻研究员回复", /^\[派活\] 新闻研究员\n查黄仁勋/, () => "三家媒体有报道。"),
					on("重启后新闻研究员接着上次，跑一条不会结束的命令", /^\[派活\] 新闻研究员\n接着查/, () => [{ name: "bash", args: { command: "echo $PPID > member.pid; sleep 300" } }]),
					on("强杀重启后新闻研究员又跑一条不会结束的命令", /^\[派活\] 新闻研究员\n强杀之后/, () => [{ name: "bash", args: { command: "echo $PPID > member2.pid; sleep 300" } }]),
				),
			],
		},
		async ({ step, host, stateDir }) => {
			const ticketDir = () => join(stateDir, "workers", readdirSync(join(stateDir, "workers"))[0]);
			const memberGroupFrom = async (file: string) => {
				const path = join(ticketDir(), file);
				for (let waited = 0; waited < 8000 && !(existsSync(path) && readFileSync(path, "utf8").trim()); waited += 50) await sleep(50);
				return Number(readFileSync(path, "utf8"));
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
				memberGroup = await memberGroupFrom("member.pid");
				assert.ok(memberGroup > 0 && groupAlive(memberGroup), `成员进程组 ${memberGroup} 在运行`);
				assert.equal(readdirSync(join(ticketDir(), "team", "news-researcher")).filter((f) => f.endsWith(".jsonl")).length, 1, "重启前后是同一份会话");
				await page.locator("#left .card", { hasText: TASK.title }).first().click();
				await page.locator("#steps .step.pending", { hasText: "新闻研究员 · 进行中" }).waitFor();
			});
			await step("宿主被强杀（来不及停成员）后重启：新宿主先结束留下的成员，那次派活一连回来就写「新闻研究员 · 已停止」", async (page) => {
				process.kill(host.pid, "SIGKILL");
				await sleep(300);
				assert.ok(groupAlive(memberGroup), "宿主被强杀时成员还活着");
				await host.restart();
				assert.equal(groupAlive(memberGroup), false, `新宿主启动完成时，留下的成员进程组 ${memberGroup} 应该已经结束`);
				assert.match(host.log(), /结束了上一个宿主留下的成员进程：任务 tkt_\S+ 的 news-researcher/);
				await waitStatus(page, "connected");
				await page.locator("#steps .step.stopped", { hasText: "新闻研究员 · 已停止" }).waitFor();
			});
			await step("刷新页面后，被强杀打断的那次派活仍带着成员用掉的 token", async (page) => {
				await page.reload();
				await waitStatus(page, "connected");
				await page.locator("#left .card", { hasText: TASK.title }).first().click();
				const cut = page.locator("#steps .step.stopped", { hasText: "新闻研究员 · 已停止" }).first();
				await cut.locator("summary", { hasText: "派活明细" }).click();
				assert.match(await cut.locator(".dispatch-head").textContent() ?? "", /^新闻研究员 · 已停止 · [1-9]\d* tokens$/);
			});
			await step("恢复后的助手再派一次，成员又在干活", async (page) => {
				await page.locator("#steps .step.pending", { hasText: "新闻研究员 · 进行中" }).waitFor();
				memberGroup = await memberGroupFrom("member2.pid");
				assert.ok(memberGroup > 0 && groupAlive(memberGroup), `成员进程组 ${memberGroup} 在运行`);
			});
			await step("叫停任务：成员进程组整个结束；派活那一步写「新闻研究员 · 已停止」，没有一步还在转圈；小卡消失", async (page) => {
				await sayInPage(page, "停掉这个任务");
				await page.waitForFunction(() => [...document.querySelectorAll("#steps .step.stopped .step-detail")].filter((n) => n.textContent === "新闻研究员 · 已停止").length === 2);
				assert.equal(await page.locator("#steps .step.pending").count(), 0, "没有还在等结果的步骤");
				for (let waited = 0; waited < 5000 && groupAlive(memberGroup); waited += 50) await sleep(50);
				assert.equal(groupAlive(memberGroup), false, `成员进程组 ${memberGroup} 还活着`);
				await page.waitForFunction(() => document.querySelectorAll("#helpers .helper-chip").length === 0);
				const last = page.locator("#steps .step.stopped", { hasText: "新闻研究员 · 已停止" }).last();
				await last.locator("summary", { hasText: "派活明细" }).click();
				assert.deepEqual(await last.locator(".member-step.stopped .member-step-title").allTextContents(), ["执行命令"], "成员没跑完的那条命令也写已停止");
			});
		},
		{ files: STATE_FILES, config: { dispatchTimeoutSeconds: 60 }, fixedPort: true },
	));

const FOUR = [["market-analyst", "行情分析师"], ["news-researcher", "新闻研究员"], ["earnings-reader", "财报解读"], ["chart-reader", "技术分析师"]];
const FOUR_FILES = {
	"modules/watch/module.json": WATCH_MANIFEST,
	...Object.fromEntries(FOUR.map(([name, title]) => [`modules/watch/agents/${name}.md`, `---\nname: ${name}\ntitle: ${title}\ndescription: ${title}的活\ntools: read\n---\n你是${title}。\n`])),
};

test("一次派给四位成员、同时只能跑两位：小卡下两位在干活、两位写排队中；手机宽度下成员换行，不用横向滚动", (t) =>
	story(
		t,
		{
			router: [on("Router 把问题交给看盘队", /^\[对话\][\s\S]*为什么跌/, (c) => [openInDomain(c, "watch"), reply(c, "已交给看盘队")])],
			workers: [
				worker(
					TASK.brief,
					on("助手同时派给四位成员", /^\[任务说明\]/, () => FOUR.map(([name, title]) => dispatch(name, `${title}看一下 NVDA`))),
					...FOUR.slice(1).map(([name, title]) => on(`助手收到${title}的回复`, new RegExp(`^\\[成员回复\\] 成员回复 · ${title}（${name}）`), () => [])),
					on("助手收到行情分析师的回复后汇报", /^\[成员回复\] 成员回复 · 行情分析师（market-analyst）/, () => [report("progress", "四位都看过了。")]),
				),
				...FOUR.map(([, title]) => worker(`${title}看一下 NVDA`, on(`${title}回复`, new RegExp(`^\\[派活\\] ${title}\\n`), () => `${title}：没有异常。`, WORKING_MS))),
			],
		},
		async ({ step }) => {
			await step("问一句，四位成员都列在助手小卡下：两位在干活，两位写排队中", async (page) => {
				await sayInPage(page, ASK);
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip.running").length === 2 && document.querySelectorAll("#helpers .member-chip.queued").length === 2);
				for (const label of await page.locator("#helpers .member-chip.queued").allTextContents()) assert.match(label, /^(行情分析师|新闻研究员|财报解读|技术分析师) · 排队中 · 上限 2$/);
				await page.locator("#helpers .helper-chip", { hasText: "看盘队领队 #1" }).click();
				await page.waitForFunction(() => document.querySelectorAll("#steps .lane").length === 4);
			});
			await step("手机宽度（390 px）下四位成员换行显示，每一位都在屏幕里；执行过程不横向滚动，四条分支竖排成一列", async (page) => {
				await page.setViewportSize({ width: 390, height: 844 });
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip").length === 4);
				const boxes = await page.locator("#helpers .member-chip").evaluateAll((chips) => chips.map((c) => {
					const { left, right, top } = c.getBoundingClientRect();
					return { left: Math.round(left), right: Math.round(right), top: Math.round(top) };
				}));
				const how = await page.evaluate(() => {
					const panel = document.getElementById("how")!;
					return { page: document.scrollingElement!.scrollWidth, panel: panel.scrollWidth - panel.clientWidth, lefts: [...document.querySelectorAll("#steps .lane")].map((n) => Math.round(n.getBoundingClientRect().left)) };
				});
				await page.setViewportSize({ width: 1280, height: 720 });
				assert.ok(how.page <= 390 && how.panel <= 0, `执行过程横向滚动：${JSON.stringify(how)}`);
				assert.equal(new Set(how.lefts).size, 1, `四条分支竖排成一列：${JSON.stringify(how.lefts)}`);
				assert.ok(boxes.every((b) => b.left >= 0 && b.right <= 390), `成员小标签超出 390 px：${JSON.stringify(boxes)}`);
				assert.ok(new Set(boxes.map((b) => b.top)).size > 1, "四位放不下一行，应该换行");
			});
			await step("四位都做完，助手汇报，小卡下不再有成员", async (page) => {
				await page.locator("#left .card", { hasText: "四位都看过了。" }).waitFor({ timeout: 20_000 });
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip").length === 0);
			});
		},
		{ files: FOUR_FILES, config: { maxConcurrentExperts: 2 } },
	));
