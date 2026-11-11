import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { NOTES } from "../../src/host/telegram/rules.ts";
import { FAKE_BOT_TOKEN, FakeTelegram } from "../helpers/fake-telegram.ts";
import { on, reply } from "./fake-model.ts";
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

function telegramStory(tg: FakeTelegram, allowedUserIds: number[]): StoryOptions {
	return {
		imports: ["./tests/e2e/telegram-preload.mjs"],
		env: { PSA_E2E_TELEGRAM_URL: tg.url },
		files: { "secrets.env": `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n` },
		config: { secretsFile: "secrets.env", telegram: { allowedUserIds } },
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
