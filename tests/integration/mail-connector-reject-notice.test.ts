import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const BODY = "账户尾号 8842 余额 31,337.00";

test("拒收一封信时，发出去的通知只说哪个 feed、哪封信、试了几次；handler 错误里引用的正文只写进本地拒收记录", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "psa-mail-reject-"));
	const stateDir = join(root, "state");
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [REFRESH]: "https://www.googleapis.com/auth/gmail.readonly" } });
	let stopHost = async () => {};
	t.after(async () => {
		await stopHost();
		await google.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	});
	const pkg = join(root, "modules", "fills");
	mkdirSync(join(pkg, "feeds/fills"), { recursive: true });
	mkdirSync(join(pkg, "data/fills"), { recursive: true });
	writeFileSync(join(pkg, "module.json"), JSON.stringify({ schema: 1, name: "fills", version: "0.1.0", title: "成交" }));
	writeFileSync(join(pkg, "data/fills/collection.json"), JSON.stringify({ title: "成交", kind: "record", class: "private", fields: { subject: { type: "text", title: "主题" } } }));
	writeFileSync(join(pkg, "feeds/fills/feed.json"), JSON.stringify({ title: "成交确认", connector: "mail", handler: "index.ts", every: "1s", settings: { senders: ["@broker.example.net"] }, into: "fills" }));
	writeFileSync(join(pkg, "feeds/fills/index.ts"), "export default (input) => { throw new Error(`读不懂，收到 ${input.items[0].body}`); };\n");
	const modules = servedAsHost(Modules.load([join(root, "modules")]));
	const secrets: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: google.client.id, GOOGLE_OAUTH_CLIENT_SECRET: google.client.secret, GMAIL_READ_REFRESH_TOKEN: REFRESH };
	const host = await Host.start({
		stateDir,
		createRouter: fauxRouter(() => []).createRouter,
		createSpawner: () => new FakeSpawner(() => {}),
		log: () => {},
		workerModels: defaultWorkerModels(),
		moduleFeeds: { feeds: () => modules.feeds(), fixtures: false, tickMs: 20, mail: gmailAccount({ secret: (name) => secrets[name], oauthUrl: google.url }) },
	});
	stopHost = () => host.stop();
	const rejectedDir = join(stateDir, "inbox", "fills", "fills", "rejected");
	const notices = () => host.kernel.conversation(500).filter((l) => l.who === "notice").map((l) => l.text);
	await until(() => instanceData(stateDir).feedState("fills" as never, "fills/fills").connectorCursor !== null, "feed 起了步");
	box.deliver({ id: "m-bad", from: "Broker <trade@broker.example.net>", subject: "成交确认", text: BODY });
	await until(() => notices().some((l) => l.includes("m-bad")), "拒收通知发出来了", 15_000).catch((e) => {
		throw new Error(`${e.message} ${JSON.stringify(notices())}`);
	});
	const notice = notices().find((l) => l.includes("m-bad"))!;
	assert.ok(!notice.includes("8842") && !notice.includes("读不懂"), `通知不带 handler 的错误文字：${notice}`);
	assert.match(notice, /成交确认/);
	assert.match(notice, /3 次/);
	const record = JSON.parse(readFileSync(join(rejectedDir, readdirSync(rejectedDir)[0]!), "utf8"));
	assert.match(record.note, /8842/, "错误详情留在本地拒收记录里");
});
