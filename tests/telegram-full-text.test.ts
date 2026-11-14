import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostLineLabel } from "../src/client/board-format.mjs";
import { Host } from "../src/host/host.ts";
import { BotApi, BotToken } from "../src/host/telegram/bot-api.ts";
import { createGateway } from "../src/modules/gateway.ts";
import { googlePort } from "../src/modules/google-port.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { moduleDataDir } from "../src/modules/knowledge.ts";
import { ModuleStore } from "../src/modules/live.ts";
import type { ModuleName } from "../src/modules/manifest.ts";
import { scanPackage } from "../src/modules/validate.ts";
import { Modules } from "../src/modules.ts";
import { FAKE_BOT_TOKEN, FakeTelegram, unmarked } from "./helpers/fake-telegram.ts";
import { FakeInbox } from "./helpers/fake-gmail.ts";
import { startFakeGoogle } from "./helpers/fake-google.ts";
import { defaultWorkerModels, FakeSpawner, fauxRouter, ids, servedAsHost, until, type Brain, type ToolCallSpec } from "./helpers/fakes.ts";

const USER = 42;
const LETTERS = "private-line" as ModuleName;
const BODY = "正文：复查定在周四上午九点";
const PRICE = "回：TSLA 现价 412.5";

test("私密模块的信经过幕僚长和任务之后，Telegram 上照样是全文：命令卡片和问题卡片在手机上能点，转述带正文，之后无关的回复也是全文", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "psa-full-text-"));
	const stateDir = join(root, "state");
	const pkg = join(import.meta.dirname, "fixtures/modules/private-line");
	const scan = scanPackage(pkg, { runCases: false, folder: LETTERS });
	assert.ok(scan.ok);
	const store = new ModuleStore(join(stateDir, "module-store"));
	assert.ok(store.keep(LETTERS, scan.scan.digest, pkg));
	const modules = servedAsHost(Modules.load([join(import.meta.dirname, "fixtures/modules")]));
	const gateway = createGateway({
		copyDir: (module, d) => store.dirOf(module, d),
		serving: (module) => (module === LETTERS ? scan.scan.digest : undefined),
		dataDir: (module) => moduleDataDir(stateDir, module),
		rows: instanceData(stateDir),
		secret: () => undefined,
		log: () => {},
	});
	const brain: Brain = (cards) =>
		cards.flatMap((card): ToolCallSpec[] => {
			if (card.startsWith("[候选触发]")) return [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "inference", triggerId: ids(card, "trg"), title: "看信", brief: "看信", domain: LETTERS }] } }];
			if (card.startsWith("[Worker 汇报]")) return [{ name: "reply", args: { text: `转述：${card.split("\n")[1]}`, cause: ids(card, "tkt") } }];
			const answered = card.match(/点选回答：(tkt_[\w-]+)/)?.[1];
			if (card.startsWith("[对话]") && answered) return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: ids(card, "trg"), ticketId: answered }] } }];
			if (card.startsWith("[对话]")) return [{ name: "reply", args: { text: PRICE, cause: ids(card, "trg") } }];
			return [];
		});
	const tg = await FakeTelegram.start();
	let host!: Host;
	const turns = new Map<string, number>();
	const spawner = new FakeSpawner((worker) => {
		const turn = (turns.get(worker.spec.ticketId) ?? 0) + 1;
		turns.set(worker.spec.ticketId, turn);
		void (async () => {
			const read = (await worker.request("worker.data", { op: "query", collection: "messages" })) as { rows: { fields: { body: string } }[] };
			const body = read.rows.map((r) => r.fields.body).join("；");
			if (turn === 1) await worker.request("worker.ask_to_run", { command: "printf ok > run-marker", why: `核对 ${body}` });
			else if (turn === 2) worker.report({ status: "blocked", summary: body, question: `${body}，要回信吗？`, options: ["要", "不要"] });
			else worker.report({ status: "ready", summary: `信里说：${body}` });
			worker.settle();
		})().catch((e: Error) => worker.report({ status: "failed", summary: e.message }));
	});
	host = await Host.start({
		stateDir,
		createRouter: fauxRouter(brain).createRouter,
		createSpawner: () => spawner,
		log: () => {},
		workerModels: defaultWorkerModels(),
		domains: { book: () => modules.book, kitFor: (d) => (d === LETTERS ? { skillsDir: undefined, prepare: undefined, crew: [], granted: [] } : undefined) },
		gateway,
		moduleFeeds: { feeds: () => modules.feeds(), fixtures: false, tickMs: 20 },
		telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 1, minGapMs: 5 } },
	});
	spawner.request = (...args) => host.workers.handleRequest(...args);
	t.after(async () => {
		await host.stop();
		await tg.close();
		rmSync(root, { recursive: true, force: true });
	});
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length > 0, "聊天打开");
	const phone = () => tg.sent.filter((m) => m.chatId === USER);

	const inbox = join(stateDir, "inbox", LETTERS, "inbox");
	mkdirSync(inbox, { recursive: true });
	writeFileSync(join(inbox, "m-1.json"), JSON.stringify({ id: "m-1", from: "Ann <ann@example.com>", subject: "复查通知", snippet: "请看正文", body: BODY }));
	await until(() => !readdirSync(inbox).some((f) => f.endsWith(".json")), "收件箱处理完", 10_000);
	await until(() => phone().some((m) => unmarked(m.text) === "通知：测试信箱：Ann <ann@example.com>\n复查通知\n请看正文"), "三行通知照旧到了 Telegram", 10_000);

	await until(() => phone().some((m) => m.text.includes("printf ok > run-marker") && m.buttons !== null), "命令卡片带着命令和按钮到了手机", 10_000);
	const runCard = phone().find((m) => m.text.includes("printf ok > run-marker"))!;
	assert.ok(runCard.text.includes(BODY), "命令卡片带着任务的说法");
	const ticketId = host.kernel.listTickets().find((r) => r.title === "看信")!.id;
	tg.userTaps(USER, runCard.messageId, runCard.buttons!.flat()[0]!.data);
	await until(() => existsSync(join(stateDir, "workers", ticketId, "run-marker")), "在手机上点「同意」，命令运行了", 10_000);

	await until(() => phone().some((m) => m.text.includes("要回信吗") && m.buttons !== null), "问题卡片带按钮到了手机", 10_000);
	const question = phone().find((m) => m.text.includes("要回信吗") && m.buttons !== null)!;
	assert.ok(question.text.includes(BODY), "问题卡片是全文");
	tg.userTaps(USER, question.messageId, question.buttons!.flat()[1]!.data);
	await until(() => phone().some((m) => unmarked(m.text) === `转述：信里说：${BODY}`), "看信任务的转述全文到了 Telegram", 10_000);

	tg.userSays(USER, "TSLA 现在多少");
	await until(() => phone().some((m) => unmarked(m.text) === PRICE), "之后无关的回复全文到了 Telegram", 10_000);
	assert.deepEqual(phone().filter((m) => m.text.includes("请在网页上查看")).map((m) => m.text), []);
});

test("mail 模块：三行通知、看信和回信任务的转述都全文到 Telegram；写草稿的收据只在本机；不发信", async (t) => {
	const MAIL = "mail" as ModuleName;
	const root = mkdtempSync(join(tmpdir(), "psa-canary-mail-"));
	const stateDir = join(root, "state");
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { "1//fake-refresh-mail": "https://www.googleapis.com/auth/gmail.readonly", "1//fake-refresh-draft": "https://www.googleapis.com/auth/gmail.compose" } });
	const pkg = join(root, "modules", "mail");
	cpSync(join(import.meta.dirname, "../docs/modules/examples/mail"), pkg, { recursive: true });
	const feedJson = join(pkg, "feeds", "inbox", "feed.json");
	writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), every: "1s", settings: { baseUrl: google.url, tokenUrl: `${google.url}/token` } }));
	const scan = scanPackage(pkg, { runCases: false, folder: MAIL });
	assert.ok(scan.ok);
	const store = new ModuleStore(join(stateDir, "module-store"));
	assert.ok(store.keep(MAIL, scan.scan.digest, pkg));
	const modules = servedAsHost(Modules.load([join(root, "modules")]));
	const secrets: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: google.client.id, GOOGLE_OAUTH_CLIENT_SECRET: google.client.secret, GMAIL_READ_REFRESH_TOKEN: "1//fake-refresh-mail", GMAIL_DRAFT_REFRESH_TOKEN: "1//fake-refresh-draft" };
	const rows = instanceData(stateDir);
	const mailComponents = modules.feeds().find((e) => e.source === "mail/inbox")!.components;
	rows.write(MAIL, mailComponents, "senders", [{ address: "ann@example.com" }], "使用者口述", "test");
	const gateway = createGateway({
		copyDir: (module, d) => store.dirOf(module, d),
		serving: (module) => (module === MAIL ? scan.scan.digest : undefined),
		dataDir: (module) => moduleDataDir(stateDir, module),
		rows,
		secret: () => undefined,
		log: () => {},
		google: googlePort({ secret: (name) => secrets[name], oauthUrl: google.url, fixtures: false }),
	});
	const brain: Brain = (cards) =>
		cards.flatMap((card): ToolCallSpec[] => {
			if (card.startsWith("[候选触发]") && card.includes("季度对账单")) return [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "inference", triggerId: ids(card, "trg"), title: "看信", brief: "看信", domain: MAIL }] } }];
			if (card.startsWith("[Worker 汇报]")) return [{ name: "reply", args: { text: `转述：${card.split("\n")[1]}`, cause: ids(card, "tkt") } }];
			if (card.startsWith("[对话]") && card.includes("回那封信")) return [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId: ids(card, "trg"), title: "回信", brief: "回信", domain: MAIL }] } }];
			return [];
		});
	const tg = await FakeTelegram.start();
	let host!: Host;
	const spawner = new FakeSpawner((worker, input) => {
		if (!input.startsWith("[任务说明]")) return;
		void (async () => {
			if (host.kernel.getTicket(worker.spec.ticketId)!.title === "回信") {
				const made = (await worker.request("worker.domain_tool", { name: "draft-reply", input: { messageId: "m-1", body: "周四可以" } })) as { subject: string };
				worker.report({ status: "ready", summary: `草稿写好了：${made.subject}` });
				return worker.settle();
			}
			const read = (await worker.request("worker.data", { op: "query", collection: "messages" })) as { rows: { fields: { body: string } }[] };
			worker.report({ status: "ready", summary: `信里说：${read.rows.map((r) => r.fields.body).join("；")}` });
			worker.settle();
		})().catch((e: Error) => worker.report({ status: "failed", summary: e.message }));
	});
	host = await Host.start({
		stateDir,
		createRouter: fauxRouter(brain).createRouter,
		createSpawner: () => spawner,
		log: () => {},
		ruleAllows: () => true,
		workerModels: defaultWorkerModels(),
		domains: { book: () => modules.book, kitFor: (d) => (d === MAIL ? { skillsDir: undefined, prepare: undefined, crew: [], granted: [] } : undefined) },
		gateway,
		moduleFeeds: { feeds: () => modules.feeds(), fixtures: false, tickMs: 20, secret: (name) => secrets[name] },
		telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 1, minGapMs: 5 } },
	});
	spawner.request = (...args) => host.workers.handleRequest(...args);
	t.after(async () => {
		await host.stop();
		await tg.close();
		await google.close();
		rmSync(root, { recursive: true, force: true });
	});
	tg.userSays(USER, "/start");
	const phone = () => tg.sent.filter((m) => m.chatId === USER).map((m) => unmarked(m.text));
	await until(() => phone().length > 0, "聊天打开");
	box.deliver({ id: "m-1", from: "Ann Lee <ann@example.com>", subject: "季度对账单", snippet: "附件是对账单", text: "正文 周四下午三点开会" });
	await until(() => phone().includes("通知：邮件：Ann Lee <ann@example.com>\n季度对账单\n附件是对账单"), "三行通知到了 Telegram", 10_000);
	await until(() => phone().some((text) => text.startsWith("转述：信里说：") && text.includes("周四下午三点开会")), "看信任务的转述全文到了 Telegram", 10_000);
	host.say("帮我回那封信");
	await until(() => host.kernel.conversation(500).some((l) => l.who === "receipt" && l.text.includes("收件人：ann@example.com")), "网页上有写草稿的收据", 10_000);
	const receipt = host.kernel.conversation(500).find((l) => l.who === "receipt")!;
	assert.equal(hostLineLabel(receipt), "邮件（只在本机）", "收据在网页和终端上标着模块名和只在本机");
	await until(() => phone().some((text) => text.startsWith("转述：草稿写好了")), "回信任务的转述全文到了 Telegram", 10_000);
	assert.equal(box.drafts.length, 1, "建了一封草稿");
	assert.match(box.drafts[0]!.raw, /^To: ann@example\.com\r\n/);
	await new Promise((r) => setTimeout(r, 200));
	assert.deepEqual([...tg.sent.map((m) => m.text), ...tg.edits.map((e) => e.text)].filter((text) => text.includes("收件人")), [], "收据不上 Telegram");
	assert.ok(!google.log.some((line) => line.includes("SEND")), "没有发信的请求");
});
