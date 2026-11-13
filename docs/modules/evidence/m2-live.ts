/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/m2-live.ts [lanes|perf] [outDir] [lane numbers...]
 *
 * Every lane talks to the local fake Google server (tests/helpers/fake-google.ts) with fake client ids and a fake
 * refresh token; nothing reaches Google. Lanes 1, 2 and 4 to 8 run the fake model and the fake Telegram. Lane 3
 * asks a real openai-codex model through the Pi login in ~/.pi/agent. Lane 1 and the perf baseline also run a
 * detached worktree of origin/main at <outDir>/trunk. Lanes 9 and 10 use the user's real account and are not
 * here. For them, `proxy [outDir] [port]` forwards 127.0.0.1:<port> to Google and logs only each request's method,
 * path with ids masked, status and time, so lane 9 can show which kinds of requests the feed made.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const PKG = join(HEAD, "docs/modules/examples/mail");
const TAX_SAMPLE = join(HEAD, "docs/modules/architecture/sample/personal-tax");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const USER = 42;
const REFRESH = "1//fake-refresh-mail";
const HOUR = 3_600_000;
const GMAIL = "/gmail/v1/users/me";
const [mode = "lanes", outDir = "/tmp/swarm-m2/owner", ...only] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
mkdirSync("/tmp/m2l", { recursive: true });

const { fakeModels } = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, domainTool, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const { startFakeGoogle } = await import(join(HEAD, "tests/helpers/fake-google.ts"));
const { FakeInbox } = await import(join(HEAD, "tests/helpers/fake-gmail.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
type Letter = import("../../tests/helpers/fake-gmail.ts").Letter;
type Call = { name: string; args: Record<string, unknown> };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function within(limitMs: number, ok: () => boolean, stepMs = 50): Promise<boolean> {
	for (const end = Date.now() + limitMs; Date.now() < end; await sleep(stepMs)) if (ok()) return true;
	return ok();
}
const graphemes = (s: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

function query(path: string, sql: string): Record<string, unknown>[] {
	if (!existsSync(path)) return [];
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(sql).all() as Record<string, unknown>[];
	} finally {
		db.close();
	}
}
const tableRows = (state: string, collection: string) => {
	const db = join(state, "modules-data/mail/data.db");
	return query(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${collection}'`).flatMap((t) => query(db, `SELECT * FROM "${t.name}" ORDER BY "_id"`));
};

function trunk(): string {
	const dir = join(outDir, "trunk");
	if (!existsSync(dir)) {
		spawnSync("git", ["worktree", "add", "--detach", dir, "origin/main"], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(dir, "node_modules"));
	}
	return dir;
}

const ann = (id: string, extra: Partial<Letter> = {}): Letter => ({ id, from: "Ann Lee <ann@example.com>", subject: "季度对账单", snippet: "您好，附件是本季度的对账单", text: "您好，附件是本季度的对账单。", ...extra });
const promo = (id: string): Letter => ({ id, from: "Promo <deals@example.org>", subject: "大促", snippet: "全场五折", text: "全场五折" });

type WorldOptions = { mail?: "installed" | "later" | "none"; tax?: boolean; every?: string; senders?: string[]; cursor?: object; real?: boolean; repo?: string };

async function world(o: WorldOptions = {}) {
	const { mail = "installed", tax = false, every = "2s", senders = [], real = false, repo = HEAD } = o;
	const state = mkdtempSync("/tmp/m2l/s-");
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [REFRESH]: "https://www.googleapis.com/auth/gmail.readonly" } });
	const secretsText = (refresh: string) => `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\nGOOGLE_OAUTH_CLIENT_ID=${google.client.id}\nGOOGLE_OAUTH_CLIENT_SECRET=${google.client.secret}\nGMAIL_READ_REFRESH_TOKEN=${refresh}\n`;
	writeFileSync(join(state, "secrets.env"), secretsText(REFRESH), { mode: 0o600 });
	const pkgCopy = join(mkdtempSync("/tmp/m2l/p-"), "mail");
	cpSync(PKG, pkgCopy, { recursive: true });
	const feedJson = join(pkgCopy, "feeds/inbox/feed.json");
	writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), every, settings: { baseUrl: google.url, tokenUrl: `${google.url}/token` } }));
	const install = () => cpSync(pkgCopy, join(state, "modules/mail"), { recursive: true });
	if (mail === "installed") install();
	if (tax) cpSync(TAX_SAMPLE, join(state, "modules/personal-tax"), { recursive: true });
	if (mail === "installed" && (senders.length > 0 || o.cursor)) {
		const { Modules } = await import(join(HEAD, "src/modules.ts"));
		const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
		const entry = servedAsHost(Modules.load([join(state, "modules")])).feeds().find((e: { source: string }) => e.source === "mail/inbox");
		const data = instanceData(state);
		if (senders.length > 0) data.write("mail", entry.components, "senders", senders.map((address) => ({ address })), "使用者口述", "lane");
		if (o.cursor) data.saveFeedState("mail", "mail/inbox", { cursor: JSON.stringify(o.cursor) });
	}
	const tg = await FakeTelegram.start();
	const fake = real
		? null
		: await FakeModel.start({
				router: [
					on("算税", /^\[对话\][\s\S]*使用者：算一下 30000 美元的税/, (c: string) => [inDomain(openTicket(c, "算税"), "personal-tax"), reply(c, "好")]),
					on("回一句", /^\[对话\][\s\S]*使用者：今天大盘怎么样/, (c: string) => [reply(c, "固定的回答：今天大盘平稳")]),
					on("转述算税", /^\[Worker 汇报\][^\n]*算税/, (c: string) => [reply(c, `转述：${c.split("\n")[1] ?? ""}`)]),
				],
				workers: [worker("算税", on("调工具", /^\[任务说明\]/, () => [domainTool("tax-bracket", { taxableIncome: 30000 })]), on("汇报", /^\[模块工具\]/, (c: string) => [report("ready", c)]))],
			});
	const harness = await import(join(repo, "tests/e2e/harness.ts"));
	const host = await harness.startHost({
		repo,
		models: real ? REAL : fakeModels,
		stateDir: state,
		logFile: join(state, "host.log"),
		config: { webPort: 0, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] }, modules: { ...(mail === "installed" && { mail: true }), ...(tax && { "personal-tax": true }) } },
		env: { ...(fake ? fakeAgentEnv(fake, join(state, "pi")) : {}), PSA_E2E_TELEGRAM_URL: tg.url },
		timeoutMs: 60_000,
		imports: ["./tests/e2e/telegram-preload.mjs"],
	});
	tg.userSays(USER, "/start");
	await within(10_000, () => tg.sent.length > 0);
	const just = (args: string[]) => {
		const run = spawnSync("just", args, { cwd: repo, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300" }, encoding: "utf8", timeout: 60_000 });
		return { status: run.status, out: run.stdout + run.stderr };
	};
	const log = () => (existsSync(join(state, "host.log")) ? readFileSync(join(state, "host.log"), "utf8") : "");
	const beats = () => log().split("\n").filter((l) => l.includes("[feeds] mail/inbox")).length;
	const nextBeats = async (n: number, limitMs = 30_000) => {
		const target = beats() + n;
		await within(limitMs, () => beats() >= target);
		return beats() >= target;
	};
	const phone = () => (tg.sent as { chatId: number; text: string }[]).filter((m) => m.chatId === USER).map((m) => m.text);
	const notices = () => query(join(state, "state.db"), "SELECT text FROM host_lines WHERE kind = 'notice' AND source = 'mail/inbox' ORDER BY rowid").map((r) => String(r["text"]));
	const cursor = () => instanceData(state).feedState("mail", "mail/inbox").cursor as string | null;
	const stop = async (label: string) => {
		cpSync(join(state, "host.log"), join(outDir, `${label}-host.log`));
		await host.stop();
		await fake?.close();
		await tg.close();
		await google.close();
		rmSync(state, { recursive: true, force: true });
		rmSync(resolve(pkgCopy, ".."), { recursive: true, force: true });
	};
	return {
		state, box, google, tg, fake, host, just, log, beats, nextBeats, phone, notices, cursor, install, stop,
		messages: () => tableRows(state, "messages"),
		senders: () => tableRows(state, "senders"),
		setRefresh: (refresh: string) => writeFileSync(join(state, "secrets.env"), secretsText(refresh), { mode: 0o600 }),
		gmailRequests: () => google.log.filter((l: string) => l.startsWith("GET /gmail/")),
	};
}
type World = Awaited<ReturnType<typeof world>>;

const inDomain = (call: Call, domain: string, basis = "request") => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain, basis })) } });
const threeLines = (t: string) => t.startsWith("通知：邮件：") && t.split("\n").length === 3;

const results: string[] = [];
async function lane(n: number, slug: string, body: () => Promise<{ pass: boolean; evidence: string }>): Promise<void> {
	if (only.length > 0 && !only.includes(String(n))) return;
	let verdict: { pass: boolean; evidence: string };
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const file = join(outDir, `${slug}.txt`);
	writeFileSync(file, `${verdict.pass ? "PASS" : "FAIL"} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${verdict.pass ? "PASS" : "FAIL"}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

async function taxCall(w: World): Promise<string> {
	w.just(["module", "on", "personal-tax"]);
	w.tg.userSays(USER, "算一下 30000 美元的税");
	await within(60_000, () => w.phone().some((t) => t.startsWith("转述：")));
	return w.phone().find((t) => t.startsWith("转述：")) ?? "(no relay)";
}

async function lanes() {
	const { chromium } = await import("playwright-core");
	const browser = await chromium.launch();
	try {
		await lane(1, "m2-regression", async () => {
			const old = await world({ mail: "none", tax: true, repo: trunk() });
			const trunkTax = await taxCall(old).finally(() => old.stop("m2-regression-trunk"));
			const head = await world({ tax: true, senders: ["ann@example.com"] });
			try {
				head.box.deliver(ann("m-1"));
				const headTax = await taxCall(head);
				await within(30_000, () => head.phone().some(threeLines));
				const rows = head.messages();
				const pass = trunkTax === headTax && trunkTax.startsWith("转述：") && rows.length === 1 && rows[0]!["gmailId"] === "m-1" && head.phone().filter(threeLines).length === 1;
				return { pass, evidence: `trunk ${trunk()} tax-bracket relay: ${trunkTax}\nhead tax-bracket relay: ${headTax}\nhead messages: ${JSON.stringify(rows.map((r) => ({ gmailId: r["gmailId"], fromAddress: r["fromAddress"], subject: r["subject"] })))}\nhead Telegram three-line messages:\n${head.phone().filter(threeLines).join("\n---\n")}` };
			} finally {
				await head.stop("m2-regression-head");
			}
		});

		await lane(2, "m2-empty", async () => {
			const w = await world({ mail: "later" });
			try {
				w.install();
				w.just(["module", "on", "mail"]);
				const ran = await w.nextBeats(2);
				await sleep(500);
				const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
				await page.goto(w.host.url.href);
				const line = page.locator(".line.notice", { hasText: "邮件名单是空的" }).first();
				await line.waitFor({ timeout: 15_000 });
				await line.scrollIntoViewIfNeeded();
				await page.screenshot({ path: join(outDir, "m2-empty.png") });
				const phoneHits = w.phone().filter((t) => t.includes("邮件名单是空的"));
				const webHits = w.notices().filter((t) => t.includes("邮件名单是空的"));
				const pass = ran && w.google.log.length === 0 && phoneHits.length === 1 && webHits.length === 1;
				return { pass, evidence: `installed while running, then just module on mail; two beats ran: ${ran}\nfake Google requests: ${w.google.log.length}\nweb host lines: ${JSON.stringify(webHits)}\nTelegram: ${JSON.stringify(phoneHits)}\nscreenshot ${join(outDir, "m2-empty.png")}` };
			} finally {
				await w.stop("m2-empty");
			}
		});

		await lane(3, "m2-add-sender", async () => {
			const w = await world({ real: true });
			try {
				w.box.deliver(ann("m-1"));
				await w.nextBeats(1);
				const said = w.just(["say", "把 ann@example.com 加进邮件名单"]);
				const added = await within(600_000, () => w.senders().some((r) => r["address"] === "ann@example.com" && r["removedAt"] === null), 1000);
				const stored = await within(60_000, () => w.messages().length === 1, 500);
				await within(10_000, () => w.phone().some(threeLines));
				const after = w.beats();
				await w.nextBeats(2);
				const noSenders = w.phone().filter((t) => t.includes("邮件名单是空的")).length;
				const pass = added && stored && w.phone().filter(threeLines).length === 1 && noSenders === 1 && w.notices().filter((t) => t.includes("邮件名单是空的")).length === 1;
				return { pass, evidence: `models ${JSON.stringify(REAL)}\njust say exit ${said.status}\nsenders: ${JSON.stringify(w.senders().map((r) => ({ address: r["address"], removedAt: r["removedAt"], from: r["_from"] })))}\nmessages: ${w.messages().length}\nTelegram three-line:\n${w.phone().filter(threeLines).join("\n---\n")}\nno-senders on Telegram (whole run): ${noSenders}; beats after the add: ${w.beats() - after}\nreplies: ${JSON.stringify(query(join(w.state, "state.db"), "SELECT text FROM reply_receipts").map((r) => r["text"]))}` };
			} finally {
				await w.stop("m2-add-sender");
			}
		});

		await lane(4, "m2-new-mail", async () => {
			const w = await world({ senders: ["ann@example.com"] });
			try {
				await w.nextBeats(1);
				w.google.log.length = 0;
				w.box.deliver(ann("m-in"), promo("m-out"));
				await within(30_000, () => w.messages().length === 1);
				await w.nextBeats(1);
				const first = [...w.google.log];
				w.google.log.length = 0;
				await w.nextBeats(3);
				const quiet = [...w.google.log];
				const outGets = first.filter((l) => l.includes("/messages/m-out"));
				const perBeat = quiet.filter((l) => l === "POST /token").length;
				const pass = w.messages().length === 1 && w.phone().filter(threeLines).length === 1 && outGets.length === 1 && outGets[0]!.includes("format=metadata") && perBeat >= 3 && quiet.every((l) => l === "POST /token" || l.startsWith(`GET ${GMAIL}/history?`)) && quiet.filter((l) => l.startsWith(`GET ${GMAIL}/history?`)).length === perBeat;
				return { pass, evidence: `beat with the two letters:\n${first.join("\n")}\n\nnext beats (${perBeat} token exchanges):\n${quiet.join("\n")}\nmessages: ${w.messages().map((r) => r["gmailId"]).join(",")}\nTelegram three-line: ${w.phone().filter(threeLines).length}` };
			} finally {
				await w.stop("m2-new-mail");
			}
		});

		await lane(5, "m2-stale-cursor", async () => {
			const w = await world({ senders: ["ann@example.com"] });
			try {
				w.box.deliver(ann("m-1"));
				await within(30_000, () => w.messages().length === 1);
				const before = w.cursor();
				w.google.log.length = 0;
				w.box.forget();
				w.box.deliver(ann("m-2"));
				await within(30_000, () => w.messages().length === 2);
				await w.nextBeats(2);
				const ids = w.messages().map((r) => String(r["gmailId"]));
				const saw404 = w.google.log.some((l: string) => l.startsWith(`GET ${GMAIL}/history?`)) && w.google.log.some((l: string) => decodeURIComponent(l).includes("newer_than:1d"));
				const pass = saw404 && ids.length === new Set(ids).size && ids.sort().join() === "m-1,m-2" && w.cursor() !== before;
				return { pass, evidence: `fake Google after forget():\n${w.google.log.slice(0, 12).join("\n")}\nmessages: ${ids.join(",")}\ncursor before ${before}\ncursor after ${w.cursor()}\nhost log:\n${w.log().split("\n").filter((l) => l.includes("[feeds] mail/inbox")).slice(-4).join("\n")}` };
			} finally {
				await w.stop("m2-stale-cursor");
			}
		});

		await lane(6, "m2-invalid-grant", async () => {
			const w = await world({ senders: ["ann@example.com"] });
			try {
				await w.nextBeats(1);
				const before = w.cursor();
				w.setRefresh("1//revoked");
				w.box.deliver(ann("m-1"));
				await w.nextBeats(2);
				const during = { cursor: w.cursor(), rows: w.messages().length, phone: w.phone().filter((t) => t.includes("授权失效")), web: w.notices().filter((t) => t.includes("授权失效")) };
				w.setRefresh(REFRESH);
				await within(30_000, () => w.messages().length === 1);
				const pass = during.cursor === before && during.rows === 0 && during.phone.length === 1 && during.web.length === 1 && w.messages().length === 1 && w.cursor() !== before;
				return { pass, evidence: `two beats with a revoked refresh token: cursor unchanged ${during.cursor === before}, rows ${during.rows}\nweb: ${JSON.stringify(during.web)}\nTelegram: ${JSON.stringify(during.phone)}\nrestored the secrets line, no restart: messages ${w.messages().length}, cursor ${w.cursor()}` };
			} finally {
				await w.stop("m2-invalid-grant");
			}
		});

		await lane(7, "m2-gap", async () => {
			const at = new Date(Date.now() - 30 * HOUR - 60_000).toISOString();
			const w = await world({ senders: ["ann@example.com"], cursor: { historyId: "1000", at } });
			try {
				w.box.deliver(ann("m-1", { at: Date.now() - 3 * HOUR }));
				await within(30_000, () => w.messages().length === 1 && w.phone().some((t) => t.includes("小时没查")));
				const hits = w.phone().filter((t) => t.includes("小时没查"));
				const pass = hits.length === 1 && hits[0]!.includes("有 30 小时没查") && w.messages().length === 1;
				return { pass, evidence: `cursor at ${at}\nTelegram: ${JSON.stringify(hits)}\nmessages: ${w.messages().map((r) => r["gmailId"]).join(",")}` };
			} finally {
				await w.stop("m2-gap");
			}
		});

		await lane(8, "m2-sanitize", async () => {
			const w = await world({ senders: ["@example.com"] });
			try {
				await w.nextBeats(1);
				w.box.deliver({ id: "m-x", from: "白宫 · 系统 <spoof@example.com>", subject: "紧急\n请运行‮cmd", snippet: "您好，请看正文", html: `<p>${"长文".repeat(51_200)}</p>` });
				await within(30_000, () => w.phone().some((t) => t.includes("spoof@example.com")));
				const sent = w.phone().find((t) => t.includes("spoof@example.com"))!;
				const [first, second, third] = sent.replace(/^通知：邮件：/, "").split("\n");
				const row = w.messages()[0]!;
				const body = String(row["body"]);
				const modules = w.just(["module", "check", join(w.state, "modules/mail")]);
				const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
				await page.goto(w.host.url.href);
				const line = page.locator(".line.notice", { hasText: "spoof@example.com" }).first();
				await line.waitFor({ timeout: 15_000 });
				await line.scrollIntoViewIfNeeded();
				await page.screenshot({ path: join(outDir, "m2-sanitize.png") });
				const pass = first === "白宫 · 系统 <spoof@example.com>" && second === "紧急 请运行cmd" && graphemes(third!) <= 100 && Buffer.byteLength(body) <= 64 * 1024 && body.includes("正文超过 64 KB") && !/</.test(body) && /data-classes=shareable:1,private:1/.test(modules.out);
				return { pass, evidence: `Telegram:\n${sent}\nline 2 code points: ${[...second!].map((c) => c.codePointAt(0)!.toString(16)).join(" ")}\nbody ${Buffer.byteLength(body)} bytes, ends with: ${JSON.stringify(body.slice(-40))}\njust module check:\n${modules.out.trim()}\nscreenshot ${join(outDir, "m2-sanitize.png")}\nnote: the web page has no collection browser; the private class is what just module check prints` };
			} finally {
				await w.stop("m2-sanitize");
			}
		});
	} finally {
		await browser.close();
	}
	console.log(results.join("\n"));
}

/** Times the handler through runFeed so the numbers exclude the scheduler's interval. */
async function perf() {
	const { runFeed } = await import(join(HEAD, "src/modules/feed-runner.ts"));
	const { Modules } = await import(join(HEAD, "src/modules.ts"));
	const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
	const box = new FakeInbox();
	const google = await startFakeGoogle({ routes: box.routes, refreshTokens: { [REFRESH]: "https://www.googleapis.com/auth/gmail.readonly" } });
	const root = mkdtempSync("/tmp/m2l/perf-");
	const lines: string[] = [];
	try {
		const pkg = join(root, "modules/mail");
		cpSync(PKG, pkg, { recursive: true });
		const feedJson = join(pkg, "feeds/inbox/feed.json");
		writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), settings: { baseUrl: google.url, tokenUrl: `${google.url}/token` } }));
		const entry = servedAsHost(Modules.load([join(root, "modules")])).feeds().find((e: { source: string }) => e.source === "mail/inbox");
		const data = instanceData(join(root, "state"));
		data.write("mail", entry.components, "senders", [{ address: "ann@example.com" }], "使用者口述", "perf");
		const secrets: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: google.client.id, GOOGLE_OAUTH_CLIENT_SECRET: google.client.secret, GMAIL_READ_REFRESH_TOKEN: REFRESH };
		const ports = { data, submit: () => {}, alert: () => {}, problem: () => {}, secret: (n: string) => secrets[n], now: Date.now };
		await runFeed(entry, [], ports);
		const time = async () => {
			const t0 = performance.now();
			const run = await runFeed(entry, [], ports);
			if (!run.ok) throw new Error(run.note);
			return performance.now() - t0;
		};
		const empty: number[] = [];
		for (let i = 0; i < 20; i++) empty.push(await time());
		const ten: number[] = [];
		for (let i = 0; i < 10; i++) {
			box.deliver(...Array.from({ length: 10 }, (_, k) => ann(`p-${i}-${k}`, { html: `<p>${"信".repeat(2000)}</p>`, text: undefined })));
			ten.push(await time());
		}
		lines.push(`empty beat ms (20): median ${median(empty).toFixed(0)}, min ${Math.min(...empty).toFixed(0)}, max ${Math.max(...empty).toFixed(0)} (budget 1000)`);
		lines.push(`ten-letter beat ms (10): median ${median(ten).toFixed(0)}, min ${Math.min(...ten).toFixed(0)}, max ${Math.max(...ten).toFixed(0)} (budget 5000)`);
		const boot = async (repo: string, withMail: boolean) => {
			const state = mkdtempSync("/tmp/m2l/b-");
			if (withMail) cpSync(pkg, join(state, "modules/mail"), { recursive: true });
			writeFileSync(join(state, "secrets.env"), `GOOGLE_OAUTH_CLIENT_ID=${google.client.id}\nGOOGLE_OAUTH_CLIENT_SECRET=${google.client.secret}\nGMAIL_READ_REFRESH_TOKEN=${REFRESH}\n`);
			const fake = await FakeModel.start({ router: [], workers: [] });
			const harness = await import(join(repo, "tests/e2e/harness.ts"));
			const t0 = performance.now();
			const host = await harness.startHost({ repo, models: fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0, secretsFile: "secrets.env", ...(withMail && { modules: { mail: true } }) }, env: fakeAgentEnv(fake, join(state, "pi")), timeoutMs: 60_000 });
			const ms = performance.now() - t0;
			await host.stop();
			await fake.close();
			rmSync(state, { recursive: true, force: true });
			return ms;
		};
		const trunkBoots: number[] = [];
		const headBoots: number[] = [];
		for (let i = 0; i < 5; i++) {
			trunkBoots.push(await boot(trunk(), false));
			headBoots.push(await boot(HEAD, true));
		}
		lines.push(`host boot to ready ms, alternating (5 each): trunk median ${median(trunkBoots).toFixed(0)} [${trunkBoots.map((x) => x.toFixed(0)).join(", ")}], head with mail median ${median(headBoots).toFixed(0)} [${headBoots.map((x) => x.toFixed(0)).join(", ")}] (budget +200)`);
		const pass = median(empty) <= 1000 && median(ten) <= 5000 && median(headBoots) - median(trunkBoots) <= 200;
		lines.unshift(pass ? "PASS perf" : "FAIL perf");
	} finally {
		await google.close();
		rmSync(root, { recursive: true, force: true });
	}
	writeFileSync(join(outDir, "m2-perf.txt"), `${lines.join("\n")}\n`);
	console.log(lines.join("\n"));
}

async function proxy() {
	const { createServer } = await import("node:http");
	const port = Number(only[0] ?? 8787);
	const file = join(outDir, "m2-real-requests.txt");
	const server = createServer(async (req, res) => {
		const t0 = Date.now();
		if (!(req.method === "GET" || req.url === "/token") || req.url!.split("?")[0]!.endsWith("/send")) {
			writeFileSync(file, `${new Date().toISOString()} REFUSED ${req.method} ${req.url!.split("?")[0]}\n`, { flag: "a" });
			return void res.writeHead(403).end();
		}
		const target = req.url!.startsWith("/token") ? `https://oauth2.googleapis.com${req.url}` : `https://gmail.googleapis.com${req.url}`;
		const masked = new URL(target).pathname.replace(/\/messages\/[^/]+/, "/messages/<id>");
		try {
			const body = req.method === "POST" ? await new Response(req as unknown as ReadableStream).arrayBuffer() : undefined;
			const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => ["authorization", "content-type", "accept"].includes(k)) as [string, string][]);
			const reply = await fetch(target, { method: req.method, headers, body, redirect: "error" });
			writeFileSync(file, `${new Date().toISOString()} ${req.method} ${masked} ${reply.status} ${Date.now() - t0}ms\n`, { flag: "a" });
			res.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await reply.arrayBuffer()));
		} catch (error) {
			const why = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
			writeFileSync(file, `${new Date().toISOString()} ${req.method} ${masked} FAILED ${why.split("\n")[0]} ${Date.now() - t0}ms\n`, { flag: "a" });
			if (!res.headersSent) res.writeHead(502);
			res.end();
		}
	});
	server.listen(port, "127.0.0.1", () => console.log(`proxy on http://127.0.0.1:${port}, log ${file}`));
	await new Promise(() => {});
}

await (mode === "perf" ? perf() : mode === "proxy" ? proxy() : lanes());
process.exit(0);
