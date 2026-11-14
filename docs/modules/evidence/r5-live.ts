/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/r5-live.ts [fake|real|market|perf] [outDir] [--off-hours]
 *
 * fake    Lanes 1, 2, 4, 5, 6, 7, 8: hosts on the fake model, a local server standing in for Massive, a fake Telegram.
 *         The host's clock starts at a trading-day morning (r5-clock-preload.mjs) and each step moves it a minute, so the
 *         quotes feed beats on cue at any hour.
 * real    Lanes 3 and 10 on openai-codex models through the Pi login in ~/.pi/agent, with the same stand-ins; lane 3 runs
 *         R5_RUNS times (default 1) and doubles as the alert and report latency probe. The experts read a seed data dir
 *         from an earlier lane run (R5_SEED, default /tmp/swarm-r3/owner/seed).
 * market  Lane 9: real Massive for 30 minutes. Refuses outside 9:30 to 16:20 New York time unless --off-hours.
 * R5_LANES=4,5 runs only those lanes of the mode.
 * perf    The quotes round on trunk and head, alternating, 3 passes of 390 rounds each.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const USER = 42;
const DAY = "2026-11-13";
const MINUTE = 60_000;
const args = process.argv.slice(2);
const [mode = "fake", outDir = "/tmp/swarm-r5/owner"] = args.filter((a) => !a.startsWith("--"));
mkdirSync(outDir, { recursive: true });

const R = await import(join(HEAD, "docs/modules/evidence/replay-day.ts"));
const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, fakeAgentEnv, on, openTicket, reply, report, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const { Kernel } = await import(join(HEAD, "src/kernel/kernel.ts"));
const { openStore } = await import(join(HEAD, "src/kernel/store.ts"));
const { Modules } = await import(join(HEAD, "src/modules.ts"));
const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
const { chromium } = await import("playwright-core");
type Host = Awaited<ReturnType<typeof harness.startHost>>;
type Row = Record<string, unknown>;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const show = (rows: unknown[]) => rows.map((r) => `  ${typeof r === "string" ? r : JSON.stringify(r)}`).join("\n") || "  (none)";
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const ny = (hhmm: string, date = DAY) => Date.parse(`${date}T${hhmm}:00-05:00`);
const made: string[] = [];
const temp = () => {
	const dir = mkdtempSync("/tmp/psa-r5-");
	made.push(dir);
	return dir;
};

function query(path: string, sql: string): Row[] {
	if (!existsSync(path)) return [];
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(sql).all().map((r) => ({ ...r }));
	} finally {
		db.close();
	}
}

async function within<T>(limitMs: number, probe: () => T | undefined | false, stepMs = 100): Promise<T | undefined> {
	for (const end = Date.now() + limitMs; Date.now() < end; await sleep(stepMs)) {
		const found = probe();
		if (found !== undefined && found !== false) return found;
	}
	const last = probe();
	return last === false ? undefined : last;
}

function just(state: string, argv: string[]) {
	const run = spawnSync("just", argv, { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300" }, encoding: "utf8", timeout: 120_000 });
	return { status: run.status, out: (run.stdout + run.stderr).trim() };
}

const results: string[] = [];
type Verdict = { pass: boolean | "not run"; evidence: string };
const only = process.env["R5_LANES"]?.split(",");
async function lane(n: number | string, slug: string, body: () => Promise<Verdict>): Promise<void> {
	if (only && !only.includes(String(n))) return;
	let verdict: Verdict;
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const word = verdict.pass === "not run" ? "NOT RUN" : verdict.pass ? "PASS" : "FAIL";
	const file = join(outDir, `r5-${slug}.txt`);
	writeFileSync(file, `${word} lane ${n}\n${verdict.evidence.replaceAll(/\/tmp\/psa-r5-\w+/g, "<state>")}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

async function fakeMassive() {
	const market = { prices: {} as Record<string, number>, prevClose: {} as Record<string, number>, at: 0, hits: [] as string[] };
	const server = createServer((req, res) => {
		market.hits.push(req.url ?? "");
		const asked = new URL(req.url ?? "", "http://x").searchParams.get("tickers")?.split(",") ?? [];
		const tickers = asked.filter((s) => s in market.prices).map((s) => ({ ticker: s, lastTrade: { p: market.prices[s], t: market.at * 1e6 }, min: { c: market.prices[s], t: market.at, v: 1000 }, day: { c: market.prices[s], v: 5e6 }, prevDay: { c: market.prevClose[s], v: 3.9e7 } }));
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "DELAYED", tickers }));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { market, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((done) => server.close(done)) };
}

function installStockTa(state: string, baseUrl: string): void {
	const pkg = join(state, "modules", "stock-ta");
	cpSync(join(HEAD, "docs/modules/examples/stock-ta"), pkg, { recursive: true });
	const feedJson = join(pkg, "feeds", "quotes", "feed.json");
	const feed = JSON.parse(readFileSync(feedJson, "utf8"));
	writeFileSync(feedJson, JSON.stringify({ ...feed, settings: { ...feed.settings, baseUrl } }));
}

function seedUsMarketHistory(state: string): string {
	const db = openStore(join(state, "state.db"));
	const kernel = new Kernel({ db, clock: { now: () => ny("10:05", "2026-11-12") }, sourcePolicy: () => "candidate" });
	const body = "NVDA 涨 +5.31%，到达 +5% 档。现价 105.31，昨收 100。报价时间 10:05 ET（延迟行情）。";
	const thread = "thr_us-market:NVDA:2026-11-12";
	const { triggerId } = kernel.submitTrigger({ source: "us-market", externalId: "NVDA:2026-11-12:up5", threads: [{ id: thread, title: "NVDA 2026-11-12 行情" }], sender: "us-market", body, occurredAt: ny("10:05", "2026-11-12") });
	const title = "以前 us-market 的任务：NVDA 涨 5%";
	kernel.route([{ kind: "open_ticket", basis: "rule", ruleId: "us-market/big-move", triggerId, title, brief: "核实 NVDA 的波动", threads: [thread] }]);
	kernel.postHostLine("us-market", { kind: "alert", externalId: "NVDA:2026-11-12:up5", text: `盯盘提醒：${body}`, occurredAt: ny("10:05", "2026-11-12") });
	db.close();
	return title;
}

type Boot = { models: typeof REAL | typeof harness.fakeModels; fake?: InstanceType<typeof FakeModel>; health?: boolean; watch: string[]; history?: boolean; seed?: string; config?: Record<string, unknown> };

async function boot(o: Boot) {
	const state = temp();
	const massive = await fakeMassive();
	installStockTa(state, massive.base);
	if (o.health) cpSync(join(HEAD, "docs/modules/architecture/sample/personal-health"), join(state, "modules/personal-health"), { recursive: true });
	if (o.seed) {
		mkdirSync(join(state, "modules-data"), { recursive: true });
		if (spawnSync("cp", ["-cR", join(o.seed, "modules-data/stock-ta"), join(state, "modules-data/stock-ta")]).status !== 0) throw new Error(`could not clone the seed ${o.seed}`);
	}
	const entry = servedAsHost(Modules.load([join(state, "modules")])).feeds().find((e: { source: string }) => e.source === "stock-ta/quotes");
	instanceData(state).write("stock-ta", entry.components, "watchlist", o.watch.map((symbol) => ({ symbol })), "使用者口述", "r5-live");
	const oldTitle = o.history ? seedUsMarketHistory(state) : undefined;
	const tg = await FakeTelegram.start();
	writeFileSync(join(state, "secrets.env"), `POLYGON_API_KEY=fake-key\nTELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`, { mode: 0o600 });
	const host: Host = await harness.startHost({
		models: o.models, stateDir: state, logFile: join(state, "host.log"), timeoutMs: 60_000,
		config: { webPort: 0, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] }, ...o.config },
		env: { ...(o.fake ? fakeAgentEnv(o.fake, join(state, "pi")) : {}), PSA_E2E_TELEGRAM_URL: tg.url, PSA_R5_NOW: new Date(ny("11:00")).toISOString() },
		imports: ["./tests/e2e/telegram-preload.mjs", "./docs/modules/evidence/r5-clock-preload.mjs"],
	});
	const db = join(state, "state.db");
	const active = (name: string) => query(db, `SELECT record FROM module_records WHERE name = '${name}'`).some((r) => String(r["record"]).includes('"at":"active"'));
	for (const name of o.health ? ["stock-ta", "personal-health"] : ["stock-ta"]) {
		just(state, ["module", "on", name]);
		if (!(await within(30_000, () => active(name)))) throw new Error(`${name} did not turn on`);
	}
	tg.userSays(USER, "/start");
	await within(10_000, () => tg.sent.length > 0);
	const beats = () => (host.log().match(/\[feeds\] stock-ta\/quotes/g) ?? []).length;
	const phone = () => tg.sent.filter((m: { chatId: number }) => m.chatId === USER).map((m: { text: string; at: number }) => ({ text: m.text, at: m.at }));
	return {
		state, host, tg, massive, oldTitle, phone,
		/** One feed beat on these prices at this data time; the minute jump makes the beat due. */
		async step(hhmm: string, prices: Record<string, number>, prevClose: Record<string, number>) {
			Object.assign(massive.market.prices, prices);
			Object.assign(massive.market.prevClose, prevClose);
			massive.market.at = ny(hhmm);
			const before = beats();
			const sentAt = Date.now();
			process.kill(host.pid, "SIGUSR2");
			if (!(await within(15_000, () => beats() > before))) throw new Error(`no quotes beat after ${hhmm}; log tail:\n${host.log().split("\n").slice(-8).join("\n")}`);
			return sentAt;
		},
		say: (text: string) => just(state, ["say", text]),
		triggers: () => query(db, "SELECT source, external_id, body FROM triggers WHERE source <> 'conversation' ORDER BY rowid"),
		lines: () => query(db, "SELECT source, external_id, text, created_at FROM host_lines WHERE kind = 'alert' ORDER BY rowid"),
		tickets: () => query(db, "SELECT id, title, domain, worker_state, dispatched_to FROM tickets ORDER BY rowid"),
		ticketTriggers: () => query(db, "SELECT s.ticket_id AS ticket, tr.external_id AS trigger FROM triggers tr JOIN trigger_threads tt ON tt.trigger_id = tr.id JOIN subscriptions s ON s.thread_id = tt.thread_id WHERE tr.source = 'stock-ta/quotes' ORDER BY tr.rowid"),
		async stop() {
			await host.stop();
			await tg.close();
			await massive.close();
		},
	};
}

async function bubbles(png: string, title: string, lines: string[]): Promise<void> {
	const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
	const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#c8dcc0;font:15px/1.45 -apple-system,"PingFang SC",sans-serif;width:520px}h2{font-size:14px;color:#345;margin:0 0 12px}.msg{background:#fff;border-radius:12px 12px 12px 4px;padding:8px 12px;margin:0 0 10px;box-shadow:0 1px 1px rgba(0,0,0,.15);white-space:pre-wrap}</style><h2>${esc(title)}</h2>${lines.map((l) => `<div class="msg">${esc(l)}</div>`).join("")}`;
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 568, height: 200 }, deviceScaleFactor: 2 });
		await page.setContent(html);
		await page.screenshot({ path: png, fullPage: true });
	} finally {
		await browser.close();
	}
}

async function pageShot(host: Host, png: string, act: (page: import("playwright-core").Page) => Promise<void>): Promise<void> {
	const browser = await chromium.launch();
	try {
		const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		await page.goto(host.url.href);
		await act(page);
		await page.screenshot({ path: png, fullPage: true });
	} finally {
		await browser.close();
	}
}

const BAND = /^band:/;
const PREV = { NVDA: 100, SPY: 500, QQQ: 400 };
const bigMoveTicket = (c: string, title: string) => {
	const open = openTicket(c, title);
	const [d] = open.args.decisions as Row[];
	return { ...open, args: { decisions: [{ ...d, basis: "rule", ruleId: "stock-ta/big-move", domain: "stock-ta" }] } };
};
const routerForTriggers = (n: number) => Array.from({ length: n }, (_, i) => on(`到档开任务 ${i}`, /来源 stock-ta\/quotes/, (c: string) => [bigMoveTicket(c, `${/(NVDA|SPY|QQQ)/.exec(c)?.[1] ?? "?"} 到档 ${i}`)]));
const deskWorkers = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => worker(`${prefix} ${i}`, on("汇报", /[\s\S]/, () => [report("ready", "盘面：个股行情。结构和动量见下。这是技术分析，不是交易指令。")])));

async function fake(): Promise<void> {
	await lane(1, "parity", async () => {
		const run = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "docs/modules/evidence/r5-parity.ts", outDir], { cwd: HEAD, encoding: "utf8", timeout: 600_000 });
		const text = readFileSync(join(outDir, "r5-parity.txt"), "utf8");
		return { pass: run.status === 0 && text.startsWith("PASS"), evidence: text };
	});

	await lane(2, "one-path", async () => {
		const fakeModel = await FakeModel.start({ router: routerForTriggers(4), workers: deskWorkers(4, "NVDA 到档").concat(deskWorkers(4, "SPY 到档")) });
		const h = await boot({ models: harness.fakeModels, fake: fakeModel, watch: ["NVDA"] });
		try {
			const ladder = [["09:31", 101], ["09:50", 105.2], ["10:10", 106.4], ["10:30", 108.1], ["10:50", 104.5], ["11:10", 103], ["11:30", 105.8], ["11:50", 108.4]] as const;
			for (const [hhmm, nvda] of ladder) await h.step(hhmm, { NVDA: nvda, SPY: 501 }, PREV);
			await h.step("12:00", { SPY: 510.5 }, PREV);
			await sleep(2000);
			const triggers = h.triggers();
			const lines = h.lines();
			const bands = triggers.map((t) => String(t["external_id"]));
			const oneEach = bands.every((id) => lines.filter((l) => l["external_id"] === id).length === 1);
			const want = [`band:NVDA:${DAY}:up5`, `band:NVDA:${DAY}:up8`, `band:SPY:${DAY}:up2`];
			const sources = new Set([...triggers.map((t) => t["source"]), ...lines.map((l) => l["source"])]);
			const pass = JSON.stringify(bands) === JSON.stringify(want) && oneEach && lines.length === want.length && !sources.has("us-market") && [...sources].every((s) => s === "stock-ta/quotes" || s === "module:stock-ta");
			return { pass, evidence: `host on the fake model, NVDA in the watchlist, the ladder scenario (5 to 8, fall back, rise again) then SPY +2.1%\nMassive requests: ${h.massive.market.hits.length}, first ${h.massive.market.hits[0]}\ntriggers:\n${show(triggers)}\nalert lines:\n${show(lines)}\nsources seen: ${[...sources].join(", ")}\nexpected band events: ${want.join(", ")}; each has exactly one trigger and one line: ${oneEach}` };
		} finally {
			await h.stop();
		}
	});

	await lane(4, "private-first", async () => {
		const BRIEF = "记 CEA";
		const ANSWER = "NVDA 到了 +5% 档，已经开任务看盘面、结构和动量";
		const inHealth = (open: { name: string; args: Record<string, unknown> }) => ({ ...open, args: { decisions: (open.args.decisions as object[]).map((d) => ({ ...d, domain: "personal-health" })) } });
		const fakeModel = await FakeModel.start({
			router: [
				on("开任务", /^\[对话\][\s\S]*使用者：记 CEA/, (c: string) => [inHealth(openTicket(c, BRIEF)), reply(c, "好，记 CEA")]),
				on("转述", /^\[Worker 汇报\][^\n]*记 CEA/, (c: string) => [reply(c, "转述：CEA 4.2 ng/mL")]),
				on("到档", /来源 stock-ta\/quotes/, (c: string) => [bigMoveTicket(c, "NVDA 到 5% 档")]),
				on("回答", /^\[对话\][\s\S]*使用者：NVDA 怎么了/, (c: string) => [reply(c, ANSWER)]),
			],
			workers: [
				worker(BRIEF, on("写", /^\[任务说明\]/, () => [{ name: "data", args: { op: "write", collection: "lab-results", rows: [{ item: "CEA", value: 4.2, unit: "ng/mL", reference: "<5", takenAt: "2026-10-01", lab: "协和" }], from: "使用者口述" } }]), on("汇报", /^\[模块数据\]/, () => [report("ready", "CEA 4.2 ng/mL")])),
				...deskWorkers(1, "NVDA 到 5% 档"),
			],
		});
		const h = await boot({ models: harness.fakeModels, fake: fakeModel, health: true, watch: ["NVDA"] });
		try {
			h.say("记 CEA");
			await within(60_000, () => h.phone().some((m) => m.text === "转述：CEA 4.2 ng/mL"));
			const before = h.phone().length;
			await h.step("10:05", { NVDA: 105.3 }, PREV);
			const line = await within(20_000, () => h.phone().slice(before).find((m) => m.text.startsWith("提醒 · 股票技术分析：NVDA")));
			h.say("NVDA 怎么了");
			await within(30_000, () => h.phone().slice(before).some((m) => m.text === ANSWER));
			await sleep(1500);
			const after = h.phone().slice(before).map((m) => m.text);
			const png = join(outDir, "r5-private-first.png");
			await bubbles(png, "幕僚长读过私密数据以后，NVDA 到 +5% 档（假 Telegram）", h.phone().map((m) => m.text).filter((t) => !t.startsWith("你在网页或终端说")));
			const pass = line?.text === "提醒 · 股票技术分析：NVDA 涨 +5.30%，到达 +5% 档。现价 105.30，昨收 100.00。报价时间 10:05 ET（延迟行情）。" && after.includes(ANSWER) && !after.some((t) => t.includes("请在网页上查看"));
			return { pass, evidence: `personal-health ticket wrote private data and its report reached Telegram in full, then NVDA +5.3%\nTelegram after the band:\n${show(after)}\nscreenshot ${png}` };
		} finally {
			await h.stop();
		}
	});

	await lane(5, "spy", async () => {
		const fakeModel = await FakeModel.start({ router: routerForTriggers(2), workers: deskWorkers(2, "SPY 到档") });
		const h = await boot({ models: harness.fakeModels, fake: fakeModel, watch: ["NVDA"] });
		try {
			await h.step("10:30", { NVDA: 100.5, SPY: 508 }, PREV);
			await sleep(1500);
			const at16 = { triggers: h.triggers(), lines: h.lines() };
			await h.step("11:30", { SPY: 510.5 }, PREV);
			await within(20_000, () => h.tickets().length > 0);
			const at21 = { triggers: h.triggers(), lines: h.lines(), tickets: h.tickets() };
			const pass = at16.triggers.length === 0 && at16.lines.length === 0 && at21.triggers.length === 1 && at21.lines.length === 1 && String(at21.lines[0]!["text"]).startsWith("SPY 涨 +2.10%，到达 +2% 档") && at21.tickets.length === 1 && h.massive.market.hits.every((u) => u.includes("SPY") && u.includes("QQQ"));
			return { pass, evidence: `watchlist NVDA only; SPY prevClose 500\nrequests: ${show(h.massive.market.hits)}\nafter SPY 508 (+1.6%): triggers ${at16.triggers.length}, lines ${at16.lines.length}\nafter SPY 510.5 (+2.1%):\ntriggers:\n${show(at21.triggers)}\nlines:\n${show(at21.lines)}\ntickets:\n${show(at21.tickets)}` };
		} finally {
			await h.stop();
		}
	});

	await lane(6, "calendar", async () => {
		const holiday = await R.replay(HEAD, temp(), R.scenario("holiday"), ["NVDA"], []);
		const early = await R.replay(HEAD, temp(), R.scenario("early-close"), ["NVDA"], []);
		const pass = holiday.rows === 0 && holiday.triggered.length === 0 && holiday.posted.length === 0 && early.rows === 2 && early.triggered.length === 0 && early.posted.length === 0;
		return { pass, evidence: `holiday (${R.scenario("holiday").title}): quote rows ${holiday.rows}, triggers ${holiday.triggered.length}, lines ${holiday.posted.length}\nearly close (${R.scenario("early-close").title}): quote rows ${early.rows} (12:30 and 12:59; 13:05 is after the 13:00 close), triggers ${show(early.triggered)}, lines ${show(early.posted)}` };
	});

	await lane(7, "config", async () => {
		const state = temp();
		const env = fakeAgentEnv(await FakeModel.start({ router: [] }), join(state, "pi"));
		let refused = "";
		try {
			const host = await harness.startHost({ models: harness.fakeModels, stateDir: state, logFile: join(state, "host.log"), timeoutMs: 30_000, env, config: { webPort: 0, sources: { "us-market": { everySeconds: 300 } } } });
			await host.stop();
		} catch (error) {
			refused = (error as Error).message;
		}
		const config = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
		delete config.sources;
		writeFileSync(join(state, "config.json"), JSON.stringify(config));
		const host = await harness.startHost({ models: harness.fakeModels, stateDir: state, logFile: join(state, "host2.log"), timeoutMs: 30_000, env, config });
		const started = host.url.href !== "";
		await host.stop();
		const pass = /us-market 已经退役，删掉 .*config\.json 里的 sources\.us-market/.test(refused) && started;
		return { pass, evidence: `config.json with sources.us-market:\n  ${refused}\nafter deleting it: host started, web ${started ? "up" : "down"}` };
	});

	await lane(8, "page", async () => {
		const fakeModel = await FakeModel.start({ router: routerForTriggers(1), workers: deskWorkers(1, "NVDA 到档") });
		const h = await boot({ models: harness.fakeModels, fake: fakeModel, watch: ["NVDA", "AMD"], history: true });
		try {
			await h.step("10:05", { NVDA: 105.3, AMD: 151, SPY: 501, QQQ: 401 }, { ...PREV, AMD: 150 });
			await within(20_000, () => h.tickets().length > 1);
			const sourcesPng = join(outDir, "r5-page-sources.png");
			const modulesPng = join(outDir, "r5-page.png");
			const oldPng = join(outDir, "r5-page-old-ticket.png");
			let sources = "", card = "", old = "";
			await pageShot(h.host, sourcesPng, async (page) => {
				await harness.showScreen(page, "overview");
				await page.locator('.tab[data-tab="sources"]').click();
				await page.locator("#sources").waitFor();
				sources = (await page.locator("#sources").innerText()).trim();
			});
			await pageShot(h.host, modulesPng, async (page) => {
				await harness.showScreen(page, "overview");
				await page.locator('.tab[data-tab="modules"]').click();
				await page.locator("#modules button.more").click();
				await page.locator("#modules").getByText("今日提醒").first().waitFor({ timeout: 15_000 });
				await page.locator('#modules [data-module="stock-ta"]').scrollIntoViewIfNeeded();
				card = (await page.locator("#modules").innerText()).trim();
			});
			await pageShot(h.host, oldPng, async (page) => {
				await page.getByText(h.oldTitle!).first().click();
				await page.getByText("核实 NVDA 的波动").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
				old = (await page.locator("body").innerText()).slice(0, 2000);
			});
			const pass = !sources.includes("美股行情") && /今日提醒 1 条/.test(card) && /自选股报价 \d\d:\d\d 美东 取到 \d+ 行/.test(card) && old.includes(h.oldTitle!);
			return { pass, evidence: `来源 tab text:\n${sources}\n\n模块 tab text:\n${card}\n\nold us-market ticket opened: ${old.includes(h.oldTitle!)}\nscreenshots ${sourcesPng} ${modulesPng} ${oldPng}` };
		} finally {
			await h.stop();
		}
	});
	console.log(results.join("\n"));
}

const SEED = process.env["R5_SEED"] ?? "/tmp/swarm-r3/owner/seed";

async function real(): Promise<void> {
	const runs = Number(process.env["R5_RUNS"] ?? "1");
	const timings: { line: number; report: number }[] = [];
	for (let i = 0; i < runs; i++) {
		await lane(3, runs === 1 ? "ticket" : `ticket-${i + 1}`, async () => {
			const h = await boot({ models: REAL, watch: ["NVDA"], seed: SEED });
			try {
				const before = h.phone().length;
				const sentAt = await h.step("10:05", { NVDA: 105.3, SPY: 501, QQQ: 401 }, PREV);
				const line = await within(10_000, () => h.phone().slice(before).find((m) => m.text.startsWith("提醒 · 股票技术分析：NVDA")));
				const ticket = await within(240_000, () => h.tickets().find((t) => t["domain"] === "stock-ta"));
				const THREE = ["盘面", "结构与形态", "趋势与动量"];
				const members = await within(240_000, () => {
					const to = h.tickets().find((t) => t["domain"] === "stock-ta")?.["dispatched_to"];
					const names = to ? (JSON.parse(String(to)) as string[]) : [];
					return names.length > 0 ? names : undefined;
				});
				await h.step("10:30", { NVDA: 108.1 }, PREV);
				const second = await within(20_000, () => h.ticketTriggers().find((r) => String(r["trigger"]).endsWith("up8")));
				const firstReport = await within(600_000, () => h.phone().slice(before).find((m) => !/^(提醒 · |你在|成员上限)/.test(m.text)));
				await sleep(3000);
				const tickets = h.tickets();
				const ta = tickets.filter((t) => t["domain"] === "stock-ta");
				if (line) timings.push({ line: line.at - sentAt, report: firstReport ? firstReport.at - sentAt : NaN });
				const png = join(outDir, runs === 1 ? "r5-ticket.png" : `r5-ticket-${i + 1}.png`);
				await pageShot(h.host, png, async (page) => {
					await page.getByText(String(ta[0]?.["title"] ?? "NVDA")).first().click().catch(() => undefined);
					await sleep(1500);
				});
				const firstCalls = Object.fromEntries(["market-desk", "structure-pattern", "trend-momentum"].map((m) => [m, h.host.log().split("\n").find((l) => l.includes("[gateway]") && l.includes(` ${m} `))?.slice(0, 24)]));
				const stamps = Object.values(firstCalls).map((t) => Date.parse(t ?? ""));
				const oneRound = stamps.every((n) => !Number.isNaN(n)) && Math.max(...stamps) - Math.min(...stamps) < 30_000;
				const exactlyThree = members !== undefined && members.length === 3 && THREE.every((m) => members.includes(m));
				const pass = ta.length === 1 && exactlyThree && oneRound && second?.["ticket"] === ta[0]!["id"] && line !== undefined;
				return {
					pass,
					evidence: `real models ${JSON.stringify(REAL)}, NVDA +5.3% then +8.1%\nband line on Telegram after ${line ? `${line.at - sentAt} ms` : "never"}: ${line?.text}\nfirst report line after ${firstReport ? `${((firstReport.at - sentAt) / 1000).toFixed(1)} s` : "never"}: ${firstReport?.text}\ndispatched to: ${JSON.stringify(members)} (exactly the three: ${exactlyThree})\neach member's first gateway call: ${JSON.stringify(firstCalls)} (within 30 s of each other: ${oneRound})\n+8% trigger joined ticket: ${JSON.stringify(second)}\ntickets:\n${show(tickets)}\nTelegram:\n${show(h.phone().map((m) => m.text))}\nscreenshot ${png}`,
				};
			} finally {
				writeFileSync(join(outDir, `r5-ticket-host-${i + 1}.log`), h.host.log());
				await h.stop();
			}
		});
	}
	if (timings.length > 0) {
		const report = `alert and report latency over ${timings.length} real run(s)\n  band line on Telegram after the beat: median ${median(timings.map((t) => t.line))} ms (${timings.map((t) => t.line).join(", ")})\n  first report line after the beat: median ${(median(timings.map((t) => t.report)) / 1000).toFixed(1)} s (${timings.map((t) => (t.report / 1000).toFixed(1)).join(", ")})`;
		writeFileSync(join(outDir, "r5-latency.txt"), `${report}\n`);
		console.log(report);
	}

	await lane(10, "chat-set", async () => {
		const h = await boot({ models: REAL, watch: ["NVDA", "TSLA"], seed: SEED });
		try {
			Object.assign(h.massive.market, { prices: { TSLA: 251.2, NVDA: 101 }, prevClose: { TSLA: 248, NVDA: 100 }, at: ny("10:45") });
			const before = h.phone().length;
			h.tg.userSays(USER, "给 TSLA 设个当天涨跌 4% 的提醒");
			const conditions = () => query(join(h.state, "modules-data/stock-ta/data.db"), "SELECT id, key, kind, params FROM _conditions");
			await within(240_000, () => conditions().length > 0);
			await sleep(5000);
			const receipts = query(join(h.state, "state.db"), "SELECT text FROM host_lines WHERE kind = 'receipt'").map((r) => String(r["text"]));
			const tripwire = h.host.log().split("\n").filter((l) => l.includes("tripwire"));
			const lines = query(join(h.state, "state.db"), "SELECT kind, source, text FROM host_lines ORDER BY rowid");
			const gateway = h.host.log().split("\n").filter((l) => l.includes("[gateway]"));
			const png = join(outDir, "r5-chat-set.png");
			let pageChat = "";
			await pageShot(h.host, png, async (page) => {
				await harness.showScreen(page, "chat");
				await page.getByText(/已设/).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
				pageChat = await page.locator("body").innerText();
			});
			const set = conditions();
			const pass = set.length === 1 && set[0]!["kind"] === "day-move" && set[0]!["key"] === "TSLA" && JSON.parse(String(set[0]!["params"])).atLeast === 4 && tripwire.length === 0 && pageChat.includes("TSLA") && /4%/.test(pageChat.slice(pageChat.lastIndexOf("TSLA") - 40));
			return { pass, evidence: `real models, Telegram: 给 TSLA 设个当天涨跌 4% 的提醒\n_conditions: ${show(set)}\nreceipt host lines: ${show(receipts)} (the gateway keeps a watch receipt inside the tool output, so the page shows the lead's confirmation, not a receipt line)\npage chat confirms: ${pageChat.split("\n").filter((l) => l.includes("TSLA")).join(" | ")}\nhost log lines naming tripwire: ${show(tripwire)}\nall host lines: ${show(lines)}\ngateway: ${show(gateway)}\nTelegram: ${show(h.phone().slice(before).map((m) => m.text))}\nscreenshot ${png}` };
		} finally {
			await h.stop();
		}
	});
	console.log(results.join("\n"));
}

async function media(): Promise<void> {
	const fakeModel = await FakeModel.start({
		router: [
			...routerForTriggers(1),
			...[1, 2].map(() => on("转述汇报", /^\[Worker 汇报\]/, (c: string) => [reply(c, `NVDA 到档的分析：${c.split("\n").slice(1).join(" ").slice(0, 120)}`)])),
		],
		workers: [worker("NVDA 到档 0", on("汇报", /^\[任务说明\]/, () => [report("ready", "盘面：NVDA 单独走强，SPY、QQQ 平。结构：放量突破 104 阻力。动量：日线 MACD 金叉。这是技术分析，不是交易指令。")]), on("再汇报", /[\s\S]/, () => [report("ready", "盘面：+8% 档，仍是个股行情。这是技术分析，不是交易指令。")]))],
	});
	const h = await boot({ models: harness.fakeModels, fake: fakeModel, watch: ["NVDA", "AMD"], history: true });
	const browser = await chromium.launch();
	const videoDir = temp();
	try {
		const entry = servedAsHost(Modules.load([join(h.state, "modules")])).feeds().find((e: { source: string }) => e.source === "stock-ta/quotes");
		instanceData(h.state).watch("stock-ta", entry.components, { kind: "watch", collection: "quotes", op: "set", watch: { key: "NVDA", condition: { when: "day-move", atLeast: 1, direction: "either" } } }, "page");
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } });
		const page = await context.newPage();
		await page.goto(h.host.url.href);
		await page.waitForTimeout(2500);
		await h.step("10:04", { NVDA: 100.4, AMD: 150.5, SPY: 500.5, QQQ: 400.2 }, { ...PREV, AMD: 150 });
		await page.waitForTimeout(2000);
		await h.step("10:05", { NVDA: 105.31 }, PREV);
		await within(30_000, () => h.phone().some((m) => m.text.startsWith("NVDA 到档的分析")));
		await page.waitForTimeout(4000);
		await h.step("10:30", { NVDA: 108.12 }, PREV);
		await within(30_000, () => h.phone().filter((m) => m.text.startsWith("NVDA 到档的分析")).length >= 2 || undefined);
		await page.waitForTimeout(4000);
		await harness.showScreen(page, "overview");
		await page.locator('.tab[data-tab="sources"]').click();
		await page.waitForTimeout(3000);
		await page.locator('.tab[data-tab="modules"]').click();
		await page.locator("#modules button.more").click();
		await page.locator('#modules [data-module="stock-ta"]').scrollIntoViewIfNeeded();
		await page.waitForTimeout(5000);
		await page.getByText(h.oldTitle!).first().click();
		await page.waitForTimeout(4000);
		await context.close();
		const [webm] = (await import("node:fs")).readdirSync(videoDir);
		const mp4 = join(outDir, "r5-review.mp4");
		const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(videoDir, webm!), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], { encoding: "utf8" });
		if (ff.status !== 0) throw new Error(ff.stderr);
		const sent = h.phone().map((m) => m.text).filter((t) => !t.startsWith("你在网页或终端说") && !t.startsWith("这里是白宫"));
		await bubbles(join(outDir, "r5-review-telegram.png"), "到档提醒和汇报（假 Telegram，回放 NVDA +5.31% 再 +8.12%，你设了 NVDA 当天涨跌 1%）", sent);
		writeFileSync(join(outDir, "r5-review.txt"), `fake Telegram, sent to the user:\n${show(sent)}\nalert lines:\n${show(h.lines())}\n`);
		console.log(`media in ${outDir}: r5-review.mp4, r5-review-telegram.png, r5-review.txt`);
	} finally {
		await browser.close();
		await h.stop();
	}
}

async function market(): Promise<void> {
	await lane(9, "real", async () => {
		const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(Date.now()).map((p) => [p.type, p.value]));
		const minutes = Number(parts["hour"]) * 60 + Number(parts["minute"]);
		const open = !["Sat", "Sun"].includes(parts["weekday"]!) && minutes >= 9 * 60 + 30 && minutes <= 16 * 60 + 20;
		if (!open && !args.includes("--off-hours")) return { pass: "not run", evidence: `New York time is ${parts["weekday"]} ${parts["hour"]}:${parts["minute"]}, outside 9:30 to 16:20; rerun on a trading day, or pass --off-hours` };
		return { pass: "not run", evidence: "lane 9 needs a trading session; not written for an off-hours run" };
	});
}

async function perf(): Promise<void> {
	const TRUNK = join(outDir, "trunk");
	if (!existsSync(TRUNK)) throw new Error(`run r5-parity.ts first; it makes the trunk worktree at ${TRUNK}`);
	const symbols = ["NVDA", "AMD", "AAPL", "MSFT", "META", "GOOGL", "TSLA", "SPY", "QQQ"];
	const times = { trunk: [] as number[], head: [] as number[] };
	const requests = { trunk: 0, head: 0 };
	for (let pass = 0; pass < 3; pass++) {
		const order = pass % 2 === 0 ? (["trunk", "head"] as const) : (["head", "trunk"] as const);
		for (const side of order) {
			const day = await R.stockTaDay(side === "trunk" ? TRUNK : HEAD, temp(), symbols);
			if (side === "head") day.watch({ key: "NVDA", condition: { when: "day-move", atLeast: 1, direction: "either" } });
			const start = ny("09:31", "2026-11-12");
			for (let i = 0; i < 390; i++) {
				const at = start + i * MINUTE;
				const prices = Object.fromEntries(symbols.map((s, k) => [s, 100 * (1 + (Math.sin((i + k * 7) / 40) * 9) / 100)]));
				const round = await day.round({ day: "2026-11-12", at, now: at + 15 * MINUTE, prices, prevClose: Object.fromEntries(symbols.map((s) => [s, 100])) });
				times[side].push(round.ms);
				requests[side]++;
			}
			day.close();
		}
	}
	const spread = (xs: number[]) => `p10 ${[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 10)]!.toFixed(1)}, p90 ${[...xs].sort((a, b) => a - b)[Math.floor((xs.length * 9) / 10)]!.toFixed(1)}`;
	const slower = median(times.head) - median(times.trunk);
	const verdict = slower <= 20 && requests.head <= requests.trunk;
	const report = [
		`${verdict ? "PASS" : "FAIL"} perf: one quotes round (handler process, write, conditions, bands), ${symbols.length} symbols, trunk vs head, 3 passes of 390 rounds each, alternating which side goes first. Rule: head median more than 20 ms over trunk fails; more requests per hour on head fails.`,
		`  baseline trunk: median ${median(times.trunk).toFixed(1)} ms (${spread(times.trunk)}), ${times.trunk.length} rounds`,
		`  head:           median ${median(times.head).toFixed(1)} ms (${spread(times.head)}), ${times.head.length} rounds`,
		`  head minus trunk: ${slower.toFixed(1)} ms`,
		`  requests: trunk ${requests.trunk}, head ${requests.head} over the same ${3 * 390} rounds, so ${60} per hour on each (one snapshot a round)`,
	].join("\n");
	writeFileSync(join(outDir, "r5-perf.txt"), `${report}\n`);
	console.log(report);
}

try {
	await ({ fake, real, market, perf, media } as Record<string, () => Promise<void>>)[mode]!();
} finally {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
	// The fake model servers and Playwright leave handles open.
	process.exit(process.exitCode ?? 0);
}
