/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/mail-ticket-live.ts [outDir]
 *
 * The real Router and Worker (openai-codex, through the Pi login in ~/.pi/agent) see two letters from the local fake
 * Gmail, once on a detached worktree of origin/main at <outDir>/trunk and once on this head. Nothing reaches Google.
 * Each run passes when every mail ticket's worker found its letter in `messages` by the trigger's id, and no report
 * asks the user for the letter's text.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const USER = 42;
const REFRESH = "1//fake-refresh-mail";
const [outDir = "/tmp/psa-mailread/live"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const { FakeTelegram, FAKE_BOT_TOKEN } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const { startFakeGoogle } = await import(join(HEAD, "tests/helpers/fake-google.ts"));
const { FakeInbox } = await import(join(HEAD, "tests/helpers/fake-gmail.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
const { Modules } = await import(join(HEAD, "src/modules.ts"));
const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));

const LETTERS = [
	{ id: "18f0a1b2c3d4e5f6", from: "Ann Lee <ann@example.com>", subject: "IRS notice CP2000 for your 2025 return", snippet: "Please see the attached IRS notice", text: "The IRS proposes an additional $1,840 for tax year 2025. You must respond by December 1, 2026, or the amount becomes final. Please send the 1099-B from your broker before November 25." },
	{ id: "18f0a1b2c3d4e5f7", from: "Ann Lee <ann@example.com>", subject: "RE: Internal transfer and outgoing wire", snippet: "We need your confirmation to release the wire", text: "The FX for the outgoing wire was booked today. We need your signed confirmation by Monday 5pm ET to release the wire of 250,000 CNH; otherwise the booking is cancelled." },
];

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function within(limitMs: number, ok: () => boolean): Promise<boolean> {
	for (const end = Date.now() + limitMs; Date.now() < end; await sleep(500)) if (ok()) return true;
	return ok();
}
function query(path: string, sql: string): Record<string, unknown>[] {
	if (!existsSync(path)) return [];
	const db = new DatabaseSync(path, { readOnly: true, timeout: 2000 });
	try {
		return db.prepare(sql).all() as Record<string, unknown>[];
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

type DataCall = { args: string; rows: number };
function dataCalls(sessionFile: string): DataCall[] {
	const calls: DataCall[] = [];
	const pending = new Map<string, string>();
	for (const line of readFileSync(sessionFile, "utf8").split("\n").filter(Boolean)) {
		const message = JSON.parse(line).message as { role?: string; content?: unknown; toolCallId?: string; toolName?: string } | undefined;
		if (!message || !Array.isArray(message.content)) continue;
		for (const part of message.content as { type: string; id?: string; name?: string; arguments?: unknown; text?: string }[]) {
			if (part.type === "toolCall" && part.name === "data") pending.set(part.id!, JSON.stringify(part.arguments));
			if (part.type === "text" && message.role === "toolResult" && message.toolName === "data" && pending.has(message.toolCallId!)) {
				const reply = part.text!.slice(part.text!.indexOf("{"));
				let rows = 0;
				try {
					rows = (JSON.parse(reply) as { rows?: unknown[] }).rows?.length ?? 0;
				} catch {
					rows = 0;
				}
				calls.push({ args: pending.get(message.toolCallId!)!, rows });
			}
		}
	}
	return calls;
}

async function run(label: string, repo: string): Promise<{ pass: boolean; evidence: string }> {
	const state = mkdtempSync("/tmp/psa-mailread/s-");
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [REFRESH]: "https://www.googleapis.com/auth/gmail.readonly" } });
	writeFileSync(join(state, "secrets.env"), `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\nGOOGLE_OAUTH_CLIENT_ID=${google.client.id}\nGOOGLE_OAUTH_CLIENT_SECRET=${google.client.secret}\nGMAIL_READ_REFRESH_TOKEN=${REFRESH}\n`, { mode: 0o600 });
	const pkg = join(state, "modules/mail");
	cpSync(join(repo, "docs/modules/examples/mail"), pkg, { recursive: true });
	const feedJson = join(pkg, "feeds/inbox/feed.json");
	writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), every: "2s", settings: { baseUrl: google.url, tokenUrl: `${google.url}/token` } }));
	const entry = servedAsHost(Modules.load([join(state, "modules")])).feeds().find((e: { source: string }) => e.source === "mail/inbox");
	instanceData(state).write("mail", entry.components, "senders", [{ address: "ann@example.com" }], "使用者口述", "lane");
	const tg = await FakeTelegram.start();
	const harness = await import(join(repo, "tests/e2e/harness.ts"));
	const host = await harness.startHost({
		repo,
		models: REAL,
		stateDir: state,
		logFile: join(state, "host.log"),
		config: { webPort: 0, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] }, modules: { mail: true } },
		env: { PSA_E2E_TELEGRAM_URL: tg.url },
		timeoutMs: 60_000,
		imports: ["./tests/e2e/telegram-preload.mjs"],
	});
	try {
		tg.userSays(USER, "/start");
		await within(10_000, () => tg.sent.length > 0);
		box.deliver(...LETTERS);
		const db = join(state, "state.db");
		const tickets = () => query(db, "SELECT id, title, basis, domain FROM tickets WHERE domain = 'mail' OR origin_trigger_id IN (SELECT id FROM triggers WHERE source = 'mail/inbox')");
		const reported = () => query(db, "SELECT t.id, r.status, r.summary, r.question FROM tickets t JOIN reports r ON r.ticket_id = t.id WHERE r.status <> 'progress'");
		await within(120_000, () => tickets().length > 0);
		await within(300_000, () => tickets().every((t) => reported().some((r) => r["id"] === t["id"])));
		const sessionsDir = join(state, "sessions/workers");
		const sessions = existsSync(sessionsDir) ? readdirSync(sessionsDir).map((f) => join(sessionsDir, f)) : [];
		const perSession = sessions.map((f) => dataCalls(f));
		const triggers = query(db, "SELECT external_id, disposition FROM triggers WHERE source = 'mail/inbox'");
		const askedForText = reported().filter((r) => typeof r["question"] === "string" && /正文|全文|内容|附件|提供/.test(String(r["question"])));
		const ids = new Set(triggers.map((t) => String(t["external_id"])));
		const byTriggerId = (c: DataCall) => ids.has(String((JSON.parse(c.args) as { where?: { gmailId?: unknown } }).where?.gmailId));
		const found = perSession.length > 0 && perSession.every((calls) => calls.some((c) => byTriggerId(c) && c.rows > 0));
		const pass = tickets().length > 0 && found && askedForText.length === 0;
		cpSync(join(state, "host.log"), join(outDir, `${label}-host.log`));
		if (existsSync(sessionsDir)) cpSync(sessionsDir, join(outDir, `${label}-sessions`), { recursive: true });
		return {
			pass,
			evidence: [
				`repo ${repo} models ${JSON.stringify(REAL)}`,
				`stored gmailIds ${JSON.stringify(query(join(state, "modules-data/mail/data.db"), "SELECT gmailId FROM messages").map((r) => r["gmailId"]))}`,
				`triggers ${JSON.stringify(triggers)}`,
				`tickets ${JSON.stringify(tickets())}`,
				...perSession.map((calls, i) => `worker session ${i + 1} data calls: ${calls.map((c) => `${c.args} -> ${c.rows} rows`).join(" | ") || "none"}`),
				`reports ${JSON.stringify(reported())}`,
				`reports asking for the letter's text: ${askedForText.length}`,
			].join("\n"),
		};
	} finally {
		await host.stop();
		await tg.close();
		await google.close();
		rmSync(state, { recursive: true, force: true });
	}
}

for (const [label, repo] of [["trunk", trunk()], ["head", HEAD]] as const) {
	const verdict = await run(label, repo);
	const out = join(outDir, `${label}.txt`);
	writeFileSync(out, `${verdict.pass ? "PASS" : "FAIL"} ${label}\n${verdict.evidence}\n`);
	console.log(`${verdict.pass ? "PASS" : "FAIL"}  ${label}  ${out}`);
}
