import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { HostDeps } from "../src/host/host.ts";
import { BotApi, BotToken, type Http } from "../src/host/telegram/bot-api.ts";
import type { TelegramTiming } from "../src/host/telegram/client.ts";
import { NOTES } from "../src/host/telegram/rules.ts";
import { TelegramStore } from "../src/host/telegram/store.ts";
import { Kernel } from "../src/kernel/kernel.ts";
import { openStore } from "../src/kernel/store.ts";
import { CONVERSATION_THREAD_ID } from "../src/kernel/types.ts";
import { FAKE_BOT_TOKEN, FakeTelegram } from "./helpers/fake-telegram.ts";
import { fauxRouter, freePort, ids, startHost, tempStateDir, until, within, type Brain } from "./helpers/fakes.ts";

const USER = 42;
const FAST: Partial<TelegramTiming> = { pollTimeoutSec: 2, minGapMs: 20, backoffMs: [100, 200], conflictBackoffMs: 200, stopGraceMs: 500 };
const SECRET = FAKE_BOT_TOKEN.split(":")[1];
const echo: Brain = (cards) =>
	cards.flatMap((card) => (card.startsWith("[对话]") ? [{ name: "reply", args: { text: `收到：${card.split("使用者：")[1]?.split("\n")[0]}`, cause: ids(card, "trg") } }] : []));
const sentTo = (tg: FakeTelegram, chatId: number) => tg.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const refused = () => new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) });

interface Setup {
	stateDir?: string;
	timing?: Partial<TelegramTiming>;
	http?: Http;
	brain?: Brain;
	extra?: object;
}

async function tgHost(t: TestContext, tg: FakeTelegram, { stateDir = tempStateDir(), timing = FAST, http, brain = echo, extra = {} }: Setup = {}) {
	const logs: string[] = [];
	const { host } = await startHost(brain, () => {}, {
		stateDir,
		log: (l) => logs.push(l),
		telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url, ...(http && { http }) }), allowedUserIds: new Set([USER]), timing },
		...extra,
	});
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await host.stop();
	};
	t.after(async () => {
		await stop();
		assert.ok(!logs.some((l) => l.includes(SECRET)), "日志里没有 token");
		assert.equal(tg.wrongToken, 0, "每个请求都带对的 token");
	});
	return { host, logs, stop, stateDir };
}

async function fakeTelegram(t: TestContext): Promise<FakeTelegram> {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	return tg;
}

test("重启时还没送出的回复，等 Telegram 客户端在了才送，手机上收得到", async (t) => {
	const tg = await fakeTelegram(t);
	const stateDir = tempStateDir();
	const first = await tgHost(t, tg, { stateDir });
	tg.userSays(USER, "before");
	await until(() => sentTo(tg, USER).includes("收到：before"), "第一条回复");
	await first.stop();
	const kernel = new Kernel({ db: openStore(join(stateDir, "state.db")), clock: { now: () => Date.now() }, sourcePolicy: () => "candidate" });
	const { triggerId } = kernel.userSaid({ text: "pending", at: Date.now() });
	assert.ok(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "收到：pending", cause: triggerId }).ok);
	const router = fauxRouter(() => []);
	const slowRouter = async (deps: HostDeps) => {
		await sleep(1500);
		return router.createRouter(deps);
	};
	await tgHost(t, tg, { stateDir, brain: () => [], extra: { createRouter: slowRouter } });
	await until(() => sentTo(tg, USER).includes("收到：pending"), "停机前没送出的回复到了 Telegram", 4000);
});

test("宿主启动、Router 还没好时网页上说的话，也静默转到 Telegram", async (t) => {
	const tg = await fakeTelegram(t);
	const stateDir = tempStateDir();
	const first = await tgHost(t, tg, { stateDir });
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length === 1, "说明");
	await first.stop();
	const webPort = await freePort();
	const router = fauxRouter(() => []);
	const sayOnWebFirst = async (deps: HostDeps) => {
		const token = readFileSync(join(stateDir, "web-token"), "utf8").trim();
		const origin = `http://127.0.0.1:${webPort}`;
		const res = await fetch(`${origin}/say?token=${token}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: "启动时网页上说的" }) });
		assert.equal(res.status, 200);
		return router.createRouter(deps);
	};
	await tgHost(t, tg, { stateDir, brain: () => [], extra: { webPort, createRouter: sayOnWebFirst } });
	await until(() => sentTo(tg, USER).includes("你在网页或终端说：启动时网页上说的"), "网页上的话转到 Telegram");
});
