import assert from "node:assert/strict";
import test from "node:test";
import { Host } from "../../src/host/host.ts";
import type { Router } from "../../src/host/router.ts";
import { BotApi, BotToken } from "../../src/host/telegram/bot-api.ts";
import { FAKE_BOT_TOKEN, FakeTelegram, unmarked } from "../helpers/fake-telegram.ts";
import { defaultWorkerModels, FakeSpawner, fauxRouter, ids, openOnConversation, tempStateDir, until, type Brain, type ToolCallSpec, type WorkerScript } from "../helpers/fakes.ts";

const opensTickets: Brain = (cards) => cards.flatMap((c) => (c.startsWith("[对话]") ? openOnConversation(c) : []));

async function hostWith(stateDir: string, brain: Brain, routerOptions = {}) {
	const router = fauxRouter(brain, { persist: true, ...routerOptions });
	const spawner = new FakeSpawner((w) => w.settle());
	const host = await Host.start({ stateDir, createRouter: router.createRouter, createSpawner: () => spawner, log: () => {}, workerModels: defaultWorkerModels() });
	spawner.request = (...a) => host.workers.handleRequest(...a);
	return { host, router };
}

const titles = (host: Host) => host.kernel.listTickets().map((r) => r.title).sort();

test("Router 处理到一半时宿主停掉，重启后接着处理那句话", async (t) => {
	const stateDir = tempStateDir();
	const first = await hostWith(stateDir, () => new Promise(() => {}));
	t.after(() => first.host.stop());
	first.host.say("查下周的航班");
	await until(() => first.router.batches.length === 1, "第一轮开始");
	await first.host.stop();

	const second = await hostWith(stateDir, opensTickets);
	t.after(() => second.host.stop());
	await until(() => titles(second.host).length === 1, "重启后处理了那句话");
	assert.deepEqual(titles(second.host), ["查下周的航班"]);
});

test("Router 忙时到达、还没写进会话的话，宿主停掉后重启会重新送达", async (t) => {
	const stateDir = tempStateDir();
	const first = await hostWith(stateDir, () => new Promise(() => {}));
	t.after(() => first.host.stop());
	first.host.say("任务甲");
	await until(() => first.router.batches.length === 1, "第一轮开始");
	first.host.say("任务乙");
	await new Promise((r) => setTimeout(r, 100));
	await first.host.stop();

	const second = await hostWith(stateDir, opensTickets);
	t.after(() => second.host.stop());
	await until(() => titles(second.host).length === 2, "两句话都被处理");
	assert.deepEqual(titles(second.host), ["任务乙", "任务甲"]);
});

test("Router 一轮以普通模型错误结束时，退避后重试，直到处理完", async (t) => {
	let calls = 0;
	const { host } = await hostWith(tempStateDir(), opensTickets, { failOn: () => (++calls <= 4 ? "500 Internal Server Error" : undefined) });
	t.after(() => host.stop());
	host.say("整理下载目录");
	await until(() => titles(host).length === 1, "错误之后重试并处理完", 5000);
});

test("清屏换一个新的 Router 会话：会话 id 变了，新会话里没有清屏前的话，宿主重启后也不接回旧会话", async (t) => {
	const stateDir = tempStateDir();
	const first = await hostWith(stateDir, opensTickets);
	t.after(() => first.host.stop());
	first.host.say("记一下旧的话");
	await until(() => titles(first.host).length === 1, "第一句处理完");
	const session = () => (first.host.router as Router).session;
	const oldId = session().sessionManager.getSessionId();
	const remembers = (s: Router["session"]) => JSON.stringify(s.messages).includes("记一下旧的话");
	assert.ok(remembers(session()), "清屏前会话里有这句话");
	first.host.clearConversation();
	await until(() => session().sessionManager.getSessionId() !== oldId, "清屏后换了会话");
	assert.ok(!remembers(session()), "新会话里没有清屏前的话");
	await first.host.stop();

	const second = await hostWith(stateDir, opensTickets);
	t.after(() => second.host.stop());
	const restarted = (second.host.router as Router).session;
	assert.notEqual(restarted.sessionManager.getSessionId(), oldId);
	assert.ok(!remembers(restarted), "重启后没有接回清屏前的会话");
	assert.deepEqual(titles(second.host), ["记一下旧的话"], "任务还在");
});

test("清屏时对话里一行都没有，也换一个新的 Router 会话", async (t) => {
	const { host } = await hostWith(tempStateDir(), opensTickets);
	t.after(() => host.stop());
	const session = () => (host.router as Router).session;
	const oldId = session().sessionManager.getSessionId();
	assert.equal(host.kernel.conversation().length, 0);
	host.clearConversation();
	await until(() => session().sessionManager.getSessionId() !== oldId, "清屏后换了会话");
});

test("对话里一行都没有时清屏，宿主重启后也不接回清屏前的会话", async (t) => {
	const stateDir = tempStateDir();
	const first = await hostWith(stateDir, opensTickets);
	t.after(() => first.host.stop());
	const session = () => (first.host.router as Router).session;
	first.host.kernel.submitTrigger({ source: "generic", externalId: "mail-1", threads: [{ id: "thr_mail" }], sender: "mail", body: "清屏之间来的信", occurredAt: Date.now() });
	await until(() => JSON.stringify(session().messages).includes("清屏之间来的信") && !session().isStreaming, "信进了会话");
	const holding = session().sessionManager.getSessionId();
	assert.equal(first.host.kernel.conversation().length, 0);
	first.host.clearConversation();
	await until(() => session().sessionManager.getSessionId() !== holding, "空对话清屏也换了会话");
	await first.host.stop();

	const second = await hostWith(stateDir, opensTickets);
	t.after(() => second.host.stop());
	const restarted = (second.host.router as Router).session;
	assert.notEqual(restarted.sessionManager.getSessionId(), holding);
	assert.ok(!JSON.stringify(restarted.messages).includes("清屏之间来的信"), "重启后没有接回空对话清屏前的会话");
});

test("清屏后 Router 正在开新会话时说的话，送进新会话并得到回复", async (t) => {
	const echo: Brain = (cards) => cards.flatMap((c) => (c.startsWith("[对话]") ? [{ name: "reply", args: { text: `回：${c.split("使用者：")[1]!.split("\n")[0]}`, cause: ids(c, "trg") } }] : []));
	const { host } = await hostWith(tempStateDir(), echo);
	t.after(() => host.stop());
	const replies = () => [...host.kernel.conversation(500), ...(host.kernel.cleared(500)?.lines ?? [])].filter((l) => l.who === "router").map((l) => l.text);
	host.say("零");
	await until(() => replies().includes("回：零"), "第一句");
	const session = () => (host.router as Router).session;
	const oldId = session().sessionManager.getSessionId();
	host.clearConversation();
	const said: string[] = [];
	while (session().sessionManager.getSessionId() === oldId) {
		said.push(`话${said.length}`);
		host.say(said.at(-1)!);
		await new Promise((r) => setImmediate(r));
	}
	await until(() => said.every((s) => replies().includes(`回：${s}`)), `新会话打开前后说的 ${said.length} 句话都得到回复`, 5000);
});

test("一句话的那一轮模型出错、重试前清屏：新会话里补上那句话，只回一次，重启后也不重回", async (t) => {
	const stateDir = tempStateDir();
	let failing = true;
	const echo: Brain = (cards) => cards.flatMap((c) => (c.startsWith("[对话]") ? [{ name: "reply", args: { text: `回：${c.split("使用者：")[1]!.split("\n")[0]}`, cause: ids(c, "trg") } }] : []));
	const options = { failOn: () => (failing ? "503 overloaded" : undefined), errorRetryMs: [1500] };
	const first = await hostWith(stateDir, echo, options);
	t.after(() => first.host.stop());
	const replies = (host: Host) => [...host.kernel.conversation(500), ...(host.kernel.cleared(500)?.lines ?? [])].filter((l) => l.who === "router").map((l) => l.text);
	const session = () => (first.host.router as Router).session;
	first.host.say("一");
	await until(() => (session().messages.at(-1) as { stopReason?: string } | undefined)?.stopReason === "error" && !session().isStreaming, "那一轮出错", 5000);
	first.host.clearConversation();
	failing = false;
	await new Promise((r) => setTimeout(r, 100));
	first.host.say("二");
	await until(() => replies(first.host).includes("回：二") && replies(first.host).includes("回：一"), "两句都得到回复", 5000);
	await new Promise((r) => setTimeout(r, 1800));
	await first.host.stop();

	const second = await hostWith(stateDir, echo);
	t.after(() => second.host.stop());
	await new Promise((r) => setTimeout(r, 500));
	assert.deepEqual(replies(second.host).filter((x) => x === "回：一"), ["回：一"], "那句话只回了一次");
});

const CANARY = "CANARY-V8Q";
const USER = 42;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const telegram = (url: string) => ({ api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 1, minGapMs: 5 } });
const routerReplies = (host: Host) => [...host.kernel.conversation(500), ...(host.kernel.cleared(500)?.lines ?? [])].filter((l) => l.who === "router").map((l) => l.text);
const erroredOut = (session: Router["session"]) => (session.messages.at(-1) as { stopReason?: string } | undefined)?.stopReason === "error" && !session.isStreaming;

// Replies `回：<said>｜<canary if the session holds it>` to each line and ignores candidate triggers.
async function chatRig(t: test.TestContext, routerOptions: object = {}) {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const hooks: { onSaid?: (said: string) => void } = {};
	const echo: Brain = (cards, _n, _tr, sessionText) => {
		const out: ToolCallSpec[] = [];
		for (const c of cards) {
			if (c.startsWith("[候选触发]")) out.push({ name: "route", args: { decisions: [{ kind: "ignore", triggerId: ids(c, "trg"), reason: "看过了" }] } });
			if (!c.startsWith("[对话]")) continue;
			const said = c.split("使用者：")[1]!.split("\n")[0]!;
			hooks.onSaid?.(said);
			out.push({ name: "reply", args: { text: `回：${said}｜${sessionText.includes(CANARY) ? CANARY : "无"}`, cause: ids(c, "trg") } });
		}
		return out;
	};
	const stateDir = tempStateDir();
	let host!: Host;
	const start = async () => {
		const spawner = new FakeSpawner((w) => w.settle());
		host = await Host.start({ stateDir, createRouter: fauxRouter(echo, { persist: true, ...routerOptions }).createRouter, createSpawner: () => spawner, log: () => {}, workerModels: defaultWorkerModels(), telegram: telegram(tg.url) });
	};
	await start();
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length > 0, "聊天打开");
	t.after(() => host.stop());
	return {
		get host() {
			return host;
		},
		start,
		hooks,
		session: () => (host.router as Router).session,
		count: (prefix: string) => routerReplies(host).filter((x) => x.startsWith(prefix)).length,
		phone: () => tg.sent.filter((m) => m.chatId === USER).map((m) => unmarked(m.text)),
	};
}

// Opens a ticket per line and relays Worker reports, naming the cards each reply answers. `relayOne` relays the
// oldest report of a turn, `relayLast` only the latest, `combine` all of them in one reply. `omit` leaves `answers`
// out and, when a reply is refused, sends it again naming its cards. `failOnceRelayed` makes every model call fail
// once that many relays reached the user.
async function taskRig(t: test.TestContext, script: WorkerScript, options: { stateDir?: string; retry?: number[] } = {}) {
	const st = { failing: false, failNext: false, relayOne: false, relayLast: false, combine: false, failAfterLine: false, omit: false, failOnceRelayed: 0 };
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const pending: string[] = [];
	let sent: ToolCallSpec[] = [];
	const named = (spec: ToolCallSpec) => ({ ...spec, args: { ...spec.args, answers: (spec as { cards?: string[] }).cards!.map((c) => ids(c, "act")) } });
	const brain: Brain = (cards, _n, results) => {
		const refused = sent.filter((spec, i) => spec.name === "reply" && results[i]?.includes('"ok": false'));
		sent = [];
		if (refused.length) return (sent = refused.map(named));
		const out: ToolCallSpec[] = [];
		for (const c of cards) {
			if (c.startsWith("[对话]")) {
				out.push(...openOnConversation(c));
				if (st.failAfterLine) st.failing = true;
			}
			if (c.startsWith("[Worker")) pending.push(c);
		}
		const take = st.relayOne ? pending.splice(0, 1) : st.relayLast ? pending.splice(0).slice(-1) : pending.splice(0);
		const relay = (cards: string[]) => {
			const spec = { name: "reply", args: { text: `转达：${cards.map((c) => c.split("\n")[1]).join("＋")}`, cause: ids(cards[0]!, "tkt") }, cards };
			return st.omit ? spec : named(spec);
		};
		if (st.combine && take.length) out.push(relay(take));
		else for (const c of take) out.push(relay([c]));
		if (take.length && st.failNext) st.failing = true;
		return (sent = out);
	};
	const stateDir = options.stateDir ?? tempStateDir();
	let host!: Host;
	const start = async () => {
		const spawner = new FakeSpawner(script);
		host = await Host.start({
			stateDir,
			createRouter: fauxRouter(brain, { persist: true, failOn: () => (st.failing || (st.failOnceRelayed > 0 && relays() >= st.failOnceRelayed) ? "boom: overloaded" : undefined), errorRetryMs: options.retry ?? [1500] }).createRouter,
			createSpawner: () => spawner,
			log: () => {},
			workerModels: defaultWorkerModels(),
			telegram: telegram(tg.url),
		});
		spawner.request = (...a) => host.workers.handleRequest(...a);
	};
	const relays = () => routerReplies(host).filter((x) => x.startsWith("转达")).length;
	await start();
	t.after(() => host.stop());
	return {
		st,
		pending,
		get host() {
			return host;
		},
		start,
		session: () => (host.router as Router).session,
		count: (text: string) => routerReplies(host).filter((x) => x.startsWith(text)).length,
		mentions: (text: string) => routerReplies(host).filter((x) => x.includes(text)).length,
	};
}

test("G：回复了一句话之后同一轮的下一次模型调用出错、重试前清屏：那句话只回一次", async (t) => {
	let failing = false;
	const r = await chatRig(t, { failOn: () => (failing ? "boom: overloaded" : undefined), errorRetryMs: [1500] });
	r.hooks.onSaid = (s) => {
		if (s === "一") failing = true;
	};
	r.host.say("一");
	await until(() => erroredOut(r.session()), "那一轮出错", 5000);
	assert.equal(r.count("回：一"), 1, "出错前已经回了");
	r.host.clearConversation();
	failing = false;
	r.hooks.onSaid = undefined;
	await sleep(100);
	r.host.say("二");
	await until(() => r.count("回：二") > 0, "二", 5000);
	await sleep(2500);
	assert.equal(r.count("回：一"), 1);
});

test("G0：回复了一句话之后同一轮的下一次模型调用出错，重试后那句话只回一次", async (t) => {
	let failing = false;
	const r = await chatRig(t, { failOn: () => (failing ? "boom: overloaded" : undefined), errorRetryMs: [300] });
	r.hooks.onSaid = (s) => {
		if (s === "一") failing = true;
	};
	r.host.say("一");
	await until(() => erroredOut(r.session()), "那一轮出错", 5000);
	failing = false;
	r.hooks.onSaid = undefined;
	await sleep(1500);
	r.host.say("二");
	await until(() => r.count("回：二") > 0, "二", 5000);
	await sleep(500);
	assert.equal(r.count("回：一"), 1);
});

test("H：候选那一轮出错、清屏后补进新会话；之后的回复全文发到 Telegram", async (t) => {
	let failing = true;
	const r = await chatRig(t, { failOn: () => (failing ? "boom: overloaded" : undefined), errorRetryMs: [1500] });
	r.host.kernel.submitTrigger({ source: "personal-health/mail", externalId: "h1", threads: [{ id: "thr_h1" }], sender: "h", body: `检验单 ${CANARY}`, occurredAt: Date.now() });
	await until(() => erroredOut(r.session()), "那一轮出错", 5000);
	r.host.clearConversation();
	failing = false;
	await until(() => !r.session().isStreaming && r.session().messages.length > 0, "新会话看到候选", 5000);
	assert.ok(JSON.stringify(r.session().messages).includes(CANARY), "新会话里有那张卡片");
	r.host.say("二");
	await until(() => r.count("回：二") > 0, "二", 5000);
	await sleep(500);
	await until(() => r.phone().includes(`回：二｜${CANARY}`), "二 全文到了手机", 5000);
});

test("I：清屏时没有没处理完的卡片，新会话不多跑一轮", async (t) => {
	const r = await chatRig(t);
	r.host.say("一");
	await until(() => r.count("回：一") > 0 && !r.session().isStreaming, "一");
	const before = r.session();
	r.host.clearConversation();
	await until(() => r.session() !== before, "换了新会话", 5000);
	await sleep(300);
	assert.equal(r.session().messages.length, 0, "新会话空着");
	r.host.say("二");
	await until(() => r.count("回：二") > 0, "二", 5000);
	assert.equal(r.count("回：一"), 1);
});

test("J：好几句没处理完的话，清屏后按顺序各回一次", async (t) => {
	let failing = true;
	const r = await chatRig(t, { failOn: () => (failing ? "boom: overloaded" : undefined), errorRetryMs: [3000] });
	const said = ["一", "二", "三", "四", "五"];
	for (const s of said) {
		r.host.say(s);
		await sleep(20);
	}
	await until(() => erroredOut(r.session()), "那一轮出错", 5000);
	await sleep(300);
	await until(() => erroredOut(r.session()), "又出错", 5000);
	r.host.clearConversation();
	failing = false;
	await until(() => said.every((s) => r.count(`回：${s}`) > 0), "每句都回了", 8000);
	await sleep(3500);
	for (const s of said) assert.equal(r.count(`回：${s}`), 1, `${s} 回了几次`);
	const order = routerReplies(r.host).map((x) => x[2]!);
	assert.deepEqual(order.filter((c) => said.includes(c)), said);
});

test("K：出错、清屏后宿主马上停掉，重启：那句话只回一次", async (t) => {
	let failing = true;
	const r = await chatRig(t, { failOn: () => (failing ? "boom: overloaded" : undefined), errorRetryMs: [1500] });
	r.host.say("一");
	await until(() => erroredOut(r.session()), "那一轮出错", 5000);
	r.host.clearConversation();
	await r.host.stop();
	failing = false;
	await r.start();
	await until(() => r.count("回：一") > 0, "重启后回了", 5000);
	await sleep(2500);
	assert.equal(r.count("回：一"), 1);
});

test("T1：转达了任务报告，同一轮出错，清屏：只转达一次", async (t) => {
	const r = await taskRig(t, (w) => {
		w.report({ status: "ready", summary: "完成了" });
		w.settle();
	});
	r.st.failNext = true;
	r.host.say("做事");
	await until(() => erroredOut(r.session()), "转达之后出错", 8000);
	assert.equal(r.count("转达"), 1);
	r.host.clearConversation();
	r.st.failing = r.st.failNext = false;
	await sleep(3000);
	assert.equal(r.count("转达"), 1);
});

test("T1b：转达了任务报告，同一轮出错，重试：只转达一次", async (t) => {
	const r = await taskRig(
		t,
		(w) => {
			w.report({ status: "ready", summary: "完成了" });
			w.settle();
		},
		{ retry: [300] },
	);
	r.st.failNext = true;
	r.host.say("做事");
	await until(() => erroredOut(r.session()), "转达之后出错", 8000);
	r.st.failing = r.st.failNext = false;
	await sleep(2500);
	assert.equal(r.count("转达"), 1);
});

test("T2：同一任务的两份报告进了一轮，只转达了第一份就出错、清屏：第二份照样转达", async (t) => {
	const r = await taskRig(t, (w) => {
		w.report({ status: "blocked", summary: "卡住了" });
		w.report({ status: "ready", summary: "完成了" });
		w.settle();
	});
	r.st.failNext = r.st.relayOne = true;
	r.host.say("做事");
	await until(() => erroredOut(r.session()), "转达第一份之后出错", 8000);
	r.pending.splice(0);
	r.host.clearConversation();
	r.st.failing = r.st.failNext = false;
	await sleep(3000);
	assert.equal(r.count("转达：卡住了"), 1);
	assert.equal(r.count("转达：完成了"), 1, "完成了 转达一次");
});

test("T3：回了一句话、那一轮出错，宿主重启后旧会话又出错，再清屏：那句话只回一次", async (t) => {
	const stateDir = tempStateDir();
	const r = await taskRig(t, () => {}, { stateDir, retry: [60000] });
	r.st.failAfterLine = true;
	r.host.say("一");
	await until(() => erroredOut(r.session()), "回复之后出错", 5000);
	r.st.failAfterLine = false;
	assert.equal(r.count("收到：一"), 1);
	await r.host.stop();
	r.st.failing = true;
	await r.start();
	await sleep(1500);
	r.host.clearConversation();
	r.st.failing = false;
	await sleep(3000);
	assert.equal(r.count("收到：一"), 1);
});

test("T3b：回了一句话、那一轮出错，宿主重启、旧会话正常：那句话只回一次", async (t) => {
	const stateDir = tempStateDir();
	const r = await taskRig(t, () => {}, { stateDir, retry: [60000] });
	r.st.failAfterLine = true;
	r.host.say("一");
	await until(() => erroredOut(r.session()), "回复之后出错", 5000);
	r.st.failAfterLine = false;
	await r.host.stop();
	r.st.failing = false;
	await r.start();
	await sleep(2500);
	assert.equal(r.count("收到：一"), 1);
});

const twoReports: WorkerScript = (w) => {
	w.report({ status: "blocked", summary: "卡住了" });
	w.report({ status: "ready", summary: "完成了" });
	w.settle();
};

test("A1：同一任务的两份报告进了一轮，只转达了后一份就出错、清屏：前一份补转达，后一份不重发", async (t) => {
	const r = await taskRig(t, twoReports);
	r.st.failNext = r.st.relayLast = true;
	r.host.say("做事");
	await until(() => erroredOut(r.session()), "转达后一份之后出错", 8000);
	r.host.clearConversation();
	r.st.failing = r.st.failNext = false;
	await sleep(3000);
	assert.equal(r.mentions("完成了"), 1, "完成了 转达一次");
	assert.equal(r.mentions("卡住了"), 1, "卡住了 补转达一次");
});

test("A2：同一任务的两份报告合成一句转达，出错、清屏：两份都不重发", async (t) => {
	const r = await taskRig(t, twoReports);
	r.st.failNext = r.st.combine = true;
	r.host.say("做事");
	await until(() => erroredOut(r.session()), "合并转达之后出错", 8000);
	r.host.clearConversation();
	r.st.failing = r.st.failNext = false;
	await sleep(3000);
	assert.equal(r.mentions("完成了"), 1, "完成了 转达一次");
	assert.equal(r.mentions("卡住了"), 1, "卡住了 转达一次");
});

test("A3：只转达了后一份就出错，宿主重启：前一份补转达，后一份不重发", async (t) => {
	const r = await taskRig(t, twoReports, { retry: [60000] });
	r.st.failNext = r.st.relayLast = true;
	r.host.say("做事");
	await until(() => erroredOut(r.session()), "转达后一份之后出错", 8000);
	await r.host.stop();
	r.st.failing = r.st.failNext = false;
	await r.start();
	await sleep(3000);
	assert.equal(r.mentions("完成了"), 1, "完成了 转达一次");
	assert.equal(r.mentions("卡住了"), 1, "卡住了 补转达一次");
});

test("P1：两份报告进了一轮，只转达后一份、没列 answers：回复被拒，重发时列出卡片；出错、清屏后前一份补转达一次", async (t) => {
	const r = await taskRig(t, twoReports);
	r.st.omit = r.st.relayLast = true;
	r.st.failOnceRelayed = 1;
	r.host.say("做事");
	await until(() => erroredOut(r.session()), "转达后一份之后出错", 8000);
	r.host.clearConversation();
	r.st.failOnceRelayed = 0;
	await sleep(3000);
	assert.equal(r.mentions("完成了"), 1, "完成了 转达一次");
	assert.equal(r.mentions("卡住了"), 1, "卡住了 补转达一次，0 就是汇报丢了");
});

test("P2：两份报告进了一轮，只转达前一份、没列 answers，出错后宿主重启：后一份补转达一次", async (t) => {
	const r = await taskRig(t, twoReports, { retry: [60000] });
	r.st.omit = r.st.relayOne = true;
	r.st.failOnceRelayed = 1;
	r.host.say("做事");
	await until(() => erroredOut(r.session()), "转达前一份之后出错", 8000);
	await r.host.stop();
	r.pending.splice(0);
	r.st.failOnceRelayed = 0;
	await r.start();
	await sleep(3000);
	assert.equal(r.mentions("卡住了"), 1, "卡住了 转达一次");
	assert.equal(r.mentions("完成了"), 1, "完成了 补转达一次，0 就是汇报丢了");
});
