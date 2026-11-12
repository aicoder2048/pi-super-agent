import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HostConnection } from "../src/client/connection.ts";
import type { HostToClient, WatchedSource } from "../src/client/protocol.ts";
import type { Host } from "../src/host/host.ts";
import { BotApi, BotToken, type Http } from "../src/host/telegram/bot-api.ts";
import { randomUUID } from "node:crypto";
import type { MemberCapBoard } from "../src/client/protocol.ts";
import type { AnswerResult, Broadcast, ImChat } from "../src/host/server.ts";
import { TelegramClient, type TelegramHost, type TelegramTiming } from "../src/host/telegram/client.ts";
import { NOTES } from "../src/host/telegram/rules.ts";
import { openStore } from "../src/kernel/store.ts";
import type { DashboardRow, PendingQuestion } from "../src/kernel/types.ts";
import { FAKE_BOT_TOKEN, FakeTelegram } from "./helpers/fake-telegram.ts";
import { Kernel } from "../src/kernel/kernel.ts";
import type { FeedSpec } from "../src/sources/feeds.ts";
import { fakeFeed, ids, ofType, openOnConversation, startHost, tempStateDir, until, within, type Brain, type WorkerScript } from "./helpers/fakes.ts";

const USER = 42;
const FAST: Partial<TelegramTiming> = { pollTimeoutSec: 2, minGapMs: 20, backoffMs: [100, 200], conflictBackoffMs: 200, stopGraceMs: 500 };
const SECRET = FAKE_BOT_TOKEN.split(":")[1];

const echo: Brain = (cards) =>
	cards.flatMap((card) => (card.startsWith("[对话]") ? [{ name: "reply", args: { text: `收到：${card.split("使用者：")[1]?.split("\n")[0]}`, cause: ids(card, "trg") } }] : []));

interface Setup {
	allowed?: number[];
	stateDir?: string;
	timing?: Partial<TelegramTiming>;
	fake?: FakeTelegram;
	brain?: Brain;
	script?: WorkerScript;
	http?: Http;
	feeds?: FeedSpec[];
	watching?: WatchedSource[];
}

/** Fails sendMessage the way a refused connection does, so the request surely did not reach Telegram, while `down` is on. */
function unreachable() {
	const link = { down: false, refusals: 0 };
	const http: Http = async (url, init) => {
		if (link.down && url.endsWith("/sendMessage")) {
			link.refusals++;
			throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
		}
		return fetch(url, init);
	};
	return { link, http };
}

async function telegramHost(t: TestContext, { allowed = [USER], stateDir = tempStateDir(), timing = FAST, fake, brain = echo, script = () => {}, http, feeds, watching }: Setup = {}) {
	const tg = fake ?? (await FakeTelegram.start());
	const logs: string[] = [];
	const { host } = await startHost(brain, script, {
		stateDir,
		feeds,
		watching,
		log: (line) => logs.push(line),
		telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url, ...(http && { http }) }), allowedUserIds: new Set(allowed), timing },
	});
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await host.stop();
	};
	t.after(async () => {
		const snapshot = JSON.stringify(host.snapshot());
		await stop();
		if (!fake) await tg.close();
		assert.ok(!logs.some((l) => l.includes(SECRET)), "日志里没有 token");
		assert.ok(!snapshot.includes(SECRET), "给客户端的快照里没有 token");
		assert.equal(tg.wrongToken, 0, "每个请求都带对的 token");
	});
	return { host, tg, logs, stateDir, stop };
}

function watch(t: TestContext, host: Host) {
	const got: HostToClient[] = [];
	const conn = new HostConnection({ socketPath: host.socketPath, onMessage: (m) => got.push(m), retryMs: 30 });
	conn.open();
	t.after(() => conn.close());
	return { got, connected: () => until(() => ofType(got, "snapshot").length === 1, "宿主收下了客户端") };
}

const userLines = (host: Host) => host.kernel.conversation().filter((l) => l.who === "user").map((l) => l.text);
const sentTo = (tg: FakeTelegram, chatId: number) => tg.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
const db = (stateDir: string): DatabaseSync => openStore(join(stateDir, "state.db"));

test("名单上的人私聊说一句：对话里出现这句话；幕僚长的回复带通知发回这个聊天，网页和终端各收到一次", async (t) => {
	const { host, tg } = await telegramHost(t);
	const client = watch(t, host);
	await client.connected();
	tg.userSays(USER, "查一下 NVDA");
	await until(() => sentTo(tg, USER).includes("收到：查一下 NVDA"), "回复到达 Telegram");
	await host.settled();
	assert.deepEqual(userLines(host), ["查一下 NVDA"]);
	assert.deepEqual(ofType(client.got, "user").map((m) => m.text), ["查一下 NVDA"]);
	assert.deepEqual(ofType(client.got, "reply").map((m) => m.text), ["收到：查一下 NVDA"]);
	assert.deepEqual(tg.sent.map((m) => [m.chatId, m.text, m.silent]), [[USER, "收到：查一下 NVDA", false]], "自己在 Telegram 说的话不再发回给自己");
});

test("陌生人和群里的话：不进对话、不回复、不进 Telegram 的表；日志只记条数，不记 id 和内容，一小时最多一行", async (t) => {
	const { host, tg, logs, stateDir } = await telegramHost(t);
	tg.userSays(99, "我是陌生人 secret-words");
	tg.userSays(USER, "群里的话 secret-words", { chatId: -100777, group: true });
	tg.userSays(98, "又一个陌生人 secret-words");
	tg.userSays(USER, "名单上的人说一句");
	await until(() => tg.sent.length === 1, "名单上的人收到回复");
	await host.settled();
	assert.deepEqual(userLines(host), ["名单上的人说一句"]);
	assert.deepEqual(tg.sent.map((m) => m.chatId), [USER]);
	const dropped = logs.filter((l) => l.includes("丢弃"));
	assert.equal(dropped.length, 1, dropped.join("\n"));
	assert.match(dropped[0], /^\[telegram\] 丢弃了 1 条不在名单里的人或群里的消息/);
	for (const line of logs) assert.ok(!/99|98|100777|secret-words/.test(line), line);
	const chats = db(stateDir).prepare("SELECT DISTINCT chat_id FROM telegram_messages UNION SELECT chat_id FROM telegram_chats").all() as { chat_id: number }[];
	assert.deepEqual(chats.map((c) => c.chat_id), [USER]);
});

test("设置模式（名单为空）：私聊的人只收到自己的 id，每个聊天一次；什么都不进对话", async (t) => {
	const { host, tg, logs } = await telegramHost(t, { allowed: [] });
	tg.userSays(555001, "你好");
	tg.userSays(555001, "再问一次");
	tg.userSays(555002, "/start");
	tg.userSays(555003, "群里", { chatId: -100, group: true });
	await until(() => tg.sent.length === 2, "两个人各收到自己的 id");
	await new Promise((r) => setTimeout(r, 200));
	assert.deepEqual(tg.sent.map((m) => [m.chatId, m.text]), [
		[555001, NOTES.setup(555001)],
		[555002, NOTES.setup(555002)],
	]);
	assert.deepEqual(userLines(host), []);
	assert.ok(logs.includes("[telegram] 名单为空：只告诉来信的人他自己的数字 id，不把任何消息交给幕僚长"));
});

test("同一个 update 投两次：对话里只有一行，幕僚长只回一次", async (t) => {
	const { host, tg } = await telegramHost(t);
	const id = tg.userSays(USER, "只说一次");
	await until(() => sentTo(tg, USER).length === 1, "第一次的回复");
	tg.redeliver(id);
	await until(() => tg.calls("getUpdates").length >= 3, "重投的 update 被取走");
	await host.settled();
	await new Promise((r) => setTimeout(r, 100));
	assert.deepEqual(userLines(host), ["只说一次"]);
	assert.deepEqual(sentTo(tg, USER), ["收到：只说一次"]);
});

test("/start、/help 回说明；转发的和图片回一句说明；都不进对话", async (t) => {
	const { host, tg } = await telegramHost(t);
	tg.userSays(USER, "/start");
	tg.userSays(USER, "转发的", { forwarded: true });
	tg.userSays(USER, "", { photo: true });
	await until(() => tg.sent.length === 3, "三条说明");
	assert.deepEqual(sentTo(tg, USER), [NOTES.help, NOTES["no-forwards"], NOTES["text-only"]]);
	assert.deepEqual(userLines(host), []);
});

test("经别的机器人（inline bot）发的消息回一句说明，不进对话", async (t) => {
	const { host, tg } = await telegramHost(t);
	tg.userSays(USER, "gif 机器人的结果", { viaBot: true });
	await until(() => tg.sent.length === 1, "说明");
	await host.settled();
	await new Promise((r) => setTimeout(r, 200));
	assert.deepEqual(sentTo(tg, USER), [NOTES["no-via-bot"]]);
	assert.deepEqual(userLines(host), []);
});

test("网页或终端说的话静默转到 Telegram，带前缀；之后幕僚长的回复带通知", async (t) => {
	const { host, tg } = await telegramHost(t);
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length === 1, "说明");
	host.say("网页上说的");
	await until(() => tg.sent.length === 3, "转过来的话和回复");
	assert.deepEqual(tg.sent.slice(1).map((m) => [m.text, m.silent]), [
		["你在网页或终端说：网页上说的", true],
		["收到：网页上说的", false],
	]);
});

test("连不上 Telegram 时网页照常只收一次回复，回复动作不重试；恢复后按顺序补发，每条一次", async (t) => {
	const { link, http } = unreachable();
	const { host, tg } = await telegramHost(t, { http });
	const client = watch(t, host);
	await client.connected();
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length === 1, "说明");
	link.down = true;
	host.say("第一句");
	host.say("第二句");
	await until(() => ofType(client.got, "reply").length === 2, "网页收到两条回复");
	await until(() => link.refusals >= 2, "连了几次没连上");
	assert.equal(host.kernel.dueActions(10).length, 0, "回复动作已完成，不重试");
	link.down = false;
	await until(() => tg.sent.length === 5, "恢复后补发", 5000);
	await new Promise((r) => setTimeout(r, 300));
	assert.deepEqual(sentTo(tg, USER).slice(1), ["你在网页或终端说：第一句", "你在网页或终端说：第二句", "收到：第一句", "收到：第二句"]);
	assert.equal(ofType(client.got, "reply").length, 2);
});

test("429 带 retry_after：发送暂停到时间再继续，不丢消息", async (t) => {
	const { host, tg } = await telegramHost(t);
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length === 1, "说明");
	tg.fail("sendMessage", 429, { parameters: { retry_after: 1 } }, 1);
	host.say("限流时说的");
	await until(() => tg.sent.length === 3, "暂停后发出", 5000);
	const limited = tg.calls("sendMessage").find((r) => r.status === 429)!;
	const next = tg.calls("sendMessage").find((r) => r.at > limited.at)!;
	assert.ok(next.at - limited.at >= 950, `暂停了 ${next.at - limited.at} ms`);
	assert.deepEqual(sentTo(tg, USER).slice(1), ["你在网页或终端说：限流时说的", "收到：限流时说的"]);
});

test("getMe 回 401：日志一行说 Telegram 已停用，不再取消息；宿主照常对话", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	tg.fail("getMe", 401);
	const { host, logs } = await telegramHost(t, { fake: tg });
	await until(() => logs.some((l) => l.includes("已停用")), "停用的日志");
	assert.deepEqual(logs.filter((l) => l.includes("已停用")), ["[telegram] Telegram 拒绝了 bot token（401），Telegram 客户端已停用；改好 TELEGRAM_BOT_TOKEN 后重启宿主"]);
	host.say("网页照常");
	await host.settled();
	assert.ok(host.kernel.conversation().some((l) => l.who === "router" && l.text === "收到：网页照常"));
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(tg.calls("getUpdates").length, 0);
});

test("宿主停止时立刻中止长轮询", async (t) => {
	const { tg, stop } = await telegramHost(t, { timing: { ...FAST, pollTimeoutSec: 50 } });
	await until(() => tg.calls("getMe").length === 1, "开始取消息");
	await new Promise((r) => setTimeout(r, 100));
	await within(stop(), 1000, "宿主停止");
});

test("宿主停着时发的话，重启后进对话一次；停机前没发出去的回复，重启后补发一次", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const stateDir = tempStateDir();
	const { link, http } = unreachable();
	const first = await telegramHost(t, { fake: tg, stateDir, http });
	first.tg.userSays(USER, "停机前");
	await until(() => sentTo(tg, USER).length === 1, "停机前的回复");
	link.down = true;
	first.host.say("回复发不出去");
	await until(() => first.host.kernel.conversation().some((l) => l.text === "收到：回复发不出去"), "幕僚长回复了");
	await first.stop();
	tg.userSays(USER, "停机时说的");
	const second = await telegramHost(t, { fake: tg, stateDir });
	await until(() => sentTo(tg, USER).includes("收到：停机时说的"), "重启后的回复", 5000);
	await second.host.settled();
	await new Promise((r) => setTimeout(r, 300));
	assert.deepEqual(userLines(second.host), ["停机前", "回复发不出去", "停机时说的"]);
	for (const text of ["收到：停机前", "你在网页或终端说：回复发不出去", "收到：回复发不出去", "收到：停机时说的"]) {
		assert.equal(sentTo(tg, USER).filter((m) => m === text).length, 1, text);
	}
});

test("宿主停止过程中广播的话也记进发件箱，下次启动后补发到 Telegram", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const stateDir = tempStateDir();
	const first = await telegramHost(t, { fake: tg, stateDir });
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length === 1, "说明");
	await first.stop();
	first.host.say("停止过程中说的");
	await telegramHost(t, { fake: tg, stateDir, brain: () => [] });
	await until(() => sentTo(tg, USER).includes("你在网页或终端说：停止过程中说的"), "下次启动后补发");
});

const OTHER = 43;
const CAP = "ask_cap_2026-11-11";
const rpt = () => `rpt_${randomUUID()}`;
const pending = (reportId: string, over: Partial<PendingQuestion> = {}): PendingQuestion => ({ reportId, text: "查哪个城市？", options: ["北京", "上海"], askedAt: 1, click: null, spoke: false, ...over });
const ticket = (q: PendingQuestion | null, title = "查天气") =>
	({ id: `tkt_${q?.reportId ?? "none"}`, title, stage: "awaiting_answer", question: q, helper: { name: "青檀", role: "conversation", seq: 1 } }) as unknown as DashboardRow;
const capBoard = (): MemberCapBoard => ({ limit: 4, question: { reportId: CAP, text: "现在有 2 位成员在排队，同时运行的成员上限是 4。今天放宽到 10 吗？", options: ["今天放宽到 10", "保持 4"], askedAt: 1 } });
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/** A TelegramClient against the fake Bot API and a stand-in host whose board the test sets frame by frame. */
async function cardClient(t: TestContext, { allowed = [USER], answer = (): AnswerResult => ({ ok: true, triggerId: "trg_1" }) }: { allowed?: number[]; answer?: () => AnswerResult } = {}) {
	const tg = await FakeTelegram.start();
	const stateDir = tempStateDir();
	const state = { rows: [] as DashboardRow[], memberCap: null as MemberCapBoard };
	const answered: [string, number, ImChat][] = [];
	const logs: string[] = [];
	const host: TelegramHost = {
		say: () => `trg_${randomUUID()}`,
		sayQuoting: () => null,
		answer: (reportId, option, { from }) => {
			answered.push([reportId, option, from]);
			return answer();
		},
		board: () => state,
	};
	const store = openStore(join(stateDir, "state.db"));
	const client = new TelegramClient({ api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set(allowed), timing: FAST, host, db: store, clock: { now: () => Date.now() }, log: (l) => logs.push(l) });
	client.start();
	t.after(async () => {
		await client.stop();
		await tg.close();
		store.close();
	});
	const frame = (rows: DashboardRow[], memberCap: MemberCapBoard = null) => {
		state.rows = rows;
		state.memberCap = memberCap;
		client.broadcast({ type: "board", rows, memberCap } as unknown as Broadcast);
	};
	const open = async (chatId: number) => {
		const before = sentTo(tg, chatId).length;
		tg.userSays(chatId, "/start");
		await until(() => sentTo(tg, chatId).length > before, "聊天打开");
	};
	return { tg, frame, open, answered, logs, state, host, client };
}

const cards = (tg: FakeTelegram, chatId: number) => tg.sent.filter((m) => m.chatId === chatId && m.text.includes("问你（任务"));
const labels = (m: { buttons: { text: string }[][] | null } | undefined) => m?.buttons?.map((row) => row.map((b) => b.text)) ?? null;

test("助手的问题在每个聊天里只发一张带按钮的卡片；十个一样的看板帧不发也不编辑；状态变一次只编辑一次", async (t) => {
	const { tg, frame, open } = await cardClient(t, { allowed: [USER, OTHER] });
	await open(USER);
	await open(OTHER);
	const id = rpt();
	for (let i = 0; i < 10; i++) frame([ticket(pending(id))]);
	await until(() => cards(tg, USER).length === 1 && cards(tg, OTHER).length === 1, "两个聊天各一张卡片");
	await settle();
	for (const chat of [USER, OTHER]) {
		const [card] = cards(tg, chat);
		assert.equal(card.text, "青檀 · 对话助手 #1 问你（任务「查天气」）：\n查哪个城市？");
		assert.deepEqual(labels(card), [["北京"], ["上海"]]);
		assert.equal(card.silent, false, "新问题带通知");
	}
	assert.equal(tg.edits.length, 0);
	for (let i = 0; i < 10; i++) frame([ticket(pending(id, { click: { option: 1, state: "sent", triggerId: "trg_1" } }))]);
	await until(() => tg.edits.length === 2, "两个聊天各编辑一次");
	await settle();
	assert.equal(tg.edits.length, 2);
	for (const chat of [USER, OTHER]) {
		const shown = tg.shown(cards(tg, chat)[0].messageId)!;
		assert.match(shown.text, /\n\n已选「上海」，已发送，等待幕僚长转交$/);
		assert.equal(shown.buttons, null, "按钮消失");
	}
	assert.equal(cards(tg, USER).length + cards(tg, OTHER).length, 2, "没有再发新卡片");
});

test("问题离开看板：卡片编辑成已结束，按钮消失；之后的看板帧不再动它", async (t) => {
	const { tg, frame, open } = await cardClient(t);
	await open(USER);
	const id = rpt();
	frame([ticket(pending(id))]);
	await until(() => cards(tg, USER).length === 1, "卡片");
	frame([]);
	await until(() => tg.edits.length === 1, "关闭");
	const shown = tg.shown(cards(tg, USER)[0].messageId)!;
	assert.match(shown.text, /\n\n已结束：这个问题已经回答过，或已不在等待回答$/);
	assert.equal(shown.buttons, null);
	frame([]);
	frame([ticket(null)]);
	await settle();
	assert.equal(tg.edits.length, 1);
});

test("没有选项的问题：卡片没有按钮，写「直接打字回答。」", async (t) => {
	const { tg, frame, open } = await cardClient(t);
	await open(USER);
	frame([ticket(pending(rpt(), { options: [] }))]);
	await until(() => cards(tg, USER).length === 1, "卡片");
	assert.match(cards(tg, USER)[0].text, /\n\n直接打字回答。$/);
	assert.equal(cards(tg, USER)[0].buttons, null);
});

test("聊天打开之前就在等回答的问题：打开时补发卡片", async (t) => {
	const { tg, frame, open } = await cardClient(t);
	frame([ticket(pending(rpt()))]);
	await settle(100);
	assert.equal(tg.sent.length, 0, "还没有打开的聊天");
	await open(USER);
	await until(() => cards(tg, USER).length === 1, "打开后补发");
});

test("点按钮：交给宿主回答，带上是哪个 Telegram 聊天；成功提示已发送，被拒提示原因", async (t) => {
	let result: AnswerResult = { ok: true, triggerId: "trg_1" };
	const { tg, frame, open, answered } = await cardClient(t, { answer: () => result });
	await open(USER);
	const id = rpt();
	frame([ticket(pending(id))]);
	await until(() => cards(tg, USER).length === 1, "卡片");
	const { messageId, buttons } = cards(tg, USER)[0];
	const first = tg.userTaps(USER, messageId, buttons![1][0].data);
	await until(() => tg.toastFor(first) !== undefined, "第一次点的回应");
	assert.equal(tg.toastFor(first), "已发送");
	result = { ok: false, refusal: { kind: "chosen", option: 0, label: "北京" } };
	const second = tg.userTaps(USER, messageId, buttons![1][0].data);
	await until(() => tg.toastFor(second) !== undefined, "第二次点的回应");
	assert.equal(tg.toastFor(second), "已选「北京」");
	assert.deepEqual(answered, [
		[id, 1, { client: "telegram", chatId: USER }],
		[id, 1, { client: "telegram", chatId: USER }],
	]);
});

test("成员上限：只发一条说明，没有按钮，看板帧再来也不重发；伪造的成员上限按钮被拒，不问宿主", async (t) => {
	const { tg, frame, open, answered } = await cardClient(t);
	await open(USER);
	for (let i = 0; i < 10; i++) frame([], capBoard());
	await until(() => sentTo(tg, USER).includes(NOTES.cap), "成员上限的说明");
	await settle();
	const notes = tg.sent.filter((m) => m.text === NOTES.cap);
	assert.equal(notes.length, 1);
	assert.equal(notes[0].buttons, null);
	const forged = tg.userTaps(USER, notes[0].messageId, `a:${CAP}:0`);
	await until(() => tg.toastFor(forged) !== undefined, "伪造按钮的回应");
	assert.equal(tg.toastFor(forged), "成员上限只能在网页或终端的「待你处理」里回答");
	assert.deepEqual(answered, []);
});

test("看不懂的按钮、不在名单里的人点按钮：都不问宿主；名单上的人收到提示，陌生人什么都收不到", async (t) => {
	const { tg, open, answered } = await cardClient(t);
	await open(USER);
	const junk = tg.userTaps(USER, 1, "zzz");
	const stranger = tg.userTaps(99, 1, `a:${rpt()}:0`);
	await until(() => tg.toastFor(junk) !== undefined, "看不懂的按钮的回应");
	await settle();
	assert.equal(tg.toastFor(junk), "这个问题已经回答过，或已不在等待回答");
	assert.equal(tg.toastFor(stranger), undefined);
	assert.deepEqual(answered, []);
});

const CITY = "上海";
const askBrain = (typedDelayMs = 0): Brain => (cards) =>
	Promise.all(
		cards.map(async (card) => {
			const clicked = card.split("\n").find((l) => l.startsWith("点选回答："));
			if (card.startsWith("[对话]") && clicked) return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: ids(card, "trg"), ticketId: ids(clicked, "tkt") }] } }];
			if (card.startsWith("[对话]") && card.includes("使用者：查天气")) return openOnConversation(card);
			if (card.startsWith("[对话]")) {
				await new Promise((r) => setTimeout(r, typedDelayMs));
				return [{ name: "reply", args: { text: "收到你打的字。", cause: ids(card, "trg") } }];
			}
			if (card.startsWith("[Worker 提问]")) return [{ name: "reply", args: { text: "查哪个城市？", cause: ids(card, "tkt") } }];
			return [];
		}),
	).then((calls) => calls.flat());
const asking: WorkerScript = (w, input) => {
	if (input.includes("回答任务")) return;
	w.report({ status: "blocked", summary: "要你定", question: "查哪个城市？", options: ["北京", CITY] });
	w.settle();
};

async function askedOnTelegram(t: TestContext, setup: Setup = {}) {
	const started = await telegramHost(t, { brain: askBrain(), script: asking, ...setup });
	started.tg.userSays(USER, "/start");
	await until(() => sentTo(started.tg, USER).length === 1, "说明");
	started.host.say("查天气");
	await until(() => cards(started.tg, USER).length === 1, "卡片到达 Telegram");
	return { ...started, card: cards(started.tg, USER)[0] };
}

test("真宿主：在 Telegram 点按钮，回答像网页点选一样进对话；卡片变成已回答，按钮消失；同一个按钮再点只答一次、弹出提示", async (t) => {
	const { host, tg, card } = await askedOnTelegram(t);
	const client = watch(t, host);
	await client.connected();
	assert.deepEqual(labels(card), [["北京"], [CITY]]);
	const tap = tg.userTaps(USER, card.messageId, card.buttons![1][0].data);
	await until(() => ofType(client.got, "user").some((m) => m.text === `回答任务「查天气」：${CITY}`), "网页收到回答");
	await until(() => tg.shown(card.messageId)!.text.endsWith(`已选「${CITY}」，已回答`), "卡片编辑成已回答");
	assert.equal(tg.shown(card.messageId)!.buttons, null);
	assert.equal(tg.toastFor(tap), "已发送");
	const again = tg.userTaps(USER, card.messageId, card.buttons![1][0].data);
	await until(() => tg.toastFor(again) !== undefined, "第二次点的回应");
	assert.equal(tg.toastFor(again), "已发送");
	await host.settled();
	assert.equal(userLines(host).filter((l) => l === `回答任务「查天气」：${CITY}`).length, 1, "只答一次");
	assert.ok(!sentTo(tg, USER).some((m) => m.includes("你在网页或终端说：回答任务")), "自己点的回答不再转回这个聊天");
});

test("真宿主：网页先点了另一项，再在 Telegram 点：被拒，提示已选；卡片跟着网页变", async (t) => {
	const { host, tg, card } = await askedOnTelegram(t);
	const reportId = host.kernel.listTickets()[0].question!.reportId;
	assert.equal(host.answer(reportId, 0).ok, true);
	const tap = tg.userTaps(USER, card.messageId, card.buttons![1][0].data);
	await until(() => tg.toastFor(tap) !== undefined, "点的回应");
	assert.equal(tg.toastFor(tap), "已选「北京」");
	await until(() => /已选「北京」，(已发送，等待幕僚长转交|已回答)$/.test(tg.shown(card.messageId)!.text), "卡片跟着网页的点选");
	assert.ok(sentTo(tg, USER).includes("你在网页或终端说：回答任务「查天气」：北京"));
});

test("真宿主：使用者在 Telegram 直接打字：卡片变成已插话，这句话照常交给幕僚长", async (t) => {
	const { host, tg, card } = await askedOnTelegram(t, { brain: askBrain(1500) });
	tg.userSays(USER, "我打字说上海");
	await until(() => tg.shown(card.messageId)!.text.endsWith("已插话：你刚发了一句话，等幕僚长处理完再点"), "卡片变成已插话");
	assert.equal(tg.shown(card.messageId)!.buttons, null);
	await until(() => sentTo(tg, USER).includes("收到你打的字。"), "幕僚长处理了这句话", 5000);
	assert.ok(userLines(host).includes("我打字说上海"));
});

test("真宿主重启：卡片不重发；重启前的按钮点了仍然有效", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const stateDir = tempStateDir();
	const first = await askedOnTelegram(t, { fake: tg, stateDir });
	await first.stop();
	const sentBefore = tg.sent.length;
	const second = await telegramHost(t, { fake: tg, stateDir, brain: askBrain(), script: asking });
	await until(() => tg.calls("getMe").length === 2, "重启后连上 Telegram");
	await settle(500);
	assert.equal(tg.sent.length, sentBefore, "没有重发");
	const tap = tg.userTaps(USER, first.card.messageId, first.card.buttons![0][0].data);
	await until(() => tg.toastFor(tap) !== undefined, "点的回应");
	assert.equal(tg.toastFor(tap), "已发送");
	await until(() => userLines(second.host).includes("回答任务「查天气」：北京"), "回答进对话");
	await until(() => /已选「北京」/.test(tg.shown(first.card.messageId)!.text), "旧卡片被编辑");
});

test("编辑卡片时 Telegram 的回应说不清（500）：编辑把卡片设成一个状态，再编辑一次结果一样，所以重试；不改发「可能没送到」的说明，也不重发卡片", async (t) => {
	const { tg, frame, open } = await cardClient(t);
	await open(USER);
	const id = rpt();
	frame([ticket(pending(id))]);
	await until(() => cards(tg, USER).length === 1, "卡片");
	tg.fail("editMessageText", 500, {}, 2);
	frame([ticket(pending(id, { click: { option: 1, state: "sent", triggerId: "trg_1" } }))]);
	await until(() => tg.edits.length === 1, "重试后编辑成功", 5000);
	await settle();
	assert.equal(tg.calls("editMessageText").filter((r) => r.status === 500).length, 2);
	assert.match(tg.shown(cards(tg, USER)[0].messageId)!.text, /已选「上海」，已发送，等待幕僚长转交$/);
	assert.ok(!sentTo(tg, USER).includes(NOTES.missed), "没有改发说明");
	assert.equal(cards(tg, USER).length, 1, "没有重发卡片");
});

test("聊天欠着「可能没送到」的说明时：卡片发出和编辑都不带说明、也不算还清；之后的第一条文字消息开头带上，说明只到一次", async (t) => {
	const { tg, frame, open } = await cardClient(t);
	await open(USER);
	tg.fail("sendMessage", 500);
	tg.userSays(USER, "/help");
	await until(() => tg.calls("sendMessage").filter((r) => r.status === 500).length === 2, "帮助和单独的说明都说不准到没到");
	tg.heal("sendMessage");
	const id = rpt();
	frame([ticket(pending(id))]);
	await until(() => cards(tg, USER).length === 1, "卡片");
	frame([ticket(pending(id, { click: { option: 1, state: "sent", triggerId: "trg_1" } }))]);
	await until(() => tg.edits.length === 1, "卡片编辑");
	const card = tg.shown(cards(tg, USER)[0].messageId)!;
	assert.ok(card.text.startsWith("青檀"), "卡片编辑后不带说明");
	assert.ok(cards(tg, USER)[0].text.startsWith("青檀"), "卡片发出时不带说明");
	tg.userSays(USER, "/help");
	await until(() => sentTo(tg, USER).includes(`${NOTES.missed}\n${NOTES.help}`), "下一条文字带上说明");
	tg.userSays(USER, "/help");
	await until(() => sentTo(tg, USER).filter((m) => m === NOTES.help).length === 2, "还清后不再带");
	assert.equal(sentTo(tg, USER).filter((m) => m.includes(NOTES.missed)).length, 1);
});

test("点一条不是卡片的消息，按钮数据写成卡片的：被拒，不问宿主", async (t) => {
	const { tg, open, frame, answered } = await cardClient(t);
	await open(USER);
	const help = tg.sent.find((m) => m.chatId === USER && m.text === NOTES.help)!;
	frame([ticket(pending(rpt()))]);
	await until(() => cards(tg, USER).length === 1, "卡片");
	const tap = tg.userTaps(USER, help.messageId, cards(tg, USER)[0].buttons![1][0].data);
	await until(() => tg.toastFor(tap) !== undefined, "点的回应");
	assert.equal(tg.toastFor(tap), "这个问题已经回答过，或已不在等待回答");
	assert.deepEqual(answered, []);
});

test("在卡片 A 上点，按钮数据写成卡片 B 的：被拒，不问宿主；A 自己的按钮照常回答 A", async (t) => {
	const { tg, frame, open, answered } = await cardClient(t);
	await open(USER);
	const a = rpt();
	const b = rpt();
	frame([ticket(pending(a), "任务A"), ticket(pending(b, { text: "要不要发邮件？", options: ["发", "不发"] }), "任务B")]);
	await until(() => cards(tg, USER).length === 2, "两张卡片");
	const [cardA, cardB] = cards(tg, USER);
	const forged = tg.userTaps(USER, cardA.messageId, cardB.buttons![0][0].data);
	await until(() => tg.toastFor(forged) !== undefined, "伪造的点的回应");
	assert.equal(tg.toastFor(forged), "这个问题已经回答过，或已不在等待回答");
	const own = tg.userTaps(USER, cardA.messageId, cardA.buttons![1][0].data);
	await until(() => tg.toastFor(own) !== undefined, "A 自己按钮的回应");
	assert.equal(tg.toastFor(own), "已发送");
	assert.deepEqual(answered, [[a, 1, { client: "telegram", chatId: USER }]]);
});

const dropBrain: Brain = (cards) =>
	cards.flatMap((card) => {
		const clicked = card.split("\n").find((l) => l.startsWith("点选回答："));
		if (card.startsWith("[对话]") && clicked) return [{ name: "reply", args: { text: "先不转交。", cause: ids(card, "trg") } }];
		if (card.startsWith("[对话]") && card.includes("使用者：查天气")) return openOnConversation(card);
		if (card.startsWith("[Worker 提问]")) return [{ name: "reply", args: { text: "查哪个城市？", cause: ids(card, "tkt") } }];
		if (card.startsWith("[对话]")) return [{ name: "reply", args: { text: "收到。", cause: ids(card, "trg") } }];
		return [];
	});

test("真宿主：点一次，幕僚长没转交；Telegram 重投这次点的 update：不再多一条回答，提示照旧", async (t) => {
	const { host, tg, card } = await askedOnTelegram(t, { brain: dropBrain });
	const updateId = tg.push({ callback_query: { id: "cb-once", from: { id: USER, is_bot: false, first_name: "测试" }, message: { message_id: card.messageId, chat: { id: USER, type: "private" } }, chat_instance: "fake", data: card.buttons![1][0].data } });
	await until(() => tg.toastFor("cb-once") !== undefined, "点的回应");
	await until(() => /幕僚长没有转交这次选择/.test(tg.shown(card.messageId)!.text), "卡片显示没转交、按钮回来", 5000);
	tg.redeliver(updateId);
	await until(() => tg.tapAnswers.filter((a) => a.callbackId === "cb-once").length === 2, "重投的 update 被处理");
	await host.settled();
	assert.equal(userLines(host).filter((l) => l === `回答任务「查天气」：${CITY}`).length, 1, "一次点只答一次");
	assert.deepEqual(tg.tapAnswers.filter((a) => a.callbackId === "cb-once").map((a) => a.text), ["已发送", "已发送"]);
});

const lastUserLine = (host: Host) => host.kernel.conversation().filter((l) => l.who === "user").at(-1)!;
const sentMessage = (tg: FakeTelegram, text: string) => tg.sent.find((m) => m.text === text)!;

async function swipeReplied(tg: FakeTelegram, host: Host, text: string, replyTo: number) {
	const updateId = tg.userSays(USER, text, { replyTo });
	await until(() => userLines(host).includes(text), `「${text}」进对话`);
	return updateId;
}

test("滑动回复幕僚长的回复：这句话带着引用进对话，网页收到的也带引用，引用的是那条回复；不转回这个聊天", async (t) => {
	const { host, tg } = await telegramHost(t);
	const client = watch(t, host);
	await client.connected();
	tg.userSays(USER, "查一下 NVDA");
	await until(() => sentTo(tg, USER).includes("收到：查一下 NVDA"), "回复到达 Telegram");
	const reply = host.kernel.conversation().find((l) => l.who === "router")!;
	await swipeReplied(tg, host, "为什么跌", sentMessage(tg, "收到：查一下 NVDA").messageId);
	const { lineId, who, text } = lastUserLine(host).quote!;
	assert.deepEqual({ lineId, who, text }, { lineId: reply.id, who: "router", text: "收到：查一下 NVDA" });
	await until(() => ofType(client.got, "user").some((m) => m.text === "为什么跌"), "网页收到这句话");
	assert.equal(ofType(client.got, "user").find((m) => m.text === "为什么跌")!.quote?.lineId, reply.id);
	await until(() => sentTo(tg, USER).includes("收到：为什么跌"), "幕僚长回复了这句话");
	assert.ok(!sentTo(tg, USER).some((m) => m.includes("为什么跌") && m.startsWith("你在")), "自己说的不转回来");
});

test("滑动回复自己在 Telegram 说过的话：引用的是自己那句", async (t) => {
	const { host, tg } = await telegramHost(t);
	const said = tg.userSays(USER, "查天气");
	await until(() => sentTo(tg, USER).includes("收到：查天气"), "回复");
	const own = host.kernel.conversation().find((l) => l.text === "查天气")!;
	await swipeReplied(tg, host, "明天的", tg.messageIdOf(said));
	assert.deepEqual([lastUserLine(host).quote?.lineId, lastUserLine(host).quote?.who], [own.id, "user"]);
});

test("滑动回复从网页转过来的话：引用的是网页上那句原话，不带转发前缀", async (t) => {
	const { host, tg } = await telegramHost(t);
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length === 1, "说明");
	const webLine = host.say("网页上说的");
	await until(() => sentTo(tg, USER).includes("你在网页或终端说：网页上说的"), "转过来的话");
	await swipeReplied(tg, host, "接着说", sentMessage(tg, "你在网页或终端说：网页上说的").messageId);
	assert.deepEqual([lastUserLine(host).quote?.lineId, lastUserLine(host).quote?.text], [webLine, "网页上说的"]);
});

test("滑动回复说明或找不到的旧消息：话照常作为普通的一句进对话，不带引用，不报错", async (t) => {
	const { host, tg, logs } = await telegramHost(t);
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length === 1, "说明");
	await swipeReplied(tg, host, "对说明回复", sentMessage(tg, NOTES.help).messageId);
	assert.equal(lastUserLine(host).quote, undefined);
	await swipeReplied(tg, host, "对很早的消息回复", 987_654);
	assert.equal(lastUserLine(host).quote, undefined);
	assert.ok(!logs.some((l) => l.includes("出错")), logs.join("\n"));
});

test("真宿主：滑动回复问题卡片：话照常作为普通的一句进对话，不带引用", async (t) => {
	const { host, tg, card } = await askedOnTelegram(t);
	await swipeReplied(tg, host, "对卡片回复", card.messageId);
	assert.equal(lastUserLine(host).quote, undefined);
});

test("同一个滑动回复的 update 投两次：对话里只有一行，带着引用", async (t) => {
	const { host, tg } = await telegramHost(t);
	tg.userSays(USER, "查一下 NVDA");
	await until(() => sentTo(tg, USER).includes("收到：查一下 NVDA"), "回复");
	const id = await swipeReplied(tg, host, "为什么跌", sentMessage(tg, "收到：查一下 NVDA").messageId);
	await until(() => sentTo(tg, USER).includes("收到：为什么跌"), "第二句的回复");
	const polls = tg.calls("getUpdates").length;
	tg.redeliver(id);
	await until(() => tg.calls("getUpdates").length >= polls + 2, "重投的 update 被取走");
	await host.settled();
	const lines = host.kernel.conversation().filter((l) => l.text === "为什么跌");
	assert.equal(lines.length, 1);
	assert.ok(lines[0].quote);
	assert.equal(sentTo(tg, USER).filter((m) => m === "收到：为什么跌").length, 1);
});

test("清屏之后滑动回复清屏前的回复：引用仍然成立", async (t) => {
	const { host, tg } = await telegramHost(t);
	tg.userSays(USER, "查一下 NVDA");
	await until(() => sentTo(tg, USER).includes("收到：查一下 NVDA"), "回复");
	const reply = host.kernel.conversation().find((l) => l.who === "router")!;
	host.clearConversation();
	await swipeReplied(tg, host, "清屏后接着问", sentMessage(tg, "收到：查一下 NVDA").messageId);
	assert.equal(host.kernel.conversation().find((l) => l.text === "清屏后接着问")!.quote?.lineId, reply.id);
});

const relayBrain: Brain = (cards) =>
	cards.flatMap((card) => {
		if (card.startsWith("[对话]") && card.includes("使用者：查天气")) return openOnConversation(card);
		if (card.startsWith("[Worker 提问]")) {
			const cause = ids(card, "tkt");
			return [
				{ name: "reply", args: { text: "查哪个城市？", cause } },
				{ name: "reply", args: { text: "助手查天气前要先知道城市。", cause } },
			];
		}
		return [];
	});

test("真宿主：助手带选项提问，手机上只有卡片，幕僚长转述的同一个问题不再单发一条；同一任务的别的话照常到；网页照常收到转述", async (t) => {
	const started = await telegramHost(t, { brain: relayBrain, script: asking });
	const { host, tg } = started;
	const client = watch(t, host);
	await client.connected();
	tg.userSays(USER, "/start");
	await until(() => sentTo(tg, USER).length === 1, "说明");
	host.say("查天气");
	await until(() => sentTo(tg, USER).includes("助手查天气前要先知道城市。"), "同一任务的别的话到达 Telegram");
	await host.settled();
	await settle();
	assert.equal(cards(tg, USER).length, 1, "一张卡片");
	assert.ok(!sentTo(tg, USER).includes("查哪个城市？"), "转述的问题不单发");
	const ask = sentTo(tg, USER).findIndex((m) => m.includes("问你（任务"));
	assert.ok(ask < sentTo(tg, USER).indexOf("助手查天气前要先知道城市。"), "卡片在后面那句话之前");
	assert.deepEqual(ofType(client.got, "reply").map((m) => m.text).slice(-2), ["查哪个城市？", "助手查天气前要先知道城市。"], "终端照常收到两句");
	assert.ok(host.kernel.conversation().some((l) => l.text === "查哪个城市？"), "对话里照常有转述");
});

test("读看板出错时，幕僚长带任务的回复照常发到手机，日志记一行", async (t) => {
	const { tg, open, logs, host, client } = await cardClient(t);
	await open(USER);
	host.board = () => {
		throw new Error("看板读不出来");
	};
	client.broadcast({ type: "reply", text: "查哪个城市？", at: Date.now(), replyId: "rep_1", ticketId: "tkt_1" });
	await until(() => sentTo(tg, USER).includes("查哪个城市？"), "回复到达 Telegram");
	assert.equal(logs.filter((l) => l.includes("看板读不出来")).length, 1);
});

test("盯盘提醒带通知发到每个聊天，前面写「盯盘提醒：」；同一行再广播一次不重发", async (t) => {
	const { tg, open, client } = await cardClient(t, { allowed: [USER, OTHER] });
	await open(USER);
	await open(OTHER);
	const line = { type: "host_line", id: "hln_1", who: "alert", text: "NVDA 涨了 5.3%，现价 150.20", at: Date.now() } as const;
	client.broadcast(line);
	client.broadcast(line);
	await until(() => sentTo(tg, USER).length === 2 && sentTo(tg, OTHER).length === 2, "两个聊天都收到提醒");
	await settle();
	for (const chat of [USER, OTHER]) {
		assert.deepEqual(tg.sent.filter((m) => m.chatId === chat).slice(1).map((m) => [m.text, m.silent]), [["盯盘提醒：NVDA 涨了 5.3%，现价 150.20", false]]);
	}
});

test("盯盘条件的收据只在本机：广播收据，Telegram 什么都不发", async (t) => {
	const { tg, open, client } = await cardClient(t);
	await open(USER);
	const before = sentTo(tg, USER).length;
	client.broadcast({ type: "host_line", id: "hln_2", who: "receipt", text: "已记下：NVDA 成本价 120.00、100 股", at: Date.now() });
	client.broadcast({ type: "reply", text: "已添加", at: Date.now(), replyId: "rpl_after" });
	await until(() => sentTo(tg, USER).includes("已添加"), "收据之后的回复到达");
	assert.deepEqual(sentTo(tg, USER).slice(before), ["已添加"]);
});

test("真宿主：改了盯盘条件后，网页左栏的面板带着成本价随 board 帧推出去，Telegram 一条带成本价的都不发", async (t) => {
	let tripwires: string[] = [];
	const feed = fakeFeed("us-market", () => ({ watchlist: ["NVDA"], tripwires }));
	const { host, tg } = await telegramHost(t, { feeds: [feed.spec], watching: [{ source: "us-market", timers: [], rules: [] }] });
	tg.userSays(USER, "/start");
	await until(() => sentTo(tg, USER).length === 1, "说明");
	tripwires = ["NVDA 成本价 120、100 股，相对成本价涨跌超过 10% 时提醒"];
	feed.ctx!.post({ kind: "receipt", text: "已添加：NVDA 成本价 120、100 股" });
	assert.match(JSON.stringify(host.snapshot().watching), /成本价 120/);
	await new Promise((r) => setTimeout(r, 300));
	tg.userSays(USER, "好了吗");
	await until(() => sentTo(tg, USER).includes("收到：好了吗"), "之后的回复到达");
	assert.deepEqual(sentTo(tg, USER).filter((m) => /120|盯盘条件/.test(m)), []);
});

test("不认识的广播类型：不发到 Telegram，日志记一行，不悄悄丢掉", async (t) => {
	const { tg, open, client, logs } = await cardClient(t);
	await open(USER);
	client.broadcast({ type: "brand_new", text: "以后加的新类型" } as unknown as Broadcast);
	assert.equal(logs.filter((l) => l.includes("brand_new")).length, 1, logs.join("\n"));
	await settle();
	assert.ok(!sentTo(tg, USER).some((m) => m.includes("以后加的新类型")));
});

const ALERT = "NVDA 涨了 5.3%，现价 150.20";
const PHONE_ALERT = `盯盘提醒：${ALERT}`;

test("真宿主：来源贴的提醒带通知到手机一次，同一个 id 再贴不重发；收据不发；来源能问出这条提醒贴过了", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const stateDir = tempStateDir();
	const feed = fakeFeed("us-market");
	const first = await telegramHost(t, { fake: tg, stateDir, feeds: [feed.spec] });
	tg.userSays(USER, "/start");
	await until(() => sentTo(tg, USER).length === 1, "说明");
	assert.equal(feed.ctx!.raised("NVDA:2026-11-11:day-up-5"), false);
	feed.ctx!.post({ kind: "alert", externalId: "NVDA:2026-11-11:day-up-5", text: ALERT, occurredAt: Date.now() });
	feed.ctx!.post({ kind: "alert", externalId: "NVDA:2026-11-11:day-up-5", text: ALERT, occurredAt: Date.now() });
	feed.ctx!.post({ kind: "receipt", text: "已记下：NVDA 成本价 120.00、100 股" });
	assert.equal(feed.ctx!.raised("NVDA:2026-11-11:day-up-5"), true);
	await until(() => sentTo(tg, USER).includes(PHONE_ALERT), "提醒到手机");
	assert.equal(tg.sent.find((m) => m.text === PHONE_ALERT)!.silent, false, "提醒带通知");
	assert.deepEqual(first.host.kernel.conversation().map((l) => [l.who, l.text]), [["alert", ALERT], ["receipt", "已记下：NVDA 成本价 120.00、100 股"]]);
	await first.stop();
	await telegramHost(t, { fake: tg, stateDir, feeds: [fakeFeed("us-market").spec] });
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(sentTo(tg, USER).filter((m) => m === PHONE_ALERT).length, 1, "重启后不重发");
	assert.ok(!sentTo(tg, USER).some((m) => m.includes("120.00")), "收据不出本机");
});

test("真宿主：提醒写进库后、广播前宿主停了，重启后补发到手机一次，再重启也不重发；网页对话里有它", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const stateDir = tempStateDir();
	const first = await telegramHost(t, { fake: tg, stateDir });
	tg.userSays(USER, "/start");
	await until(() => sentTo(tg, USER).length === 1, "说明");
	await first.stop();
	const crashed = db(stateDir);
	new Kernel({ db: crashed, clock: { now: () => Date.now() }, sourcePolicy: () => "candidate" }).postHostLine("us-market", { kind: "alert", externalId: "NVDA:x", text: ALERT, occurredAt: Date.now() });
	crashed.close();
	const second = await telegramHost(t, { fake: tg, stateDir });
	await until(() => sentTo(tg, USER).includes(PHONE_ALERT), "重启后补发");
	assert.deepEqual(second.host.snapshot().conversation.map((l) => [l.who, l.text]), [["alert", ALERT]]);
	await second.stop();
	await telegramHost(t, { fake: tg, stateDir });
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(sentTo(tg, USER).filter((m) => m === PHONE_ALERT).length, 1);
});
