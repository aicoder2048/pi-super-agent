import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { NOTES } from "../../src/host/telegram/rules.ts";
import { FAKE_BOT_TOKEN, FakeTelegram } from "../helpers/fake-telegram.ts";
import { dispatch, on, openTicket, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, sayInPage, story, waitStatus, type StoryOptions } from "./harness.ts";

after(closeBrowser);

const USER = 42;
const SECRET = FAKE_BOT_TOKEN.split(":")[1];
const userLine = (page: Page, text: string) => page.locator(".line.user .bubble", { hasText: text });
const routerLine = (page: Page, text: string) => page.locator(".line.router .bubble", { hasText: text });
const sentTo = (tg: FakeTelegram, chatId: number) => tg.sent.filter((m) => m.chatId === chatId);
const unnoted = (text: string) => (text.startsWith(`${NOTES.missed}\n`) ? text.slice(NOTES.missed.length + 1) : text);
const noteCount = (texts: string[]) => texts.filter((x) => x.split("\n")[0] === NOTES.missed).length;

async function until(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
	for (const start = Date.now(); !predicate(); await new Promise((r) => setTimeout(r, 50))) {
		if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
	}
}

function telegramStory(tg: FakeTelegram, allowedUserIds: number[], extra: { files?: Record<string, string>; config?: Record<string, unknown> } = {}): StoryOptions {
	return {
		imports: ["./tests/e2e/telegram-preload.mjs"],
		env: { PSA_E2E_TELEGRAM_URL: tg.url },
		files: { "secrets.env": `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`, ...extra.files },
		config: { secretsFile: "secrets.env", telegram: { allowedUserIds }, ...extra.config },
		fixedPort: true,
	};
}

test("Telegram：名单上的人在手机上说话，网页上看到；幕僚长的回复同时到网页和 Telegram；陌生人和群看不到；网页的话静默转过去；Telegram 出错不重发、之后的消息带一句说明；重启不丢不重", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	await story(
		t,
		{
			router: [
				on("幕僚长回答手机上的话", /^\[对话\][\s\S]*使用者：查一下 NVDA/, (c) => [reply(c, "NVDA 现在 170 美元。")]),
				on("幕僚长回答网页上的话", /^\[对话\][\s\S]*使用者：网页上说一句/, (c) => [reply(c, "收到网页上的话。")]),
				on("幕僚长回答断网时的话", /^\[对话\][\s\S]*使用者：断网时说/, (c) => [reply(c, "收到断网时的话。")]),
				on("幕僚长回答恢复后的话", /^\[对话\][\s\S]*使用者：恢复后说/, (c) => [reply(c, "收到恢复后的话。")]),
				on("幕僚长回答重启前的话", /^\[对话\][\s\S]*使用者：重启前说的/, (c) => [reply(c, "收到重启前的话。")]),
				on("幕僚长回答停机时的话", /^\[对话\][\s\S]*使用者：停机时说的/, (c) => [reply(c, "收到停机时的话。")]),
			],
		},
		async ({ step, host, stateDir }) => {
			await step("手机上说「查一下 NVDA」：网页出现这句话和幕僚长的回复，回复带通知发到 Telegram", async (page) => {
				tg.userSays(USER, "查一下 NVDA");
				await userLine(page, "查一下 NVDA").waitFor();
				await routerLine(page, "NVDA 现在 170 美元。").waitFor();
				await until(() => sentTo(tg, USER).some((m) => m.text === "NVDA 现在 170 美元。"), "回复到达 Telegram");
				assert.deepEqual(sentTo(tg, USER).map((m) => [m.text, m.silent]), [["NVDA 现在 170 美元。", false]]);
			});
			await step("陌生人和群里的话：网页、状态库和日志里都没有", async (page) => {
				tg.userSays(99887766, "陌生人 stranger-words");
				tg.userSays(USER, "群里 stranger-words", { chatId: -100555, group: true });
				await until(() => host.log().includes("丢弃了"), "丢弃的日志");
				await page.waitForTimeout(500);
				assert.equal(await page.locator(".bubble", { hasText: "stranger-words" }).count(), 0);
				const db = new DatabaseSync(join(stateDir, "state.db"), { readOnly: true });
				try {
					assert.equal((db.prepare("SELECT COUNT(*) AS n FROM triggers WHERE body LIKE '%stranger-words%'").get() as { n: number }).n, 0);
					assert.deepEqual(db.prepare("SELECT chat_id FROM telegram_chats").all().map((r) => (r as { chat_id: number }).chat_id), [USER]);
				} finally {
					db.close();
				}
				assert.ok(!/99887766|100555|stranger-words/.test(host.log()), "日志里没有对方 id 和内容");
				assert.equal(sentTo(tg, 99887766).length, 0);
			});
			await step("网页上说一句：Telegram 静默收到「你在网页或终端说：…」，回复带通知", async (page) => {
				await sayInPage(page, "网页上说一句");
				await routerLine(page, "收到网页上的话。").waitFor();
				await until(() => sentTo(tg, USER).length === 3, "转过去的话和回复");
				assert.deepEqual(sentTo(tg, USER).slice(1).map((m) => [m.text, m.silent]), [
					["你在网页或终端说：网页上说一句", true],
					["收到网页上的话。", false],
				]);
			});
			await step("Telegram 回 500 时网页照常只有一条回复；出错的那几条不重发；恢复后手机上的第一条消息开头带一句说明", async (page) => {
				const before = sentTo(tg, USER).length;
				tg.fail("sendMessage", 500);
				await sayInPage(page, "断网时说");
				await routerLine(page, "收到断网时的话。").waitFor();
				await until(() => tg.calls("sendMessage").filter((r) => r.status === 500).length === 3, "转过去的话、回复和单独的说明都没发出");
				tg.heal("sendMessage");
				tg.userSays(USER, "恢复后说");
				await until(() => sentTo(tg, USER).length > before, "恢复后的回复到达 Telegram");
				await page.waitForTimeout(1500);
				assert.deepEqual(sentTo(tg, USER).slice(before).map((m) => m.text), [`${NOTES.missed}\n收到恢复后的话。`]);
				assert.equal(await routerLine(page, "收到断网时的话。").count(), 1);
			});
			await step("重启：停机时手机上说的话进对话一次、回复一次；停机前说不准的不重发，重启后的第一条消息带一句说明", async (page) => {
				const failedBefore = tg.calls("sendMessage").filter((r) => r.status === 500).length;
				tg.fail("sendMessage", 500);
				await sayInPage(page, "重启前说的");
				await routerLine(page, "收到重启前的话。").waitFor();
				await until(() => tg.calls("sendMessage").filter((r) => r.status === 500).length > failedBefore, "重启前 Telegram 失败过");
				await host.restart(() => {
					tg.userSays(USER, "停机时说的");
					tg.heal("sendMessage");
				});
				await waitStatus(page, "connected");
				await routerLine(page, "收到停机时的话。").waitFor({ timeout: 20_000 });
				await until(() => sentTo(tg, USER).some((m) => unnoted(m.text) === "收到停机时的话。"), "停机时的话的回复到达 Telegram", 30_000);
				await page.waitForTimeout(1500);
				assert.equal(await userLine(page, "停机时说的").count(), 1);
				const texts = sentTo(tg, USER).map((m) => unnoted(m.text));
				for (const text of ["你在网页或终端说：重启前说的", "收到重启前的话。"]) assert.ok(texts.filter((x) => x === text).length <= 1, text);
				assert.equal(texts.filter((x) => x === "收到停机时的话。").length, 1);
				assert.equal(noteCount(sentTo(tg, USER).map((m) => m.text)), 2, "两次出错，各有一条消息带说明");
			});
			await step("宿主日志和状态目录（secretsFile 以外）里没有 bot token，Telegram 每个请求都带对的 token", async () => {
				assert.ok(!host.log().includes(SECRET));
				const leaks = readdirSync(stateDir, { recursive: true, withFileTypes: true })
					.filter((e) => e.isFile() && e.name !== "secrets.env")
					.map((e) => join(e.parentPath, e.name))
					.filter((file) => readFileSync(file).includes(SECRET));
				assert.deepEqual(leaks, []);
				assert.equal(tg.wrongToken, 0);
			});
		},
		telegramStory(tg, [USER]),
	);
});

test("盯盘提醒：来源贴一条提醒，网页对话里出现带「盯盘提醒」标签、不能引用的一行，手机响一次；重启后不重发，刷新后还在", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const alerts = mkdtempSync(join(tmpdir(), "psa-e2e-alerts-"));
	const text = "NVDA 涨了 5.3%，现价 150.20（延迟行情）";
	const alertLine = (page: Page) => page.locator(".line.alert");
	const rang = () => sentTo(tg, USER).filter((m) => m.text === `盯盘提醒：${text}`);
	const options = telegramStory(tg, [USER], {
		files: { "modules/alerts/module.json": JSON.stringify({ name: "alerts", sources: [{ name: "e2e-alerts", feed: { kind: "e2e-alerts" } }] }) },
	});
	await story(
		t,
		{ router: [] },
		async ({ step, host }) => {
			await step("手机打开聊天后，来源贴一条提醒：网页出现这一行，手机收到一条带通知的「盯盘提醒：…」", async (page) => {
				tg.userSays(USER, "/start");
				await until(() => sentTo(tg, USER).length === 1, "说明");
				writeFileSync(join(alerts, "NVDA-2026-11-11-day-up-5"), text);
				await alertLine(page).waitFor();
				assert.equal(await alertLine(page).locator(".who").textContent(), "盯盘提醒");
				assert.equal(await alertLine(page).locator(".bubble").textContent(), text);
				assert.equal(await alertLine(page).locator(".quote-btn").count(), 0, "提醒不能引用");
				await until(() => rang().length === 1, "提醒到达 Telegram");
				assert.equal(rang()[0].silent, false, "手机响");
			});
			await step("重启宿主：来源再贴同一条，手机不再收到；刷新网页，这一行还在、只有一行", async (page) => {
				await host.restart();
				await waitStatus(page, "connected");
				await page.reload();
				await alertLine(page).waitFor();
				await page.waitForTimeout(1500);
				assert.equal(await alertLine(page).count(), 1);
				assert.equal(rang().length, 1);
			});
		},
		{ ...options, imports: [...options.imports!, "./tests/e2e/alert-feed-preload.mjs"], env: { ...options.env, PSA_E2E_ALERTS_DIR: alerts } },
	);
});

test("Telegram 设置模式：名单为空时，来信的人只收到自己的 id，网页上什么都不出现", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	await story(
		t,
		{ router: [] },
		async ({ step, host }) => {
			await step("陌生人私聊：只收到自己的 id；对话是空的", async (page) => {
				await until(() => host.log().includes("名单为空"), "设置模式的日志");
				tg.userSays(555001, "你好");
				await until(() => sentTo(tg, 555001).length === 1, "收到自己的 id");
				assert.match(sentTo(tg, 555001)[0].text, /^你的 Telegram 数字 id 是 555001。/);
				await page.waitForTimeout(500);
				assert.equal(await page.locator(".thread > .line").count(), 0);
				assert.ok(!host.log().includes(SECRET));
			});
		},
		telegramStory(tg, []),
	);
});

const CITY = "上海市浦东新区陆家嘴";
const OTHER_CITY = "北京市朝阳区望京街道";
const cardsTo = (tg: FakeTelegram, chatId: number) => sentTo(tg, chatId).filter((m) => m.text.includes("问你（任务"));
const handOverTo = (title: string) => (card: string): ToolCall[] => {
	const ticketId = card.match(new RegExp(`(tkt_[\\w-]+)「${title}」`))?.[1];
	return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: card.match(/trg_[\w-]+/)?.[0], ticketId }] } }];
};

test("Telegram 问题卡片：助手提问，手机上出现带两个按钮的卡片；点一下，网页上出现这句回答，卡片按钮消失；再点只答一次；问题结束后卡片写已结束", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	await story(
		t,
		{
			router: [
				on("Router 开任务查天气", /^\[对话\][\s\S]*使用者：查天气/, (c) => [openTicket(c, "查天气", "查天气任务"), reply(c, "好的，去查了。")]),
				on("Router 把助手的问题转给使用者", /^\[Worker 提问\][\s\S]*查哪个城市/, (c) => [reply(c, "查哪个城市？")]),
				on("Router 把手机上的点选转交给任务", new RegExp(`^\\[对话\\][\\s\\S]*回答任务「查天气」：${CITY}`), handOverTo("查天气")),
				on("Router 转述结果", /^\[Worker 汇报\][\s\S]*陆家嘴晴/, (c) => [reply(c, "陆家嘴晴，26 度。")]),
			],
			workers: [
				worker(
					"查天气任务",
					on("助手问城市", /^\[任务说明\]/, () => [{ name: "report", args: { status: "blocked", summary: "要你定", question: "查哪个城市？", options: [OTHER_CITY, CITY] } }]),
					on("助手收到回答后汇报", new RegExp(`^\\[使用者的话[\\s\\S]*${CITY}`), () => [report("ready", "陆家嘴晴，26 度。")]),
				),
			],
		},
		async ({ step }) => {
			await step("手机上先打开聊天，网页上说「查天气」：Telegram 收到一张带两个按钮的卡片", async (page) => {
				tg.userSays(USER, "/start");
				await until(() => sentTo(tg, USER).length === 1, "说明");
				await sayInPage(page, "查天气");
				await until(() => cardsTo(tg, USER).length === 1, "卡片到达 Telegram");
				const [card] = cardsTo(tg, USER);
				assert.match(card.text, /^.+ · 对话助手 #\d 问你（任务「查天气」）：\n查哪个城市？$/u);
				assert.deepEqual(card.buttons?.map((row) => row.map((b) => b.text)), [[OTHER_CITY], [CITY]]);
				await page.locator(".thread > .line.router", { hasText: "查哪个城市？" }).locator(".choices button").first().waitFor();
			});
			await step("在 Telegram 点「上海」：网页对话出现这句回答，幕僚长转述结果；提示已发送", async (page) => {
				const [card] = cardsTo(tg, USER);
				const tap = tg.userTaps(USER, card.messageId, card.buttons![1][0].data);
				await page.locator(".line.user .bubble", { hasText: `回答任务「查天气」：${CITY}` }).waitFor();
				await until(() => tg.toastFor(tap) === "已发送", "按钮的提示");
				await page.locator(".line.router .bubble", { hasText: "陆家嘴晴，26 度。" }).waitFor({ timeout: 15_000 });
			});
			await step("同一个按钮再点一次：只答一次，弹出提示", async (page) => {
				const [card] = cardsTo(tg, USER);
				const again = tg.userTaps(USER, card.messageId, card.buttons![1][0].data);
				await until(() => tg.toastFor(again) !== undefined, "第二次点的提示");
				await page.waitForTimeout(800);
				assert.equal(await page.locator(".line.user .bubble", { hasText: `回答任务「查天气」：${CITY}` }).count(), 1);
			});
			await step("问题结束：Telegram 的卡片编辑成已结束，写着选了哪一项，按钮消失；没有重发卡片", async () => {
				const [card] = cardsTo(tg, USER);
				await until(() => tg.shown(card.messageId)!.text.endsWith(`已结束：你选了「${CITY}」`), "卡片关闭");
				assert.equal(tg.shown(card.messageId)!.buttons, null);
				assert.equal(cardsTo(tg, USER).length, 1);
				assert.ok(!sentTo(tg, USER).some((m) => m.text.startsWith("你在网页或终端说：回答任务")), "手机上点的回答不再转回手机");
			});
		},
		telegramStory(tg, [USER]),
	);
});

const CREW = [["market-analyst", "行情分析师"], ["news-researcher", "新闻研究员"]];
const WATCH = {
	"modules/watch/module.json": JSON.stringify({ name: "watch", title: "看盘", description: "看盘面、查新闻", team: "看盘队" }),
	...Object.fromEntries(CREW.map(([name, title]) => [`modules/watch/agents/${name}.md`, `---\nname: ${name}\ntitle: ${title}\ndescription: ${title}的活\ntools: read\n---\n你是${title}。\n`])),
};
const RAISE = "今天放宽到 10";

test("Telegram 和成员上限：手机上只有一条说明、没有按钮；伪造的按钮被拒；网页照常能放宽", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const openInWatch = (card: string): ToolCall => {
		const call = openTicket(card, "看 NVDA", "看一下 NVDA");
		return { ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain: "watch" })) } };
	};
	await story(
		t,
		{
			router: [on("Router 把 NVDA 交给看盘队", /^\[对话\][\s\S]*看 NVDA/, (c) => [openInWatch(c), reply(c, "已交给看盘队")])],
			workers: [
				worker(
					"看一下 NVDA",
					on("助手同时派给两位成员", /^\[任务说明\]/, () => CREW.map(([name, title]) => dispatch(name, `${title}看一下 NVDA`))),
					on("助手收到新闻研究员的回复", /^\[成员回复\] 成员回复 · 新闻研究员/, () => []),
					on("助手收到行情分析师的回复后汇报", /^\[成员回复\] 成员回复 · 行情分析师/, () => [report("progress", "两位都看过了。")]),
				),
				...CREW.map(([, title]) => worker(`${title}看一下 NVDA`, on(`${title}回复`, new RegExp(`^\\[派活\\] ${title}\\n`), () => `${title}：没有异常。`, 4000))),
			],
		},
		async ({ step }) => {
			await step("手机上打开聊天；网页上说「看 NVDA」，一位成员排队，网页出现成员上限的卡片", async (page) => {
				tg.userSays(USER, "/start");
				await until(() => sentTo(tg, USER).length === 1, "说明");
				await sayInPage(page, "看 NVDA");
				await page.locator("#left .card.cap").waitFor();
			});
			await step("Telegram 只收到一条成员上限的说明，没有按钮；之后也不重发", async (page) => {
				await until(() => sentTo(tg, USER).some((m) => m.text.startsWith("成员上限：")), "成员上限的说明");
				await page.waitForTimeout(1500);
				const notes = sentTo(tg, USER).filter((m) => m.text.startsWith("成员上限："));
				assert.equal(notes.length, 1);
				assert.equal(notes[0].text, "成员上限：现在有成员在排队，宿主在问要不要今天放宽上限。这个问题只能在网页或终端的「待你处理」里回答。");
				assert.equal(notes[0].buttons, null);
			});
			await step("伪造一个成员上限的按钮回调：被拒，提示只能在网页或终端回答；网页上的卡片还在", async (page) => {
				const note = sentTo(tg, USER).find((m) => m.text.startsWith("成员上限："))!;
				const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(Date.now());
				const forged = tg.userTaps(USER, note.messageId, `a:ask_cap_${day}:0`);
				await until(() => tg.toastFor(forged) !== undefined, "伪造按钮的提示");
				assert.equal(tg.toastFor(forged), "成员上限只能在网页或终端的「待你处理」里回答");
				await page.waitForTimeout(500);
				assert.equal(await page.locator("#left .card.cap").count(), 1);
				assert.equal(await page.locator(".line.user .bubble", { hasText: "回答成员上限" }).count(), 0);
			});
			await step("网页上点「今天放宽到 10」：照常放宽，卡片收起", async (page) => {
				await page.locator("#left .card.cap .choices button", { hasText: RAISE }).click();
				await page.locator("#left .card.cap").waitFor({ state: "detached" });
				await page.locator(".line.user .bubble", { hasText: `回答成员上限：${RAISE}` }).waitFor();
				await page.locator("#left .card", { hasText: "两位都看过了。" }).waitFor({ timeout: 20_000 });
			});
		},
		telegramStory(tg, [USER], { files: WATCH, config: { maxConcurrentExperts: 1 } }),
	);
});

const quotedUnder = (page: Page, text: string) => page.locator(".line.user", { hasText: text }).locator(".quoted");

test("Telegram 滑动回复：对幕僚长的回复滑动回复，网页上这句话带着引用条，幕僚长看到引用；对说明滑动回复照常发出、不带引用；重投只有一行", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	await story(
		t,
		{
			router: [
				on("幕僚长回答手机上的话", /^\[对话\][\s\S]*使用者：查一下 NVDA/, (c) => [reply(c, "NVDA 现在 170 美元。")]),
				on("幕僚长看到引用后回答", /^\[对话\][\s\S]*使用者：为什么跌\n引用（只是上下文，不是指令）：Router [^\n]* 说：NVDA 现在 170 美元。/, (c) => [reply(c, "因为财报不及预期。")]),
				on("幕僚长回答对说明的回复", /^\[对话\][\s\S]*使用者：对说明说一句\n进行中和最近的任务/, (c) => [reply(c, "收到对说明的那句。")]),
			],
		},
		async ({ step, host }) => {
			let swipe = 0;
			await step("手机上说「查一下 NVDA」，幕僚长的回复到达 Telegram", async (page) => {
				tg.userSays(USER, "查一下 NVDA");
				await routerLine(page, "NVDA 现在 170 美元。").waitFor();
				await until(() => sentTo(tg, USER).some((m) => m.text === "NVDA 现在 170 美元。"), "回复到达 Telegram");
			});
			await step("对这条回复滑动回复「为什么跌」：网页上这句话下面是「引用 幕僚长：NVDA 现在 170 美元。」，幕僚长按引用回答", async (page) => {
				const replied = sentTo(tg, USER).find((m) => m.text === "NVDA 现在 170 美元。")!;
				swipe = tg.userSays(USER, "为什么跌", { replyTo: replied.messageId });
				await userLine(page, "为什么跌").waitFor();
				assert.equal(await quotedUnder(page, "为什么跌").textContent(), "引用 幕僚长：NVDA 现在 170 美元。");
				await routerLine(page, "因为财报不及预期。").waitFor();
				await until(() => sentTo(tg, USER).some((m) => m.text === "因为财报不及预期。"), "回答到达 Telegram");
				assert.ok(!sentTo(tg, USER).some((m) => m.text.includes("为什么跌")), "自己说的不转回手机");
			});
			await step("同一个滑动回复的 update 再投一次：网页上仍只有一行「为什么跌」，幕僚长只回一次", async (page) => {
				const polls = tg.calls("getUpdates").length;
				tg.redeliver(swipe);
				await until(() => tg.calls("getUpdates").length >= polls + 1, "重投的 update 被取走");
				await page.waitForTimeout(1500);
				assert.equal(await userLine(page, "为什么跌").count(), 1);
				assert.equal(sentTo(tg, USER).filter((m) => m.text === "因为财报不及预期。").length, 1);
			});
			await step("对 /start 的说明滑动回复：这句话照常进对话，不带引用，幕僚长照常回答", async (page) => {
				tg.userSays(USER, "/start");
				await until(() => sentTo(tg, USER).some((m) => m.text === NOTES.help), "说明");
				const note = sentTo(tg, USER).find((m) => m.text === NOTES.help)!;
				tg.userSays(USER, "对说明说一句", { replyTo: note.messageId });
				await userLine(page, "对说明说一句").waitFor();
				assert.equal(await quotedUnder(page, "对说明说一句").count(), 0);
				await routerLine(page, "收到对说明的那句。").waitFor();
				assert.ok(!host.log().includes(SECRET));
			});
		},
		telegramStory(tg, [USER]),
	);
});

test("私密 feed 放出三行：来一封信，网页上一条「通知」三行，手机上一条三行的消息、带通知、不出链接预览；之后在手机上问幕僚长，回复是全文", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const pkg = join(import.meta.dirname, "../fixtures/modules/private-line");
	const files = Object.fromEntries(
		readdirSync(pkg, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => {
				const path = join(entry.parentPath, entry.name);
				return [join("modules/private-line", path.slice(pkg.length + 1)), readFileSync(path, "utf8")];
			}),
	);
	const LINE = "测试信箱：Ann <ann@example.com>\n季度对账单\n您好，对账单在 https://example.com/x";
	const noticeLine = (page: Page) => page.locator(".line.notice", { hasText: "测试信箱" });
	await story(
		t,
		{
			router: [
				on("幕僚长看到来信的三行，不开任务", /^\[候选触发\][^\n]*来源 private-line\/inbox[\s\S]*季度对账单/, () => "ok"),
				on("幕僚长回一句固定的话", /^\[对话\][\s\S]*使用者：今天大盘怎么样/, (c) => [reply(c, "固定的回答：今天大盘平稳")]),
			],
		},
		async ({ step, stateDir }) => {
			await step("收件箱放进一封信：网页出现一条三行的「通知」，手机收到一条同样三行、带通知、不出链接预览的消息", async (page) => {
				tg.userSays(USER, "/start");
				await until(() => sentTo(tg, USER).length === 1, "说明");
				const inbox = join(stateDir, "inbox/private-line/inbox");
				mkdirSync(inbox, { recursive: true });
				writeFileSync(join(inbox, "m-1.json"), JSON.stringify({ id: "m-1", from: "Ann <ann@example.com>", subject: "季度对账单", snippet: "您好，对账单在 https://example.com/x", body: "正文 CANARY-7f3a" }));
				await noticeLine(page).waitFor({ timeout: 20_000 });
				assert.equal(await noticeLine(page).locator(".who").textContent(), "通知");
				assert.equal(await noticeLine(page).locator(".bubble").innerText(), LINE);
				await until(() => sentTo(tg, USER).some((m) => m.text === `通知：${LINE}`), "三行到达 Telegram");
				const sent = sentTo(tg, USER).find((m) => m.text === `通知：${LINE}`)!;
				assert.equal(sent.silent, false, "手机响");
				assert.equal(sent.preview, false, "不出链接预览");
			});
			await step("在手机上问幕僚长：回复全文到手机，不是一行提示；正文没出本机", async () => {
				tg.userSays(USER, "今天大盘怎么样");
				await until(() => sentTo(tg, USER).some((m) => m.text === "固定的回答：今天大盘平稳"), "全文回复到达 Telegram");
				assert.equal(tg.sent.filter((m) => m.text.includes("CANARY-7f3a")).length, 0);
			});
		},
		telegramStory(tg, [USER], { files, config: { modules: { "private-line": true } } }),
	);
});
