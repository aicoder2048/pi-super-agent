import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { inTransaction, openStore } from "../src/kernel/store.ts";
import { TelegramStore } from "../src/host/telegram/store.ts";
import { tempStateDir } from "./helpers/fakes.ts";

const BOT = 123456789;
const reply = (text: string) => ({ kind: "line" as const, text, silent: false });

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
	assert.deepEqual(store.next(), { chatId: 42, key: "line:rpl_1", version: 1, messageId: null, body: reply("收到。") });
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
