import assert from "node:assert/strict";
import test, { after } from "node:test";
import { dispatch, on, openTicket, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, sayInPage, story, waitStatus } from "./harness.ts";

after(closeBrowser);

const FIRST = { ask: "NVDA 今天为什么跌", title: "NVDA 为什么跌", brief: "弄清 NVDA 今天为什么跌", symbol: "NVDA", done: "四位都看过 NVDA 了。" };
const SECOND = { ask: "AMD 今天为什么涨", title: "AMD 为什么涨", brief: "弄清 AMD 今天为什么涨", symbol: "AMD", done: "四位都看过 AMD 了。" };
const WORKING_MS = 6000;
const RAISE = "今天放宽到 10";
const SAID = `回答成员上限：${RAISE}`;

const FOUR = [["market-analyst", "行情分析师"], ["news-researcher", "新闻研究员"], ["earnings-reader", "财报解读"], ["chart-reader", "技术分析师"]];
const FILES = {
	"modules/watch/module.json": JSON.stringify({ name: "watch", title: "看盘", description: "看盘面、查新闻", team: "看盘队" }),
	...Object.fromEntries(FOUR.map(([name, title]) => [`modules/watch/agents/${name}.md`, `---\nname: ${name}\ntitle: ${title}\ndescription: ${title}的活\ntools: read\n---\n你是${title}。\n`])),
};

const openInWatch = (card: string, task: typeof FIRST): ToolCall => {
	const call = openTicket(card, task.title, task.brief);
	return { ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain: "watch" })) } };
};
const taskFor = (title: string, task: typeof FIRST) => `${title}看一下 ${task.symbol}`;
const helperOf = (task: typeof FIRST) =>
	worker(
		task.brief,
		on(`助手把 ${task.symbol} 同时派给四位成员`, /^\[任务说明\]/, () => FOUR.map(([name, title]) => dispatch(name, taskFor(title, task)))),
		...FOUR.slice(1).map(([name, title]) => on(`助手收到${title}看 ${task.symbol} 的回复`, new RegExp(`^\\[成员回复\\] 成员回复 · ${title}（${name}）`), () => [])),
		on(`助手收到行情分析师看 ${task.symbol} 的回复后汇报`, /^\[成员回复\] 成员回复 · 行情分析师（market-analyst）/, () => [report("progress", task.done)]),
	);
const membersOf = (task: typeof FIRST) =>
	FOUR.map(([, title]) => worker(taskFor(title, task), on(`${title}回复 ${task.symbol}`, new RegExp(`^\\[派活\\] ${title}\\n`), () => `${title}：${task.symbol} 没有异常。`, WORKING_MS)));
const chips = (kind: "running" | "queued") => `#helpers .member-chip.${kind}`;
const asks = (log: string) => log.split("\n").filter((line) => line.includes("[host] 成员上限")).map((line) => line.replace(/^\S+ /, ""));

test("四位成员、上限 2：有成员排队时页面问要不要放宽；点「今天放宽到 10」后排队的马上开始；同一天重启宿主，放宽还在", (t) =>
	story(
		t,
		{
			router: [
				on("Router 把 NVDA 交给看盘队", /^\[对话\][\s\S]*为什么跌/, (c) => [openInWatch(c, FIRST), reply(c, "已交给看盘队")]),
				on("Router 把 AMD 交给看盘队", /^\[对话\][\s\S]*为什么涨/, (c) => [openInWatch(c, SECOND), reply(c, "也交给看盘队")]),
			],
			workers: [helperOf(FIRST), ...membersOf(FIRST), helperOf(SECOND), ...membersOf(SECOND)],
		},
		async ({ step, host }) => {
			await step("问一句，两位在干活、两位排队，排队的标签写着上限 2", async (page) => {
				await sayInPage(page, FIRST.ask);
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip.running").length === 2 && document.querySelectorAll("#helpers .member-chip.queued").length === 2);
				for (const label of await page.locator(chips("queued")).allTextContents()) assert.match(label, / · 排队中 · 上限 2$/);
			});
			await step("待你处理里出现成员上限的卡片：几位在排队、现在的上限、两个按钮", async (page) => {
				const card = page.locator("#left .card.cap");
				await card.waitFor();
				assert.equal(await card.locator(".title").textContent(), "成员上限");
				assert.equal(await card.locator(".latest").textContent(), "现在有 2 位成员在排队，同时运行的成员上限是 2。今天放宽到 10 吗？");
				assert.deepEqual(await card.locator(".choices button").allTextContents(), [RAISE, "保持 2"]);
				assert.match((await page.locator("#left h2").first().textContent())!, /^待你处理 · 1$/);
				assert.equal(await page.locator(chips("queued")).count(), 2, "问题开着的时候排队的照常等");
			});
			await step("点「今天放宽到 10」：四位马上都在干活，卡片收起，对话里多一句你的话", async (page) => {
				await page.locator("#left .card.cap .choices button", { hasText: RAISE }).click();
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip.running").length === 4, null, { timeout: 3000 });
				await page.locator("#left .card.cap").waitFor({ state: "detached" });
				await page.locator(".line.user .bubble", { hasText: SAID }).waitFor();
				assert.match((await page.locator("#left h2").first().textContent())!, /^待你处理 · 0$/);
			});
			await step("宿主日志里提问和回答各一行；提问记在第三位成员排上队的那一刻", async () => {
				assert.deepEqual(asks(host.log()), [
					"[host] 成员上限：1 位成员在排队，上限 2，已问使用者今天是否放宽到 10",
					`[host] 成员上限：使用者选了「${RAISE}」，纽约 ${new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(Date.now())} 这一天上限 10`,
				]);
			});
			await step("四位都做完，助手汇报", (page) => page.locator("#left .card", { hasText: FIRST.done }).waitFor({ timeout: 20_000 }));
			await step("重启宿主，页面自己连回来，对话里那句话还在", async (page) => {
				await host.restart();
				await waitStatus(page, "connected");
				await page.reload();
				await page.locator(".line.user .bubble", { hasText: SAID }).waitFor();
			});
			await step("同一天再问一句：四位直接同时干活，没有排队，也不再问", async (page) => {
				await sayInPage(page, SECOND.ask);
				await page.waitForFunction(() => document.querySelectorAll("#helpers .member-chip.running").length === 4);
				assert.equal(await page.locator(chips("queued")).count(), 0);
				assert.equal(await page.locator("#left .card.cap").count(), 0);
				assert.equal(asks(host.log()).length, 2, "重启后的宿主没有再问，也没有记到期");
			});
			await step("第二个任务的四位也做完", (page) => page.locator("#left .card", { hasText: SECOND.done }).waitFor({ timeout: 20_000 }));
		},
		{ files: FILES, config: { maxConcurrentExperts: 2 }, fixedPort: true },
	));
