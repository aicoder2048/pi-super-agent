import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Host } from "../../src/host/host.ts";
import { BotApi, BotToken } from "../../src/host/telegram/bot-api.ts";
import { gmailAccount } from "../../src/modules/connectors/gmail.ts";
import { instanceData } from "../../src/modules/instance-data.ts";
import { Modules } from "../../src/modules.ts";
import { FakeInbox } from "../helpers/fake-gmail.ts";
import { FAKE_BOT_TOKEN, FakeTelegram, unmarked } from "../helpers/fake-telegram.ts";
import { startFakeGoogle } from "../helpers/fake-google.ts";
import { defaultWorkerModels, FakeSpawner, fauxRouter, servedAsHost, until } from "../helpers/fakes.ts";

const REFRESH = "1//fake-refresh-mail";
const BODY = "账户尾号 8842 余额 31,337.00";
const USER = 42;

function writeModule(root: string, name: string, title: string, files: Record<string, unknown>): void {
	const pkg = join(root, "modules", name);
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "module.json"), JSON.stringify({ schema: 1, name, version: "0.1.0", title }));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(pkg, path, ".."), { recursive: true });
		writeFileSync(join(pkg, path), typeof content === "string" ? content : JSON.stringify(content));
	}
}

test("私密 feed 连续失败亮警报：发到手机的警报不带 handler 的错误原文，原文只进本机日志；可分享 feed 的警报照旧带原文", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "psa-feed-alarm-private-"));
	const stateDir = join(root, "state");
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [REFRESH]: "https://www.googleapis.com/auth/gmail.readonly" } });
	const tg = await FakeTelegram.start();
	let stopHost = async () => {};
	t.after(async () => {
		await stopHost();
		await tg.close();
		await google.close();
		rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	});
	writeModule(root, "fills", "成交", {
		"data/fills/collection.json": { title: "成交", kind: "record", class: "private", fields: { subject: { type: "text", title: "主题" } } },
		"feeds/fills/feed.json": { title: "成交确认", connector: "mail", handler: "index.ts", every: "1s", settings: { senders: ["@broker.example.net"] }, into: "fills" },
		"feeds/fills/index.ts": "export default (input) => { throw new Error(`读不懂，收到 ${input.items[0].body}`); };\n",
	});
	writeModule(root, "quotes", "报价", {
		"data/quotes/collection.json": { title: "行情", kind: "record", class: "shareable", fields: { price: { type: "number", title: "价" } } },
		"feeds/quotes/feed.json": { title: "行情", handler: "index.ts", every: "1s", into: "quotes" },
		"feeds/quotes/index.ts": "export default () => { throw new Error(\"HTTP 503 Service Unavailable\"); };\n",
	});
	const modules = servedAsHost(Modules.load([join(root, "modules")]));
	const secrets: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: google.client.id, GOOGLE_OAUTH_CLIENT_SECRET: google.client.secret, GMAIL_READ_REFRESH_TOKEN: REFRESH };
	const log: string[] = [];
	const host = await Host.start({
		stateDir,
		createRouter: fauxRouter(() => []).createRouter,
		createSpawner: () => new FakeSpawner(() => {}),
		log: (line) => void log.push(line),
		workerModels: defaultWorkerModels(),
		health: { modelFailuresBeforeAlarm: 2, feedFailuresBeforeAlarm: 1 },
		moduleFeeds: { feeds: () => modules.feeds(), fixtures: false, tickMs: 20, mail: gmailAccount({ secret: (name) => secrets[name], oauthUrl: google.url }) },
		telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 1, minGapMs: 5 } },
	});
	stopHost = () => host.stop();
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length > 0, "聊天打开");
	const alarm = (subject: string) => tg.sent.map((m) => unmarked(m.text)).find((text) => text.includes(`⚠️ ${subject}出问题了`));
	await until(() => instanceData(stateDir).feedState("fills" as never, "fills/fills").connectorCursor !== null, "feed 起了步");
	box.deliver({ id: "m-bad", from: "Broker <trade@broker.example.net>", subject: "成交确认", text: BODY });
	await until(() => alarm("fills 成交确认") !== undefined && alarm("quotes 行情") !== undefined, "两个 feed 的警报都亮了", 15_000).catch((e) => {
		throw new Error(`${e.message} ${JSON.stringify(tg.sent.map((m) => m.text))} ${log.join("\n")}`);
	});

	const phone = alarm("fills 成交确认")!;
	assert.ok(!phone.includes("8842") && !phone.includes("读不懂"), `私密 feed 的警报不带 handler 的错误原文：${phone}`);
	assert.match(phone, /host\.log/, "警报说详情在本机日志里");
	assert.ok(log.some((line) => line.includes("fills/fills") && line.includes("8842")), "错误原文进了本机日志");
	assert.match(alarm("quotes 行情")!, /HTTP 503 Service Unavailable/, "可分享 feed 的警报照旧带诊断");
});
