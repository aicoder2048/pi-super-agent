import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { inTransaction, openStore } from "../src/kernel/store.ts";
import type { CardView } from "../src/host/telegram/rules.ts";
import { TelegramStore } from "../src/host/telegram/store.ts";
import { tempStateDir } from "./helpers/fakes.ts";

const BOT = 123456789;
const reply = (text: string) => ({ kind: "line" as const, role: "router" as const, text, silent: false });

function fresh(): { db: DatabaseSync; store: TelegramStore; reopen: (botId?: number) => TelegramStore } {
	const db = openStore(join(tempStateDir(), "state.db"));
	const reopen = (botId = BOT) => {
		const store = new TelegramStore(db, botId, () => 1000);
		store.claim(new Set([42]));
		return store;
	};
	return { db, store: reopen(), reopen };
}

const rows = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("同一条消息写两次只有一行；内容变了版本加一，待发的是最新版本", () => {
	const { db, store } = fresh();
	store.put(42, "line:rpl_1", "rpl_1", reply("收到。"));
	store.put(42, "line:rpl_1", "rpl_1", reply("收到。"));
	assert.equal(rows(db, "telegram_messages"), 1);
	assert.deepEqual(store.next(), { chatId: 42, key: "line:rpl_1", version: 1, messageId: null, body: reply("收到。"), note: false, task: null });
	store.put(42, "line:rpl_1", "rpl_1", reply("改了。"));
	assert.equal(store.next()?.version, 2);
	assert.deepEqual(store.next()?.body, reply("改了。"));
});

test("待发的按写入顺序取；发出后不再待发，记下 Telegram 的 message_id", () => {
	const { store } = fresh();
	store.put(42, "line:a", "a", reply("一"));
	store.put(42, "line:b", "b", reply("二"));
	const first = store.next()!;
	assert.equal(first.key, "line:a");
	store.sent(first, 500);
	assert.equal(store.next()?.key, "line:b");
	store.sent(store.next()!, 501);
	assert.equal(store.next(), undefined);
});

test("旧版本晚发完时不覆盖新版本的发送记录", () => {
	const { store } = fresh();
	store.put(42, "line:a", "a", reply("一"));
	const v1 = store.next()!;
	store.put(42, "line:a", "a", reply("一改"));
	const v2 = store.next()!;
	store.sent(v2, 500);
	store.sent(v1, 500);
	assert.equal(store.next(), undefined);
});

test("放弃的消息不再待发", () => {
	const { store } = fresh();
	store.put(42, "line:a", "a", reply("一"));
	store.giveUp(store.next()!, "bad_request");
	assert.equal(store.next(), undefined);
});

test("使用者自己在 Telegram 发的话记一行，永远不待发；再记一次不变", () => {
	const { db, store } = fresh();
	store.received(42, "trg_1", 9);
	store.received(42, "trg_1", 9);
	assert.equal(rows(db, "telegram_messages"), 1);
	assert.equal(store.next(), undefined);
});

test("取更新的 offset 存在状态库里，重开后还在", () => {
	const { store, reopen } = fresh();
	assert.equal(store.nextUpdateId(), undefined);
	store.setNextUpdateId(11);
	assert.equal(reopen().nextUpdateId(), 11);
});

test("聊天第一次打开时返回 true；屏蔽后再打开又返回 true；屏蔽时放弃这个聊天待发的消息", () => {
	const { store } = fresh();
	assert.equal(store.openChat(42), true);
	assert.equal(store.openChat(42), false);
	assert.deepEqual(store.openChats(), [42]);
	store.put(42, "line:a", "a", reply("一"));
	store.blockChat(42);
	assert.deepEqual(store.openChats(), []);
	assert.equal(store.next(), undefined);
	assert.equal(store.openChat(42), true);
	assert.equal(store.next(), undefined, "屏蔽前没发出的不补发");
});

test("只建表不改行：认领（claim）之前，换了机器人的宿主也不清别人的 Telegram 状态", () => {
	const { db, store } = fresh();
	store.put(42, "line:a", "a", reply("一"));
	new TelegramStore(db, 987654321, () => 1000);
	assert.equal(rows(db, "telegram_messages"), 1);
});

test("换了机器人（bot id 不同）时清掉全部 Telegram 状态；同一个机器人重开不清", () => {
	const { db, store, reopen } = fresh();
	store.setNextUpdateId(11);
	store.openChat(42);
	store.put(42, "line:a", "a", reply("一"));
	reopen();
	assert.equal(rows(db, "telegram_messages"), 1);
	const other = reopen(987654321);
	assert.equal(other.nextUpdateId(), undefined);
	assert.deepEqual(other.openChats(), []);
	assert.equal(rows(db, "telegram_messages"), 0);
});

test("名单里去掉的人：他的聊天和消息在启动时删掉", () => {
	const { db, store } = fresh();
	for (const chat of [42, 43]) {
		store.openChat(chat);
		store.put(chat, "setup", null, { kind: "note", text: "id" });
	}
	store.claim(new Set([42]));
	assert.deepEqual(store.openChats(), [42]);
	assert.equal(rows(db, "telegram_messages"), 1);
	store.claim(new Set());
	assert.equal(rows(db, "telegram_messages"), 0);
	assert.equal(rows(db, "telegram_chats"), 0);
});

test("在内核已开的事务里写，跟着事务一起回滚", () => {
	const { db, store } = fresh();
	assert.throws(() =>
		inTransaction(db, () => {
			store.put(42, "line:a", "a", reply("一"));
			throw new Error("内核这一步失败");
		}),
	);
	assert.equal(store.next(), undefined);
});

const view = (status: CardView["status"], reportId = "rpt_1"): CardView => ({ reportId, title: "查天气", helper: "青檀 · 对话助手 #1", question: "查哪个城市？", options: ["北京", "上海"], status });
const card = (status: CardView["status"], reportId = "rpt_1") => ({ kind: "card" as const, view: view(status, reportId) });

test("卡片发出后内容变了是一次编辑：待发的那一行带着 Telegram 的 message_id", () => {
	const { store } = fresh();
	store.put(42, "ask:rpt_1", null, card({ kind: "open" }));
	store.sent(store.next()!, 600);
	store.put(42, "ask:rpt_1", null, card({ kind: "open" }));
	assert.equal(store.next(), undefined, "同样的卡片不再发");
	store.put(42, "ask:rpt_1", null, card({ kind: "sent", label: "上海" }));
	assert.deepEqual(store.next(), { chatId: 42, key: "ask:rpt_1", version: 2, messageId: 600, body: card({ kind: "sent", label: "上海" }), note: false, task: null });
});

test("还没发出就已结束的卡片不发；正在发的卡片发完后再编辑成已结束", () => {
	const { store } = fresh();
	store.put(42, "ask:rpt_1", null, card({ kind: "open" }));
	store.put(42, "ask:rpt_1", null, card({ kind: "closed", label: null }));
	assert.equal(store.next(), undefined);
	store.put(42, "ask:rpt_2", null, card({ kind: "open" }, "rpt_2"));
	const inFlight = store.next()!;
	store.put(42, "ask:rpt_2", null, card({ kind: "closed", label: null }, "rpt_2"));
	assert.equal(store.next(), undefined, "发出去之前不知道 message_id，没有可编辑的");
	store.sent(inFlight, 601);
	assert.deepEqual(store.next(), { chatId: 42, key: "ask:rpt_2", version: 2, messageId: 601, body: card({ kind: "closed", label: null }, "rpt_2"), note: false, task: null });
});

test("还开着的卡片：只列这个聊天里没结束的问题卡片", () => {
	const { store } = fresh();
	store.put(42, "ask:rpt_1", null, card({ kind: "open" }));
	store.put(42, "ask:rpt_2", null, card({ kind: "sent", label: "北京" }, "rpt_2"));
	store.put(42, "ask:rpt_3", null, card({ kind: "closed", label: null }, "rpt_3"));
	store.put(43, "ask:rpt_4", null, card({ kind: "open" }, "rpt_4"));
	store.put(42, "cap:ask_cap_2026-11-11", null, { kind: "note", text: "成员上限" });
	store.put(42, "line:rpl_1", "rpl_1", reply("收到。"));
	assert.deepEqual(store.openCards(42).map((v) => v.reportId).sort(), ["rpt_1", "rpt_2"]);
});

test("可能已送达的消息不再发；聊天欠一句说明，由下一条消息带上，带着的那条发出后不再欠", () => {
	const { store } = fresh();
	for (const key of ["a", "b", "c"] as const) store.put(42, `line:${key}`, key, reply(key));
	assert.equal(store.next()?.note, false);
	store.maybeSent(store.next()!);
	const b = store.next()!;
	assert.deepEqual([b.key, b.note], ["line:b", true]);
	store.maybeSent(b);
	const c = store.next()!;
	assert.deepEqual([c.key, c.note], ["line:c", true], "带着说明的那条说不准到没到时，仍然欠着");
	store.sent(c, 500);
	assert.equal(store.next(), undefined, "说明已带到，不再单独发");
	store.put(42, "line:d", "d", reply("d"));
	assert.equal(store.next()?.note, false);
});

test("欠一句说明、没有别的待发：排一条单独的说明；它说不准到没到时不再排第二条，下一条消息带上", () => {
	const { store } = fresh();
	store.put(42, "line:a", "a", reply("a"));
	store.maybeSent(store.next()!);
	const alone = store.next()!;
	assert.deepEqual([alone.key, alone.note], ["missed", true]);
	store.maybeSent(alone);
	assert.equal(store.next(), undefined, "同一笔欠账只排一条单独的说明");
	store.put(42, "line:b", "b", reply("b"));
	const b = store.next()!;
	assert.deepEqual([b.key, b.note], ["line:b", true]);
	store.sent(b, 500);
	store.put(42, "line:c", "c", reply("c"));
	store.maybeSent(store.next()!);
	assert.equal(store.next()?.key, "missed", "新的一笔欠账再排一条");
});

test("欠着说明时，发出过的卡片或文字改了内容是编辑：不带说明、不算还清；没有新文字可带时排一条单独的说明", () => {
	const { store } = fresh();
	store.put(42, "ask:rpt_1", null, card({ kind: "open" }));
	store.put(42, "line:a", "a", reply("a"));
	store.sent(store.next()!, 600);
	store.sent(store.next()!, 601);
	store.put(42, "line:b", "b", reply("b"));
	store.maybeSent(store.next()!);
	store.put(42, "ask:rpt_1", null, card({ kind: "sent", label: "上海" }));
	store.put(42, "line:a", "a", reply("a 改了"));
	const edits = [store.next()!];
	store.sent(edits[0], 600);
	edits.push(store.next()!);
	store.sent(edits[1], 601);
	assert.deepEqual(edits.map((e) => [e.key, e.messageId, e.note]), [["ask:rpt_1", 600, false], ["line:a", 601, false]]);
	const alone = store.next()!;
	assert.deepEqual([alone.key, alone.note], ["missed", true], "编辑没有还清，单独的说明照排");
	store.put(42, "line:c", "c", reply("c"));
	store.sent(alone, 602);
	assert.equal(store.next()?.note, false);
});

test("欠的说明存在状态库里，重开后还欠着；屏蔽、换机器人时不再欠", () => {
	const { store, reopen } = fresh();
	store.put(42, "line:a", "a", reply("a"));
	store.maybeSent(store.next()!);
	const owed = reopen().next()!;
	assert.deepEqual([owed.key, owed.note], ["missed", true]);
	store.blockChat(42);
	store.openChat(42);
	store.put(42, "line:b", "b", reply("b"));
	assert.equal(store.next()?.note, false, "屏蔽时欠的说明一起放下");
	store.maybeSent(store.next()!);
	assert.equal(reopen(987654321).next(), undefined);
});

test("同一个 update 的点只处理一次：重投拿回第一次的提示；处理出错不记，连同它写的一起回滚；换了机器人才忘掉", () => {
	const { db, store, reopen } = fresh();
	assert.throws(() =>
		store.tapOnce(7, () => {
			store.put(42, "line:a", "a", reply("一"));
			throw new Error("宿主出错");
		}),
	);
	assert.equal(rows(db, "telegram_messages"), 0);
	let runs = 0;
	const handle = (toast: string) => () => {
		runs++;
		return toast;
	};
	assert.equal(store.tapOnce(7, handle("已发送")), "已发送");
	assert.equal(reopen().tapOnce(7, handle("别的")), "已发送");
	assert.equal(runs, 1);
	assert.equal(reopen(987654321).tapOnce(7, handle("新机器人")), "新机器人");
	assert.equal(runs, 2);
});
