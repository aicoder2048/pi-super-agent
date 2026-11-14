/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/p2-live.ts [fake|real] [outDir]
 *
 * A real temp host with a fake Massive (snapshot with day.o/h/l/v) and the repo's fake Bot API, as p1-live.ts; the host clock
 * comes from proactive-clock-preload.mjs. Each host gets a module daily-bar database with 260 days of history (52-week high 110,
 * low 90, 20-day volume 1,000,000) so the history rules can fire.
 * fake  Lane 1: NVDA paced volume while up, then a 52-week high: two silent lines, the second is the combo, and one watch-task
 *       ticket whose trigger carries both facts.
 *       Lane 2: NVDA 52-week high, then paced volume below the previous close: no combo, no escalation, 多空分歧 in the line.
 *       Lane 3: SPY -2.1%, then NVDA and AMD -5%: one ticket on SPY's thread holds all three triggers, the stock ones say 大盘日.
 *       Lane 5 (phase 5): NVDA gaps +3.4%, later reverses: level 1 both times, so no line and no Telegram message; the module card
 *       in the page's snapshot lists one NVDA badge with both facts (ADR-0028).
 * real  Lane 4 on openai-codex models through the Pi login: after a beat with hits, the user asks on Telegram for today's signals;
 *       the reply lists them from the hits tool. The module's Python env is installed (just module setup) so the daily-bar tools
 *       answer instead of failing.
 * The scan feed runs a stand-in for `ta` that reports a clean scan, so no lane starts with a 日线扫描出问题 notice.
 * P2_LANES=1,3 runs only those lanes.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const USER = 42;
const DAY = "2026-11-12";
const [mode = "fake", outDir = "/tmp/swarm-p2/live"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, fakeAgentEnv, on, openTicket, report, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const { Modules } = await import(join(HEAD, "src/modules.ts"));
const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
type Row = Record<string, unknown>;
type Sent = { chatId: number; text: string; silent: boolean };
type Day = { o: number; h: number; l: number; v: number };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const show = (rows: unknown[]) => rows.map((r) => `  ${typeof r === "string" ? r : JSON.stringify(r)}`).join("\n") || "  (none)";
const ny = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00-05:00`);
const made: string[] = [];
/** Volume that is `x` times the 20-day average (1,000,000) scaled to the elapsed regular session at `hhmm`. */
const paced = (x: number, hhmm: string) => {
	const [h, m] = hhmm.split(":").map(Number) as [number, number];
	return Math.ceil(x * 1_000_000 * ((h * 60 + m - 570) / 390));
};

function query(path: string, sql: string): Row[] {
	if (!existsSync(path)) return [];
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(sql).all().map((r) => ({ ...r }));
	} catch {
		return [];
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

const results: string[] = [];
type Verdict = { pass: boolean; evidence: string };
const only = process.env["P2_LANES"]?.split(",");
async function lane(n: number, slug: string, body: () => Promise<Verdict>): Promise<void> {
	if (only && !only.includes(String(n))) return;
	let verdict: Verdict;
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const file = join(outDir, `p2-${slug}.txt`);
	writeFileSync(file, `${verdict.pass ? "PASS" : "FAIL"} lane ${n}\n${verdict.evidence.replaceAll(/\/tmp\/psa-p2-\w+/g, "<state>")}\n`);
	results.push(`${verdict.pass ? "PASS" : "FAIL"}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

async function fakeMassive() {
	const market = { prices: {} as Record<string, number>, prevClose: {} as Record<string, number>, day: {} as Record<string, Partial<Day>>, at: 0 };
	const server = createServer((req, res) => {
		const asked = new URL(req.url ?? "", "http://x").searchParams.get("tickers")?.split(",") ?? [];
		const tickers = asked.filter((s) => s in market.prices).map((s) => {
			const p = market.prices[s]!;
			const d = market.day[s] ?? {};
			return { ticker: s, lastTrade: { p, t: market.at * 1e6 }, min: { c: p, t: market.at, v: 1000 }, day: { o: d.o ?? market.prevClose[s], h: d.h ?? Math.max(p, market.prevClose[s]!), l: d.l ?? Math.min(p, market.prevClose[s]!), c: p, v: d.v ?? 100_000 }, prevDay: { c: market.prevClose[s], v: 3.9e7 } };
		});
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "DELAYED", tickers }));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { market, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((done) => server.close(done)) };
}

/** The scan feed's database as it stands after a scan: 260 complete daily bars per symbol before DAY. */
function seedHistory(dataDir: string, symbols: readonly string[]) {
	mkdirSync(join(dataDir, "files", "ta"), { recursive: true });
	const db = new DatabaseSync(join(dataDir, "files", "ta", "ta.sqlite"));
	db.exec("CREATE TABLE bars (symbol TEXT NOT NULL, timeframe TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, session_date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, vw REAL, complete INTEGER NOT NULL, PRIMARY KEY (symbol, timeframe, start_ms))");
	const insert = db.prepare("INSERT INTO bars VALUES (?, '1d', ?, ?, ?, 100, 110, 90, 100, 1000000, NULL, 1)");
	for (const symbol of symbols) {
		for (let i = 1; i <= 260; i++) {
			const start = Date.parse(`${DAY}T05:00:00Z`) - i * 86_400_000;
			insert.run(symbol, start, start + 86_400_000, new Date(start).toISOString().slice(0, 10));
		}
	}
	db.close();
}

/** Answers `ta calendar` and reports `ta scan` as clean without touching the database, which seedHistory already filled. */
const CLEAN_SCAN = `let text = "";
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text || "{}");
if (process.argv[2] === "calendar") {
	const trading = [1, 2, 3, 4, 5].includes(new Date(input.date + "T12:00:00Z").getUTCDay());
	console.log(JSON.stringify({ date: input.date, is_trading_day: trading, close: trading ? input.date + "T21:00:00+00:00" : null }));
} else console.log(JSON.stringify({ scan_id: 1, symbol_count: input.symbols.length, new_signals: [], errors: [] }));
`;

async function boot(o: { models: unknown; fake?: { close?: () => unknown }; watch: string[]; at: string; python?: true }) {
	const state = mkdtempSync("/tmp/psa-p2-");
	made.push(state);
	const massive = await fakeMassive();
	const pkg = join(state, "modules", "stock-ta");
	cpSync(join(HEAD, "docs/modules/examples/stock-ta"), pkg, { recursive: true });
	const feedJson = join(pkg, "feeds/quotes/feed.json");
	const json = JSON.parse(readFileSync(feedJson, "utf8"));
	writeFileSync(feedJson, JSON.stringify({ ...json, settings: { ...json.settings, baseUrl: massive.base } }, null, 2));
	const scanJson = join(pkg, "feeds/scan/feed.json");
	const scanTa = join(state, "clean-scan-ta.mjs");
	writeFileSync(scanTa, CLEAN_SCAN);
	const scan = JSON.parse(readFileSync(scanJson, "utf8"));
	writeFileSync(scanJson, JSON.stringify({ ...scan, settings: { ...scan.settings, ta: scanTa } }, null, 2));
	const entry = servedAsHost(Modules.load([join(state, "modules")])).feeds().find((e: { source: string }) => e.source === "stock-ta/quotes");
	const data = instanceData(state);
	data.write("stock-ta", entry.components, "watchlist", o.watch.map((symbol) => ({ symbol })), "使用者口述", "p2-live");
	seedHistory(data.dir("stock-ta"), o.watch);
	const tg = await FakeTelegram.start();
	writeFileSync(join(state, "secrets.env"), `POLYGON_API_KEY=fake-key\nTELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`, { mode: 0o600 });
	const host = await harness.startHost({
		models: o.models, stateDir: state, logFile: join(state, "host.log"), timeoutMs: 60_000,
		config: { webPort: 0, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } },
		env: { ...(o.fake ? fakeAgentEnv(o.fake, join(state, "pi")) : {}), PSA_E2E_TELEGRAM_URL: tg.url, PSA_PROACTIVE_NOW: new Date(ny(o.at)).toISOString(), PSA_PROACTIVE_STEP_MS: "60000" },
		imports: ["./tests/e2e/telegram-preload.mjs", "./docs/modules/evidence/proactive-clock-preload.mjs"],
	});
	const db = join(state, "state.db");
	const beats = () => (host.log().match(/\[feeds\] stock-ta\/quotes/g) ?? []).length;
	tg.userSays(USER, "/start");
	await within(10_000, () => tg.sent.length > 0);
	if (o.python) {
		const setup = spawnSync("just", ["module", "setup", "stock-ta"], { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: state }, encoding: "utf8", timeout: 600_000 });
		if (setup.status !== 0) throw new Error(`just module setup stock-ta failed:\n${setup.stdout}\n${setup.stderr}`);
	}
	spawnSync("just", ["module", "on", "stock-ta"], { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: state }, encoding: "utf8", timeout: 120_000 });
	if (!(await within(30_000, () => query(db, "SELECT record FROM module_records WHERE name = 'stock-ta'").some((r) => String(r["record"]).includes('"at":"active"'))))) throw new Error("stock-ta did not turn on");
	await within(30_000, () => beats() > 0);
	return {
		state, host, tg, massive, data, entry,
		phone: (): Sent[] => tg.sent.filter((m: Sent) => m.chatId === USER).map((m: Sent) => ({ chatId: m.chatId, text: m.text, silent: m.silent })),
		async beat() {
			const before = beats();
			process.kill(host.pid, "SIGUSR2");
			if (!(await within(30_000, () => beats() > before))) throw new Error(`no quotes beat; log tail:\n${host.log().split("\n").slice(-8).join("\n")}`);
			await sleep(500);
		},
		quote(prices: Record<string, number>, prevClose: Record<string, number>, day: Record<string, Partial<Day>>, hhmm: string) {
			Object.assign(this.massive.market, { prices: { SPY: 501, QQQ: 401, ...prices }, prevClose: { SPY: 500, QQQ: 400, ...prevClose }, day, at: ny(hhmm) });
		},
		alerts: () => query(db, "SELECT external_id, push, text FROM host_lines WHERE kind = 'alert' ORDER BY rowid"),
		triggers: () => query(db, "SELECT t.external_id, t.body, i.ticket_id FROM triggers t LEFT JOIN ticket_inputs i ON i.trigger_id = t.id WHERE t.source = 'stock-ta/quotes' ORDER BY t.rowid"),
		tickets: () => query(db, "SELECT id, title, basis, rule_id, domain, worker_state FROM tickets ORDER BY rowid"),
		hits: () => {
			const file = join(data.dir("stock-ta"), "files", "hits", DAY, "quotes.json");
			return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).hits as Row[]).map((h) => `${h["rule"]} ${h["symbol"]} level ${h["level"]} ${h["lean"] ?? "-"}`) : [];
		},
		async stop() {
			await host.stop();
			await tg.close();
			await massive.close();
		},
	};
}

const byWatchTask = (c: string, title: string) => {
	const open = openTicket(c, title);
	const [d] = open.args.decisions as Row[];
	return { ...open, args: { decisions: [{ ...d, basis: "rule", ruleId: "stock-ta/watch-task", domain: "stock-ta", threads: [c.match(/线程 (thr_\S+)/)?.[1]] }] } };
};
const stockLines = (sent: Sent[]) => sent.filter((m) => /报价时间/.test(m.text));
const fakeTeam = (title: string) => FakeModel.start({
	router: [on("规则开任务", /来源 stock-ta\/quotes/, (c: string) => [byWatchTask(c, title)])],
	workers: [worker(title, on("汇报", /[\s\S]/, () => [report("ready", "这是技术分析，不是交易指令。")], 20_000))],
});

/** The module cards as the page gets them: the snapshot frame that opens the event stream. */
async function cards(url: URL): Promise<Row[]> {
	const events = new URL("/events", url);
	events.search = url.search;
	const controller = new AbortController();
	const res = await fetch(events, { signal: controller.signal });
	const reader = res.body!.getReader();
	let text = "";
	const frame = () => /^data: (.*)\n\n/m.exec(text)?.[1];
	while (frame() === undefined) text += new TextDecoder().decode((await reader.read()).value);
	controller.abort();
	return JSON.parse(frame()!).modules as Row[];
}

async function fake(): Promise<void> {
	await lane(1, "volume-high-combo", async () => {
		const h = await boot({ models: harness.fakeModels, fake: await fakeTeam("NVDA 放量创新高"), watch: ["NVDA"], at: "11:15" });
		try {
			h.quote({ NVDA: 103 }, { NVDA: 100 }, { NVDA: { h: 104, v: paced(3.8, "11:00") } }, "11:00");
			await h.beat();
			h.quote({ NVDA: 104 }, { NVDA: 100 }, { NVDA: { h: 112.3, v: paced(4, "11:01") } }, "11:01");
			await h.beat();
			const ticket = await within(20_000, () => h.tickets().find((t) => t["rule_id"] === "stock-ta/watch-task"));
			await within(10_000, () => h.triggers().every((t) => t["ticket_id"] !== null));
			const lines = stockLines(h.phone());
			const triggers = h.triggers();
			const body = String(triggers[0]?.["body"] ?? "");
			const pass =
				lines.length === 2 && lines.every((l) => l.silent) && lines[0]!.text.includes("放量 3.8 倍") && lines[1]!.text.includes("放量创 52 周新高") &&
				triggers.length === 1 && body.includes("创 52 周新高 112.30（此前最高 110.00）") && body.includes("放量 3.8 倍") && body.endsWith("（规则 volume+high-52w，层级 5，做法 band-move）") &&
				!/分数|评分|胜率/.test(body) && ticket !== undefined && triggers[0]!["ticket_id"] === ticket["id"];
			return { pass, evidence: `host clock 11:15 ET ${DAY}; history: 52-week high 110, 20-day volume 1,000,000\nbeat 1: NVDA 103 (+3%), volume 3.8x paced (11:00 ET); beat 2: NVDA 104, day high 112.30 (11:01 ET)\nTelegram lines (silent = disable_notification):\n${show(lines)}\ntriggers with the ticket each went to:\n${show(triggers)}\ntickets:\n${show(h.tickets())}\nhits file:\n${show(h.hits())}\nexpected: a silent volume line, then a silent combo line; one trigger volume+high-52w with both facts, in one watch-task ticket` };
		} finally {
			await h.stop();
		}
	});

	await lane(5, "level-1-badge", async () => {
		const h = await boot({ models: harness.fakeModels, fake: await fakeTeam("不该开"), watch: ["NVDA"], at: "13:05" });
		try {
			h.quote({ NVDA: 103.5 }, { NVDA: 100 }, { NVDA: { o: 103.4, h: 103.5, v: 100_000 } }, "09:45");
			await h.beat();
			h.quote({ NVDA: 99.6 }, { NVDA: 100 }, { NVDA: { o: 103.4, h: 103.6, l: 99.5, v: 100_000 } }, "13:00");
			await h.beat();
			await within(10_000, () => query(join(h.state, "state.db"), "SELECT text FROM badges").some((r) => String(r["text"]).includes("盘中曾涨")));
			const badges = (await cards(h.host.url)).find((c) => c["name"] === "stock-ta")?.["badges"] as { day: string; items: { key: string; text: string }[] } | undefined;
			const stored = query(join(h.state, "state.db"), "SELECT source, key, text, day FROM badges");
			const phone = h.phone().filter((m) => /开盘跳空|盘中曾涨/.test(m.text));
			const pass = badges?.items.length === 1 && badges.items[0]!.key === "NVDA" && badges.items[0]!.text === "NVDA · 开盘跳空 +3.40% · 盘中曾涨 +3.60%，现在跌 -0.40%" && badges.day === DAY &&
				phone.length === 0 && h.alerts().length === 0 && h.triggers().length === 0;
			return { pass, evidence: `beat 1: NVDA opens 103.40 over prev close 100 (09:45 ET); beat 2: NVDA 99.60 after a day high of 103.60 (13:00 ET)\nmodule card badges in the page snapshot:\n${show([badges])}\nbadges table:\n${show(stored)}\nhost alert lines:\n${show(h.alerts())}\nTelegram messages naming either fact:\n${show(phone)}\nhits file:\n${show(h.hits())}\nexpected: one NVDA badge listing both level-1 facts; no host line, no Telegram message, no trigger` };
		} finally {
			await h.stop();
		}
	});

	await lane(2, "opposite-lean", async () => {
		const h = await boot({ models: harness.fakeModels, fake: await fakeTeam("不该开"), watch: ["NVDA"], at: "11:15" });
		try {
			h.quote({ NVDA: 109 }, { NVDA: 108 }, { NVDA: { h: 111, v: 100_000 } }, "10:00");
			await h.beat();
			h.quote({ NVDA: 106 }, { NVDA: 108 }, { NVDA: { h: 111, v: paced(3.6, "12:00") } }, "12:00");
			await h.beat();
			await sleep(1500);
			const lines = stockLines(h.phone());
			const pass = lines.length === 2 && lines.every((l) => l.silent) && lines[1]!.text.includes("多空分歧（看多 1 条，看空 1 条）") && h.triggers().length === 0 && h.tickets().filter((t) => t["domain"] === "stock-ta").length === 0;
			return { pass, evidence: `beat 1: NVDA 109 over prev close 108, day high 111 (10:00 ET); beat 2: NVDA 106 under prev close, volume 3.6x paced (12:00 ET)\nTelegram lines:\n${show(lines)}\nalerts:\n${show(h.alerts())}\ntriggers:\n${show(h.triggers())}\nhits file:\n${show(h.hits())}\nexpected: two silent lines, the volume one says 多空分歧, no trigger, no ticket` };
		} finally {
			await h.stop();
		}
	});

	await lane(3, "broad-market-day", async () => {
		const h = await boot({ models: harness.fakeModels, fake: await fakeTeam("大盘日"), watch: ["NVDA", "AMD"], at: "10:20" });
		try {
			h.quote({ SPY: 489.5, NVDA: 99, AMD: 99 }, { NVDA: 100, AMD: 100 }, {}, "10:00");
			await h.beat();
			const ticket = await within(20_000, () => h.tickets().find((t) => t["rule_id"] === "stock-ta/watch-task"));
			h.quote({ SPY: 489, NVDA: 94.8, AMD: 94.9 }, { NVDA: 100, AMD: 100 }, {}, "10:05");
			await h.beat();
			await within(10_000, () => h.triggers().length >= 3 && h.triggers().every((t) => t["ticket_id"] !== null));
			await within(10_000, () => stockLines(h.phone()).length >= 3);
			const triggers = h.triggers();
			const stocks = triggers.filter((t) => /band:(NVDA|AMD)/.test(String(t["external_id"])));
			const pass = triggers.length === 3 && stocks.length === 2 && ticket !== undefined && triggers.every((t) => t["ticket_id"] === ticket["id"]) && stocks.every((t) => String(t["body"]).includes("大盘日：SPY 今天已到 -2% 档")) && h.tickets().filter((t) => t["domain"] === "stock-ta").length === 1;
			return { pass, evidence: `beat 1: SPY 489.50 (-2.1%) at 10:00 ET; beat 2: NVDA 94.80, AMD 94.90 (-5.2%, -5.1%) at 10:05 ET\nTelegram lines:\n${show(stockLines(h.phone()))}\ntriggers with the ticket each went to:\n${show(triggers)}\ntickets:\n${show(h.tickets())}\nexpected: three triggers, all in the one ticket opened for SPY; the two stock triggers say 大盘日` };
		} finally {
			await h.stop();
		}
	});
}

async function real(): Promise<void> {
	await lane(4, "real-todays-signals", async () => {
		const h = await boot({ models: REAL, watch: ["NVDA", "AMD"], at: "11:15", python: true });
		try {
			h.quote({ NVDA: 104, AMD: 101 }, { NVDA: 100, AMD: 100 }, { NVDA: { o: 103.4, h: 111.5, v: 100_000 }, AMD: { o: 101, h: 101.5, l: 96.5, v: 100_000 } }, "11:00");
			await h.beat();
			const hits = h.hits();
			const saidAt = Date.now();
			h.tg.userSays(USER, "stock-ta 今天有哪些信号？");
			const answer = await within(600_000, () => h.phone().find((m) => m.text.startsWith("🧭") && /52 ?周新高/.test(m.text) && m.text.includes("NVDA") && m.text.includes("AMD")), 1000);
			const seconds = ((Date.now() - saidAt) / 1000).toFixed(0);
			const pass = hits.length >= 3 && answer !== undefined;
			return { pass, evidence: `real models ${JSON.stringify(REAL)}\nhits after one beat (NVDA gap +3.4% and 52-week high 111.50, AMD reversal from -3.5%):\n${show(hits)}\nthe user asked on Telegram 「stock-ta 今天有哪些信号？」; reply after ${seconds} s:\n${answer?.text ?? "(none)"}\nall Telegram messages:\n${show(h.phone())}` };
		} finally {
			writeFileSync(join(outDir, "p2-real-host.log"), h.host.log().replaceAll(/\/tmp\/psa-p2-\w+/g, "<state>"));
			await h.stop();
		}
	});
}

try {
	if (mode === "fake") await fake();
	else if (mode === "real") await real();
	else throw new Error(`unknown mode ${mode}`);
} finally {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
}
writeFileSync(join(outDir, `p2-${mode}-summary.txt`), `${results.join("\n")}\n`);
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
