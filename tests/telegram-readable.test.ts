import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BotApi, BotToken } from "../src/host/telegram/bot-api.ts";
import { TelegramClient, type TelegramHost, type TelegramTiming } from "../src/host/telegram/client.ts";
import { DOTS, NOTES, render, type CardView } from "../src/host/telegram/rules.ts";
import { TelegramStore } from "../src/host/telegram/store.ts";
import { openStore } from "../src/kernel/store.ts";
import { FAKE_BOT_TOKEN, FakeTelegram } from "./helpers/fake-telegram.ts";
import { tempStateDir, until } from "./helpers/fakes.ts";

const reply = (text: string, ticketId?: string) => ({ kind: "line" as const, role: "router" as const, text, silent: false, ...(ticketId && { ticketId }) });
const MAX = 4000;
const TAGS = /<\/?(b|i|s|code|pre|a|blockquote)(?:\s[^>]*)?>/g;

/** Telegram refuses tags that do not nest; this is the same check. */
function assertWellFormed(html: string) {
	const open: string[] = [];
	for (const [tag, name] of html.matchAll(TAGS)) {
		if (tag.startsWith("</")) assert.equal(open.pop(), name, `${tag} 关错了：${html}`);
		else open.push(name);
	}
	assert.deepEqual(open, [], `没关上的标签：${html}`);
	assert.equal(html.replace(TAGS, "").match(/<|>/), null, `多出来的尖括号：${html}`);
	assert.equal(html.replace(/&(lt|gt|amp|quot);/g, "").includes("&"), false, `没转义的 &：${html}`);
}

const visible = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

test("角色标记：幕僚长 🧭 加粗名字，系统 ⚙️，通知 🔔，助手的问题 🙋；纯文本版本没有标签", () => {
	const router = render(reply("收到。"));
	assert.equal(router.text, "🧭 <b>幕僚长</b>：收到。");
	assert.equal(router.plain, "🧭 幕僚长：收到。");
	assert.equal(render({ kind: "line", role: "system", text: "你在网页或终端说：x", silent: true }).text, "⚙️ 你在网页或终端说：x");
	assert.equal(render({ kind: "line", role: "notice", text: "提醒 · 邮件：<老板> & 你", silent: false, noPreview: true }).text, "🔔 提醒 · 邮件：&lt;老板&gt; &amp; 你");
	assert.equal(render({ kind: "note", text: NOTES.cap }).text, `⚙️ ${NOTES.cap}`);
	const view: CardView = { reportId: "rpt_1", ticketId: "tkt_1", title: "查天气", helper: "星槎 · 对话助手 #4", question: "查哪个城市？", options: ["北京"], status: { kind: "open" } };
	assert.equal(render({ kind: "card", view }).text, "🙋 星槎 · 对话助手 #4 问你（任务「查天气」）：\n查哪个城市？");
});

test("可能漏发的说明放在最前面，带系统标记", () => {
	assert.equal(render(reply("收到。"), true).plain, `⚙️ ${NOTES.missed}\n🧭 幕僚长：收到。`);
	assert.equal(render({ kind: "note", text: "" }, true).plain, `⚙️ ${NOTES.missed}`);
});

test("任务圆点：同一任务的消息都带它的颜色，放在角色标记后面；回复挂在开任务的那条消息下；不属于任务的消息没有圆点", () => {
	assert.equal(DOTS.length, 8);
	const task = { dot: 1, replyTo: 77 };
	const m = render(reply("查好了。", "tkt_1"), false, task);
	assert.equal(m.text, `🧭 ${DOTS[1]} <b>幕僚长</b>：查好了。`);
	assert.equal(m.replyTo, 77);
	const view: CardView = { reportId: "rpt_1", ticketId: "tkt_1", title: "查天气", helper: "星槎 · 对话助手 #4", question: "查哪个城市？", options: [], status: { kind: "open" } };
	assert.ok(render({ kind: "card", view }, false, task).text.startsWith(`🙋 ${DOTS[1]} 星槎`));
	assert.equal(render({ kind: "line", role: "system", text: "任务「x」想运行一条命令，请在网页上批准", silent: false, ticketId: "tkt_1" }, false, { dot: 0, replyTo: null }).text, `⚙️ ${DOTS[0]} 任务「x」想运行一条命令，请在网页上批准`);
	const plain = render(reply("收到。"));
	assert.equal(plain.replyTo, undefined);
	assert.ok(!DOTS.some((d) => plain.text.includes(d)));
});

test("Markdown 转 Telegram HTML：粗体、斜体、行内代码、代码块、链接、引用；标题变粗体行，列表用 •，表格一行一行", () => {
	const html = (md: string) => {
		const { text } = render(reply(md));
		assertWellFormed(text);
		return text;
	};
	assert.equal(html("## 结论"), "🧭 <b>幕僚长</b>：<b>结论</b>");
	assert.equal(html("**NVDA** 今天 *小涨*，`RSI` 在 60，~~不是~~ 下划线_变量_名 snake_case_name 不动。"), "🧭 <b>幕僚长</b>：<b>NVDA</b> 今天 <i>小涨</i>，<code>RSI</code> 在 60，<s>不是</s> 下划线_变量_名 snake_case_name 不动。");
	assert.equal(html("- 第一点\n  - 子项\n\n1. 有序"), "🧭 <b>幕僚长</b>\n• 第一点\n  • 子项\n\n1. 有序");
	assert.equal(html("看这句：\n> 引用一句\n> 第二句"), "🧭 <b>幕僚长</b>\n看这句：\n<blockquote>引用一句\n第二句</blockquote>");
	assert.equal(html("[来源](https://example.com/a?b=1&c=2) 和 **[粗链接](https://example.com)**"), '🧭 <b>幕僚长</b>：<a href="https://example.com/a?b=1&amp;c=2">来源</a> 和 <b><a href="https://example.com">粗链接</a></b>');
	assert.equal(html("```ts\nif (a < b && c) {}\n```"), '🧭 <b>幕僚长</b>\n<pre><code class="language-ts">if (a &lt; b &amp;&amp; c) {}</code></pre>');
	assert.equal(html("| 代码 | 收盘 |\n| --- | ---: |\n| NVDA | 120 |"), "🧭 <b>幕僚长</b>\n<b>代码 | 收盘</b>\nNVDA | 120");
});

test("Markdown 里配不上对的符号和尖括号照原样显示，不会变成标签", () => {
	for (const md of ["2 * 3 = 6，**没关上", "<script>alert(1)</script>", "a **b *c** d*", "[x](javascript:alert(1))", "`没关上的代码", "```\n没关上的代码块"]) {
		const { text } = render(reply(md));
		assertWellFormed(text);
		assert.ok(!text.includes("javascript:alert(1)\""), text);
	}
	assert.equal(visible(render(reply("<script>alert(1)</script>")).text), "🧭 幕僚长：<script>alert(1)</script>");
});

test("长回复：前 5 行直接显示，其余收进可展开的引用；5 行以内不折叠", () => {
	const lines = Array.from({ length: 9 }, (_, i) => `第 ${i + 1} 行`);
	const long = render(reply(lines.join("\n"))).text;
	assertWellFormed(long);
	assert.equal(long, `🧭 <b>幕僚长</b>\n${lines.slice(0, 5).join("\n")}\n<blockquote expandable>${lines.slice(5).join("\n")}</blockquote>`);
	const short = render(reply(lines.slice(0, 5).join("\n"))).text;
	assert.equal(short, `🧭 <b>幕僚长</b>\n${lines.slice(0, 5).join("\n")}`);
	const quoted = render(reply([...lines, "> 尾部的引用"].join("\n"))).text;
	assertWellFormed(quoted);
	assert.equal((quoted.match(/<blockquote/g) ?? []).length, 1, "可展开的引用里不再套引用");
});

test("转换后仍守 4096 字的上限：不切在标签或实体中间，结尾说明全文在网页上；纯文本版本同样不超", () => {
	const paragraphs = Array.from({ length: 400 }, (_, i) => `**第 ${i} 段** 有 <尖括号> & 链接 [x](https://example.com/${i})`).join("\n");
	for (const md of [paragraphs, "```\n" + "x < y & z\n".repeat(800) + "```", "长".repeat(5000)]) {
		const m = render(reply(md));
		assertWellFormed(m.text);
		assert.ok(visible(m.text).length <= MAX, `${visible(m.text).length}`);
		assert.ok(m.plain.length <= MAX);
		assert.ok(m.plain.endsWith("…（全文见网页）"), m.plain.slice(-20));
	}
});

test("卡片编辑和第一次发出用同一套格式：问题文字里的尖括号被转义", () => {
	const view: CardView = { reportId: "rpt_1", ticketId: "tkt_1", title: "a<b", helper: "", question: "选 <A> 还是 <B>？", options: ["A"], status: { kind: "closed", label: "A" } };
	const m = render({ kind: "card", view }, false, { dot: 2, replyTo: 5 });
	assertWellFormed(m.text);
	assert.equal(visible(m.text), m.plain);
	assert.match(m.plain, /^🙋 \S+ 助手问你（任务「a<b」）：\n选 <A> 还是 <B>？\n\n已结束：你选了「A」$/u);
});

test("任务的圆点和开任务的消息记在库里：按开任务的先后轮换颜色，重开库后不变；换了 bot 一起清掉", () => {
	const db = openStore(join(tempStateDir(), "state.db"));
	const open = (botId = 123456789) => {
		const store = new TelegramStore(db, botId, () => 1000);
		store.claim(new Set([42]));
		return store;
	};
	let store = open();
	store.received(42, "trg_1", 900);
	for (let i = 1; i <= 9; i++) store.track(`tkt_${i}`, () => (i === 1 ? "trg_1" : null));
	store.track("tkt_1", () => assert.fail("已记下的任务不再问开任务的那条消息"));
	store.put(42, "line:rpl_1", "rpl_1", reply("查好了。", "tkt_1"));
	assert.deepEqual(store.next()?.task, { dot: 0, replyTo: 900 });
	store.sent(store.next()!, 901);
	store = open();
	store.put(42, "line:rpl_2", "rpl_2", reply("又一句。", "tkt_2"));
	assert.deepEqual(store.next()?.task, { dot: 1, replyTo: null });
	store.sent(store.next()!, 902);
	store.put(42, "line:rpl_9", "rpl_9", reply("第九个任务。", "tkt_9"));
	assert.deepEqual(store.next()?.task, { dot: 0, replyTo: null }, "八种颜色轮一圈");
	store.sent(store.next()!, 903);
	store.put(42, "line:rpl_3", "rpl_3", reply("没有任务的话。"));
	assert.equal(store.next()?.task, null);
	open(999999999);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM telegram_tasks").get() as { n: number }).n, 0);
});

const USER = 42;
const FAST: Partial<TelegramTiming> = { pollTimeoutSec: 2, minGapMs: 20, backoffMs: [100, 200], conflictBackoffMs: 200, stopGraceMs: 500 };

async function client(t: TestContext, tg: FakeTelegram, stateDir: string) {
	let said = 0;
	const host: TelegramHost = {
		say: () => `trg_${++said}`,
		sayQuoting: () => null,
		answer: () => ({ ok: true, triggerId: "trg_x" }),
		board: () => ({ rows: [], memberCap: null }),
		originOf: (ticketId) => (ticketId === "tkt_a" ? "trg_1" : ticketId === "tkt_b" ? "trg_2" : null),
	};
	const db = openStore(join(stateDir, "state.db"));
	const c = new TelegramClient({ api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: FAST, host, db, clock: { now: () => Date.now() }, log: () => {} });
	c.start();
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await c.stop();
		db.close();
	};
	t.after(stop);
	return { c, stop };
}

test("两个任务交错时：每条回复挂在自己那句问话下，带各自的颜色；重启宿主后颜色和挂靠不变", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const stateDir = tempStateDir();
	let { c, stop } = await client(t, tg, stateDir);
	const askA = tg.messageIdOf(tg.userSays(USER, "查 NVDA"));
	const askB = tg.messageIdOf(tg.userSays(USER, "看看邮件"));
	await until(() => tg.calls("getUpdates").length >= 2, "两句话都收下了");
	await new Promise((r) => setTimeout(r, 200));
	c.broadcast({ type: "reply", text: "邮件：没有新的。", at: Date.now(), replyId: "rpl_1", ticketId: "tkt_b" });
	c.broadcast({ type: "reply", text: "NVDA **120**", at: Date.now(), replyId: "rpl_2", ticketId: "tkt_a" });
	c.broadcast({ type: "reply", text: "好的。", at: Date.now(), replyId: "rpl_3" });
	await until(() => tg.sent.length === 3, "三条回复都发出");
	const [b, a, plain] = tg.sent;
	assert.equal(b.replyTo, askB);
	assert.equal(a.replyTo, askA);
	assert.equal(plain.replyTo, null);
	assert.equal(a.text, `🧭 ${DOTS[1]} 幕僚长：NVDA 120`);
	assert.equal(b.text, `🧭 ${DOTS[0]} 幕僚长：邮件：没有新的。`);
	assert.equal(plain.text, "🧭 幕僚长：好的。");
	assert.equal(a.parseMode, "HTML");
	await stop();
	({ c } = await client(t, tg, stateDir));
	c.broadcast({ type: "reply", text: "NVDA 收盘了。", at: Date.now(), replyId: "rpl_4", ticketId: "tkt_a" });
	await until(() => tg.sent.length === 4, "重启后的回复发出");
	assert.equal(tg.sent[3].replyTo, askA);
	assert.equal(tg.sent[3].text, `🧭 ${DOTS[1]} 幕僚长：NVDA 收盘了。`);
});

test("Telegram 不认 HTML（400 can't parse entities）时改发纯文本：消息不会因为格式丢掉", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const { c } = await client(t, tg, tempStateDir());
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length === 1, "聊天打开");
	tg.rejectHtml = true;
	c.broadcast({ type: "reply", text: "**很重要**", at: Date.now(), replyId: "rpl_1" });
	await until(() => tg.sent.length === 2, "纯文本发出");
	assert.equal(tg.sent[1].text, "🧭 幕僚长：很重要");
	assert.equal(tg.sent[1].parseMode, null);
});
