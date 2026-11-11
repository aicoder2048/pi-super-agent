import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HostConnection } from "../src/client/connection.ts";
import type { HostToClient } from "../src/client/protocol.ts";
import type { Host } from "../src/host/host.ts";
import { BotApi, BotToken, type Http } from "../src/host/telegram/bot-api.ts";
import type { TelegramTiming } from "../src/host/telegram/client.ts";
import { NOTES } from "../src/host/telegram/rules.ts";
import { openStore } from "../src/kernel/store.ts";
import { FAKE_BOT_TOKEN, FakeTelegram } from "./helpers/fake-telegram.ts";
import { ids, ofType, startHost, tempStateDir, until, within, type Brain } from "./helpers/fakes.ts";

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
	http?: Http;
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

async function telegramHost(t: TestContext, { allowed = [USER], stateDir = tempStateDir(), timing = FAST, fake, brain = echo, http }: Setup = {}) {
	const tg = fake ?? (await FakeTelegram.start());
	const logs: string[] = [];
	const { host } = await startHost(brain, () => {}, {
		stateDir,
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
	return { got, connected: () => until(() => conn.connected, "连接") };
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
