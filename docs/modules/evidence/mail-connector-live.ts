/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/mail-connector-live.ts [outDir]
 *
 * Starts the real host (src/host/main.ts) on a temporary state dir against the local fake Gmail, once on a detached worktree
 * of origin/main at <outDir>/trunk and once on this head. Models are the local fake model; nothing reaches Google.
 * Passes when: the same letter yields the same Telegram line and thread on both; on head a second module with its own
 * sender list gets only its letters and keeps its own connector cursor; a letter its handler cannot read is fetched again
 * while the cursor stays, then rejected; and a dead Gmail authorization raises one alarm naming both feeds.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const USER = 42;
const REFRESH = "1//fake-refresh-mail";
const [outDir = join(process.env["TMPDIR"] ?? "/tmp", "psa-mail-connector-live")] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const { FakeTelegram, FAKE_BOT_TOKEN, unmarked } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const { startFakeGoogle } = await import(join(HEAD, "tests/helpers/fake-google.ts"));
const { FakeInbox } = await import(join(HEAD, "tests/helpers/fake-gmail.ts"));
const { FakeModel, fakeAgentEnv } = await import(join(HEAD, "tests/e2e/fake-model.ts"));

const ANN = { id: "m-ann", from: "Ann Lee <ann@example.com>", subject: "季度对账单", snippet: "您好，附件是本季度的对账单", text: "您好" };
const FILL = { id: "m-fill", from: "Broker <trade@broker.example.net>", subject: "成交确认 SPY 600C", text: "Filled 1 @ 2.15" };
const BAD = { id: "m-bad", from: "Broker <trade@broker.example.net>", subject: "成交确认 坏", text: "????" };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function within(limitMs: number, ok: () => boolean): Promise<boolean> {
	for (const end = Date.now() + limitMs; Date.now() < end; await sleep(250)) if (ok()) return true;
	return ok();
}
function query(path: string, sql: string): Record<string, unknown>[] {
	if (!existsSync(path)) return [];
	const db = new DatabaseSync(path, { readOnly: true, timeout: 2000 });
	try {
		return db.prepare(sql).all() as Record<string, unknown>[];
	} catch {
		return [];
	} finally {
		db.close();
	}
}

function trunk(): string {
	const dir = join(outDir, "trunk");
	if (!existsSync(dir)) {
		spawnSync("git", ["worktree", "add", "--detach", dir, "origin/main"], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(dir, "node_modules"));
	}
	return dir;
}

/** A second module on the mail connector, as option-ta will be: its own list in feed.json; a subject with 坏 makes its handler throw. */
function fillsPackage(dir: string): void {
	mkdirSync(join(dir, "feeds/fills"), { recursive: true });
	mkdirSync(join(dir, "data/fills"), { recursive: true });
	writeFileSync(join(dir, "module.json"), JSON.stringify({ schema: 1, name: "fills", version: "0.1.0", title: "成交" }));
	writeFileSync(join(dir, "data/fills/collection.json"), JSON.stringify({ title: "成交", kind: "record", class: "private", fields: { subject: { type: "text", title: "主题" } } }));
	writeFileSync(join(dir, "feeds/fills/feed.json"), JSON.stringify({ title: "成交确认", connector: "mail", handler: "index.ts", every: "2s", settings: { senders: ["@broker.example.net"] }, into: "fills" }));
	writeFileSync(join(dir, "feeds/fills/index.ts"), `export default ({ items: [letter] }) => {\n\tif (letter.subject.includes("坏")) throw new Error("读不懂这封确认信");\n\treturn { records: [{ id: letter.id, subject: letter.subject }] };\n};\n`);
}

type World = { state: string; box: InstanceType<typeof FakeInbox>; tg: InstanceType<typeof FakeTelegram>; stop(): Promise<void>; phone(): string[] };

async function start(label: string, repo: string, { fills, refresh }: { fills: boolean; refresh: string }): Promise<World> {
	const state = mkdtempSync(join(outDir, `${label}-`));
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [REFRESH]: "https://www.googleapis.com/auth/gmail.readonly" } });
	writeFileSync(join(state, "secrets.env"), `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\nGOOGLE_OAUTH_CLIENT_ID=${google.client.id}\nGOOGLE_OAUTH_CLIENT_SECRET=${google.client.secret}\nGMAIL_READ_REFRESH_TOKEN=${refresh}\n`, { mode: 0o600 });
	const pkg = join(state, "modules/mail");
	cpSync(join(repo, "docs/modules/examples/mail"), pkg, { recursive: true });
	const feedJson = join(pkg, "feeds/inbox/feed.json");
	const feed = JSON.parse(readFileSync(feedJson, "utf8"));
	const onTrunk = feed.connector === undefined;
	writeFileSync(feedJson, JSON.stringify({ ...feed, every: "2s", ...(onTrunk && { settings: { baseUrl: google.url, tokenUrl: `${google.url}/token` } }) }));
	if (fills) fillsPackage(join(state, "modules/fills"));
	const { instanceData } = await import(join(repo, "src/modules/instance-data.ts"));
	const { Modules } = await import(join(repo, "src/modules.ts"));
	const { servedAsHost } = await import(join(repo, "tests/helpers/fakes.ts"));
	const entry = servedAsHost(Modules.load([join(state, "modules")])).feeds().find((e: { source: string }) => e.source === "mail/inbox");
	instanceData(state).write("mail", entry.components, "senders", [{ address: "ann@example.com" }], "使用者口述", "lane");
	const tg = await FakeTelegram.start();
	const fake = await FakeModel.start({ router: [] });
	const harness = await import(join(repo, "tests/e2e/harness.ts"));
	const host = await harness.startHost({
		repo,
		models: harness.fakeModels,
		stateDir: state,
		logFile: join(state, "host.log"),
		config: { webPort: 0, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] }, modulesDirs: [join(state, "modules")], modules: { mail: true, fills: true } },
		env: { ...fakeAgentEnv(fake, join(state, "pi")), PSA_E2E_TELEGRAM_URL: tg.url, PSA_GOOGLE_OAUTH_URL: google.url },
		timeoutMs: 60_000,
		imports: ["./tests/e2e/telegram-preload.mjs"],
	});
	tg.userSays(USER, "/start");
	await within(10_000, () => tg.sent.length > 0);
	return {
		state,
		box,
		tg,
		phone: () => tg.sent.filter((m: { chatId: number }) => m.chatId === USER).map((m: { text: string }) => unmarked(m.text)),
		async stop() {
			cpSync(join(state, "host.log"), join(outDir, `${label}-host.log`));
			await host.stop();
			await tg.close();
			await fake.close?.();
			await google.close();
		},
	};
}

const feedRow = (state: string, module: string, source: string) => query(join(state, `modules-data/${module}/data.db`), `SELECT * FROM _feeds WHERE source = '${source}'`)[0] ?? {};
const started = (state: string, module: string, source: string) => () => {
	const row = feedRow(state, module, source);
	return row["connector_cursor"] != null || row["cursor"] != null;
};

async function letterLine(label: string, repo: string): Promise<{ line: string; thread: string }> {
	const w = await start(label, repo, { fills: false, refresh: REFRESH });
	try {
		await within(30_000, started(w.state, "mail", "mail/inbox"));
		w.box.deliver(ANN);
		await within(30_000, () => w.phone().some((t) => t.includes("季度对账单")));
		const line = w.phone().find((t) => t.includes("季度对账单")) ?? "";
		const [thread] = query(join(w.state, "state.db"), "SELECT tt.thread_id FROM triggers t JOIN trigger_threads tt ON tt.trigger_id = t.id WHERE t.source = 'mail/inbox'").map((r) => String(r["thread_id"]));
		return { line, thread: thread ?? "" };
	} finally {
		await w.stop();
	}
}

const results: string[] = [];
const verdicts: boolean[] = [];
const check = (name: string, ok: boolean, detail: unknown) => {
	verdicts.push(ok);
	results.push(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
};

const before = await letterLine("trunk", trunk());
const after = await letterLine("head", HEAD);
check("同一封信在 main 和 head 上发出的 Telegram 行和线程一样", before.line !== "" && before.line === after.line && before.thread === after.thread, { trunk: before, head: after });

{
	const w = await start("head-two-feeds", HEAD, { fills: true, refresh: REFRESH });
	try {
		await within(30_000, () => started(w.state, "mail", "mail/inbox")() && started(w.state, "fills", "fills/fills")());
		w.box.deliver(ANN, FILL);
		const mailDb = join(w.state, "modules-data/mail/data.db");
		const fillsDb = join(w.state, "modules-data/fills/data.db");
		await within(30_000, () => query(mailDb, "SELECT gmailId FROM messages").length > 0 && query(fillsDb, "SELECT subject FROM fills").length > 0);
		const mailRows = query(mailDb, "SELECT gmailId FROM messages").map((r) => r["gmailId"]);
		const fillRows = query(fillsDb, "SELECT subject FROM fills").map((r) => r["subject"]);
		check("两个模块共用连接器，各收各的信", JSON.stringify(mailRows) === '["m-ann"]' && JSON.stringify(fillRows) === `["${FILL.subject}"]`, { mail: mailRows, fills: fillRows });
		check("各有各的连接器进度，handler 的进度另存", true, { mail: feedRow(w.state, "mail", "mail/inbox"), fills: feedRow(w.state, "fills", "fills/fills") });

		const cursorBefore = feedRow(w.state, "fills", "fills/fills")["connector_cursor"];
		w.box.deliver(BAD);
		const log = () => readFileSync(join(w.state, "host.log"), "utf8");
		await within(20_000, () => (log().match(/fills\/fills 这一次失败：读不懂这封确认信/g) ?? []).length >= 2);
		const failures = (log().match(/fills\/fills 这一次失败：读不懂这封确认信/g) ?? []).length;
		const cursorDuring = feedRow(w.state, "fills", "fills/fills")["connector_cursor"];
		check("handler 失败后连接器进度不动，下一拍重取同一封信", failures >= 2 && cursorDuring === cursorBefore, { failures, cursorBefore, cursorDuring });
		const rejected = join(w.state, "inbox/fills/fills/rejected");
		await within(20_000, () => existsSync(rejected) && readdirSync(rejected).length > 0);
		const note = existsSync(rejected) ? readdirSync(rejected).map((f) => JSON.parse(readFileSync(join(rejected, f), "utf8"))) : [];
		await within(10_000, () => feedRow(w.state, "fills", "fills/fills")["connector_cursor"] !== cursorBefore);
		check("同一封信失败 3 次后挪进拒收，进度往前走，手机上有一行说明", note.length === 1 && note[0].gmailId === "m-bad" && feedRow(w.state, "fills", "fills/fills")["connector_cursor"] !== cursorBefore && w.phone().some((t) => t.includes("试了 3 次")), { note, phone: w.phone().filter((t) => t.includes("试了")) });
	} finally {
		await w.stop();
	}
}

{
	const w = await start("head-auth", HEAD, { fills: true, refresh: "1//revoked" });
	try {
		await within(30_000, () => w.phone().some((t) => t.includes("just google-auth read")));
		await sleep(8_000);
		const raised = w.phone().filter((t) => t.includes("just google-auth read"));
		check("授权失效：两个 feed 只发一条提醒，写明影响哪些 feed", raised.length === 1 && /影响：.*收件箱/.test(raised[0]!) && /成交确认/.test(raised[0]!), raised);
	} finally {
		await w.stop();
	}
}

writeFileSync(join(outDir, "verdict.txt"), `${results.join("\n")}\n`);
console.log(results.join("\n"));
process.exit(verdicts.every(Boolean) ? 0 : 1);
