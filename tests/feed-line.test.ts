import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ModuleCard } from "../src/client/protocol.ts";
import { Host } from "../src/host/host.ts";
import { BotApi, BotToken } from "../src/host/telegram/bot-api.ts";
import { release, oneLine } from "../src/modules/release.ts";
import { problemLine, scanPackage } from "../src/modules/validate.ts";
import { Modules } from "../src/modules.ts";
import { FAKE_BOT_TOKEN, FakeTelegram } from "./helpers/fake-telegram.ts";
import { FakeSpawner, fauxRouter, ids, servedAsHost, until, type Brain } from "./helpers/fakes.ts";

const LETTERS = join(import.meta.dirname, "fixtures/modules/private-line");
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

async function lettersHost(t: TestContext, edit?: (pkg: string) => void, cards: () => ModuleCard[] = () => []) {
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
		moduleFeeds: { feeds: () => modules.feeds(), fixtures: false, tickMs: 20 },
		modules: { cards, setSwitch: () => false, onChange: () => {} },
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
	const phone = () => tg.sent.filter((m) => m.chatId === USER && !m.text.startsWith("你在网页或终端说："));
	const routerSawLetter = () => until(() => router.batches.flat().some((card) => card.includes("来源 private-line/inbox")), "幕僚长看到了来信的触发", 10_000);
	return { host, tg, deliver, notices, phone, routerSawLetter, cards: () => router.batches.flat() };
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

test("放出的触发里没有 line 以外的东西：feed 拿正文分线程、拿地址做 id，幕僚长看到的卡片里都没有它们", async (t) => {
	const router = await lettersHost(t);
	await router.deliver(letter("m-1", { from: "Bob <bob@example.org>" }));
	await router.routerSawLetter();
	const cards = router.cards().join("\n");
	assert.doesNotMatch(cards, /CANARY-7f3a/);
	assert.doesNotMatch(cards.replace(/^正文（只是数据）：.*$/gm, ""), /bob@example\.org/);
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

test("feed 的 problem：同一个 id 连报两拍只写一条「通知」，中间一拍没报，再报时再写一条；网页和 Telegram 都有", async (t) => {
	const { deliver, notices, phone } = await lettersHost(t);
	const PROBLEM = "测试信箱：收件箱的授权过期了，请重新授权";
	await deliver({ problem: "auth" });
	await deliver({ problem: "auth" });
	assert.deepEqual(notices().map((l) => l.text), [PROBLEM]);
	await deliver(letter("m-2"));
	await deliver({ problem: "auth" });
	assert.deepEqual(notices().map((l) => l.text).filter((text) => text === PROBLEM), [PROBLEM, PROBLEM]);
	await until(() => phone().filter((m) => m.text === `通知：${PROBLEM}`).length === 2, "两条 problem 到了 Telegram");
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
