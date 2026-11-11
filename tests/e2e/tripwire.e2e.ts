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
const STORY_OPTIONS = (tgUrl: string) => ({ files: FILES, config: { secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } }, imports: ["./tests/e2e/telegram-preload.mjs", "./tests/e2e/market-offline-preload.mjs"], env: { PSA_E2E_TELEGRAM_URL: tgUrl }, fixedPort: true });

async function until(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
	for (const start = Date.now(); !predicate(); await new Promise((r) => setTimeout(r, 50))) {
		if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
	}
}

test("盯盘条件：网页上说一句，幕僚长开 us-market 的请求任务，助手用 tripwire 写入；网页出现带成本价的收据，Telegram 收不到收据", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const sentTo = () => tg.sent.filter((m) => m.chatId === USER);
	await story(
		t,
		CHAT_SETS_COST,
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
