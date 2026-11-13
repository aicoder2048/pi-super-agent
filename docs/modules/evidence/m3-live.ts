/** node --import ./src/pi-runtime.mjs docs/modules/evidence/m3-live.ts <trunk checkout> [outDir] */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const [trunk, outDir = "/tmp/swarm-m3/owner"] = process.argv.slice(2);
if (!trunk) throw new Error("用法：m3-live.ts <trunk 的检出目录> [outDir]");
mkdirSync(outDir, { recursive: true });
const PKG = join(HEAD, "tests/fixtures/modules/private-line");
const USER = 42;
const CANARY = "CANARY-7f3a";
const ONE_LINE = "测试信箱 有新内容，请在网页上查看";
const ANSWER = "固定的回答：今天大盘平稳";
const PROBLEM = "测试信箱：收件箱的授权过期了，请重新授权";
const BAD = "\u0007\u2028\u202E\u200B";
const segments = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;

const { fakeModels, startHost } = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const { chromium } = await import("playwright-core");

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function within(limitMs: number, ok: () => boolean): Promise<boolean> {
	for (const end = Date.now() + limitMs; Date.now() < end; await sleep(25)) if (ok()) return true;
	return ok();
}
const results: string[] = [];
const check = (name: string, pass: boolean, evidence: string) => {
	const file = join(outDir, `${name}.txt`);
	writeFileSync(file, `${pass ? "PASS" : "FAIL"} ${name}\n${evidence}\n`);
	results.push(`${pass ? "PASS" : "FAIL"}  ${name}  ${file}`);
};
const query = (path: string, sql: string) => {
	if (!existsSync(path)) return [];
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(sql).all() as Record<string, unknown>[];
	} finally {
		db.close();
	}
};
const inDomain = (call: { name: string; args: Record<string, unknown> }, domain: string, basis = "inference") => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain, basis })) } });
const asRule = (call: { name: string; args: Record<string, unknown> }) => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, basis: "rule", ruleId: "toy-market/big-move", threads: ["thr_toy-market:TOYX"] })) } });

const letter = (id: string, extra: object = {}) => ({ id, from: "Ann <ann@example.com>", subject: "季度对账单", snippet: "您好，对账单在 https://example.com/x", body: `正文 ${CANARY}`, ...extra });

async function side(repo: string, label: "trunk" | "head") {
	const state = mkdtempSync("/tmp/m3s/l-");
	const pkg = join(state, "modules/private-line");
	cpSync(PKG, pkg, { recursive: true });
	if (label === "trunk") {
		const feed = JSON.parse(readFileSync(join(pkg, "feeds/inbox/feed.json"), "utf8"));
		delete feed.line;
		writeFileSync(join(pkg, "feeds/inbox/feed.json"), JSON.stringify(feed, null, 2));
	}
	writeFileSync(join(state, "secrets.env"), `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`);
	const tg = await FakeTelegram.start();
	const relay = (c: string) => [reply(c, `转述：${c.split("\n")[1] ?? ""}`)];
	const fake = await FakeModel.start({
		router: [
			on("来信不开任务", /^\[候选触发\][^\n]*来源 private-line\/inbox[\s\S]*季度对账单/, () => "ok"),
			on("回一句", /^\[对话\][\s\S]*使用者：今天大盘怎么样/, (c: string) => [reply(c, ANSWER)]),
			...[1, 2, 3, 4, 5, 6].map(() => on("别的来信不开任务", /^\[候选触发\][^\n]*来源 private-line\/inbox(?![\s\S]*请处理)/, () => "ok")),
			on("行情开规则任务", /^\[候选触发\][^\n]*来源 toy-market/, (c: string) => [asRule(openTicket(c, "核实 TOYX 波动"))]),
			on("转述行情", /^\[Worker 汇报\][^\n]*核实 TOYX/, relay),
			on("为来信开任务", /^\[候选触发\][^\n]*来源 private-line\/inbox[\s\S]*请处理/, (c: string) => [inDomain(openTicket(c, "看信"), "private-line")]),
			on("转述看信", /^\[Worker 汇报\][^\n]*看信/, relay),
			on("回第二句", /^\[对话\][\s\S]*使用者：那封信呢/, (c: string) => [reply(c, "回：好的")]),
		],
		workers: [
			worker("核实 TOYX 波动", on("行情汇报", /^\[任务说明\]/, () => [report("ready", "TOYX 跌了 5.2%，成交量放大")])),
			worker(
				"看信",
				on("读集合", /^\[任务说明\]/, () => [{ name: "data", args: { op: "query", collection: "messages" } }]),
				on("复述正文", /^\[模块数据\]/, (c: string) => [report("ready", `信里说：${c.match(/正文 CANARY-\w+/)?.[0] ?? "没读到"}`)]),
			),
		],
	});
	const host = await startHost({
		repo,
		models: fakeModels,
		stateDir: state,
		logFile: join(state, "host.log"),
		config: { webPort: 0, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] }, modules: { "private-line": true, "toy-market": true } },
		env: { ...fakeAgentEnv(fake, join(state, "pi")), PSA_E2E_TELEGRAM_URL: tg.url },
		timeoutMs: 60_000,
		imports: ["./tests/e2e/telegram-preload.mjs"],
	});
	const just = (args: string[], timeout = 60_000) => spawnSync("just", args, { cwd: repo, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300" }, encoding: "utf8", timeout });
	const phone = () => (tg.sent as { chatId: number; text: string; silent: boolean; preview: boolean }[]).filter((m) => m.chatId === USER);
	const texts = () => phone().map((m) => m.text);
	const db = (sql: string) => query(join(state, "state.db"), sql);
	const letters = () => query(join(state, "modules-data/private-line/data.db"), "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%messages%'").flatMap((t) => query(join(state, "modules-data/private-line/data.db"), `SELECT * FROM "${t.name}" ORDER BY "_id"`));
	const notices = () => db("SELECT text FROM host_lines WHERE kind = 'notice' AND source = 'private-line/inbox' ORDER BY rowid").map((r) => String(r.text));
	const triggers = () => db("SELECT external_id, body FROM triggers WHERE source = 'private-line/inbox' ORDER BY rowid");
	const inbox = join(state, "inbox/private-line/inbox");
	let n = 0;
	const deliver = async (item: object) => {
		mkdirSync(inbox, { recursive: true });
		const file = join(inbox, `${String(++n).padStart(3, "0")}.json`);
		writeFileSync(file, JSON.stringify(item));
		await within(20_000, () => !existsSync(file));
		await sleep(800);
	};
	await within(20_000, () => db("SELECT record FROM module_records WHERE name = 'private-line'").some((r) => String(r.record).includes('"at":"active"')));
	tg.userSays(USER, "/start");
	await within(10_000, () => phone().length > 0);
	const stop = async () => {
		cpSync(join(state, "host.log"), join(outDir, `${label}-host.log`));
		await host.stop();
		await fake.close();
		await tg.close();
		rmSync(state, { recursive: true, force: true });
	};
	return { state, host, tg, fake, just, phone, texts, db, letters, notices, triggers, deliver, stop };
}
type Side = Awaited<ReturnType<typeof side>>;

const userSaid: { text: string; at: number }[] = [];

async function lane1(s: Side, holdMs = 0) {
	await s.deliver(letter("m-1"));
	await within(10_000, () => s.texts().some((t) => t.includes("季度对账单")) || s.texts().includes(ONE_LINE));
	await sleep(holdMs);
	s.tg.userSays(USER, "今天大盘怎么样");
	userSaid.push({ text: "今天大盘怎么样", at: Date.now() });
	await within(20_000, () => s.texts().includes(ANSWER) || s.texts().filter((t) => t === ONE_LINE).length >= 2);
	await sleep(1000);
	const asked = s.db("SELECT text FROM reply_receipts").map((r) => String(r.text));
	return { phone: s.texts(), letters: s.letters().map(({ from, subject, snippet, body }) => ({ from, subject, snippet, body })), routerSaid: asked };
}

const browser = await chromium.launch();
try {
	const old = await side(trunk, "trunk");
	const trunkRun = await lane1(old).finally(() => old.stop());

	const head = await side(HEAD, "head");
	try {
		const record = (width: number) => browser.newContext({ viewport: { width, height: 860 }, recordVideo: { dir: join(outDir, "video"), size: { width, height: 860 } } });
		const webContext = await record(1280);
		const phoneContext = await record(420);
		const webPage = await webContext.newPage();
		const phonePage = await phoneContext.newPage();
		await webPage.goto(head.host.url.href);
		await phonePage.setContent(`<html><body style="margin:0;font-family:-apple-system,sans-serif;background:#d7e3ec;height:860px;display:flex;flex-direction:column"><div style="padding:12px 16px;background:#517da2;color:#fff;font-weight:600">Telegram（假接口收到的消息）</div><div id="chat" style="flex:1;overflow:auto;padding:12px"></div></body></html>`);
		userSaid.length = 0;
		const showPhone = () => phonePage.evaluate((list: { text: string; mine?: boolean }[]) => {
			const chat = document.getElementById("chat")!;
			chat.innerHTML = "";
			for (const m of list) {
				const bubble = document.createElement("div");
				bubble.textContent = m.text;
				bubble.style.cssText = `white-space:pre-wrap;margin:6px 0;padding:8px 10px;border-radius:10px;max-width:85%;font-size:14px;background:${m.mine ? "#effdde" : "#fff"};${m.mine ? "margin-left:auto" : ""}`;
				chat.append(bubble);
			}
			chat.scrollTop = chat.scrollHeight;
		}, [...head.phone().map((m) => ({ text: m.text, at: (m as unknown as { at: number }).at })), ...userSaid.map((m) => ({ ...m, mine: true }))].sort((a, b) => a.at - b.at));
		const ticker = setInterval(() => void showPhone().catch(() => {}), 200);
		await sleep(8000);
		const headRun = await lane1(head, 8000);
		await sleep(10_000);
		clearInterval(ticker);
		await showPhone();
		await sleep(2000);
		const [webVideo, phoneVideo] = [await webPage.video()!.path(), await phonePage.video()!.path()];
		await webContext.close();
		await phoneContext.close();
		spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webVideo, "-i", phoneVideo, "-filter_complex", "[0:v][1:v]hstack=inputs=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(outDir, "m3-review.mp4")]);
		rmSync(join(outDir, "video"), { recursive: true, force: true });

		const three = (t: string) => t.startsWith("通知：测试信箱：") && t.split("\n").length === 3;
		check(
			"m3-regression",
			!trunkRun.phone.some(three) && trunkRun.phone.includes(ONE_LINE) && !trunkRun.phone.includes(ANSWER) &&
				headRun.phone.filter(three).length === 1 && headRun.phone.includes(ANSWER) && JSON.stringify(trunkRun.letters) === JSON.stringify(headRun.letters) && trunkRun.letters.length === 1,
			`trunk ${trunk}\nTelegram recorder:\n${trunkRun.phone.join("\n---\n")}\nRouter replies (web): ${JSON.stringify(trunkRun.routerSaid)}\nprivate rows: ${JSON.stringify(trunkRun.letters)}\n\nhead\nTelegram recorder:\n${headRun.phone.join("\n---\n")}\nRouter replies (web): ${JSON.stringify(headRun.routerSaid)}\nprivate rows: ${JSON.stringify(headRun.letters)}`,
		);

		const before = head.texts().filter((t) => t.includes("季度对账单")).length;
		await head.deliver(letter("m-1"));
		await sleep(1000);
		check(
			"m3-dedupe",
			head.notices().length === 1 && head.triggers().length === 1 && before === 1 && head.texts().filter((t) => t.includes("季度对账单")).length === 1,
			`host lines: ${JSON.stringify(head.notices())}\ntriggers: ${JSON.stringify(head.triggers())}\nTelegram messages naming the letter: ${head.texts().filter((t) => t.includes("季度对账单")).length}`,
		);

		const opening = `${"开".repeat(159)}😀${"尾".repeat(140)}`;
		await head.deliver(letter("m-3", { subject: `发票${BAD}\n第二行\u202Egnp.exe`, snippet: opening }));
		await within(10_000, () => head.notices().length === 2);
		const notice = head.notices()[1] ?? "";
		const lines = notice.split("\n");
		const sent = head.texts().find((t) => t === `通知：${notice}`) ?? "";
		check(
			"m3-sanitize",
			lines.length === 3 && lines.every((l) => segments(l) <= 160 + "测试信箱：".length) && !/[\u0007\u2028\u2029\u202E\u200B\n]/.test(lines.join("")) && notice.isWellFormed() && segments(lines[2]!) === 160 && lines[2]!.endsWith("…") && sent !== "",
			`host line:\n${notice}\ngraphemes per line: ${lines.map(segments).join(", ")} (line 1 carries the 5-grapheme 测试信箱： prefix)\nwell-formed: ${notice.isWellFormed()}\ncode points of line 2: ${[...lines[1]!].map((c) => c.codePointAt(0)!.toString(16)).join(" ")}\nsent to Telegram as written: ${sent !== ""}`,
		);

		head.just(["toy-feed", "TOYX", "-5.2", "12"]);
		await within(60_000, () => head.texts().includes("转述：TOYX 跌了 5.2%，成交量放大"));
		check(
			"m3-market-full",
			head.texts().includes("转述：TOYX 跌了 5.2%，成交量放大") && head.host.url !== undefined,
			`tickets: ${JSON.stringify(head.db("SELECT title, basis, rule_id FROM tickets"))}\nTelegram recorder (last 4):\n${head.texts().slice(-4).join("\n---\n")}`,
		);

		await head.deliver(letter("m-5", { subject: "请处理" }));
		await within(60_000, () => head.texts().some((t) => t.startsWith("转述：") && t.includes(CANARY)));
		const mark = head.texts().length;
		head.tg.userSays(USER, "那封信呢");
		await within(20_000, () => head.texts().slice(mark).includes("回：好的"));
		await sleep(1000);
		const web = head.db("SELECT text FROM reply_receipts").map((r) => String(r.text));
		const relayed = head.texts().filter((t) => t.startsWith("转述：") && t.includes(CANARY));
		check(
			"m3-full-text",
			relayed.length === 1 && head.texts().slice(mark).includes("回：好的") && !head.texts().some((t) => t.includes("请在网页上查看")),
			`relays on Telegram holding the letter's body: ${JSON.stringify(relayed)}\nRouter replies on the web: ${JSON.stringify(web)}\ntickets: ${JSON.stringify(head.db("SELECT title, basis, domain FROM tickets"))}\nTelegram after "那封信呢":\n${head.texts().slice(mark).join("\n---\n")}`,
		);

		const checks: string[] = [];
		for (const [name, line] of [["four-lines", "{{from}}\n{{subject}}\n{{snippet}}\n第四行"], ["names-body", "{{from}}\n{{body}}"]] as const) {
			const scratch = mkdtempSync("/tmp/m3s/c-");
			const copy = join(scratch, "private-line");
			cpSync(PKG, copy, { recursive: true });
			const feed = JSON.parse(readFileSync(join(copy, "feeds/inbox/feed.json"), "utf8"));
			writeFileSync(join(copy, "feeds/inbox/feed.json"), JSON.stringify({ ...feed, line }));
			const run = spawnSync("just", ["module", "check", copy], { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: scratch }, encoding: "utf8" });
			checks.push(`${name}: exit ${run.status}\n${(run.stdout + run.stderr).replaceAll(copy, "<copy>").trim()}`);
			rmSync(scratch, { recursive: true, force: true });
		}
		check("m3-check", checks.every((c) => !c.includes("exit 0") && /"line"/.test(c)), checks.join("\n\n"));

		const web7 = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		await web7.goto(head.host.url.href);
		const line7 = web7.locator(".line.notice", { hasText: "季度对账单" }).first();
		await line7.waitFor({ timeout: 15_000 });
		const shown = await line7.locator(".bubble").innerText();
		const buttons = await line7.locator("button").count();
		await line7.scrollIntoViewIfNeeded();
		await web7.screenshot({ path: join(outDir, "m3-web-notice.png") });
		check(
			"m3-web-notice",
			(await line7.locator(".who").textContent()) === "通知" && shown.split("\n").length === 3 && buttons === 0,
			`label: ${await line7.locator(".who").textContent()}\nbubble:\n${shown}\nbuttons on the line: ${buttons}\nscreenshot ${join(outDir, "m3-web-notice.png")}`,
		);

		const tail = spawn("just", ["tail"], { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: head.state }, detached: true });
		let tailed = "";
		tail.stdout.on("data", (d) => (tailed += d));
		tail.stderr.on("data", (d) => (tailed += d));
		await sleep(3000);
		process.kill(-tail.pid!, "SIGTERM");
		writeFileSync(join(outDir, "m3-tui-raw.txt"), tailed);
		const at = tailed.indexOf("通知> 测试信箱：Ann <ann@example.com>");
		check("m3-tui-notice", at >= 0 && tailed.slice(at).split("\n")[1] === "季度对账单", `just tail output:\n${tailed}`);

		const phoneProblems = () => head.texts().filter((t) => t === `通知：${PROBLEM}`).length;
		const webProblems = () => head.db("SELECT text FROM host_lines WHERE kind = 'notice'").filter((r) => r.text === PROBLEM).length;
		const beats: string[] = [];
		for (const item of [{ problem: "auth" }, { problem: "auth" }, letter("m-9", { subject: "第三拍" }), { problem: "auth" }]) {
			await head.deliver(item);
			beats.push(`after ${JSON.stringify(item).slice(0, 40)}: web ${webProblems()}, Telegram ${phoneProblems()}`);
		}
		await within(10_000, () => phoneProblems() === 2);
		await web7.reload();
		const problems = web7.locator(".line.notice", { hasText: "授权过期" });
		await problems.last().waitFor();
		await problems.last().scrollIntoViewIfNeeded();
		await web7.screenshot({ path: join(outDir, "m3-problem.png") });
		check("m3-problem", webProblems() === 2 && phoneProblems() === 2 && (await problems.count()) === 2, `${beats.join("\n")}\nweb page lines: ${await problems.count()}\nscreenshot ${join(outDir, "m3-problem.png")}`);
	} finally {
		await head.stop();
	}
} finally {
	await browser.close();
}
console.log(results.join("\n"));
