import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Host } from "../src/host/host.ts";
import { createGateway } from "../src/modules/gateway.ts";
import { googlePort } from "../src/modules/google-port.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { moduleDataDir } from "../src/modules/knowledge.ts";
import { ModuleStore } from "../src/modules/live.ts";
import type { ModuleName } from "../src/modules/manifest.ts";
import { scanPackage } from "../src/modules/validate.ts";
import { Modules } from "../src/modules.ts";
import { FakeInbox } from "./helpers/fake-gmail.ts";
import { startFakeGoogle } from "./helpers/fake-google.ts";
import { defaultWorkerModels, FakeSpawner, fauxRouter, ids, servedAsHost, until, type Brain, type ToolCallSpec } from "./helpers/fakes.ts";

const MAIL = "mail" as ModuleName;

test("邮件开的推断任务：用触发上的编号和线程在 messages 里查得到这封信，查不到别的信", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "psa-mail-ticket-"));
	const stateDir = join(root, "state");
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { "1//fake-refresh-mail": "https://www.googleapis.com/auth/gmail.readonly" } });
	const pkg = join(root, "modules", "mail");
	cpSync(join(import.meta.dirname, "../docs/modules/examples/mail"), pkg, { recursive: true });
	const feedJson = join(pkg, "feeds", "inbox", "feed.json");
	writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), every: "1s", settings: { baseUrl: google.url, tokenUrl: `${google.url}/token` } }));
	const scan = scanPackage(pkg, { runCases: false, folder: MAIL });
	assert.ok(scan.ok);
	const store = new ModuleStore(join(stateDir, "module-store"));
	assert.ok(store.keep(MAIL, scan.scan.digest, pkg));
	const modules = servedAsHost(Modules.load([join(root, "modules")]));
	const secrets: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: google.client.id, GOOGLE_OAUTH_CLIENT_SECRET: google.client.secret, GMAIL_READ_REFRESH_TOKEN: "1//fake-refresh-mail" };
	const rows = instanceData(stateDir);
	rows.write(MAIL, modules.feeds().find((e) => e.source === "mail/inbox")!.components, "senders", [{ address: "ann@example.com" }], "使用者口述", "test");
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
		cards.flatMap((card): ToolCallSpec[] =>
			card.startsWith("[候选触发]") && card.includes("税务通知") ? [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "inference", triggerId: ids(card, "trg"), title: "看税务信", brief: "看这封信", domain: MAIL }] } }] : [],
		);
	type Found = { rows: { fields: { body: string } }[] };
	const found: { byId?: string[]; byThread?: string[] } = {};
	const spawner = new FakeSpawner((worker, input) => {
		if (!input.startsWith("[任务说明]")) return;
		void (async () => {
			const seen = (await worker.request("worker.read", { id: input.match(/trg_[\w-]+/)![0] })) as { trigger: { externalId: string }; threadIds: string[] };
			const thread = seen.threadIds[0]!.slice("thr_mail/inbox:".length);
			const byId = (await worker.request("worker.data", { op: "query", collection: "messages", where: { gmailId: seen.trigger.externalId } })) as Found;
			const byThread = (await worker.request("worker.data", { op: "query", collection: "messages", where: { threadId: thread } })) as Found;
			found.byId = byId.rows.map((r) => r.fields.body);
			found.byThread = byThread.rows.map((r) => r.fields.body);
			worker.report({ status: "ready", summary: "看过了" });
			worker.settle();
		})().catch((e: Error) => worker.report({ status: "failed", summary: e.message }));
	});
	const host = await Host.start({
		stateDir,
		createRouter: fauxRouter(brain).createRouter,
		createSpawner: () => spawner,
		log: () => {},
		workerModels: defaultWorkerModels(),
		domains: { book: () => modules.book, kitFor: (d) => (d === MAIL ? { skillsDir: undefined, prepare: undefined, crew: [], granted: [] } : undefined) },
		gateway,
		moduleFeeds: { feeds: () => modules.feeds(), fixtures: false, tickMs: 20, secret: (name) => secrets[name] },
	});
	spawner.request = (...args) => host.workers.handleRequest(...args);
	t.after(async () => {
		await host.stop();
		await google.close();
		rmSync(root, { recursive: true, force: true });
	});
	box.deliver(
		{ id: "m-transfer", from: "Ann <ann@example.com>", subject: "转账确认", snippet: "已到账", text: "正文 转账已到账" },
		{ id: "m-tax", from: "Ann <ann@example.com>", subject: "税务通知", snippet: "附件是通知", text: "正文 下周一前回复" },
	);
	await until(() => found.byId !== undefined, "看信任务查过 messages", 10_000);
	assert.deepEqual(found, { byId: ["正文 下周一前回复"], byThread: ["正文 下周一前回复"] });
});
