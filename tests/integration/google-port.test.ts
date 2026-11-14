import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createGateway } from "../../src/modules/gateway.ts";
import { googlePort, type GooglePort } from "../../src/modules/google-port.ts";
import { ModuleStore } from "../../src/modules/live.ts";
import type { ComponentName, ModuleName } from "../../src/modules/manifest.ts";
import type { Json, Reply, WorkerCaller } from "../../src/modules/protocol.ts";
import { scanPackage } from "../../src/modules/validate.ts";
import { FakeInbox } from "../helpers/fake-gmail.ts";
import { startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.ts";

const DRAFT_TOKEN = "1//fake-refresh-draft";
const DRAFTS = "/gmail/v1/users/me/drafts";
const RAW = "To: ann@example.com\r\nSubject: Re: hi\r\n\r\nok\r\n";

async function fakeGmail(t: TestContext) {
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [DRAFT_TOKEN]: "https://www.googleapis.com/auth/gmail.compose" } });
	t.after(() => google.close());
	return { google, sent: box.drafts };
}

const secretsOf = (google: FakeGoogle): Record<string, string> => ({ GOOGLE_OAUTH_CLIENT_ID: google.client.id, GOOGLE_OAUTH_CLIENT_SECRET: google.client.secret, GMAIL_DRAFT_REFRESH_TOKEN: DRAFT_TOKEN });

function writePackage(root: string, name: string, tools: Record<string, { json: object; code: string }>): string {
	const pkg = join(root, name);
	mkdirSync(join(pkg, "data", "messages"), { recursive: true });
	writeFileSync(join(pkg, "module.json"), JSON.stringify({ schema: 1, name, version: "0.1.0", title: "邮件", description: "测试" }));
	writeFileSync(join(pkg, "data", "messages", "collection.json"), JSON.stringify({ title: "邮件", kind: "record", class: "private", fields: { subject: { type: "text", title: "主题" } } }));
	for (const [tool, { json, code }] of Object.entries(tools)) {
		mkdirSync(join(pkg, "tools", tool), { recursive: true });
		writeFileSync(join(pkg, "tools", tool, "tool.json"), JSON.stringify({ title: tool, description: tool, input: { raw: { type: "text", title: "raw" } }, output: { draftId: { type: "text", title: "draftId" } }, ...json }));
		writeFileSync(join(pkg, "tools", tool, "index.ts"), code);
	}
	return pkg;
}

const ECHO = { json: { effect: "write", port: "gmail.createDraft" }, code: "export default (input) => ({ draft: { raw: input.raw, threadId: input.threadId }, ...(input.note ? { note: input.note } : {}) });\n" };
const ENV = { json: { effect: "read" }, code: "export default () => Object.keys(process.env).sort();\n" };

async function portWorld(t: TestContext, { basis = "request" as WorkerCaller["basis"], google = undefined as GooglePort | undefined, secrets = {} as Record<string, string> } = {}) {
	const root = mkdtempSync(join(tmpdir(), "psa-port-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = writePackage(root, "mail", { "echo-draft": ECHO, env: ENV });
	const scan = scanPackage(pkg, { runCases: false });
	assert.ok(scan.ok, JSON.stringify(scan));
	const store = new ModuleStore(join(root, "store"));
	const digest = scan.scan.digest;
	assert.ok(store.keep("mail" as ModuleName, digest, pkg));
	mkdirSync(join(root, "data"), { recursive: true });
	const logs: string[] = [];
	const gateway = createGateway({ copyDir: (module, d) => store.dirOf(module, d), serving: () => digest, dataDir: () => join(root, "data"), rows: {} as never, secret: (name) => secrets[name], log: (line) => logs.push(line), ...(google && { google }) });
	const caller: WorkerCaller = { who: "worker", ticket: "tkt_1", pin: { module: "mail" as ModuleName, digest }, basis, member: null, heardOthers: false };
	const call = (name: string, input: Json): Promise<Reply> => gateway.call(caller, { kind: "tool", name: name as ComponentName, input });
	return { call, logs };
}

test("写草稿口子：createDraft 只发一个换 token 的请求和一个 POST .../users/me/drafts，raw 原样进草稿", async (t) => {
	const { google, sent } = await fakeGmail(t);
	const port = googlePort({ secret: (name) => secretsOf(google)[name], oauthUrl: google.url, fixtures: false });
	assert.equal(await port.createDraft(RAW, "t-1"), "r-1");
	assert.deepEqual(google.log, ["POST /token", `POST ${DRAFTS}`]);
	assert.deepEqual(sent, [{ raw: RAW, threadId: "t-1" }]);
});

test("写草稿口子：换 token 用的是写草稿的 refresh token", async (t) => {
	const { google } = await fakeGmail(t);
	const secrets = { ...secretsOf(google), GMAIL_DRAFT_REFRESH_TOKEN: "1//not-granted" };
	const port = googlePort({ secret: (name) => secrets[name], oauthUrl: google.url, fixtures: false });
	await assert.rejects(port.createDraft(RAW, "t-1"), /写草稿的授权失效了.*just google-auth draft/);
	assert.deepEqual(google.log, ["POST /token"]);
});

test("写草稿口子：没授权写草稿时一行说明，不请求", async (t) => {
	const { google } = await fakeGmail(t);
	const secrets: Record<string, string> = { ...secretsOf(google) };
	delete secrets["GMAIL_DRAFT_REFRESH_TOKEN"];
	const port = googlePort({ secret: (name) => secrets[name], oauthUrl: google.url, fixtures: false });
	await assert.rejects(port.createDraft(RAW, "t-1"), /还没授权写草稿.*just google-auth draft/);
	assert.deepEqual(google.log, []);
});

test("写草稿口子：fixture 模式不碰 Google，一个请求都不发", async (t) => {
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		calls.push(String(input));
		throw new Error("no network in this test");
	};
	t.after(() => (globalThis.fetch = realFetch));
	const port = googlePort({ secret: () => "x", oauthUrl: undefined, fixtures: true });
	await assert.rejects(port.createDraft(RAW, "t-1"), /fixture/);
	assert.deepEqual(calls, []);
});

test("网关：带 port 的工具回的草稿交给宿主写进 Gmail，任务拿到 draftId、收件人、主题和一句提示，还有一张只在本机的收据", async (t) => {
	const { google, sent } = await fakeGmail(t);
	const w = await portWorld(t, { google: googlePort({ secret: (name) => secretsOf(google)[name], oauthUrl: google.url, fixtures: false }) });
	const reply = await w.call("echo-draft", { raw: RAW, threadId: "t-1" });
	assert.ok(reply.ok, JSON.stringify(reply));
	assert.deepEqual(reply.output, { draftId: "r-1", threadId: "t-1", to: "ann@example.com", subject: "Re: hi", note: "草稿在 Gmail 的草稿箱里，看过后自己发送" });
	assert.equal(reply.receipt, "已写好回信草稿，没有发送\n收件人：ann@example.com\n主题：Re: hi\nhttps://mail.google.com/mail/u/0/#drafts");
	assert.equal(sent.length, 1);
});

test("网关：工具给的提示跟在收据和回复后面", async (t) => {
	const { google } = await fakeGmail(t);
	const w = await portWorld(t, { google: googlePort({ secret: (name) => secretsOf(google)[name], oauthUrl: google.url, fixtures: false }) });
	const reply = await w.call("echo-draft", { raw: RAW, threadId: "t-1", note: "原信的 Reply-To 是 b@example.org" });
	assert.ok(reply.ok, JSON.stringify(reply));
	assert.match((reply.output as { note: string }).note, /看过后自己发送。原信的 Reply-To 是 b@example.org$/);
	assert.match(reply.receipt ?? "", /\n原信的 Reply-To 是 b@example.org$/);
});

for (const [name, raw] of [
	["带 Bcc", "To: ann@example.com\r\nBcc: x@example.org\r\nSubject: hi\r\n\r\nok"],
	["带折行的 bcc", "To: ann@example.com\r\nSubject: hi\r\nbcc:\r\n x@example.org\r\n\r\nok"],
	["带 Cc", "To: ann@example.com\r\nCc: x@example.org\r\nSubject: hi\r\n\r\nok"],
	["超过 1 MB", `To: ann@example.com\r\nSubject: hi\r\n\r\n${"x".repeat(1024 * 1024)}`],
	["没有 To", "Subject: hi\r\n\r\nok"],
	["两行 To", "To: ann@example.com\r\nTo: x@example.org\r\nSubject: hi\r\n\r\nok"],
	["头里有单独的 CR", "To: ann@example.com\rCc: x@example.org\r\nSubject: hi\r\n\r\nok"],
	["头名里有 NUL", "To: ann@example.com\r\nC\u0000c: x@example.org\r\nSubject: hi\r\n\r\nok"],
] as const) {
	test(`网关：${name}的草稿被拒，不请求 Google`, async (t) => {
		const { google } = await fakeGmail(t);
		const w = await portWorld(t, { google: googlePort({ secret: (n) => secretsOf(google)[n], oauthUrl: google.url, fixtures: false }) });
		const reply = await w.call("echo-draft", { raw, threadId: "t-1" });
		assert.equal(reply.ok, false);
		assert.deepEqual(google.log, []);
	});
}

test("网关：推断任务调写草稿的工具被拒，工具不跑，口子不调", async (t) => {
	const { google } = await fakeGmail(t);
	const w = await portWorld(t, { basis: "inference", google: googlePort({ secret: (n) => secretsOf(google)[n], oauthUrl: google.url, fixtures: false }) });
	const reply = await w.call("echo-draft", { raw: RAW, threadId: "t-1" });
	assert.deepEqual(reply, { ok: false, refusal: { code: "not-allowed", sender: "inference", note: "a write call is for request-user-only, request, rule, page" } });
	assert.deepEqual(google.log, []);
});

test("网关：宿主有写草稿的 token，工具进程的环境里也没有它", async (t) => {
	const w = await portWorld(t, { secrets: { GMAIL_DRAFT_REFRESH_TOKEN: DRAFT_TOKEN } });
	const reply = await w.call("env", {});
	assert.ok(reply.ok, JSON.stringify(reply));
	assert.ok(!(reply.output as string[]).includes("GMAIL_DRAFT_REFRESH_TOKEN"), JSON.stringify(reply.output));
});

test("检查：mail 以外的模块写 port 被拒，别的 port 值被拒，port 要 effect write", () => {
	const root = mkdtempSync(join(tmpdir(), "psa-port-check-"));
	try {
		const reasons = (name: string, tool: { json: object; code: string }) => {
			const scan = scanPackage(writePackage(join(root, name + Math.random().toString(36).slice(2)), name, { draft: tool }), { runCases: false, folder: name });
			return scan.ok ? [] : scan.problems.map((p) => p.reason);
		};
		assert.deepEqual(reasons("mail", ECHO), []);
		assert.ok(reasons("notes", ECHO).some((r) => r.includes("只有模块 mail 能用")), JSON.stringify(reasons("notes", ECHO)));
		const other = { ...ECHO, json: { effect: "write", port: "gmail.send" } };
		assert.ok(reasons("mail", other).some((r) => r.includes('"port" must be gmail.createDraft')), JSON.stringify(reasons("mail", other)));
		const readOnly = { ...ECHO, json: { effect: "read", port: "gmail.createDraft" } };
		assert.ok(reasons("mail", readOnly).some((r) => r.includes('"effect": "write"')), JSON.stringify(reasons("mail", readOnly)));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
