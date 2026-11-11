import assert from "node:assert/strict";
import test from "node:test";
import type { TelegramEvent } from "../src/host/telegram/bot-api.ts";
import { decide, fitMessage, mirrorText, NOTES, render } from "../src/host/telegram/rules.ts";

const ALLOWED = new Set([42]);

function message(text: string | { forwarded: true } | { viaBot: true } | { photo: true }, { from = 42, chat = from, group = false } = {}): TelegramEvent {
	const content = typeof text === "string" ? { kind: "text" as const, text } : "forwarded" in text ? { kind: "forwarded" as const } : "viaBot" in text ? { kind: "via-bot" as const } : { kind: "other" as const };
	return { kind: "message", chat: { id: chat, private: !group }, from, messageId: 7, content, replyTo: null };
}

test("名单上的人私聊打的字交给幕僚长，原样不改", () => {
	assert.deepEqual(decide(message("查一下 NVDA"), ALLOWED), { do: "say", chatId: 42, messageId: 7, text: "查一下 NVDA" });
});

test("不在名单里的人、群里的话、发信人不是聊天本人的私聊：丢弃", () => {
	assert.deepEqual(decide(message("你好", { from: 99 }), ALLOWED), { do: "drop" });
	assert.deepEqual(decide(message("你好", { chat: -100, group: true }), ALLOWED), { do: "drop" });
	assert.deepEqual(decide(message("你好", { from: 42, chat: 43 }), ALLOWED), { do: "drop" });
	assert.deepEqual(decide(message({ photo: true }, { from: 99 }), ALLOWED), { do: "drop" });
});

test("名单为空是设置模式：私聊打字的人只得知自己的 id；群里的话和非文字丢弃", () => {
	const none = new Set<number>();
	assert.deepEqual(decide(message("你好", { from: 99 }), none), { do: "tell-id", chatId: 99 });
	assert.deepEqual(decide(message("/start", { from: 99 }), none), { do: "tell-id", chatId: 99 });
	assert.deepEqual(decide(message("你好", { chat: -100, group: true }), none), { do: "drop" });
	assert.deepEqual(decide(message({ photo: true }, { from: 99 }), none), { do: "drop" });
});

test("/start、/help（带不带 @机器人名和参数）回说明；别的 / 开头的字当作普通的话", () => {
	for (const text of ["/start", "/start@psa_test_bot", "/start payload", "/help", "/help@psa_test_bot extra"]) {
		assert.deepEqual(decide(message(text), ALLOWED), { do: "note", chatId: 42, note: "help" }, text);
	}
	for (const text of ["/foo bar", "/started", "/helpme"]) assert.deepEqual(decide(message(text), ALLOWED), { do: "say", chatId: 42, messageId: 7, text }, text);
});

test("转发的消息和非文字消息回一句说明，不交给幕僚长；只有零宽字符的话不处理", () => {
	assert.deepEqual(decide(message({ forwarded: true }), ALLOWED), { do: "note", chatId: 42, note: "no-forwards" });
	assert.deepEqual(decide(message({ photo: true }), ALLOWED), { do: "note", chatId: 42, note: "text-only" });
	assert.deepEqual(decide(message("​ ⁠"), ALLOWED), { do: "ignore" });
});

test("经别的机器人（inline bot）发出的消息和转发同理：不算使用者的话，回一句说明", () => {
	assert.deepEqual(decide(message({ viaBot: true }), ALLOWED), { do: "note", chatId: 42, note: "no-via-bot" });
	assert.deepEqual(decide(message({ viaBot: true }, { from: 99 }), ALLOWED), { do: "drop" });
});

test("Telegram 发来的看不懂的更新不处理", () => {
	assert.deepEqual(decide(null, ALLOWED), { do: "ignore" });
});

test("说明的文字：设置模式写出对方的 id；其余是固定句子，称幕僚长和你", () => {
	assert.equal(NOTES.setup(987654321), "你的 Telegram 数字 id 是 987654321。把这个数字写进宿主状态目录里 config.json 的 telegram.allowedUserIds，重启宿主后就能在这里和幕僚长对话。");
	assert.match(NOTES.help, /^这里是白宫。/);
	for (const text of [NOTES.help, NOTES["text-only"], NOTES["no-forwards"], NOTES["no-via-bot"], NOTES.missed]) assert.ok(!/它|我/.test(text), text);
});

test("网页和终端说的话转到 Telegram 时加前缀；另一个 Telegram 账号说的话也说清来处", () => {
	assert.equal(mirrorText("查天气"), "你在网页或终端说：查天气");
	assert.equal(mirrorText("查天气", { client: "telegram", chatId: 7 }), "你在另一个 Telegram 账号说：查天气");
});

test("回复带通知，转过来的话静默，说明带通知；都是纯文本", () => {
	assert.deepEqual(render({ kind: "line", text: "收到。", silent: false }), { text: "收到。", silent: false });
	assert.deepEqual(render({ kind: "line", text: "你在网页或终端说：x", silent: true }), { text: "你在网页或终端说：x", silent: true });
	assert.deepEqual(render({ kind: "note", text: NOTES.help }), { text: NOTES.help, silent: false });
});

test("欠着说明时，文字消息第一行是那句说明；单独的说明只有这一句；截断时说明还在", () => {
	assert.deepEqual(render({ kind: "line", text: "收到。", silent: false }, true), { text: `${NOTES.missed}\n收到。`, silent: false });
	assert.deepEqual(render({ kind: "note", text: "" }, true), { text: NOTES.missed, silent: false });
	assert.ok(render({ kind: "line", text: "x".repeat(5000), silent: false }, true).text.startsWith(`${NOTES.missed}\nxxx`));
});

test("超过 4000 个 UTF-16 单位的文字截断并提示去网页看全文；不拆开代理对；短的不动", () => {
	assert.equal(fitMessage("短"), "短");
	const exact = "x".repeat(4000);
	assert.equal(fitMessage(exact), exact);
	const long = fitMessage("x".repeat(5000));
	assert.equal(long.length, 4000);
	assert.ok(long.endsWith("…（全文见网页）"));
	const emoji = fitMessage("x".repeat(3992) + "😀".repeat(100));
	assert.ok(emoji.length <= 4000);
	assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji), "没有落单的高位代理");
	assert.equal(render({ kind: "line", text: "y".repeat(5000), silent: false }).text.length, 4000);
});
