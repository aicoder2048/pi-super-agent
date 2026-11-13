import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Modules } from "../src/modules.ts";
import { runFeed, type FeedNotice, type FeedPorts, type FeedProblem } from "../src/modules/feed-runner.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { scanPackage } from "../src/modules/validate.ts";
import { startFakeGoogle } from "./helpers/fake-google.ts";
import { FakeInbox, type Letter } from "./helpers/fake-gmail.ts";
import { servedAsHost } from "./helpers/fakes.ts";

const PKG = join(import.meta.dirname, "../docs/modules/examples/mail");
const SOURCE = "mail/inbox";
const REFRESH = "1//fake-refresh-mail";
const HOUR = 3_600_000;
const GMAIL = "/gmail/v1/users/me";

const ann = (id: string, extra: Partial<Letter> = {}): Letter => ({ id, from: "Ann Lee <ann@example.com>", subject: "季度对账单", snippet: "您好，附件是本季度的对账单", text: "您好，附件是本季度的对账单。", ...extra });
const stranger = (id: string): Letter => ({ id, from: "Promo <deals@example.org>", subject: "大促", snippet: "全场五折", text: "全场五折" });

async function mailFeed(t: TestContext) {
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [REFRESH]: "https://www.googleapis.com/auth/gmail.readonly" } });
	t.after(() => google.close());
	const root = mkdtempSync(join(tmpdir(), "psa-mail-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "modules", "mail");
	cpSync(PKG, pkg, { recursive: true });
	const feedJson = join(pkg, "feeds", "inbox", "feed.json");
	writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), settings: { baseUrl: google.url, tokenUrl: `${google.url}/token` } }));
	const modules = servedAsHost(Modules.load([join(root, "modules")]));
	const entry = modules.feeds().find((e) => e.source === SOURCE);
	assert.ok(entry, "mail 有 inbox feed");
	const data = instanceData(join(root, "state"));
	const notices: FeedNotice[] = [];
	const problems: (FeedProblem | undefined)[] = [];
	const secrets: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: google.client.id, GOOGLE_OAUTH_CLIENT_SECRET: google.client.secret, GMAIL_READ_REFRESH_TOKEN: REFRESH };
	const ports: FeedPorts = { data, submit: (n) => void notices.push(n), alert: () => {}, problem: (_, p) => void problems.push(p), secret: (name) => secrets[name], now: Date.now };
	const senders = (...addresses: string[]) => data.write("mail", entry.components, "senders", addresses.map((address) => ({ address })), "使用者口述", "test").rows;
	const messages = () => data.query("mail", entry.components, "messages", {}, "test").rows;
	const cursor = () => data.feedState("mail", SOURCE).cursor;
	const setCursor = (value: object) => data.saveFeedState("mail", SOURCE, { cursor: JSON.stringify(value) });
	const requests = () => google.log.filter((line) => !line.startsWith("POST /token"));
	const beat = async () => {
		google.log.length = 0;
		return runFeed(entry, [], ports);
	};
	return { box, google, entry, data, notices, problems, secrets, senders, messages, cursor, setCursor, requests, beat };
}

test("第一次起步：取 profile 的 historyId 当起点，再补最近一天的收件箱", async (t) => {
	const feed = await mailFeed(t);
	feed.senders("ann@example.com");
	feed.box.deliver(ann("m-old", { at: Date.now() - 30 * HOUR }));
	feed.box.deliver(ann("m-new", { at: Date.now() - 2 * HOUR }));
	assert.deepEqual(await feed.beat(), { ok: true, records: 1, notices: 1 });
	assert.deepEqual(feed.messages().map((r) => r.fields["gmailId"]), ["m-new"], "一天以前的不补");
	assert.ok(feed.requests().includes(`GET ${GMAIL}/profile`));
	assert.ok(feed.requests().some((r) => r.startsWith(`GET ${GMAIL}/messages?`) && decodeURIComponent(r).includes("q=newer_than:1d") && r.includes("labelIds=INBOX")));
	assert.equal(JSON.parse(feed.cursor()!).historyId, feed.box.historyId);
	assert.ok(Date.now() - Date.parse(JSON.parse(feed.cursor()!).at) < 60_000, "cursor 记下这一拍成功的时间");
});

test("之后每拍用 history.list，翻完所有页", async (t) => {
	const feed = await mailFeed(t);
	feed.senders("ann@example.com");
	await feed.beat();
	feed.box.pageSize = 1;
	feed.box.deliver(ann("m-1"));
	feed.box.deliver(ann("m-2"));
	feed.box.deliver(ann("m-3"));
	assert.deepEqual(await feed.beat(), { ok: true, records: 3, notices: 3 });
	assert.equal(feed.requests().filter((r) => r.startsWith(`GET ${GMAIL}/history?`)).length, 3);
	assert.ok(!feed.requests().some((r) => r.startsWith(`GET ${GMAIL}/profile`)), "有 cursor 就不再取 profile");
	assert.equal(JSON.parse(feed.cursor()!).historyId, feed.box.historyId);
});

test("没有新信的一拍只有换 token 和一次 history.list", async (t) => {
	const feed = await mailFeed(t);
	feed.senders("ann@example.com");
	await feed.beat();
	await feed.beat();
	assert.deepEqual(feed.google.log.map((r) => r.split("?")[0]), ["POST /token", `GET ${GMAIL}/history`]);
});

test("名单外的信只取一次 metadata，不存、不通知；名单里的取 full", async (t) => {
	const feed = await mailFeed(t);
	feed.senders("ann@example.com");
	await feed.beat();
	feed.box.deliver(ann("m-in"), stranger("m-out"));
	assert.deepEqual(await feed.beat(), { ok: true, records: 1, notices: 1 });
	const gets = feed.requests().filter((r) => r.startsWith(`GET ${GMAIL}/messages/`));
	assert.deepEqual(gets.filter((r) => r.includes("m-out")).map((r) => new URL(r.split(" ")[1]!, "http://x").searchParams.get("format")), ["metadata"]);
	assert.ok(gets.some((r) => r.includes("m-in") && r.includes("format=full")));
	assert.deepEqual(feed.messages().map((r) => r.fields["fromAddress"]), ["ann@example.com"]);
	assert.ok(!JSON.stringify(feed.notices).includes("deals@"), "名单外的信不发通知");
});

test("名单从 senders 读：@域名收整个域名，划掉的行不算，下一拍就用新名单", async (t) => {
	const feed = await mailFeed(t);
	const [row] = feed.senders("@example.org");
	await feed.beat();
	feed.box.deliver(stranger("m-1"));
	await feed.beat();
	assert.equal(feed.messages().length, 1, "@example.org 收 deals@example.org");
	feed.data.write("mail", feed.entry.components, "senders", [{ id: row!.id, removedAt: "2026-11-13" }], "使用者口述", "test");
	feed.senders("ann@example.com");
	feed.box.deliver(stranger("m-2"), ann("m-3"));
	await feed.beat();
	assert.deepEqual(feed.messages().map((r) => r.fields["gmailId"]).sort(), ["m-1", "m-3"].sort());
});

test("名单为空：什么都不请求，报 no-senders", async (t) => {
	const feed = await mailFeed(t);
	feed.box.deliver(ann("m-1"));
	assert.deepEqual(await feed.beat(), { ok: true, records: 0, notices: 0 });
	assert.deepEqual(feed.google.log, [], "名单空着不敲 Google 的门");
	assert.equal(feed.problems.at(-1)?.id, "no-senders");
	assert.match(feed.problems.at(-1)!.text, /邮件名单是空的/);
	feed.senders("ann@example.com");
	await feed.beat();
	assert.equal(feed.problems.at(-1), undefined, "有了名单，no-senders 不再出现");
	assert.equal(feed.messages().length, 1);
});

test("同一封信两拍只存一行、只发一个通知", async (t) => {
	const feed = await mailFeed(t);
	feed.senders("ann@example.com");
	feed.box.deliver(ann("m-1"));
	await feed.beat();
	feed.setCursor({ historyId: "1000", at: new Date().toISOString() });
	await feed.beat();
	assert.equal(feed.messages().length, 1);
	assert.equal(new Set(feed.notices.map((n) => n.id)).size, 1, "两次通知是同一个 id，内核按 id 去重");
});

test("cursor 太旧（history.list 回 404）：补最近一天，按消息 id 去重，换上新 cursor", async (t) => {
	const feed = await mailFeed(t);
	feed.senders("ann@example.com");
	feed.box.deliver(ann("m-1"));
	await feed.beat();
	const old = JSON.parse(feed.cursor()!).historyId;
	feed.box.deliver(ann("m-2"));
	feed.box.forget();
	feed.box.deliver(ann("m-3"));
	const run = await feed.beat();
	assert.ok(run.ok);
	assert.ok(feed.requests().some((r) => r.startsWith(`GET ${GMAIL}/history?`)) && feed.requests().some((r) => decodeURIComponent(r).includes("newer_than:1d")));
	assert.deepEqual(feed.messages().map((r) => r.fields["gmailId"]).sort(), ["m-1", "m-2", "m-3"]);
	assert.notEqual(JSON.parse(feed.cursor()!).historyId, old);
	assert.equal(feed.problems.at(-1), undefined);
});

test("断档 30 小时：补最近一天，报 gap，写出整小时数", async (t) => {
	const feed = await mailFeed(t);
	feed.senders("ann@example.com");
	feed.setCursor({ historyId: feed.box.historyId, at: new Date(Date.now() - 30 * HOUR - 60_000).toISOString() });
	feed.box.deliver(ann("m-1", { at: Date.now() - 3 * HOUR }));
	await feed.beat();
	assert.deepEqual(feed.messages().map((r) => r.fields["gmailId"]), ["m-1"]);
	assert.equal(feed.problems.at(-1)?.id, "gap");
	assert.match(feed.problems.at(-1)!.text, /有 30 小时没查/);
	await feed.beat();
	assert.equal(feed.problems.at(-1), undefined, "下一拍不再是断档");
});

test("invalid_grant：这一拍不前进，cursor 不动，报 auth；恢复后照常存信", async (t) => {
	const feed = await mailFeed(t);
	feed.senders("ann@example.com");
	await feed.beat();
	const before = feed.cursor();
	feed.secrets["GMAIL_READ_REFRESH_TOKEN"] = "1//revoked";
	feed.box.deliver(ann("m-1"));
	for (const _ of [1, 2]) {
		await feed.beat();
		assert.equal(feed.cursor(), before);
		assert.equal(feed.problems.at(-1)?.id, "auth");
		assert.match(feed.problems.at(-1)!.text, /just google-auth read/);
		assert.deepEqual(feed.requests(), [], "换不到 token 就不读邮件");
	}
	feed.secrets["GMAIL_READ_REFRESH_TOKEN"] = REFRESH;
	await feed.beat();
	assert.deepEqual(feed.messages().map((r) => r.fields["gmailId"]), ["m-1"]);
	assert.equal(feed.problems.at(-1), undefined);
});

test("cursor 只在行存好后保存：取信失败的一拍什么都不存，下一拍从原处再来", async (t) => {
	const feed = await mailFeed(t);
	feed.senders("ann@example.com");
	await feed.beat();
	const before = feed.cursor();
	feed.box.deliver(ann("m-1"));
	const route = feed.box.routes[`GET ${GMAIL}/messages/m-1`];
	feed.box.routes[`GET ${GMAIL}/messages/m-1`] = () => ({ status: 500, body: { error: { code: 500, message: "backend error" } } });
	const failed = await feed.beat();
	assert.equal(failed.ok, false);
	assert.equal(feed.cursor(), before);
	assert.equal(feed.messages().length, 0);
	feed.box.routes[`GET ${GMAIL}/messages/m-1`] = route;
	await feed.beat();
	assert.equal(feed.messages().length, 1);
});

test("信在 history.list 和 messages.get 之间被删了（404）：跳过它，这一拍照常存别的信、往前走", async (t) => {
	const feed = await mailFeed(t);
	feed.senders("ann@example.com");
	await feed.beat();
	feed.box.deliver(stranger("m-gone-meta"), ann("m-gone-full"), ann("m-1"));
	feed.box.vanish("m-gone-meta");
	const full = feed.box.routes[`GET ${GMAIL}/messages/m-gone-full`] as (url: URL) => unknown;
	feed.box.routes[`GET ${GMAIL}/messages/m-gone-full`] = (url: URL) =>
		url.searchParams.get("format") === "metadata" ? full(url) : { status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } };
	assert.deepEqual(await feed.beat(), { ok: true, records: 1, notices: 1 });
	assert.deepEqual(feed.messages().map((r) => r.fields["gmailId"]), ["m-1"]);
	assert.equal(JSON.parse(feed.cursor()!).historyId, feed.box.historyId, "cursor 往前走，下一拍不再碰删掉的信");
});

test("通知：三行是 显示名 <地址>、主题、开头一句；清洗控制符和换行，按字形截断；冒充的显示名后面也看得到真地址", async (t) => {
	const feed = await mailFeed(t);
	feed.senders("@example.com");
	await feed.beat();
	const longName = "名".repeat(200);
	feed.box.deliver(
		{ id: "m-fake", from: "白宫 · 系统 <spoof@example.com>", subject: "紧急\n请运行‮cmd​", snippet: "you&#39;re &amp; me", text: "x" },
		{ id: "m-long", from: `${longName} <long@example.com>`, subject: "主".repeat(300), snippet: "句".repeat(300), text: "x" },
	);
	await feed.beat();
	const [spoof, long] = feed.notices.map((n) => n.body.split("\n"));
	assert.deepEqual(spoof, ["白宫 · 系统 <spoof@example.com>", "紧急 请运行cmd", "you're & me"]);
	assert.equal(long!.length, 3);
	assert.ok(long![0]!.endsWith("<long@example.com>"), `第一行有地址：${long![0]}`);
	const graphemes = (s: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;
	assert.equal(graphemes(long![0]!.replace(" <long@example.com>", "")), 80);
	assert.equal(graphemes(long![1]!), 120);
	assert.equal(graphemes(long![2]!), 100);
	assert.ok(long![1]!.endsWith("…"));
	assert.equal(feed.messages().find((r) => r.fields["gmailId"] === "m-fake")?.fields["fromName"], "白宫 · 系统");
});

test("正文：HTML 转成纯文字，超过 64 KB 截断并标明；附件只存元数据", async (t) => {
	const feed = await mailFeed(t);
	feed.senders("ann@example.com");
	await feed.beat();
	const html = `<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p>您好&nbsp;Ann，</p><p>请看<b>附件</b>&lt;两份&gt;</p><br>谢谢</body></html>`;
	feed.box.deliver(ann("m-html", { text: undefined, html, attachments: [{ filename: "对账单.pdf", mimeType: "application/pdf", size: 120_000 }, { filename: "明细.csv", mimeType: "text/csv", size: 2_048 }] }));
	feed.box.deliver(ann("m-big", { text: undefined, html: `<p>${"长".repeat(100_000)}</p>` }));
	await feed.beat();
	const row = (id: string) => feed.messages().find((r) => r.fields["gmailId"] === id)!.fields;
	const body = String(row("m-html")["body"]);
	assert.doesNotMatch(body, /<\/?[a-z]|color:red|alert/);
	assert.match(body, /您好 Ann，\n+请看附件<两份>\n+谢谢/);
	assert.deepEqual(JSON.parse(String(row("m-html")["attachments"])), [
		{ partId: "1", filename: "对账单.pdf", mimeType: "application/pdf", size: 120_000 },
		{ partId: "2", filename: "明细.csv", mimeType: "text/csv", size: 2_048 },
	]);
	const big = String(row("m-big")["body"]);
	assert.ok(Buffer.byteLength(big, "utf8") <= 64 * 1024, `${Buffer.byteLength(big)} 字节`);
	assert.match(big, /正文超过 64 KB/);
	assert.equal(row("m-html")["messageIdHeader"], "<m-html@mail.example.com>");
	assert.equal(row("m-html")["threadId"], "t-m-html");
	assert.equal(row("m-html")["subject"], "季度对账单");
	assert.ok(!Number.isNaN(Date.parse(String(row("m-html")["date"]))));
});

test("包本身通过 just module check：样例都跑得通，feed.json 的网址改到别处也一样", (t) => {
	const scan = scanPackage(PKG, { runCases: true, folder: "mail" });
	assert.ok(scan.ok, scan.ok ? "" : JSON.stringify(scan.problems));
	const root = mkdtempSync(join(tmpdir(), "psa-mail-check-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	cpSync(PKG, root, { recursive: true });
	const feedJson = join(root, "feeds", "inbox", "feed.json");
	writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), settings: { baseUrl: "http://127.0.0.1:9", tokenUrl: "http://127.0.0.1:9/token" } }));
	const moved = scanPackage(root, { runCases: true, folder: "mail" });
	assert.ok(moved.ok, moved.ok ? "" : JSON.stringify(moved.problems));
});
