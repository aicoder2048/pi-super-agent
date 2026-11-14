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
import { FAKE_BOT_TOKEN, FakeTelegram, unmarked } from "./helpers/fake-telegram.ts";
import { fauxRouter, freePort, ids, startHost, tempStateDir, until, within, type Brain } from "./helpers/fakes.ts";

const USER = 42;
const FAST: Partial<TelegramTiming> = { pollTimeoutSec: 2, minGapMs: 20, backoffMs: [100, 200], conflictBackoffMs: 200, stopGraceMs: 500 };
const SECRET = FAKE_BOT_TOKEN.split(":")[1];
const echo: Brain = (cards) =>
	cards.flatMap((card) => (card.startsWith("[对话]") ? [{ name: "reply", args: { text: `收到：${card.split("使用者：")[1]?.split("\n")[0]}`, cause: ids(card, "trg") } }] : []));
const sentTo = (tg: FakeTelegram, chatId: number) => tg.sent.filter((m) => m.chatId === chatId).map((m) => unmarked(m.text));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noted = (text: string) => `${NOTES.missed}\n${text}`;
const unnoted = (text: string) => (text.startsWith(`${NOTES.missed}\n`) ? text.slice(NOTES.missed.length + 1) : text);
const noteCount = (texts: string[]) => texts.filter((m) => m.split("\n")[0] === NOTES.missed).length;
const acceptedThen502: Http = async (url, init) => {
	const res = await fetch(url, init);
	if (!url.endsWith("/sendMessage")) return res;
	await res.text();
	return new Response("<html>502 Bad Gateway</html>", { status: 502 });
};
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

test("Telegram 收下了回复、回答前连接断了：回复不重发，补一句可能没送到的说明", async (t) => {
	const tg = await fakeTelegram(t);
	let dropNext = 1;
	const http: Http = async (url, init) => {
		const res = await fetch(url, init);
		if (url.endsWith("/sendMessage") && dropNext > 0) {
			dropNext--;
			await res.text();
			throw new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
		}
		return res;
	};
	const { host } = await tgHost(t, tg, { http });
	tg.userSays(USER, "hi");
	await until(() => sentTo(tg, USER).length >= 2, "回复和说明");
	await host.settled();
	await sleep(500);
	assert.deepEqual(sentTo(tg, USER), ["收到：hi", NOTES.missed]);
});

test("Telegram 收下了回复、网关回 502 网页：回复不重发，补一句说明", async (t) => {
	const tg = await fakeTelegram(t);
	let failNext = 1;
	const http: Http = async (url, init) => {
		const res = await fetch(url, init);
		if (url.endsWith("/sendMessage") && failNext > 0) {
			failNext--;
			await res.text();
			return new Response("<html>502 Bad Gateway</html>", { status: 502 });
		}
		return res;
	};
	const { host } = await tgHost(t, tg, { http });
	tg.userSays(USER, "hi");
	await until(() => sentTo(tg, USER).length >= 2, "回复和说明");
	await host.settled();
	await sleep(500);
	assert.deepEqual(sentTo(tg, USER), ["收到：hi", NOTES.missed]);
});

test("接连几条都可能已送达：每条都不重发，说明只到一次，带在恢复后的第一条上", async (t) => {
	const tg = await fakeTelegram(t);
	const { host } = await tgHost(t, tg);
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length === 1, "说明");
	tg.fail("sendMessage", 500, {}, 3);
	host.say("一");
	host.say("二");
	await until(() => noteCount(sentTo(tg, USER)) === 1, "可能没送到的说明", 5000);
	await host.settled();
	await sleep(500);
	const texts = sentTo(tg, USER);
	assert.equal(noteCount(texts), 1, texts.join(" | "));
	assert.equal(new Set(texts.map(unnoted)).size, texts.length, `没有哪条发了两次：${texts.join(" | ")}`);
	assert.equal(tg.calls("sendMessage").filter((r) => r.status === 500).length, 3);
});

test("Telegram 回 500（没收下）一阵后恢复：出错时的回复不重发，恢复后的第一条回复开头带一句说明", async (t) => {
	const tg = await fakeTelegram(t);
	const { host } = await tgHost(t, tg);
	tg.fail("sendMessage", 500);
	tg.userSays(USER, "during1");
	tg.userSays(USER, "during2");
	await until(() => tg.calls("sendMessage").length >= 3, "出错时的几次发送");
	await host.settled();
	await sleep(500);
	tg.heal("sendMessage");
	tg.userSays(USER, "after");
	await until(() => sentTo(tg, USER).length >= 1, "恢复后的回复");
	await host.settled();
	await sleep(500);
	assert.deepEqual(sentTo(tg, USER), [noted("收到：after")]);
});

test("欠着说明时宿主重启：重启后还欠着，下一条回复开头带上", async (t) => {
	const tg = await fakeTelegram(t);
	const stateDir = tempStateDir();
	const first = await tgHost(t, tg, { stateDir });
	tg.fail("sendMessage", 500);
	tg.userSays(USER, "before");
	await until(() => tg.calls("sendMessage").length >= 2, "回复和单独的说明都没发出");
	await first.host.settled();
	await sleep(300);
	await first.stop();
	tg.heal("sendMessage");
	await tgHost(t, tg, { stateDir });
	tg.userSays(USER, "after");
	await until(() => sentTo(tg, USER).length >= 1, "重启后的回复");
	await sleep(500);
	assert.deepEqual(sentTo(tg, USER), [noted("收到：after")]);
});

test("带着说明的消息正常发出：不再欠，之后的回复不带说明", async (t) => {
	const tg = await fakeTelegram(t);
	let release: (() => void) | undefined;
	let sends = 0;
	const http: Http = async (url, init) => {
		if (!url.endsWith("/sendMessage") || ++sends > 1) return fetch(url, init);
		await new Promise<void>((resume) => (release = resume));
		return acceptedThen502(url, init);
	};
	const { host } = await tgHost(t, tg, { http });
	tg.userSays(USER, "a");
	await until(() => release !== undefined, "第一条回复在发");
	host.say("b");
	await until(() => host.kernel.conversation().some((l) => l.text === "收到：b"), "第二条回复");
	release!();
	await until(() => sentTo(tg, USER).includes("收到：b"), "第二条回复到了手机");
	tg.userSays(USER, "c");
	await until(() => sentTo(tg, USER).includes("收到：c"), "第三条回复");
	await host.settled();
	await sleep(300);
	assert.deepEqual(sentTo(tg, USER), ["收到：a", noted("你在网页或终端说：b"), "收到：b", "收到：c"]);
});

test("连不上 Telegram（请求没发出去）：重试，回复只到一次，不补说明", async (t) => {
	const tg = await fakeTelegram(t);
	let refuseNext = 2;
	const http: Http = async (url, init) => {
		if (url.endsWith("/sendMessage") && refuseNext > 0) {
			refuseNext--;
			throw refused();
		}
		return fetch(url, init);
	};
	const { host } = await tgHost(t, tg, { http });
	tg.userSays(USER, "hi");
	await until(() => sentTo(tg, USER).length >= 1, "回复");
	await host.settled();
	await sleep(500);
	assert.deepEqual(sentTo(tg, USER), ["收到：hi"]);
});

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

test("发送退避中宿主停止：不再发新请求，宿主立刻停下", async (t) => {
	const tg = await fakeTelegram(t);
	let mode: "refuse" | "hang" = "refuse";
	let refusals = 0;
	let sendsAfterStop = 0;
	const http: Http = async (url, init) => {
		if (url.endsWith("/sendMessage")) {
			if (mode === "hang") {
				sendsAfterStop++;
				return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
			}
			refusals++;
			throw refused();
		}
		return fetch(url, init);
	};
	const { host, stop } = await tgHost(t, tg, { http, timing: { ...FAST, backoffMs: [60_000], stopGraceMs: 5000 } });
	tg.userSays(USER, "hi");
	await until(() => host.kernel.conversation().some((l) => l.text === "收到：hi"), "回复");
	await until(() => refusals >= 1, "第一次发送没连上、进入退避");
	await sleep(100);
	mode = "hang";
	await within(stop(), 1000, "宿主停止");
	assert.equal(sendsAfterStop, 0, "停止后不再开始新的发送");
});

test("停止时正在发的消息被中止：下次启动不重发它，只补一句可能没送到的说明", async (t) => {
	const tg = await fakeTelegram(t);
	const stateDir = tempStateDir();
	let hang = false;
	const http: Http = async (url, init) => {
		const hangThis = hang && url.endsWith("/sendMessage");
		const res = await fetch(url, init);
		if (hangThis) {
			await res.text();
			return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
		}
		return res;
	};
	const first = await tgHost(t, tg, { stateDir, http, brain: () => [], timing: { ...FAST, stopGraceMs: 200 } });
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length === 1, "说明");
	hang = true;
	first.host.say("停机时在发");
	await until(() => sentTo(tg, USER).includes("你在网页或终端说：停机时在发"), "Telegram 收下了");
	await first.stop();
	await tgHost(t, tg, { stateDir, brain: () => [] });
	await until(() => sentTo(tg, USER).includes(NOTES.missed), "可能没送到的说明");
	await sleep(300);
	assert.equal(sentTo(tg, USER).filter((m) => m === "你在网页或终端说：停机时在发").length, 1);
});

test("Telegram 给的 retry_after 是 0 或大得离谱：按 1 秒到 1 小时之间等，日志写实际等的秒数", async (t) => {
	for (const [retryAfter, waits] of [[0, "1 秒后重试"], [2 ** 31, "3600 秒后重试"]] as const) {
		const tg = await fakeTelegram(t);
		tg.fail("getUpdates", 429, { parameters: { retry_after: retryAfter } });
		const { logs, stop } = await tgHost(t, tg);
		await until(() => tg.calls("getUpdates").length >= 1, "第一次取消息");
		await sleep(700);
		assert.ok(tg.calls("getUpdates").length <= 2, `retry_after ${retryAfter}：700 ms 里取了 ${tg.calls("getUpdates").length} 次`);
		assert.ok(logs.some((l) => l.includes(waits)), logs.join("\n"));
		await within(stop(), 1000, "等待中宿主停止");
	}
});

test("Telegram 收下了消息、本地记账失败：不重发，日志说本地出错，不说发送失败", async (t) => {
	const tg = await fakeTelegram(t);
	const original = TelegramStore.prototype.sent;
	let calls = 0;
	t.mock.method(TelegramStore.prototype, "sent", function (this: TelegramStore, ...args: Parameters<TelegramStore["sent"]>) {
		if (calls++ === 0) throw new Error("database is locked");
		return original.apply(this, args);
	});
	const { host, logs } = await tgHost(t, tg);
	tg.userSays(USER, "hi");
	await until(() => sentTo(tg, USER).length >= 1, "回复");
	await host.settled();
	await sleep(500);
	assert.deepEqual(sentTo(tg, USER), ["收到：hi"]);
	assert.ok(calls >= 2, "记账重试过");
	assert.ok(!logs.some((l) => l.includes("发消息失败")), logs.join("\n"));
	assert.ok(logs.some((l) => l.includes("database is locked")), logs.join("\n"));
});

test("Telegram 的本地表读写各抛错一次：宿主不崩，之后照常收发", async (t) => {
	const tg = await fakeTelegram(t);
	for (const method of ["next", "setNextUpdateId"] as const) {
		const original = TelegramStore.prototype[method] as (...args: unknown[]) => unknown;
		let thrown = false;
		t.mock.method(TelegramStore.prototype, method, function (this: TelegramStore, ...args: unknown[]) {
			if (!thrown) {
				thrown = true;
				throw new Error(`${method} 出错`);
			}
			return original.apply(this, args);
		});
	}
	const { host, logs } = await tgHost(t, tg);
	tg.userSays(USER, "hi");
	await until(() => sentTo(tg, USER).includes("收到：hi"), "回复");
	await host.settled();
	assert.deepEqual(host.kernel.conversation().filter((l) => l.who === "user").map((l) => l.text), ["hi"]);
	assert.ok(logs.some((l) => l.includes("next 出错")) && logs.some((l) => l.includes("setNextUpdateId 出错")), logs.join("\n"));
});

test("把一条 Telegram 消息交给幕僚长时出错：不丢，重试后进对话一次", async (t) => {
	const tg = await fakeTelegram(t);
	const { host } = await tgHost(t, tg);
	const original = host.kernel.userSaid.bind(host.kernel);
	let calls = 0;
	t.mock.method(host.kernel, "userSaid", (input: Parameters<Kernel["userSaid"]>[0]) => {
		if (calls++ === 0) throw new Error("内核暂时写不进去");
		return original(input);
	});
	tg.userSays(USER, "hi");
	await until(() => sentTo(tg, USER).includes("收到：hi"), "回复", 4000);
	await host.settled();
	assert.deepEqual(host.kernel.conversation().filter((l) => l.who === "user").map((l) => l.text), ["hi"]);
});

test("一条消息连续 5 次交不出去：跳过它，日志不写内容和 id，后面的消息照常", async (t) => {
	const tg = await fakeTelegram(t);
	const { host, logs } = await tgHost(t, tg);
	const original = host.kernel.userSaid.bind(host.kernel);
	let tries = 0;
	t.mock.method(host.kernel, "userSaid", (input: Parameters<Kernel["userSaid"]>[0]) => {
		if (input.text === "坏") {
			tries++;
			throw new Error("内核写不进去");
		}
		return original(input);
	});
	const bad = tg.userSays(USER, "坏");
	tg.userSays(USER, "好");
	await until(() => sentTo(tg, USER).includes("收到：好"), "后面的消息照常", 5000);
	assert.equal(tries, 5);
	const skipped = logs.filter((l) => l.includes("跳过"));
	assert.equal(skipped.length, 1, logs.join("\n"));
	assert.ok(!skipped[0].includes("坏") && !skipped[0].includes(String(bad)) && !skipped[0].includes(String(USER)), skipped[0]);
	assert.deepEqual(host.kernel.conversation().filter((l) => l.who === "user").map((l) => l.text), ["好"]);
});

test("退避最长 30 秒", async () => {
	const { DEFAULT_TIMING } = (await import("../src/host/telegram/client.ts")) as { DEFAULT_TIMING?: { backoffMs: readonly number[] } };
	assert.ok(DEFAULT_TIMING, "DEFAULT_TIMING 导出");
	assert.equal(Math.max(...DEFAULT_TIMING.backoffMs), 30_000);
});

test("Telegram 收下每条、却一直回 502：每条回复只到一次，单独的说明最多一句，之后的回复开头带说明；恢复后带说明的那条发出就不再带", async (t) => {
	const tg = await fakeTelegram(t);
	let bad = true;
	const http: Http = (url, init) => (bad ? acceptedThen502(url, init) : fetch(url, init));
	const { host } = await tgHost(t, tg, { http });
	const replies = [1, 2, 3, 4, 5, 6].map((i) => `收到：m${i}`);
	for (const [i, reply] of replies.entries()) {
		tg.userSays(USER, `m${i + 1}`);
		await until(() => sentTo(tg, USER).map(unnoted).includes(reply), reply);
	}
	await until(() => sentTo(tg, USER).includes(NOTES.missed), "单独的说明");
	await host.settled();
	await sleep(500);
	const texts = sentTo(tg, USER);
	assert.deepEqual(texts.filter((m) => m !== NOTES.missed).map(unnoted), replies, `每条回复只到一次：${texts.join(" | ")}`);
	assert.equal(texts.filter((m) => m === NOTES.missed).length, 1, `单独的说明只有一句：${texts.join(" | ")}`);
	assert.ok(texts.every((m) => unnoted(unnoted(m)) === unnoted(m)), "没有哪条带两句说明");
	assert.ok(texts.includes(noted("收到：m6")), `说不准到没到的消息不算还清：${texts.join(" | ")}`);
	bad = false;
	tg.userSays(USER, "again");
	await until(() => sentTo(tg, USER).includes(noted("收到：again")), "恢复后带说明的回复");
	tg.userSays(USER, "again2");
	await until(() => sentTo(tg, USER).includes("收到：again2"), "之后的回复不带说明");
});

test("说明本身没发出去（连不上）：说明重试，手机上只到一次", async (t) => {
	const tg = await fakeTelegram(t);
	let sends = 0;
	const http: Http = async (url, init) => {
		if (!url.endsWith("/sendMessage")) return fetch(url, init);
		sends++;
		if (sends === 2) throw refused();
		const res = await fetch(url, init);
		if (sends === 1) {
			await res.text();
			return new Response("<html>502 Bad Gateway</html>", { status: 502 });
		}
		return res;
	};
	const { host } = await tgHost(t, tg, { http });
	tg.userSays(USER, "hi");
	await until(() => sentTo(tg, USER).includes(NOTES.missed), "可能没送到的说明");
	await host.settled();
	await sleep(500);
	assert.deepEqual(sentTo(tg, USER), ["收到：hi", NOTES.missed]);
});

test("启动时本地状态读写失败两次：Telegram 客户端过一会儿自己开始取消息，宿主照常，日志只记一行", async (t) => {
	const tg = await fakeTelegram(t);
	const original = TelegramStore.prototype.claim;
	let failures = 2;
	t.mock.method(TelegramStore.prototype, "claim", function (this: TelegramStore, ...args: Parameters<TelegramStore["claim"]>) {
		if (failures-- > 0) throw new Error("database is locked");
		return original.apply(this, args);
	});
	const { host, logs } = await tgHost(t, tg);
	host.say("网页照常");
	await until(() => host.kernel.conversation().some((l) => l.text === "收到：网页照常"), "网页上的回复");
	tg.userSays(USER, "hi");
	await until(() => sentTo(tg, USER).includes("收到：hi"), "Telegram 上的回复", 5000);
	assert.equal(logs.filter((l) => l.includes("database is locked")).length, 1, logs.join("\n"));
});
