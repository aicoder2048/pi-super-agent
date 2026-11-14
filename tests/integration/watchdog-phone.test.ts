import assert from "node:assert/strict";
import test from "node:test";
import { BotApi, BotToken } from "../../src/host/telegram/bot-api.ts";
import { Phone } from "../../src/watchdog/phone.ts";
import { FAKE_BOT_TOKEN, FakeTelegram } from "../helpers/fake-telegram.ts";
import { until } from "../helpers/fakes.ts";

const USER = 42;

async function phone(t: { after(fn: () => Promise<void>): void }, retryMs = 50) {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const logs: string[] = [];
	const p = new Phone({ api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), chats: [USER], log: (line) => logs.push(line), retryMs });
	return { tg, p, logs, phoneSaw: () => tg.sent.filter((m) => m.chatId === USER).map((m) => ({ text: m.text, silent: m.silent })) };
}

test("看门狗直接发到名单里的聊天：只用 sendMessage，开头是通知的 🔔，⚠️ 响铃、✅ 不响铃", async (t) => {
	const { tg, p, phoneSaw } = await phone(t);
	p.tell("⚠️ 宿主停了", false);
	p.tell("✅ 宿主恢复了", true);
	await until(() => phoneSaw().length === 2, "两条都到了手机");
	assert.deepEqual(phoneSaw(), [{ text: "🔔 ⚠️ 宿主停了", silent: false }, { text: "🔔 ✅ 宿主恢复了", silent: true }]);
	assert.deepEqual(new Set(tg.requests.map((r) => r.method)), new Set(["sendMessage"]));
});

test("Telegram 连不上：tell 立刻返回，过一会儿重试，按顺序送到，日志里没有 token", async (t) => {
	const { tg, p, logs, phoneSaw } = await phone(t);
	tg.fail("sendMessage", 502);
	const started = Date.now();
	p.tell("⚠️ 宿主停了", false);
	p.tell("✅ 宿主恢复了", true);
	assert.ok(Date.now() - started < 20, "tell 不等网络");
	await until(() => tg.calls("sendMessage").length >= 3, "失败后重试了", 3000);
	assert.deepEqual(phoneSaw(), []);
	tg.heal("sendMessage");
	await until(() => phoneSaw().length === 2, "恢复后两条都到了", 3000);
	assert.deepEqual(phoneSaw().map((m) => m.text), ["🔔 ⚠️ 宿主停了", "🔔 ✅ 宿主恢复了"]);
	assert.ok(logs.some((l) => /重试|再试/.test(l)), logs.join("\n"));
	assert.ok(!logs.join("\n").includes(FAKE_BOT_TOKEN.split(":")[1]), "日志里不能有 token");
});

test("Telegram 拒绝这个聊天（403，比如使用者没跟 bot 说过话）：记一行日志就放弃，不挡住后面的消息", async (t) => {
	const { tg, p, logs, phoneSaw } = await phone(t);
	tg.fail("sendMessage", 403, {}, 1);
	p.tell("⚠️ 宿主停了", false);
	p.tell("✅ 宿主恢复了", true);
	await until(() => phoneSaw().length === 1, "第二条到了");
	assert.deepEqual(phoneSaw().map((m) => m.text), ["🔔 ✅ 宿主恢复了"]);
	assert.equal(tg.calls("sendMessage").length, 2);
	assert.ok(logs.some((l) => /forbidden/.test(l)), logs.join("\n"));
});
