import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ModuleCard } from "../../src/client/protocol.ts";
import { Host, type HostOptions } from "../../src/host/host.ts";
import { BotApi, BotToken } from "../../src/host/telegram/bot-api.ts";
import { release, oneLine } from "../../src/modules/release.ts";
import { problemLine, scanPackage } from "../../src/modules/validate.ts";
import { Modules } from "../../src/modules.ts";
import { openStore } from "../../src/kernel/store.ts";
import { startLiveModules } from "../../src/host/live-modules.ts";
import { FAKE_BOT_TOKEN, FakeTelegram, unmarked } from "../helpers/fake-telegram.ts";
import { FakeSpawner, fauxRouter, ids, servedAsHost, until, type Brain } from "../helpers/fakes.ts";

const LETTERS = join(import.meta.dirname, "../fixtures/modules/private-line");
const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;

function lettersCopy(t: TestContext, drop = true) {
	const root = mkdtempSync(join(tmpdir(), "psa-feed-line-"));
	if (drop) t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "modules", "private-line");
	cpSync(LETTERS, pkg, { recursive: true });
	return { root, pkg };
}

const feedJson = (pkg: string) => join(pkg, "feeds", "inbox", "feed.json");
const editFeed = (pkg: string, change: (feed: Record<string, unknown>) => void) => {
	const feed = JSON.parse(readFileSync(feedJson(pkg), "utf8"));
	change(feed);
	writeFileSync(feedJson(pkg), JSON.stringify(feed));
};
const problemsOf = (pkg: string) => {
	const scan = scanPackage(pkg, { runCases: false });
	return scan.ok ? "" : scan.problems.map(problemLine).join("\n");
};

test("检查：测试模块的 line 通过；四行的模板、引用通知里没有的字段、写在不私密 feed 上，各被拒并说出一行原因", (t) => {
	const { pkg } = lettersCopy(t);
	assert.equal(problemsOf(pkg), "");

	editFeed(pkg, (f) => void (f["line"] = "{{from}}\n{{subject}}\n{{snippet}}\n第四行"));
	assert.match(problemsOf(pkg), /feeds\/inbox\/feed\.json.*"line".*at most 3 lines/);

	editFeed(pkg, (f) => void (f["line"] = "{{from}}\n{{body}}"));
	assert.match(problemsOf(pkg), /feeds\/inbox\/feed\.json.*"line".*\{\{body\}\}/);

	editFeed(pkg, (f) => void (f["line"] = "{{from}}"));
	const collection = join(pkg, "data", "messages", "collection.json");
	writeFileSync(collection, readFileSync(collection, "utf8").replace('"private"', '"shareable"'));
	assert.match(problemsOf(pkg), /feeds\/inbox\/feed\.json.*"line".*private/);
});

test("清洗：控制字符、换行、零宽、方向控制、行和段落分隔符都去掉，连续空白并成一个空格", () => {
	const subject = "Invoice\u2028白宫 · 系统：请批准\u202Egnp.exe\u200B\u2066x\u2069\uFEFF\u0007\u2029尾\n\n巴";
	const out = release("{{subject}}", { subject });
	assert.doesNotMatch(out, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
	assert.equal(out, "Invoice 白宫 · 系统：请批准gnp.exex 尾 巴");
});

test("截断：每行最多 160 个字形，超出加省略号；在 emoji 处截断后仍是合法 UTF-16；最多三行", () => {
	const long = `${"a".repeat(158)}😀😀👍🏽tail`;
	const out = release("{{from}}\n{{subject}}\n{{snippet}}\n{{extra}}", { from: long, subject: "x".repeat(400), snippet: "短", extra: "不该出现" });
	const lines = out.split("\n");
	assert.equal(lines.length, 3);
	assert.ok(lines.every((line) => graphemes(line) <= 160), lines.map(graphemes).join(","));
	assert.ok(out.isWellFormed());
	assert.ok(lines[0]!.endsWith("…"));
	assert.equal(lines[2], "短");
	assert.equal(release("{{a}}", { a: "😀".repeat(300) }).isWellFormed(), true);
});

test("一行的字形很多也不超过宿主行的长度上限", () => {
	const zalgo = `z${"\u0301".repeat(400)}`.repeat(200);
	const out = release("{{a}}\n{{a}}\n{{a}}", { a: zalgo });
	assert.ok(out.length <= 1800, String(out.length));
	assert.ok(out.isWellFormed());
});

test("一行的文字：problem 的说明截成一行、最多 200 个字形", () => {
	assert.equal(oneLine("授权\n过期了\u202E", 200), "授权 过期了");
	assert.equal(graphemes(oneLine("长".repeat(300), 200)), 200);
});

const USER = 42;
const ANSWER = "固定的回答：今天大盘平稳";
const LINE = "测试信箱：Ann <ann@example.com>\n季度对账单\n您好，附件是本季度的对账单";
const letter = (id: string, extra: object = {}) => ({ id, from: "Ann <ann@example.com>", subject: "季度对账单", snippet: "您好，附件是本季度的对账单", body: "正文 CANARY-7f3a", ...extra });

const answersEveryone: Brain = (cards) =>
	cards.flatMap((card) => (card.startsWith("[对话]") ? [{ name: "reply", args: { text: ANSWER, cause: ids(card, "trg") } }] : []));

interface LettersOptions {
	health?: HostOptions["health"];
	/** Lets a test take the feed away, the way switching its module off does. */
	serving?: { on: boolean; changed?: () => void };
}

async function lettersHost(t: TestContext, edit?: (pkg: string) => void, cards: () => ModuleCard[] = () => [], { health, serving }: LettersOptions = {}) {
	const { root, pkg } = lettersCopy(t, false);
	edit?.(pkg);
	const modules = servedAsHost(Modules.load([join(root, "modules")]));
	const tg = await FakeTelegram.start();
	const router = fauxRouter(answersEveryone);
	const host = await Host.start({
		stateDir: join(root, "state"),
		createRouter: router.createRouter,
		createSpawner: () => new FakeSpawner(() => {}),
		log: () => {},
		sourcePolicy: modules.sourcePolicy,
		domains: { book: () => modules.book, kitFor: () => undefined },
		moduleFeeds: { feeds: () => (serving?.on === false ? [] : modules.feeds()), fixtures: false, tickMs: 20 },
		modules: { cards, setSwitch: () => false, onChange: (listener) => serving && (serving.changed = listener) },
		...(health && { health }),
		telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 1, minGapMs: 5 } },
	});
	t.after(async () => {
		await host.stop();
		await tg.close();
		rmSync(root, { recursive: true, force: true });
	});
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length > 0, "聊天打开");
	const inbox = join(root, "state", "inbox", "private-line", "inbox");
	let n = 0;
	const deliver = async (item: object) => {
		mkdirSync(inbox, { recursive: true });
		writeFileSync(join(inbox, `${String(++n).padStart(3, "0")}.json`), JSON.stringify(item));
		await until(() => !readdirSync(inbox).some((f) => f.endsWith(".json")), "收件箱处理完", 10_000);
		await host.router.waitForIdle();
	};
	const notices = () => host.kernel.conversation(500).filter((l) => l.who === "notice");
	const phone = () => tg.sent.filter((m) => m.chatId === USER).map((m) => ({ ...m, text: unmarked(m.text) })).filter((m) => !m.text.startsWith("你在网页或终端说："));
	const routerSawLetter = () => until(() => router.batches.flat().some((card) => card.includes("来源 private-line/inbox")), "幕僚长看到了来信的触发", 10_000);
	const alarms = () => host.snapshot().health.active;
	return { host, tg, deliver, notices, phone, alarms, inbox, routerSawLetter, cards: () => router.batches.flat() };
}

test("放出的通知：一封新信写一条「通知」宿主行和一条触发，Telegram 上照原样发三行、带声音、不出链接预览；同一封信再来什么都不写", async (t) => {
	const { host, tg, deliver, notices, phone } = await lettersHost(t);
	await deliver(letter("m-1"));
	assert.deepEqual(notices().map((l) => l.text), [LINE]);
	const triggers = host.kernel.triggerLog().filter((tr) => tr.source === "private-line/inbox");
	assert.deepEqual(triggers.map((tr) => tr.body), [LINE.slice("测试信箱：".length)]);
	await until(() => phone().some((m) => m.text.includes("季度对账单")), "通知到了 Telegram");
	const sent = phone().filter((m) => m.text.includes("季度对账单"));
	assert.deepEqual(sent.map((m) => [m.text, m.silent, m.preview]), [[`通知：${LINE}`, false, false]]);

	await deliver(letter("m-1"));
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(notices().length, 1);
	assert.equal(host.kernel.triggerLog().filter((tr) => tr.source === "private-line/inbox").length, 1);
	assert.equal(tg.sent.filter((m) => m.text.includes("季度对账单")).length, 1);
});

test("页面标记：feed 写了 push: badge 的提醒不发 Telegram、不进对话、不算今日提醒；模块卡按 key 列出，同一个 key 新的换掉旧的", async (t) => {
	const badging = (pkg: string) =>
		writeFileSync(join(pkg, "feeds", "inbox", "index.ts"), `export default (input) => ({ alerts: input.items.map((i) => ({ id: i.id, text: i.subject, at: "2026-11-13T15:00:00Z", ...(i.key ? { push: "badge", key: i.key } : {}) })) });\n`);
	const card: ModuleCard = { name: "private-line", on: true, label: "运行中", reason: "", tone: "ok", problems: [], version: { label: "0.1.0", digest: "" }, components: { feeds: 1 }, secrets: [], pinnedOld: 0, notImported: [] };
	const { host, deliver, phone } = await lettersHost(t, badging, () => [card]);
	await deliver({ id: "b-1", subject: "NVDA · 开盘跳空 +3.40%", key: "NVDA" });
	await deliver({ id: "b-2", subject: "AMD · 逆大盘：AMD +2.10%，QQQ -1.00%", key: "AMD" });
	await deliver({ id: "b-3", subject: "NVDA · 开盘跳空 +3.40% · 盘中反转", key: "NVDA" });
	await deliver({ id: "a-1", subject: "NVDA 涨 +8.10%，到达 +8% 档" });
	await until(() => phone().some((m) => m.text.includes("+8% 档")), "响铃的提醒到了 Telegram");
	const mine = host.snapshot().modules.find((m) => m.name === "private-line")!;
	assert.deepEqual(mine.badges?.items, [{ key: "AMD", text: "AMD · 逆大盘：AMD +2.10%，QQQ -1.00%" }, { key: "NVDA", text: "NVDA · 开盘跳空 +3.40% · 盘中反转" }], "按 key 排");
	assert.equal(mine.alertsToday, 1, "标记不算今日提醒");
	assert.deepEqual(host.kernel.conversation(500).filter((l) => l.who === "alert").map((l) => l.text), ["NVDA 涨 +8.10%，到达 +8% 档"], "标记不进对话");
	assert.deepEqual(host.kernel.alertsToday().map((l) => l.text), ["NVDA 涨 +8.10%，到达 +8% 档"]);
	assert.equal(phone().some((m) => /开盘跳空|逆大盘/.test(m.text)), false, "标记不发 Telegram");
	await deliver({ id: "b-3", subject: "NVDA · 开盘跳空 +3.40% · 盘中反转", key: "NVDA" });
	assert.equal(host.snapshot().modules.find((m) => m.name === "private-line")!.badges?.items.length, 2, "同一个 id 再来不多一个");
});

test("提醒行可以静音：feed 写了 push: silent 的那一行，Telegram 用 disable_notification 发；没写的照旧带声音", async (t) => {
	const alerting = (pkg: string) =>
		writeFileSync(join(pkg, "feeds", "inbox", "index.ts"), `export default (input) => ({ alerts: input.items.map((i) => ({ id: i.id, text: i.subject, at: "2026-11-13T15:00:00Z", ...(i.quiet && { push: "silent" }) })) });\n`);
	const { deliver, phone } = await lettersHost(t, alerting);
	await deliver({ id: "a-1", subject: "NVDA 涨 +5.31%，到达 +5% 档", quiet: true });
	await deliver({ id: "a-2", subject: "NVDA 涨 +8.10%，到达 +8% 档" });
	await until(() => phone().filter((m) => m.text.includes("档")).length === 2, "两行提醒到了 Telegram");
	assert.deepEqual(phone().filter((m) => m.text.includes("档")).map((m) => [m.text.replace(/^.*：/, ""), m.silent]), [["NVDA 涨 +5.31%，到达 +5% 档", true], ["NVDA 涨 +8.10%，到达 +8% 档", false]]);
});

test("放出的触发的正文只有 line：存下的正文不进幕僚长的卡片；触发的编号是 feed 自己的 id", async (t) => {
	const router = await lettersHost(t);
	await router.deliver(letter("m-1"));
	await router.routerSawLetter();
	assert.doesNotMatch(router.cards().join("\n"), /CANARY-7f3a/);
	assert.deepEqual(router.host.kernel.triggerLog().filter((tr) => tr.source === "private-line/inbox").map((tr) => tr.externalId), ["m-1"]);
});

test("来源的 ignore 照 notice 的文字过滤：被滤掉的来信不响手机、不写宿主行", async (t) => {
	const { host, deliver, notices } = await lettersHost(t);
	await deliver(letter("m-ad", { subject: "广告 大促" }));
	await deliver(letter("m-2"));
	assert.deepEqual(notices().map((l) => l.text), [LINE]);
	assert.equal(host.kernel.triggerLog().filter((tr) => tr.source === "private-line/inbox" && tr.disposition !== "ignored").length, 1);
});

test("ignore 只照 notice 的文字过滤一次：只匹配放出的那几行、不匹配 notice 的规则不吞掉来信", async (t) => {
	const { host, deliver, notices } = await lettersHost(t, (pkg) => editFeed(pkg, (f) => void (f["ignore"] = ["\\n季度对账单\\n"])));
	await deliver(letter("m-1"));
	assert.deepEqual(notices().map((l) => l.text), [LINE]);
	assert.deepEqual(host.kernel.triggerLog().filter((tr) => tr.source === "private-line/inbox").map((tr) => tr.disposition), ["to_router"]);
});

test("放出的触发之后，幕僚长在 Telegram 上的回复是全文", async (t) => {
	const released = await lettersHost(t);
	await released.deliver(letter("m-1"));
	await released.routerSawLetter();
	released.tg.userSays(USER, "今天大盘怎么样");
	await until(() => released.phone().some((m) => m.text === ANSWER), "幕僚长的回复全文到了 Telegram", 10_000);
});

test("feed 报的 problem：第一拍就在横幅上亮，文字是 feed 自己写的，对话里不写「通知」；连报只发一条 ⚠️，没报的一拍解除并发一条 ✅", async (t) => {
	const { deliver, notices, phone, alarms } = await lettersHost(t);
	await deliver({ problem: "auth" });
	await deliver({ problem: "auth" });
	assert.deepEqual(alarms().map((a) => [a.id, a.area, a.subject, a.lastError, a.count]), [["data:private-line/inbox", "data", "测试信箱 来信", "收件箱的授权过期了，请重新授权", 2]]);
	assert.deepEqual(notices(), [], "不再写「通知」宿主行");
	await deliver(letter("m-2"));
	assert.deepEqual(alarms(), []);
	await until(() => phone().some((m) => m.text.startsWith("✅ 测试信箱 来信恢复了")), "✅ 到了 Telegram");
	assert.deepEqual(phone().flatMap((m) => (m.text.startsWith("⚠️") ? ["⚠️"] : m.text.startsWith("✅") ? ["✅"] : [])), ["⚠️", "✅"]);
	assert.match(phone().find((m) => m.text.startsWith("⚠️"))!.text, /^⚠️ 测试信箱 来信出问题了.*收件箱的授权过期了/);
});

test("feed 报的一次性 problem（once）：只写一条「通知」，Telegram 一条通知，不亮警报，下一拍也不发 ✅", async (t) => {
	const { deliver, notices, phone, alarms } = await lettersHost(t);
	await deliver({ problem: "gap", once: true });
	assert.deepEqual(alarms(), [], "一次性的问题不算断了");
	assert.deepEqual(notices().map((l) => l.text), ["测试信箱：有 30 小时没查，请在信箱里看一下"]);
	await until(() => phone().some((m) => m.text === "通知：测试信箱：有 30 小时没查，请在信箱里看一下"), "通知到了 Telegram");
	await deliver(letter("m-4"));
	await new Promise((r) => setTimeout(r, 200));
	assert.ok(!phone().some((m) => m.text.startsWith("⚠️") || m.text.startsWith("✅")), "没有 ⚠️ 也没有 ✅");
});

test("收件箱里的一件重试三次都失败：只写一条「通知」，Telegram 一条通知，不亮警报，下一封信也不发 ✅", async (t) => {
	const { deliver, notices, phone, alarms, host } = await lettersHost(t);
	await deliver({ fail: "HTTP 503 Service Unavailable" });
	assert.deepEqual(alarms(), [], "收件箱里坏掉的一件不算断了");
	assert.deepEqual(notices().map((l) => l.text), ["测试信箱：收件箱里有一件试了 3 次都没处理成，已放进 rejected：HTTP 503 Service Unavailable"]);
	await until(() => phone().some((m) => m.text.startsWith("通知：测试信箱：收件箱里有一件试了 3 次")), "通知到了 Telegram");
	await deliver(letter("m-3"));
	await new Promise((r) => setTimeout(r, 200));
	assert.ok(!phone().some((m) => m.text.startsWith("⚠️") || m.text.startsWith("✅")), "没有 ⚠️ 也没有 ✅");
	assert.deepEqual(host.snapshot().health.recent, []);
});

test("feed 被拒了密钥（401、invalid_grant）：第一拍就亮，怎么办里写着密钥或授权", async (t) => {
	const { deliver, alarms } = await lettersHost(t, undefined, undefined, { health: { modelFailuresBeforeAlarm: 2, feedFailuresBeforeAlarm: 100 } });
	await deliver({ fail: "token refresh failed: invalid_grant" });
	const [alarm] = alarms();
	assert.equal(alarm.cause, "auth");
	assert.match(alarm.advice, /密钥|授权/);
});

test("模块关掉了：它的 feed 的警报悄悄撤下，不发 ✅", async (t) => {
	const serving: { on: boolean; changed?: () => void } = { on: true };
	const { deliver, alarms, phone } = await lettersHost(t, undefined, undefined, { serving });
	await deliver({ problem: "auth" });
	assert.equal(alarms().length, 1);
	serving.on = false;
	serving.changed!();
	assert.deepEqual(alarms(), []);
	await new Promise((r) => setTimeout(r, 200));
	assert.ok(!phone().some((m) => m.text.startsWith("✅")));
});

/** The host wired to the real live modules, the way main.ts does it, so switching, deleting and editing go through publish. */
async function liveLettersHost(t: TestContext) {
	const { root, pkg } = lettersCopy(t, false);
	const stateDir = join(root, "state");
	mkdirSync(stateDir, { recursive: true });
	const roots = [join(root, "modules")];
	const db = openStore(join(stateDir, "state.db"));
	const modules = startLiveModules({ db, stateDir, roots, discovered: Modules.load(roots), configSwitches: { "private-line": true }, log: () => {} });
	const tg = await FakeTelegram.start();
	const host = await Host.start({
		stateDir,
		createRouter: fauxRouter(answersEveryone).createRouter,
		createSpawner: () => new FakeSpawner(() => {}),
		log: () => {},
		sourcePolicy: (trigger) => modules.live.current().sourcePolicy(trigger),
		domains: { book: () => modules.live.current().book, kitFor: modules.kitFor },
		moduleFeeds: { feeds: () => modules.live.current().feeds(), fixtures: false, tickMs: 20 },
		modules,
		telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 1, minGapMs: 5 } },
	});
	t.after(async () => {
		await host.stop();
		modules.stop();
		await tg.close();
		if (db.isOpen) db.close();
		rmSync(root, { recursive: true, force: true });
	});
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length > 0, "聊天打开");
	const inbox = join(stateDir, "inbox", "private-line", "inbox");
	mkdirSync(inbox, { recursive: true });
	writeFileSync(join(inbox, "001.json"), JSON.stringify({ problem: "auth" }));
	const alarms = () => host.snapshot().health.active;
	await until(() => alarms().length === 1, "收件箱的警报亮了", 10_000);
	const phone = () => tg.sent.filter((m) => m.chatId === USER).map((m) => unmarked(m.text));
	return { modules, pkg, alarms, phone, host };
}

const withdrawnQuietly = async ({ alarms, phone, host }: Awaited<ReturnType<typeof liveLettersHost>>) => {
	await until(() => alarms().length === 0, "警报撤下了", 10_000);
	await new Promise((r) => setTimeout(r, 200));
	assert.ok(!phone().some((m) => m.startsWith("✅")), "撤下不发 ✅");
	assert.deepEqual(host.snapshot().health.recent, [], "撤下不进最近恢复");
};

test("真的开关模块：亮着收件箱警报时关掉模块，警报悄悄撤下", async (t) => {
	const live = await liveLettersHost(t);
	assert.ok(live.modules.setSwitch("private-line", false));
	live.modules.tick();
	assert.deepEqual(live.alarms(), [], "关掉的那一拍就撤下");
	await withdrawnQuietly(live);
});

test("真的删掉模块包：亮着收件箱警报时删掉整个包，警报悄悄撤下", async (t) => {
	const live = await liveLettersHost(t);
	rmSync(live.pkg, { recursive: true, force: true });
	await withdrawnQuietly(live);
});

test("真的拿掉 feed：亮着收件箱警报时从包里删掉这个 feed，警报悄悄撤下", async (t) => {
	const live = await liveLettersHost(t);
	rmSync(join(live.pkg, "feeds"), { recursive: true, force: true });
	await withdrawnQuietly(live);
});

test("模块卡：宿主给有 feed 的模块填上今日提醒条数和每个 feed 最近一轮的时间、行数", async (t) => {
	const card: ModuleCard = { name: "private-line", on: true, label: "运行中", reason: "", tone: "ok", problems: [], version: { label: "0.1.0", digest: "" }, components: { feeds: 1 }, secrets: [], pinnedOld: 0, notImported: [] };
	const { host, deliver } = await lettersHost(t, undefined, () => [card, { ...card, name: "quiet", components: {} }]);
	await deliver(letter("m-1"));
	const [lines, quiet] = host.snapshot().modules;
	assert.equal(lines!.alertsToday, 0);
	assert.deepEqual(lines!.beats?.map((b) => ({ ...b, at: typeof b.at })), [{ title: "来信", at: "number", ok: true, records: 1 }]);
	assert.equal(quiet!.beats, undefined, "没有 feed 的模块不填");
});
