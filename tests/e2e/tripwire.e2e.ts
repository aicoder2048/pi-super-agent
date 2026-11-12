import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { FAKE_BOT_TOKEN, FakeTelegram } from "../helpers/fake-telegram.ts";
import { on, openTicket, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, sayInPage, story } from "./harness.ts";

after(closeBrowser);

const USER = 42;
const TASK = { title: "盯英伟达", brief: "把 NVDA 加进盯盘条件：成本价 120、100 股，相对成本价涨跌 10% 提醒" };
const ROUTER_SAYS = "已添加 NVDA 的盯盘提醒，成本价和股数只在网页显示。";
const SETTINGS = {
	watchlist: ["NVDA", "SPY"],
	bands: { default: [3, 5, 8] },
	volumeSpikeX: 5,
	everySeconds: 60,
	minGapMs: 12000,
	baseURL: "https://api.massive.com",
};
const FILES = {
	"secrets.env": `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`,
	"modules/us-market/module.json": JSON.stringify({
		name: "us-market",
		title: "美股行情",
		description: "美股行情和盯盘提醒",
		tools: ["lookup", "tripwire"],
		sources: [{ name: "us-market", feed: { kind: "e2e-market", settings: SETTINGS } }],
	}),
};

const inUsMarket = (call: ToolCall): ToolCall => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain: "us-market" })) } });
const setCost: ToolCall = { name: "tripwire", args: { source: "us-market", op: "set", args: { symbol: "NVDA", condition: { kind: "cost", pct: 10, basis: 120, shares: 100 } } } };
const echoOf = (card: string) => (JSON.parse(card.slice(card.indexOf("{"))) as { echo: string }).echo;

const CHAT_SETS_COST = {
	router: [
		on("幕僚长为盯盘条件开 us-market 的请求任务", /^\[对话\][\s\S]*帮我盯英伟达/, (c) => [inUsMarket(openTicket(c, TASK.title, TASK.brief)), reply(c, "好，我让看盘队记下。")]),
		on("幕僚长转告助手的汇报", /^\[Worker 汇报\][\s\S]*已添加：NVDA/, (c) => [reply(c, ROUTER_SAYS)]),
	],
	workers: [
		worker(
			TASK.brief,
			on("助手用 tripwire 写入成本条件", /^\[任务说明\]/, () => [setCost]),
			on("助手照 echo 汇报", /^\[盯盘条件\]/, (c) => [report("ready", echoOf(c))]),
		),
	],
};
const REMOVE_TASK = { title: "不盯英伟达", brief: "把 NVDA 从盯盘条件里去掉" };
const CHAT_SETS_THEN_REMOVES_COST = {
	router: [
		...CHAT_SETS_COST.router,
		on("幕僚长为去掉条件开 us-market 的请求任务", /^\[对话\][\s\S]*不用盯英伟达/, (c) => [inUsMarket(openTicket(c, REMOVE_TASK.title, REMOVE_TASK.brief)), reply(c, "好，我让看盘队去掉。")]),
		on("幕僚长转告去掉条件的汇报", /^\[Worker 汇报\][\s\S]*已去掉：NVDA/, (c) => [reply(c, "已去掉 NVDA 的盯盘提醒。")]),
	],
	workers: [
		...CHAT_SETS_COST.workers,
		worker(
			REMOVE_TASK.brief,
			on("助手用 tripwire 去掉条件", /^\[任务说明\]/, () => [{ name: "tripwire", args: { source: "us-market", op: "remove", args: { symbol: "NVDA" } } }]),
			on("助手照 echo 汇报去掉了什么", /^\[盯盘条件\]/, (c) => [report("ready", echoOf(c))]),
		),
	],
};
const PANEL_SHOTS = new URL("./.out/source-panel/", import.meta.url).pathname;
const NVDA_LINE = "NVDA 成本价 120、100 股，相对成本价涨跌超过 10% 时提醒";
const CROSS_TASK = { title: "盯特斯拉均线", brief: "把 TSLA 的 5 日、20 日均线金叉死叉加进盯盘条件" };
const CHAT_SETS_CROSS = {
	router: [
		on("幕僚长为均线交叉开 us-market 的请求任务", /^\[对话\][\s\S]*特斯拉/, (c) => [inUsMarket(openTicket(c, CROSS_TASK.title, CROSS_TASK.brief)), reply(c, "好，我让看盘队记下。")]),
		on("幕僚长转告助手的汇报", /^\[Worker 汇报\][\s\S]*已添加：TSLA/, (c) => [reply(c, "已添加 TSLA 的均线交叉提醒。")]),
	],
	workers: [
		worker(
			CROSS_TASK.brief,
			on("助手用 tripwire 写入交叉条件", /^\[任务说明\]/, () => [{ name: "tripwire", args: { source: "us-market", op: "set", args: { symbol: "TSLA", condition: { kind: "cross" } } } }]),
			on("助手照 echo 汇报", /^\[盯盘条件\]/, (c) => [report("ready", echoOf(c))]),
		),
	],
};

const STORY_OPTIONS =(tgUrl: string) => ({ files: FILES, config: { secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } }, imports: ["./tests/e2e/telegram-preload.mjs", "./tests/e2e/market-offline-preload.mjs"], env: { PSA_E2E_TELEGRAM_URL: tgUrl }, fixedPort: true });

async function until(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
	for (const start = Date.now(); !predicate(); await new Promise((r) => setTimeout(r, 50))) {
		if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
	}
}

test("盯盘条件：网页上说一句，幕僚长开 us-market 的请求任务，助手用 tripwire 写入；网页出现带成本价的收据，左栏列出这条，Telegram 收不到收据；说去掉后左栏不再列出", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const sentTo = () => tg.sent.filter((m) => m.chatId === USER);
	await story(
		t,
		CHAT_SETS_THEN_REMOVES_COST,
		async ({ step, fake }) => {
			await step("手机打开聊天后，网页上说要盯英伟达：网页出现宿主写的收据，写着成本价和股数", async (page) => {
				tg.userSays(USER, "/start");
				await until(() => sentTo().length === 1, "说明");
				await sayInPage(page, "帮我盯英伟达，成本 120，100 股，偏离 10% 提醒");
				const receipt = page.locator(".line.receipt");
				await receipt.waitFor();
				assert.equal(await receipt.locator(".who").textContent(), "盯盘条件（只在本机）");
				assert.match((await receipt.locator(".bubble").textContent()) ?? "", /已添加：NVDA 成本价 120、100 股，相对成本价涨跌超过 10% 时提醒/);
				await page.locator(".line.router .bubble", { hasText: ROUTER_SAYS }).waitFor();
			});
			await step("助手看得到 tripwire；它拿到的 echo 和汇报都没有成本价", () => {
				const exchange = fake.exchanges.find((e) => e.conversation === TASK.brief)!;
				assert.ok(exchange.tools.includes("tripwire"));
				const echoed = fake.exchanges.flatMap((e) => e.cards).find((c) => c.startsWith("[盯盘条件]"))!;
				assert.doesNotMatch(echoed, /120|100 股/);
			});
			await step("Telegram 收到幕僚长的回复和使用者原话的转发（ADR-0016 照旧），收不到收据", async () => {
				await until(() => sentTo().some((m) => m.text === ROUTER_SAYS), "回复到达 Telegram");
				assert.ok(sentTo().some((m) => m.text.startsWith("你在网页或终端说：帮我盯英伟达")));
				assert.deepEqual(sentTo().filter((m) => /成本价 120|盯盘条件（只在本机）|现在共 1 条/.test(m.text)), []);
			});
			await step("不用刷新，左栏关注的来源下展开着「盯盘条件 1 条」，写着成本价；「自选 2 只」默认收起，点开后刷新页面还开着", async (page) => {
				const source = page.locator('.watch[data-source="us-market"]');
				await source.locator(".panel.tripwires li", { hasText: NVDA_LINE }).waitFor();
				assert.equal(await source.locator(".panel.tripwires summary").textContent(), "盯盘条件 1 条");
				assert.equal(await source.locator(".panel.tripwires").evaluate((d) => (d as HTMLDetailsElement).open), true);
				const watchlist = source.locator(".panel.watchlist");
				assert.equal(await watchlist.locator("summary").textContent(), "自选 2 只");
				assert.equal(await watchlist.evaluate((d) => (d as HTMLDetailsElement).open), false);
				await watchlist.locator("summary").click();
				await page.waitForFunction(() => localStorage.getItem("psa-panel-open")?.includes('"us-market/watchlist":true'), null, { timeout: 5_000 });
				await page.reload();
				await page.locator('.watch[data-source="us-market"] .panel.watchlist[open] li', { hasText: "SPY" }).waitFor();
			});
			await step("左栏截图：亮色和暗色，桌面宽度和 390px 手机宽度", async (page) => {
				for (const [width, height] of [[1280, 800], [390, 844]]) {
					await page.setViewportSize({ width, height });
					for (const theme of ["light", "dark"]) {
						await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
						await page.locator('.watch[data-source="us-market"]').screenshot({ path: join(PANEL_SHOTS, `source-${theme}-${width}.png`) });
						await page.locator("#left").screenshot({ path: join(PANEL_SHOTS, `left-${theme}-${width}.png`) });
						const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
						assert.ok(overflow <= 0, `${width}px ${theme} 横向溢出 ${overflow}px`);
					}
				}
				await page.setViewportSize({ width: 1280, height: 800 });
			});
			await step("网页上说不用盯英伟达了：左栏的「盯盘条件」不再列出，Telegram 照样收不到成本价", async (page) => {
				await sayInPage(page, "不用盯英伟达了");
				await page.locator(".line.router .bubble", { hasText: "已去掉 NVDA 的盯盘提醒。" }).waitFor();
				await page.locator('.watch[data-source="us-market"] .panel.tripwires').waitFor({ state: "detached" });
				assert.equal(await page.locator('.watch[data-source="us-market"] .panel.watchlist summary').textContent(), "自选 2 只");
				await until(() => sentTo().some((m) => m.text === "已去掉 NVDA 的盯盘提醒。"), "回复到达 Telegram");
				assert.deepEqual(sentTo().filter((m) => /成本价 120|盯盘条件 \d+ 条/.test(m.text)), []);
			});
		},
		STORY_OPTIONS(tg.url),
	);
});

test("盯盘提醒：聊天里设好成本条件后，盘中报价越过 +10% 线，手机响一次「盯盘提醒」且没有成本价，网页出现同一行；同价再看一轮什么都不发", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const quotes = mkdtempSync(join(tmpdir(), "psa-e2e-quotes-"));
	const alertText = "NVDA 相对成本价 +10.40%，到了你设的 +10% 提醒线。现价 132.48。报价时间 09:59 ET。";
	const rang = () => tg.sent.filter((m) => m.chatId === USER && m.text.startsWith("盯盘提醒："));
	const tick = async (name: string, price: number) => {
		writeFileSync(join(quotes, name), JSON.stringify({ symbol: "NVDA", price, prevClose: 130 }));
		await until(() => existsSync(join(quotes, `${name}.ticked`)), `看盘 ${name}`);
	};
	const options = STORY_OPTIONS(tg.url);
	await story(
		t,
		CHAT_SETS_COST,
		async ({ step }) => {
			await step("网页上说要盯英伟达，收据出现后，NVDA 报价越过成本 +10%：手机收到一条响铃的盯盘提醒，网页出现同一行", async (page) => {
				tg.userSays(USER, "/start");
				await sayInPage(page, "帮我盯英伟达，成本 120，100 股，偏离 10% 提醒");
				await page.locator(".line.receipt").waitFor();
				await tick("1-cross", 132.48);
				const alert = page.locator(".line.alert");
				await alert.waitFor();
				assert.equal(await alert.locator(".bubble").textContent(), alertText);
				await until(() => rang().length === 1, "提醒到达 Telegram");
				assert.deepEqual(rang().map((m) => [m.text, m.silent]), [[`盯盘提醒：${alertText}`, false]]);
				assert.doesNotMatch(rang()[0].text, /120|100 股/);
			});
			await step("同一个价格再看一轮：手机和网页都没有新的提醒", async (page) => {
				await tick("2-same", 132.48);
				await page.waitForTimeout(1500);
				assert.equal(rang().length, 1);
				assert.equal(await page.locator(".line.alert").count(), 1);
			});
		},
		{ ...options, env: { ...options.env, PSA_E2E_QUOTES_DIR: quotes } },
	);
});

// Weekday closes at 100 through Tuesday 2026-11-10, which closed at 99: SMA5 sits just under SMA20.
function tslaHistory(): Record<string, number> {
	const closes: Record<string, number> = {};
	for (let t = Date.parse("2026-09-01T12:00:00Z"); t <= Date.parse("2026-11-10T12:00:00Z"); t += 86_400_000) {
		if (![0, 6].includes(new Date(t).getUTCDay())) closes[new Date(t).toISOString().slice(0, 10)] = 100;
	}
	return { ...closes, "2026-11-10": 99 };
}

test("均线交叉：盘中现价拉出金叉，手机响一条「疑似金叉」；收盘 45 分钟后两次醒来取到一致的当天日线、收盘没成立，手机再响一条「金叉没有成立」；网页两条都在", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const ticks = mkdtempSync(join(tmpdir(), "psa-e2e-quotes-"));
	const rang = () => tg.sent.filter((m) => m.chatId === USER && m.text.startsWith("盯盘提醒："));
	const tick = async (name: string, body: object) => {
		writeFileSync(join(ticks, name), JSON.stringify(body));
		await until(() => existsSync(join(ticks, `${name}.ticked`)), `看盘 ${name}`);
	};
	const options = STORY_OPTIONS(tg.url);
	await story(
		t,
		CHAT_SETS_CROSS,
		async ({ step }) => {
			await step("网页上说要盯特斯拉的均线交叉，收据出现后，盘中 TSLA 涨到 102：手机收到一条响铃的「疑似金叉」，网页出现同一行", async (page) => {
				tg.userSays(USER, "/start");
				await sayInPage(page, "帮我盯特斯拉的 5 日 20 日均线金叉死叉");
				await page.locator(".line.receipt").waitFor();
				await tick("1-intraday", { quotes: [{ symbol: "TSLA", price: 102, prevClose: 99 }, { symbol: "NVDA", price: 100, prevClose: 100 }], closes: { TSLA: tslaHistory() } });
				await until(() => rang().length === 1, "疑似金叉到达 Telegram");
				assert.match(rang()[0].text, /^盯盘提醒：TSLA 疑似金叉：把现价 102\.00 当作今天收盘/);
				assert.equal(rang()[0].silent, false);
				await page.locator(".line.alert").waitFor();
				assert.match((await page.locator(".line.alert .bubble").textContent()) ?? "", /TSLA 疑似金叉/);
			});
			await step("收盘 51 分钟后第一次醒来取到当天日线（收 100）：只记下，手机不响", async () => {
				await tick("2-settle-first", { now: "2026-11-11T21:51:00Z", closes: { TSLA: { "2026-11-11": 100 } } });
				await new Promise((r) => setTimeout(r, 1500));
				assert.equal(rang().length, 1);
			});
			await step("再过 15 分钟醒来，当天收盘价一致：手机收到「金叉没有成立」，网页对话里两条提醒都在", async (page) => {
				await tick("3-settle-agree", { now: "2026-11-11T22:06:00Z" });
				await until(() => rang().length === 2, "撤回到达 Telegram");
				assert.match(rang()[1].text, /^盯盘提醒：TSLA 金叉没有成立：今天收盘 100\.00.*早前的疑似金叉提醒作废。$/);
				await page.locator(".line.alert").nth(1).waitFor();
				const shown = await page.locator(".line.alert .bubble").allTextContents();
				assert.deepEqual(shown.map((s) => s.split("：")[0]), ["TSLA 疑似金叉", "TSLA 金叉没有成立"]);
			});
		},
		{ ...options, env: { ...options.env, PSA_E2E_QUOTES_DIR: ticks } },
	);
});
