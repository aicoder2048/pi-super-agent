import assert from "node:assert/strict";
import test from "node:test";
import type { DashboardRow, PendingQuestion } from "../src/kernel/types.ts";
import type { TelegramEvent } from "../src/host/telegram/bot-api.ts";
import { answerData, cardView, closedView, decide, fitMessage, mirrorText, NOTES, parseAnswerData, render, repeatsQuestion, type CardView } from "../src/host/telegram/rules.ts";

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
	assert.deepEqual(render({ kind: "line", text: "收到。", silent: false }), { text: "收到。", keyboard: null, silent: false });
	assert.deepEqual(render({ kind: "line", text: "你在网页或终端说：x", silent: true }), { text: "你在网页或终端说：x", keyboard: null, silent: true });
	assert.deepEqual(render({ kind: "note", text: NOTES.help }), { text: NOTES.help, keyboard: null, silent: false });
});

test("欠着说明时，文字消息第一行是那句说明；单独的说明只有这一句；截断时说明还在", () => {
	assert.deepEqual(render({ kind: "line", text: "收到。", silent: false }, true), { text: `${NOTES.missed}\n收到。`, keyboard: null, silent: false });
	assert.deepEqual(render({ kind: "note", text: "" }, true), { text: NOTES.missed, keyboard: null, silent: false });
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

const RPT = "rpt_0b6f1c2e-6a8e-4c2b-9d7e-3f1a2b3c4d5e";
const CAP = "ask_cap_2026-11-11";

function tap(data: string, { from = 42, chat = from, group = false } = {}): TelegramEvent {
	return { kind: "tap", chat: { id: chat, private: !group }, from, messageId: 9, callbackId: "cb1", data };
}

test("名单上的人点按钮：data 是 a:<报告 id>:<序号> 时交给宿主回答", () => {
	assert.deepEqual(decide(tap(`a:${RPT}:2`), ALLOWED), { do: "answer", chatId: 42, messageId: 9, callbackId: "cb1", reportId: RPT, option: 2 });
});

test("点成员上限的按钮（伪造的 data）：不交给宿主，提示只能在网页或终端回答", () => {
	for (const option of [0, 1]) {
		assert.deepEqual(decide(tap(`a:${CAP}:${option}`), ALLOWED), { do: "refuse-tap", callbackId: "cb1", toast: "成员上限只能在网页或终端的「待你处理」里回答" });
	}
});

test("看不懂的按钮 data：提示问题已不在等待回答，不交给宿主", () => {
	for (const data of ["zzz", `a:${RPT}:9`, `a:${RPT}:-1`, `a:${RPT}`, "a:tkt_1:0", `a:${RPT}:1:extra`, ""]) {
		assert.deepEqual(decide(tap(data), ALLOWED), { do: "refuse-tap", callbackId: "cb1", toast: "这个问题已经回答过，或已不在等待回答" }, data);
	}
});

test("不在名单里的人、群里、设置模式下点按钮：丢弃", () => {
	assert.deepEqual(decide(tap(`a:${RPT}:0`, { from: 99 }), ALLOWED), { do: "drop" });
	assert.deepEqual(decide(tap(`a:${RPT}:0`, { chat: -100, group: true }), ALLOWED), { do: "drop" });
	assert.deepEqual(decide(tap(`a:${RPT}:0`), new Set()), { do: "drop" });
});

test("按钮的 data 和解析互为逆运算；最长的报告 id 也不超过 Telegram 的 64 字节，超过时拒绝生成", () => {
	assert.equal(answerData(RPT, 3), `a:${RPT}:3`);
	assert.ok(Buffer.byteLength(answerData(RPT, 3)) <= 64);
	assert.deepEqual(parseAnswerData(answerData(RPT, 1)), { reportId: RPT, option: 1 });
	assert.equal(parseAnswerData(`a:${CAP}:0`), "cap");
	assert.throws(() => answerData(`rpt_${"x".repeat(60)}`, 0), /64/);
});

const question = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({ reportId: RPT, text: "查哪个城市？", options: ["北京", "上海"], askedAt: 1, click: null, spoke: false, ...over });
const row = (q: PendingQuestion | null, over: Partial<DashboardRow> = {}) =>
	({ id: "tkt_1", title: "查天气", stage: "awaiting_answer", question: q, helper: { name: "青檀", role: "conversation", seq: 1 }, ...over }) as unknown as DashboardRow;
const click = (option: number, state: "sent" | "handed_over" | "dropped") => ({ option, state, triggerId: "trg_1" });

test("看板上没有问题的任务没有卡片；有问题的卡片带任务标题、助手全名、问题和选项", () => {
	assert.equal(cardView(row(null)), null);
	const view = cardView(row(question()))!;
	assert.deepEqual({ ...view, status: undefined }, { reportId: RPT, title: "查天气", helper: "青檀 · 对话助手 #1", question: "查哪个城市？", options: ["北京", "上海"], status: undefined });
});

test("卡片状态和网页卡片一致：点过的选项优先，然后是插话，再是幕僚长没有转交", () => {
	const status = (q: PendingQuestion) => cardView(row(q))!.status;
	assert.deepEqual(status(question()), { kind: "open" });
	assert.deepEqual(status(question({ click: click(1, "sent") })), { kind: "sent", label: "上海" });
	assert.deepEqual(status(question({ click: click(0, "handed_over") })), { kind: "answered", label: "北京" });
	assert.deepEqual(status(question({ click: click(0, "dropped") })), { kind: "dropped" });
	assert.deepEqual(status(question({ spoke: true })), { kind: "spoke" });
	assert.deepEqual(status(question({ spoke: true, click: click(0, "dropped") })), { kind: "spoke" });
	assert.deepEqual(status(question({ spoke: true, click: click(1, "sent") })), { kind: "sent", label: "上海" });
});

test("问题离开看板时卡片关闭：记得选过哪一项，别的都写已结束", () => {
	const view = (q: PendingQuestion) => cardView(row(q))!;
	assert.deepEqual(closedView(view(question({ click: click(0, "handed_over") }))).status, { kind: "closed", label: "北京" });
	assert.deepEqual(closedView(view(question({ click: click(1, "sent") }))).status, { kind: "closed", label: "上海" });
	for (const q of [question(), question({ spoke: true }), question({ click: click(0, "dropped") })]) assert.deepEqual(closedView(view(q)).status, { kind: "closed", label: null });
});

const card = (status: CardView["status"], options = ["北京", "上海"]): CardView => ({ reportId: RPT, title: "查天气", helper: "青檀 · 对话助手 #1", question: "查哪个城市？", options, status });
const HEAD = "青檀 · 对话助手 #1 问你（任务「查天气」）：\n查哪个城市？";

test("卡片的文字和按钮：可以点时每个选项一行按钮；点过、插话、结束后按钮消失，最后一行说明状态", () => {
	const buttons = [[{ label: "北京", data: `a:${RPT}:0` }], [{ label: "上海", data: `a:${RPT}:1` }]];
	assert.deepEqual(render({ kind: "card", view: card({ kind: "open" }) }), { text: HEAD, keyboard: buttons, silent: false });
	assert.deepEqual(render({ kind: "card", view: card({ kind: "dropped" }) }), { text: `${HEAD}\n\n幕僚长没有转交这次选择，请重选或直接回复`, keyboard: buttons, silent: false });
	const locked: [CardView["status"], string][] = [
		[{ kind: "sent", label: "上海" }, "已选「上海」，已发送，等待幕僚长转交"],
		[{ kind: "answered", label: "上海" }, "已选「上海」，已回答"],
		[{ kind: "spoke" }, "已插话：你刚发了一句话，等幕僚长处理完再点"],
		[{ kind: "closed", label: "上海" }, "已结束：你选了「上海」"],
		[{ kind: "closed", label: null }, "已结束：这个问题已经回答过，或已不在等待回答"],
	];
	for (const [status, line] of locked) assert.deepEqual(render({ kind: "card", view: card(status) }), { text: `${HEAD}\n\n${line}`, keyboard: null, silent: false }, line);
});

test("没有选项的问题：没有按钮，写「直接打字回答。」；插话后写已插话", () => {
	assert.deepEqual(render({ kind: "card", view: card({ kind: "open" }, []) }), { text: `${HEAD}\n\n直接打字回答。`, keyboard: null, silent: false });
	assert.deepEqual(render({ kind: "card", view: card({ kind: "spoke" }, []) }).text, `${HEAD}\n\n已插话：你刚发了一句话，等幕僚长处理`);
});

test("没有助手名的旧任务：卡片开头写「助手问你」；很长的任务标题截到 40 个字", () => {
	const view = cardView(row(question(), { helper: null, title: "长".repeat(50) }))!;
	assert.equal(view.helper, "");
	assert.ok(render({ kind: "card", view }).text.startsWith(`助手问你（任务「${"长".repeat(40)}…」）：`));
});

test("成员上限只发一条说明，指向网页和终端的「待你处理」；/start 的说明提到按钮", () => {
	assert.equal(NOTES.cap, "成员上限：现在有成员在排队，宿主在问要不要今天放宽上限。这个问题只能在网页或终端的「待你处理」里回答。");
	assert.deepEqual(render({ kind: "note", text: NOTES.cap }), { text: NOTES.cap, keyboard: null, silent: false });
	assert.match(NOTES.help, /点按钮就是回答/);
	assert.match(NOTES.help, /成员上限只能在网页或终端回答/);
});

test("幕僚长转述助手的问题：原话、只差标点、带一小段开场白都算重复；别的话、已回答的、没有问题的都不算", () => {
	const asked = question({ text: "你在哪个城市或地区？", askedAt: 100 });
	const relay = (text: string, at = 200) => ({ text, at });
	for (const text of ["你在哪个城市或地区？", "  你在哪个城市或地区  ", "你在哪个城市或地区。", "你在哪个城市或地区?", "请问：你在哪个城市或地区？", "助手想知道，你在哪个城市或地区？"]) {
		assert.equal(repeatsQuestion(relay(text), asked), true, text);
	}
	assert.equal(repeatsQuestion(relay("你在哪个城市或地区？告诉我之后助手会按当地的天气预报给你查明天的情况。"), asked), false, "问题之外还说了不少");
	assert.equal(repeatsQuestion(relay("助手查天气前要先知道城市。"), asked), false, "说的是别的");
	assert.equal(repeatsQuestion(relay("你在哪个城市或地区？", 50), asked), false, "问题之前的回复");
	assert.equal(repeatsQuestion(relay("你在哪个城市或地区？"), question({ text: "你在哪个城市或地区？", askedAt: 100, click: click(0, "handed_over") })), false, "问题已回答");
	assert.equal(repeatsQuestion(relay("你在哪个城市或地区？"), null), false, "没有问题");
	assert.equal(repeatsQuestion(relay("？"), question({ text: "？", askedAt: 100 })), false, "只有标点的问题不拿来比");
});
