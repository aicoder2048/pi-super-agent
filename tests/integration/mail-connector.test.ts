import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Modules } from "../../src/modules.ts";
import { gmailAccount } from "../../src/modules/connectors/gmail.ts";
import { MailConnector } from "../../src/modules/connectors/mail.ts";
import type { FeedNotice, FeedPorts, FeedProblem } from "../../src/modules/feed-runner.ts";
import { instanceData } from "../../src/modules/instance-data.ts";
import { startFakeGoogle } from "../helpers/fake-google.ts";
import { FakeInbox, type Letter } from "../helpers/fake-gmail.ts";
import { servedAsHost } from "../helpers/fakes.ts";

const MAIL = join(import.meta.dirname, "../../docs/modules/examples/mail");
const REFRESH = "1//fake-refresh-mail";

/** A second module on the same connector, the way option-ta will read broker mail: its own list, written in feed.json. A subject with 坏 makes its handler throw. */
function fillsPackage(dir: string): void {
	mkdirSync(join(dir, "feeds/fills"), { recursive: true });
	mkdirSync(join(dir, "data/fills"), { recursive: true });
	writeFileSync(join(dir, "module.json"), JSON.stringify({ schema: 1, name: "fills", version: "0.1.0", title: "成交" }));
	writeFileSync(join(dir, "data/fills/collection.json"), JSON.stringify({ title: "成交", kind: "record", class: "private", fields: { subject: { type: "text", title: "主题" }, seen: { type: "text", title: "handler 收到的 input 键" } } }));
	writeFileSync(join(dir, "feeds/fills/feed.json"), JSON.stringify({ title: "成交确认", connector: "mail", handler: "index.ts", every: "5m", settings: { senders: ["@broker.example.net"] }, into: "fills" }));
	writeFileSync(
		join(dir, "feeds/fills/index.ts"),
		`export default (input) => {
	const [letter] = input.items;
	if (letter.subject.includes("坏")) throw new Error("读不懂这封确认信");
	return { records: [{ id: letter.id, subject: letter.subject, seen: Object.keys(input).sort().join(",") }], cursor: "handler-" + letter.id };
};\n`,
	);
}

async function world(t: TestContext) {
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [REFRESH]: "https://www.googleapis.com/auth/gmail.readonly" } });
	t.after(() => google.close());
	const root = mkdtempSync(join(tmpdir(), "psa-mail-connector-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	cpSync(MAIL, join(root, "modules", "mail"), { recursive: true });
	fillsPackage(join(root, "modules", "fills"));
	const feeds = servedAsHost(Modules.load([join(root, "modules")])).feeds();
	const inbox = feeds.find((e) => e.source === "mail/inbox")!;
	const fills = feeds.find((e) => e.source === "fills/fills")!;
	assert.ok(inbox && fills, JSON.stringify(feeds.map((e) => e.source)));
	const data = instanceData(join(root, "state"));
	data.write("mail", inbox.components, "senders", [{ address: "ann@example.com" }], "使用者口述", "test");
	const secrets: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: google.client.id, GOOGLE_OAUTH_CLIENT_SECRET: google.client.secret, GMAIL_READ_REFRESH_TOKEN: REFRESH };
	const notices: FeedNotice[] = [];
	const connectorProblems: { source: string; problem: FeedProblem | undefined }[] = [];
	const rejected: { source: string; note: string; tries: number }[] = [];
	const ports: FeedPorts = { data, submit: (n) => void notices.push(n), alert: () => true, badge: () => {}, problem: () => {}, connectorProblem: (_, source, problem) => void connectorProblems.push({ source, problem }), secret: () => undefined, now: () => Date.now() };
	const rejectedDir = join(root, "rejected");
	const mail = new MailConnector({ account: gmailAccount({ secret: (name) => secrets[name], oauthUrl: google.url }), rejectedDir: (e) => join(rejectedDir, e.module, e.name), rejected: (e, note, tries) => void rejected.push({ source: e.source, note, tries }) });
	const rows = (module: string, collection: string) => data.query(module as never, (module === "mail" ? inbox : fills).components, collection, {}, "test").rows;
	const state = (entry: typeof inbox) => data.feedState(entry.module, entry.source);
	return { box, google, mail, ports, inbox, fills, data, notices, connectorProblems, rejected, rejectedDir, rows, state, secrets };
}

const ann = (id: string): Letter => ({ id, from: "Ann Lee <ann@example.com>", subject: "季度对账单", text: "您好" });
const broker = (id: string, subject = "成交确认 SPY 2026-12-18 600C"): Letter => ({ id, from: "Broker <trade@broker.example.net>", subject, text: "Filled 1 @ 2.15" });

test("两个模块共用连接器：各按自己的名单收信，各有各的连接器进度", async (t) => {
	const w = await world(t);
	await w.mail.beat(w.inbox, w.ports);
	await w.mail.beat(w.fills, w.ports);
	w.box.deliver(ann("m-ann"), broker("m-fill"));
	assert.deepEqual(await w.mail.beat(w.inbox, w.ports), { ok: true, records: 1, notices: 1 });
	assert.deepEqual(w.rows("mail", "messages").map((r) => r.fields["gmailId"]), ["m-ann"], "mail 只收名单上的 ann");
	assert.equal(JSON.parse(w.state(w.inbox).connectorCursor!).historyId, w.box.historyId);
	const fillsBefore = w.state(w.fills).connectorCursor;
	assert.notEqual(JSON.parse(fillsBefore!).historyId, w.box.historyId, "mail 的一拍不推进 fills 的进度");
	assert.deepEqual(await w.mail.beat(w.fills, w.ports), { ok: true, records: 1, notices: 0 });
	assert.deepEqual(w.rows("fills", "fills").map((r) => r.fields["subject"]), ["成交确认 SPY 2026-12-18 600C"], "fills 只收券商域名的信");
	assert.equal(JSON.parse(w.state(w.fills).connectorCursor!).historyId, w.box.historyId);
});

test("handler 看不到连接器的进度：它的 input 没有 connectorCursor，它交回的 cursor 另存一格", async (t) => {
	const w = await world(t);
	await w.mail.beat(w.fills, w.ports);
	w.box.deliver(broker("m-1"));
	await w.mail.beat(w.fills, w.ports);
	assert.equal(w.rows("fills", "fills")[0]?.fields["seen"], "cursor,items,now,rows,settings,watchedKeys");
	assert.equal(w.state(w.fills).cursor, "handler-m-1");
	assert.equal(JSON.parse(w.state(w.fills).connectorCursor!).historyId, w.box.historyId);
});

test("handler 失败：连接器进度不动，下一拍重取同一封信；同一封信失败 3 次挪进拒收，别的信照存，进度往前走", async (t) => {
	const w = await world(t);
	await w.mail.beat(w.fills, w.ports);
	const before = w.state(w.fills).connectorCursor;
	w.box.deliver(broker("m-bad", "成交确认 坏"), broker("m-good"));
	for (const beat of [1, 2]) {
		const run = await w.mail.beat(w.fills, w.ports);
		assert.equal(run.ok, false, `第 ${beat} 拍`);
		assert.match(run.ok ? "" : run.note, /读不懂这封确认信/);
		assert.equal(w.state(w.fills).connectorCursor, before, `第 ${beat} 拍进度不动`);
	}
	assert.deepEqual(w.rows("fills", "fills").map((r) => r.fields["subject"]), ["成交确认 SPY 2026-12-18 600C"], "好的那封第一拍就存了，重取时不再交给 handler");
	assert.deepEqual(await w.mail.beat(w.fills, w.ports), { ok: true, records: 0, notices: 0 });
	assert.equal(JSON.parse(w.state(w.fills).connectorCursor!).historyId, w.box.historyId, "第 3 次失败后拒收，进度往前走");
	assert.deepEqual(w.rejected.map(({ source, tries }) => ({ source, tries })), [{ source: "fills/fills", tries: 3 }]);
	const [file] = readdirSync(join(w.rejectedDir, "fills", "fills"));
	const note = JSON.parse(readFileSync(join(w.rejectedDir, "fills", "fills", file!), "utf8"));
	assert.equal(note.gmailId, "m-bad");
	assert.ok(!JSON.stringify(note).includes("Filled"), "拒收记录不存正文");
	await w.mail.beat(w.fills, w.ports);
	assert.equal(w.rejected.length, 1, "拒收的信不再重试");
});

test("取信失败（Gmail 回 500）：这一拍失败，连接器进度不动，handler 不被调用", async (t) => {
	const w = await world(t);
	await w.mail.beat(w.fills, w.ports);
	const before = w.state(w.fills).connectorCursor;
	w.box.deliver(broker("m-1"));
	w.box.routes["GET /gmail/v1/users/me/history"] = () => ({ status: 500, body: { error: { code: 500, message: "backend error" } } });
	const run = await w.mail.beat(w.fills, w.ports);
	assert.equal(run.ok, false);
	assert.equal(w.state(w.fills).connectorCursor, before);
	assert.equal(w.rows("fills", "fills").length, 0);
});

test("授权失效：两个 feed 都只报连接器的问题，不读信；恢复后第一拍清掉", async (t) => {
	const w = await world(t);
	w.secrets["GMAIL_READ_REFRESH_TOKEN"] = "1//revoked";
	w.google.log.length = 0;
	await w.mail.beat(w.inbox, w.ports);
	await w.mail.beat(w.fills, w.ports);
	assert.deepEqual(w.connectorProblems.map(({ source, problem }) => [source, problem?.id]), [["mail/inbox", "auth"], ["fills/fills", "auth"]]);
	assert.ok(w.google.log.every((line) => line.startsWith("POST /token")), "换不到 token 就不读信");
	w.secrets["GMAIL_READ_REFRESH_TOKEN"] = REFRESH;
	await w.mail.beat(w.fills, w.ports);
	assert.equal(w.connectorProblems.at(-1)?.problem, undefined);
});

test("Gmail 不回话：这一拍到连接器的时限就失败，连接器进度不动，下一拍能再开始", async (t) => {
	const w = await world(t);
	await w.mail.beat(w.fills, w.ports);
	const before = w.state(w.fills).connectorCursor;
	const silent = (async (url: string | URL | Request, init?: RequestInit) => {
		if (!String(url).includes("/gmail/v1/")) return fetch(url, init);
		return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
	}) as typeof fetch;
	const mail = new MailConnector({ account: gmailAccount({ secret: (name) => w.secrets[name], oauthUrl: w.google.url, fetch: silent }), rejectedDir: () => w.rejectedDir, rejected: () => {}, fetchMs: 200 });
	const started = Date.now();
	const run = await mail.beat(w.fills, w.ports);
	assert.equal(run.ok, false, JSON.stringify(run));
	assert.ok(Date.now() - started < 5_000, `用了 ${Date.now() - started} ms`);
	assert.equal(w.state(w.fills).connectorCursor, before);
});
