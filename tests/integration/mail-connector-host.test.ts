import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Host } from "../../src/host/host.ts";
import { gmailAccount } from "../../src/modules/connectors/gmail.ts";
import { instanceData } from "../../src/modules/instance-data.ts";
import { Modules } from "../../src/modules.ts";
import { FakeInbox } from "../helpers/fake-gmail.ts";
import { startFakeGoogle } from "../helpers/fake-google.ts";
import { defaultWorkerModels, FakeSpawner, fauxRouter, servedAsHost, until } from "../helpers/fakes.ts";

const REFRESH = "1//fake-refresh-mail";

test("宿主上的 mail 连接器：信经连接器进来成了通知；授权失效时两个 feed 只亮一条提醒，写明影响哪些 feed；恢复后自动消失", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "psa-mail-host-"));
	const stateDir = join(root, "state");
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [REFRESH]: "https://www.googleapis.com/auth/gmail.readonly" } });
	t.after(async () => {
		await google.close();
		rmSync(root, { recursive: true, force: true });
	});
	const mail = join(root, "modules", "mail");
	cpSync(join(import.meta.dirname, "../../docs/modules/examples/mail"), mail, { recursive: true });
	const feedJson = join(mail, "feeds/inbox/feed.json");
	writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), every: "1s" }));
	const second = join(root, "modules", "copy");
	cpSync(mail, second, { recursive: true });
	for (const only of ["tools", "rules.md", "py"]) rmSync(join(second, only), { recursive: true, force: true });
	writeFileSync(join(second, "module.json"), JSON.stringify({ schema: 1, name: "copy", version: "0.1.0", title: "副本" }));
	const modules = servedAsHost(Modules.load([join(root, "modules")]));
	const rows = instanceData(stateDir);
	for (const module of ["mail", "copy"] as const) rows.write(module as never, modules.feeds().find((e) => e.module === module)!.components, "senders", [{ address: "ann@example.com" }], "使用者口述", "test");
	const secrets: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: google.client.id, GOOGLE_OAUTH_CLIENT_SECRET: google.client.secret, GMAIL_READ_REFRESH_TOKEN: REFRESH };
	const host = await Host.start({
		stateDir,
		createRouter: fauxRouter(() => []).createRouter,
		createSpawner: () => new FakeSpawner(() => {}),
		log: () => {},
		workerModels: defaultWorkerModels(),
		moduleFeeds: { feeds: () => modules.feeds(), fixtures: false, tickMs: 20, mail: gmailAccount({ secret: (name) => secrets[name], oauthUrl: google.url }) },
	});
	t.after(() => host.stop());
	const lines = () => host.kernel.conversation(500).filter((l) => l.who === "notice").map((l) => l.text);
	await until(() => rows.feedState("mail" as never, "mail/inbox").connectorCursor !== null && rows.feedState("copy" as never, "copy/inbox").connectorCursor !== null, "两个 feed 都起了步");
	box.deliver({ id: "m-1", from: "Ann Lee <ann@example.com>", subject: "季度对账单", snippet: "您好，附件是本季度的对账单", text: "您好" });
	await until(() => lines().some((l) => l.includes("季度对账单") && l.startsWith("mail：")), "邮件的三行摘要发出来了").catch((e) => {
		throw new Error(`${e.message} ${JSON.stringify(host.kernel.conversation(50).map((l) => [l.who, l.text]))} ${JSON.stringify(host.snapshot().health.active)}`);
	});
	assert.ok(lines().some((l) => l.includes("Ann Lee <ann@example.com>\n季度对账单\n您好，附件是本季度的对账单")), JSON.stringify(lines()));
	secrets["GMAIL_READ_REFRESH_TOKEN"] = "1//revoked";
	const alarms = () => host.snapshot().health.active;
	await until(() => alarms().some((a) => a.id === "connector:mail"), "连接器的提醒亮了");
	await new Promise((done) => setTimeout(done, 1500));
	assert.deepEqual(alarms().map((a) => a.id), ["connector:mail"], "只有一条，不是每个 feed 一条");
	assert.match(alarms()[0]!.lastError, /just google-auth read/);
	assert.match(alarms()[0]!.lastError, /影响：copy 收件箱、mail 收件箱/);
	secrets["GMAIL_READ_REFRESH_TOKEN"] = REFRESH;
	await until(() => alarms().length === 0, "恢复后提醒消失");
});
