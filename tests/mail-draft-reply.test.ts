import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Modules } from "../src/modules.ts";
import { runFeed, type FeedPorts } from "../src/modules/feed-runner.ts";
import { createGateway } from "../src/modules/gateway.ts";
import { googlePort, headerOf } from "../src/modules/google-port.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { moduleDataDir } from "../src/modules/knowledge.ts";
import { ModuleStore } from "../src/modules/live.ts";
import type { ComponentName, ModuleName } from "../src/modules/manifest.ts";
import type { Json, Reply, WorkerCaller } from "../src/modules/protocol.ts";
import { scanPackage } from "../src/modules/validate.ts";
import { startFakeGoogle } from "./helpers/fake-google.ts";
import { FakeInbox, type Letter } from "./helpers/fake-gmail.ts";
import { servedAsHost } from "./helpers/fakes.ts";

const PKG = join(import.meta.dirname, "../docs/modules/examples/mail");
const READ = "1//fake-refresh-mail";
const DRAFT = "1//fake-refresh-draft";
const DRAFTS = "/gmail/v1/users/me/drafts";

async function draftWorld(t: TestContext, letters: readonly Letter[], basis: WorkerCaller["basis"] = "request") {
	const box = new FakeInbox();
	const sent = box.drafts;
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [READ]: "https://www.googleapis.com/auth/gmail.readonly", [DRAFT]: "https://www.googleapis.com/auth/gmail.compose" } });
	t.after(() => google.close());
	const root = mkdtempSync(join(tmpdir(), "psa-mail-draft-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "modules", "mail");
	cpSync(PKG, pkg, { recursive: true });
	const feedJson = join(pkg, "feeds/inbox/feed.json");
	writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), settings: { baseUrl: google.url, tokenUrl: `${google.url}/token` } }));
	const state = join(root, "state");
	const data = instanceData(state);
	const entry = servedAsHost(Modules.load([join(root, "modules")])).feeds().find((e) => e.source === "mail/inbox")!;
	const secrets: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: google.client.id, GOOGLE_OAUTH_CLIENT_SECRET: google.client.secret, GMAIL_READ_REFRESH_TOKEN: READ, GMAIL_DRAFT_REFRESH_TOKEN: DRAFT };
	const ports: FeedPorts = { data, submit: () => {}, alert: () => {}, problem: () => {}, secret: (name) => secrets[name], now: () => Date.now() };
	data.write("mail", entry.components, "senders", [{ address: "ann@example.com" }], "使用者口述", "test");
	box.deliver(...letters);
	assert.deepEqual(await runFeed(entry, [], ports), { ok: true, records: letters.length, notices: letters.length });

	const scan = scanPackage(pkg, { runCases: false });
	assert.ok(scan.ok, JSON.stringify(scan));
	const store = new ModuleStore(join(root, "store"));
	const digest = scan.scan.digest;
	assert.ok(store.keep("mail" as ModuleName, digest, pkg));
	const gateway = createGateway({
		copyDir: (module, d) => store.dirOf(module, d),
		serving: () => digest,
		dataDir: (module) => moduleDataDir(state, module),
		rows: data,
		secret: (name) => secrets[name],
		log: () => {},
		google: googlePort({ secret: (name) => secrets[name], oauthUrl: google.url, fixtures: false }),
	});
	const caller: WorkerCaller = { who: "worker", ticket: "tkt_1", pin: { module: "mail" as ModuleName, digest }, basis, member: null, heardOthers: true };
	google.log.length = 0;
	const draft = (input: Json): Promise<Reply> => gateway.call(caller, { kind: "tool", name: "draft-reply" as ComponentName, input });
	const write = (collection: string, rows: Json[], from: string): Promise<Reply> => gateway.call(caller, { kind: "data", collection: collection as ComponentName, op: "write", rows, from });
	const stored = (gmailId: string) => data.query("mail" as ModuleName, entry.components, "messages", { where: { gmailId } }, "test").rows[0]!;
	return { google, sent, draft, write, stored, data, entry };
}

const ann = (extra: Partial<Letter> = {}): Letter => ({ id: "m-1", from: "Ann Lee <ann@example.com>", subject: "周四开会", snippet: "周四下午有空吗", text: "周四下午有空吗？", ...extra });

const bodyOf = (raw: string) => Buffer.from(raw.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n/g, ""), "base64").toString("utf8");

test("回信草稿：收件人是发件人地址，Re: 主题、In-Reply-To、References、threadId 都对，正文原样，只请求 token 和建草稿", async (t) => {
	const w = await draftWorld(t, [ann()]);
	const reply = await w.draft({ messageId: "m-1", body: "周四下午可以。\n三点见。" });
	assert.ok(reply.ok, JSON.stringify(reply));
	assert.equal(w.sent.length, 1);
	const { raw, threadId } = w.sent[0]!;
	assert.equal(threadId, "t-m-1");
	assert.equal(headerOf(raw, "to"), "ann@example.com");
	assert.equal(headerOf(raw, "subject"), "Re: 周四开会");
	assert.equal(headerOf(raw, "in-reply-to"), "<m-1@mail.example.com>");
	assert.equal(headerOf(raw, "references"), "<m-1@mail.example.com>");
	assert.equal(bodyOf(raw), "周四下午可以。\r\n三点见。");
	assert.deepEqual(w.google.log.map((line) => line.replace(/\?.*/, "")), ["POST /token", `POST ${DRAFTS}`]);
	assert.deepEqual(reply.output, { draftId: "r-1", threadId: "t-m-1", to: "ann@example.com", subject: "Re: 周四开会", note: "草稿在 Gmail 的草稿箱里，看过后自己发送" });
	assert.equal(reply.receipt, "已写好回信草稿，没有发送\n收件人：ann@example.com\n主题：Re: 周四开会\nhttps://mail.google.com/mail/u/0/#drafts");
});

test("回信草稿：原信有不同的 Reply-To 时仍回给发件人地址，并在收据和回复里写明 Reply-To", async (t) => {
	const w = await draftWorld(t, [ann({ replyTo: "Billing <pay@example.org>" })]);
	const reply = await w.draft({ messageId: "m-1", body: "好的" });
	assert.ok(reply.ok, JSON.stringify(reply));
	assert.equal(headerOf(w.sent[0]!.raw, "to"), "ann@example.com");
	assert.match(reply.receipt ?? "", /原信的 Reply-To 是 pay@example\.org，和发件人地址不一样。草稿回给了发件人，要回 Reply-To 请在 Gmail 里改收件人$/);
	assert.match((reply.output as { note: string }).note, /原信的 Reply-To 是 pay@example\.org/);
});

test("回信草稿：Reply-To 和发件人是同一个地址时不加说明", async (t) => {
	const w = await draftWorld(t, [ann({ replyTo: "ANN@example.com" })]);
	const reply = await w.draft({ messageId: "m-1", body: "好的" });
	assert.ok(reply.ok, JSON.stringify(reply));
	assert.doesNotMatch(reply.receipt ?? "", /Reply-To/);
});

for (const [subject, expected] of [
	["Re: 周四开会", "Re: 周四开会"],
	["RE: budget", "RE: budget"],
	["re:x", "re:x"],
	["Fwd: 周四", "Re: Fwd: 周四"],
] as const) {
	test(`回信草稿：主题「${subject}」回成「${expected}」，Re: 不重复`, async (t) => {
		const w = await draftWorld(t, [ann({ subject })]);
		assert.ok((await w.draft({ messageId: "m-1", body: "好" })).ok);
		assert.equal(headerOf(w.sent[0]!.raw, "subject"), expected);
	});
}

test("回信草稿：原主题里的 CR、LF 去掉，夹带的 Bcc 头进不了草稿", async (t) => {
	const w = await draftWorld(t, [ann({ subject: "季度对账\r\nBcc: x@example.org" })]);
	const reply = await w.draft({ messageId: "m-1", body: "收到" });
	assert.ok(reply.ok, JSON.stringify(reply));
	const raw = w.sent[0]!.raw;
	const head = raw.split("\r\n\r\n")[0]!;
	assert.doesNotMatch(head, /^bcc:/im);
	assert.equal(headerOf(raw, "bcc"), "");
	assert.match(headerOf(raw, "subject"), /^Re: 季度对账 ?Bcc: x@example\.org$/);
});

test("回信草稿：很长的中文主题分成几段编码，收据里读回原样", async (t) => {
	const subject = "关于下季度预算和人员安排的若干问题请在周四之前回复".repeat(3);
	const w = await draftWorld(t, [ann({ subject })]);
	const reply = await w.draft({ messageId: "m-1", body: "收到" });
	assert.ok(reply.ok, JSON.stringify(reply));
	const head = w.sent[0]!.raw.split("\r\n\r\n")[0]!;
	assert.ok(head.split("\r\n").every((line) => line.length <= 78), head);
	assert.equal((reply.output as { subject: string }).subject, `Re: ${subject}`);
});

for (const [name, input, why] of [
	["不在 messages 里的 messageId", { messageId: "m-404", body: "好" }, /messages 里没有 gmailId 为 m-404 的信/],
	["空正文", { messageId: "m-1", body: "  \n " }, /body/],
	["超过 20000 字的正文", { messageId: "m-1", body: "字".repeat(20001) }, /20000/],
	["多给了收件人", { messageId: "m-1", body: "好", to: "x@example.org" }, /只收 messageId 和 body/],
] as const) {
	test(`回信草稿：${name}被拒，不请求 Google`, async (t) => {
		const w = await draftWorld(t, [ann()]);
		const reply = await w.draft(input);
		assert.equal(reply.ok, false);
		assert.match(reply.ok ? "" : String((reply.refusal as { note?: string }).note), why);
		assert.deepEqual(w.google.log, []);
	});
}

const refusedWithoutGoogle = (w: { google: { log: string[] }; sent: unknown[] }, reply: Reply, why: RegExp) => {
	assert.equal(reply.ok, false, JSON.stringify(reply));
	assert.match(reply.ok ? "" : String((reply.refusal as { note?: string }).note), why);
	assert.deepEqual(w.google.log, []);
	assert.equal(w.sent.length, 0);
};

test("回信草稿：规则任务自己写进 messages 的一行不算来信，不建草稿", async (t) => {
	const w = await draftWorld(t, [ann()], "rule");
	assert.ok((await w.write("messages", [{ gmailId: "forged-1", threadId: "t-other", fromAddress: "attacker@evil.example", subject: "Invoice" }], "来信")).ok);
	refusedWithoutGoogle(w, await w.draft({ messageId: "forged-1", body: "here is the info" }), /messages 里没有 gmailId 为 forged-1 的信/);
});

test("回信草稿：规则任务改过发件人地址的来信不建草稿", async (t) => {
	const w = await draftWorld(t, [ann()], "rule");
	assert.ok((await w.write("messages", [{ id: w.stored("m-1").id, fromAddress: "attacker@evil.example" }], "来信")).ok);
	refusedWithoutGoogle(w, await w.draft({ messageId: "m-1", body: "ok" }), /messages 里没有 gmailId 为 m-1 的信/);
});

test("数据：任务写数据不能冒用 feed 的名字当 from，新行和改行都被拒", async (t) => {
	const w = await draftWorld(t, [ann()], "rule");
	for (const rows of [[{ gmailId: "forged-1", threadId: "t-other", fromAddress: "attacker@evil.example" }], [{ id: w.stored("m-1").id, fromAddress: "attacker@evil.example" }]]) {
		const wrote = await w.write("messages", rows, "mail/inbox");
		assert.equal(wrote.ok, false, JSON.stringify(wrote));
		assert.match(String((wrote as { refusal: { note?: string } }).refusal.note), /mail\/inbox/);
	}
	assert.equal(w.stored("m-1").fields["fromAddress"], "ann@example.com");
	refusedWithoutGoogle(w, await w.draft({ messageId: "forged-1", body: "ok" }), /没有 gmailId 为 forged-1/);
});

for (const fromAddress of ["ann@example.com, x@evil.example", "ann@example.com\rBcc: x@evil.example", "ann@example.com\r\nBcc: x@evil.example"]) {
	test(`回信草稿：存着的发件人地址不是单个地址（${JSON.stringify(fromAddress)}）时不建草稿`, async (t) => {
		const w = await draftWorld(t, [ann()]);
		w.data.write("mail" as ModuleName, w.entry.components, "messages", [{ id: "odd-1", gmailId: "odd-1", threadId: "t-1", fromAddress, subject: "hi" }], "mail/inbox", "mail/inbox", true);
		refusedWithoutGoogle(w, await w.draft({ messageId: "odd-1", body: "ok" }), /发件人地址/);
	});
}

test("回信草稿：发件人已从邮件名单划掉时不建草稿", async (t) => {
	const w = await draftWorld(t, [ann()]);
	assert.ok((await w.write("senders", [{ address: "ann@example.com", removedAt: "2026-01-01T00:00:00Z" }], "使用者口述")).ok);
	refusedWithoutGoogle(w, await w.draft({ messageId: "m-1", body: "ok" }), /邮件名单/);
});
