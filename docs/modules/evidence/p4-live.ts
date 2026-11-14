/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/p4-live.ts [fake|real] [outDir]
 *
 * A real temp host with a fake Massive (snapshot with day.o/h/l/v) and the repo's fake Bot API, as p2-live.ts. The clock comes
 * from proactive-clock-preload.mjs through NODE_OPTIONS, so the host and every process it starts (feeds, Workers) read Thursday
 * 2026-11-12. Each host gets a module daily-bar database with 260 days of history per symbol, shaped so that only the holding
 * rules can fire. Holdings rows are written into the private `holdings` collection while the host runs, as the Worker would.
 * fake  Lane 1: NVDA cost 150, stop 138, day low 137.50: one ringing line with 138.00 and a watch-task ticket on the holding
 *       thread whose trigger names holding-ask and carries no 150 or 138; the Worker asks with three buttons, the user taps
 *       「从持仓划掉」, the Worker writes a removedAt row, and a lower beat sends no new holding line.
 *       Lane 2: AMD cost 80 bought 2026-08-01, peak 110 since then (a higher bar before boughtAt): AMD 93 rings 回撤, no ticket.
 *       Lane 3: TSLA cost 200: 199 sends one silent line, no ticket; 198 later sends nothing new.
 *       Lane 4: NVDA taken off the watchlist keeps its holding row; crossing its stop sends no line, while AMD's stop in the same
 *       beat does.
 * real  Lane 5 on openai-codex models through the Pi login: the user tells the host his NVDA holding on Telegram; the real Worker
 *       writes the row; a stop-loss beat rings and opens a ticket whose brief names holding-ask; a question card, if one comes
 *       within a few minutes, is recorded with whether it names the stop 138.00, the cost 150.00 and the price 140.00.
 * The scan feed runs a stand-in for `ta` that reports a clean scan, so no lane starts with a 日线扫描出问题 notice.
 * P4_LANES=1,3 runs only those lanes.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const USER = 42;
const DAY = "2026-11-12";
const CLOCK = join(HEAD, "docs/modules/evidence/proactive-clock-preload.mjs");
const OPTIONS = ["派研究组看一眼", "止损线不变", "从持仓划掉"];
const [mode = "fake", outDir = "/tmp/p4-verify/live"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, fakeAgentEnv, on, openTicket, reply, report, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const { Modules } = await import(join(HEAD, "src/modules.ts"));
const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
type Row = Record<string, unknown>;
type Sent = { chatId: number; text: string; silent: boolean; messageId: number; buttons: { text: string; data: string }[][] | null };
type Day = { o: number; h: number; l: number; v: number };
type Bar = { h: number; l: number; c: number };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const show = (rows: unknown[]) => rows.map((r) => `  ${typeof r === "string" ? r : JSON.stringify(r)}`).join("\n") || "  (none)";
const ny = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00-05:00`);
const scrub = (text: string) => text.replaceAll(/\/tmp\/psa-p4-\w+/g, "<state>").replaceAll(homedir(), "~");
const made: string[] = [];

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
const only = process.env["P4_LANES"]?.split(",");
async function lane(n: number, slug: string, body: () => Promise<Verdict>): Promise<void> {
	if (only && !only.includes(String(n))) return;
	let verdict: Verdict;
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const file = join(outDir, `p4-${slug}.txt`);
	writeFileSync(file, scrub(`${verdict.pass ? "PASS" : "FAIL"} lane ${n}\n${verdict.evidence}\n`));
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

/**
 * The scan feed's database as it stands after a scan: 260 complete daily bars per symbol before DAY. `bars(daysAgo)` shapes each
 * symbol's history; the defaults keep every price in the lanes inside the 52-week range.
 */
function seedHistory(dataDir: string, history: Record<string, (daysAgo: number) => Bar>) {
	mkdirSync(join(dataDir, "files", "ta"), { recursive: true });
	const db = new DatabaseSync(join(dataDir, "files", "ta", "ta.sqlite"));
	db.exec("CREATE TABLE bars (symbol TEXT NOT NULL, timeframe TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, session_date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, vw REAL, complete INTEGER NOT NULL, PRIMARY KEY (symbol, timeframe, start_ms))");
	const insert = db.prepare("INSERT INTO bars VALUES (?, '1d', ?, ?, ?, ?, ?, ?, ?, 1000000, NULL, 1)");
	for (const [symbol, bars] of Object.entries(history)) {
		for (let i = 1; i <= 260; i++) {
			const start = Date.parse(`${DAY}T05:00:00Z`) - i * 86_400_000;
			const { h, l, c } = bars(i);
			insert.run(symbol, start, start + 86_400_000, new Date(start).toISOString().slice(0, 10), c, h, l, c);
		}
	}
	db.close();
}

const HISTORY: Record<string, (daysAgo: number) => Bar> = {
	NVDA: () => ({ h: 155, l: 120, c: 145 }),
	// boughtAt 2026-08-01 is 103 days back: the 110 high 30 days back is the peak since then; the 125 high 200 days back is before it.
	AMD: (i) => ({ h: i === 30 ? 110 : i === 200 ? 125 : 100, l: 85, c: 96 }),
	TSLA: () => ({ h: 230, l: 170, c: 200 }),
};

/** Answers `ta calendar` and reports `ta scan` as clean without touching the database, which seedHistory already filled. */
const CLEAN_SCAN = `let text = "";
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text || "{}");
if (process.argv[2] === "calendar") {
	const trading = [1, 2, 3, 4, 5].includes(new Date(input.date + "T12:00:00Z").getUTCDay());
	console.log(JSON.stringify({ date: input.date, is_trading_day: trading, close: trading ? input.date + "T21:00:00+00:00" : null }));
} else console.log(JSON.stringify({ scan_id: 1, symbol_count: input.symbols.length, new_signals: [], errors: [] }));
`;

async function boot(o: { models: unknown; fake?: { close?: () => unknown }; watch: Row[]; at: string }) {
	const state = mkdtempSync("/tmp/psa-p4-");
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
	data.write("stock-ta", entry.components, "watchlist", o.watch, "使用者口述", "p4-live");
	seedHistory(data.dir("stock-ta"), HISTORY);
	const tg = await FakeTelegram.start();
	writeFileSync(join(state, "secrets.env"), `POLYGON_API_KEY=fake-key\nTELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`, { mode: 0o600 });
	const clock = { PSA_PROACTIVE_NOW: new Date(ny(o.at)).toISOString(), PSA_PROACTIVE_STEP_MS: "60000", NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --import ${CLOCK}`.trim() };
	const host = await harness.startHost({
		models: o.models, stateDir: state, logFile: join(state, "host.log"), timeoutMs: 60_000,
		config: { webPort: 0, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } },
		env: { ...(o.fake ? fakeAgentEnv(o.fake, join(state, "pi")) : {}), PSA_E2E_TELEGRAM_URL: tg.url, ...clock },
		imports: ["./tests/e2e/telegram-preload.mjs"],
	});
	const db = join(state, "state.db");
	const beats = () => (host.log().match(/\[feeds\] stock-ta\/quotes/g) ?? []).length;
	tg.userSays(USER, "/start");
	await within(10_000, () => tg.sent.length > 0);
	spawnSync("just", ["module", "on", "stock-ta"], { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: state, ...clock }, encoding: "utf8", timeout: 120_000 });
	if (!(await within(30_000, () => query(db, "SELECT record FROM module_records WHERE name = 'stock-ta'").some((r) => String(r["record"]).includes('"at":"active"'))))) throw new Error("stock-ta did not turn on");
	await within(30_000, () => beats() > 0);
	return {
		state, host, tg, massive, data, entry,
		phone: (): Sent[] => tg.sent.filter((m: Sent) => m.chatId === USER).map((m: Sent) => ({ chatId: m.chatId, text: m.text, silent: m.silent, messageId: m.messageId, buttons: m.buttons })),
		holdings: (): Row[] => data.query("stock-ta", entry.components, "holdings", { limit: 50 }, "p4-live").rows as Row[],
		hold(rows: Row[]) {
			data.write("stock-ta", entry.components, "holdings", rows, "使用者口述", "p4-live");
		},
		async beat() {
			const before = beats();
			process.kill(host.pid, "SIGUSR2");
			if (!(await within(30_000, () => beats() > before))) throw new Error(`no quotes beat; log tail:\n${host.log().split("\n").slice(-8).join("\n")}`);
			await sleep(500);
		},
		quote(prices: Record<string, number>, prevClose: Record<string, number>, day: Record<string, Partial<Day>>, hhmm: string) {
			Object.assign(this.massive.market, { prices: { SPY: 500, QQQ: 400, ...prices }, prevClose: { SPY: 500, QQQ: 400, ...prevClose }, day, at: ny(hhmm) });
		},
		alerts: () => query(db, "SELECT external_id, push, text FROM host_lines WHERE kind = 'alert' ORDER BY rowid"),
		triggers: () => query(db, "SELECT t.external_id, t.body, group_concat(tt.thread_id) AS threads, i.ticket_id FROM triggers t LEFT JOIN trigger_threads tt ON tt.trigger_id = t.id LEFT JOIN ticket_inputs i ON i.trigger_id = t.id WHERE t.source = 'stock-ta/quotes' GROUP BY t.id ORDER BY t.rowid"),
		tickets: () => query(db, "SELECT k.id, k.title, k.basis, k.rule_id, k.domain, k.worker_state, group_concat(s.thread_id) AS threads FROM tickets k LEFT JOIN subscriptions s ON s.ticket_id = k.id GROUP BY k.id ORDER BY k.rowid"),
		briefs: () => query(db, "SELECT ticket_id, kind, body FROM ticket_inputs ORDER BY rowid"),
		problems: () => query(db, "SELECT record FROM module_records WHERE name = 'stock-ta'").map((r) => String(r["record"])).filter((r) => r.includes("bad-holding")),
		hits: () => {
			const file = join(data.dir("stock-ta"), "files", "hits", DAY, "quotes.json");
			return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).hits as Row[]).map((h) => `${h["rule"]} ${h["symbol"]} level ${h["level"]}`) : [];
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
const handOverTo = (title: string) => (card: string) => {
	const ticketId = card.match(new RegExp(`(tkt_[\\w-]+)「${title}」`))?.[1];
	return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: card.match(/trg_[\w-]+/)?.[0], ticketId }] } }];
};
const holdingLines = (sent: Sent[]) => sent.filter((m) => /报价时间/.test(m.text) && /止损线|回撤|成本价/.test(m.text));
const plain = (sent: Sent[]) => sent.map(({ text, silent }) => ({ text, silent }));
const quiet = () => FakeModel.start({ router: [on("不该开任务", /来源 stock-ta\/quotes/, (c: string) => [byWatchTask(c, "不该开")])] });

async function fake(): Promise<void> {
	await lane(1, "stop-loss-card", async () => {
		const title = "NVDA 持仓止损";
		const removal = { symbol: "NVDA", removedAt: DAY, note: "从持仓划掉" };
		const model = await FakeModel.start({
			router: [
				on("规则开任务", /来源 stock-ta\/quotes/, (c: string) => [byWatchTask(c, title)]),
				on("转问题", /^\[Worker 提问\]/, (c: string) => [reply(c, "NVDA 触到止损线，问你怎么办。")]),
				on("转交回答", new RegExp(`^\\[对话\\][\\s\\S]*回答任务「${title}」：从持仓划掉`), handOverTo(title)),
				on("转述结果", /^\[Worker 汇报\][\s\S]*划掉/, (c: string) => [reply(c, "NVDA 已从持仓划掉。")]),
			],
			workers: [
				worker(
					title,
					on("问使用者", /^\[任务说明\]/, () => [{ name: "report", args: { status: "blocked", summary: "NVDA 触到止损线 138.00（成本 150.00，现价 140.00）。这是技术分析，不是交易指令。", question: "NVDA 触到止损线 138.00：要不要调整止损，还是先不管？", options: OPTIONS } }]),
					on("写划掉", /^\[使用者的话[\s\S]*从持仓划掉/, () => [{ name: "data", args: { op: "write", collection: "holdings", rows: [removal], from: "使用者口述" } }]),
					on("汇报划掉", /^\[模块数据\] holdings/, () => [report("ready", "NVDA 已从持仓划掉，持仓规则停下。这是技术分析，不是交易指令。")]),
				),
			],
			ignore: /./,
		});
		const h = await boot({ models: harness.fakeModels, fake: model, watch: [{ symbol: "NVDA" }], at: "11:15" });
		try {
			h.hold([{ symbol: "NVDA", cost: 150, stopPrice: 138, note: "NVDA 成本 150，止损 138" }]);
			h.quote({ NVDA: 140 }, { NVDA: 145 }, { NVDA: { o: 145, h: 146, l: 137.5 } }, "11:00");
			await h.beat();
			const ticket = await within(20_000, () => h.tickets().find((t) => t["rule_id"] === "stock-ta/watch-task"));
			const card = await within(30_000, () => h.phone().find((m) => m.buttons !== null && m.text.includes("止损")));
			const ring = holdingLines(h.phone());
			const numbers = card ? ["138.00", "150.00", "140.00"].map((n) => `${n} ${card.text.includes(n) ? "yes" : "no"}`).join(", ") : "(no card)";
			const triggers = h.triggers();
			const body = String(triggers[0]?.["body"] ?? "");
			const buttons = card?.buttons?.flat().map((b) => b.text) ?? [];
			let tapped = "";
			if (card) {
				const button = card.buttons!.flat().find((b) => b.text === "从持仓划掉")!;
				const tap = h.tg.userTaps(USER, card.messageId, button.data);
				await within(10_000, () => h.tg.toastFor(tap) !== undefined);
				tapped = `tapped 「${button.text}」, toast ${JSON.stringify(h.tg.toastFor(tap))}`;
			}
			const removed = await within(30_000, () => h.holdings().find((r) => JSON.stringify(r).includes(`"removedAt":"${DAY}"`)));
			const before = holdingLines(h.phone()).length;
			h.quote({ NVDA: 138 }, { NVDA: 145 }, { NVDA: { o: 145, h: 146, l: 135 } }, "11:30");
			await h.beat();
			await sleep(1500);
			const after = holdingLines(h.phone());
			const thread = `thr_stock-ta:NVDA:${DAY}:holding`;
			const checks = {
				"one ringing holding line with 138.00": ring.length === 1 && !ring[0]!.silent && ring[0]!.text.includes("138.00"),
				"one trigger on the holding thread": triggers.length === 1 && triggers[0]!["threads"] === thread,
				"trigger names holding-ask": /做法 holding-ask）$/.test(body),
				"trigger has no 150 or 138": !/150|138/.test(body),
				"watch-task ticket on the holding thread": ticket !== undefined && String(ticket["threads"]).includes(thread) && triggers[0]!["ticket_id"] === ticket["id"],
				"card has the three buttons": JSON.stringify(buttons) === JSON.stringify(OPTIONS),
				"holdings gained the removedAt row": removed !== undefined && JSON.stringify(removed).includes(`"removedAt":"${DAY}"`) && JSON.stringify(removed).includes('"symbol":"NVDA"'),
				"lower beat sends no new holding line": after.length === before,
			};
			const pass = Object.values(checks).every(Boolean);
			return { pass, evidence: `host clock 11:15 ET ${DAY}; NVDA history: 52-week high 155, low 120\nholding written while the host runs: NVDA cost 150, stopPrice 138\nbeat 1 (11:00 ET): NVDA 140, prev close 145, day low 137.50\nchecks:\n${show(Object.entries(checks).map(([k, v]) => `${v ? "ok  " : "FAIL"} ${k}`))}\nholding lines on Telegram (silent = disable_notification):\n${show(plain(ring))}\ntriggers (thread, ticket):\n${show(triggers)}\ntickets:\n${show(h.tickets())}\nquestion card:\n${show([card ? { text: card.text, silent: card.silent, buttons } : "(none)"])}\n${tapped || "no tap: no card"}\nholdings rows after the answer:\n${show(h.holdings())}\nbeat 2 (11:30 ET): NVDA 138, day low 135; holding lines after it: ${after.length} (before ${before})\nall Telegram messages:\n${show(plain(h.phone()))}\nhits file:\n${show(h.hits())}` };
		} finally {
			await h.stop();
			await model.close();
		}
	});

	await lane(2, "drawdown", async () => {
		const model = await quiet();
		const h = await boot({ models: harness.fakeModels, fake: model, watch: [{ symbol: "AMD" }], at: "11:15" });
		try {
			h.hold([{ symbol: "AMD", cost: 80, boughtAt: "2026-08-01", note: "AMD 成本 80，2026-08-01 买的" }]);
			h.quote({ AMD: 93 }, { AMD: 96 }, { AMD: { o: 96, h: 96.5, l: 92.8 } }, "11:00");
			await h.beat();
			await sleep(1500);
			const lines = holdingLines(h.phone());
			const pass = lines.length === 1 && !lines[0]!.silent && lines[0]!.text.includes("回撤") && lines[0]!.text.includes("110.00") && h.triggers().length === 0 && h.tickets().length === 0;
			return { pass, evidence: `AMD history: highs 100, one 110 high 30 days back (after boughtAt 2026-08-01), one 125 high 200 days back (before it)\nholding: AMD cost 80, boughtAt 2026-08-01\nbeat (11:00 ET): AMD 93, prev close 96\nholding lines on Telegram:\n${show(plain(lines))}\ntriggers:\n${show(h.triggers())}\ntickets:\n${show(h.tickets())}\nhits file:\n${show(h.hits())}\nexpected: one ringing 回撤 line measured from 110.00, no trigger, no ticket` };
		} finally {
			await h.stop();
			await model.close();
		}
	});

	await lane(3, "below-cost-silent", async () => {
		const model = await quiet();
		const h = await boot({ models: harness.fakeModels, fake: model, watch: [{ symbol: "TSLA" }], at: "11:15" });
		try {
			h.hold([{ symbol: "TSLA", cost: 200, note: "TSLA 成本 200" }]);
			h.quote({ TSLA: 199 }, { TSLA: 201 }, { TSLA: { o: 201, h: 201.5 } }, "11:00");
			await h.beat();
			await sleep(1000);
			const first = holdingLines(h.phone());
			h.quote({ TSLA: 198 }, { TSLA: 201 }, { TSLA: { o: 201, h: 201.5 } }, "11:05");
			await h.beat();
			await sleep(1500);
			const lines = holdingLines(h.phone());
			const pass = first.length === 1 && first[0]!.silent && first[0]!.text.includes("跌破你的成本价 200.00") && lines.length === 1 && h.triggers().length === 0 && h.tickets().length === 0;
			return { pass, evidence: `holding: TSLA cost 200\nbeat 1 (11:00 ET): TSLA 199, prev close 201; beat 2 (11:05 ET): TSLA 198\nholding lines after beat 1:\n${show(plain(first))}\nholding lines after beat 2:\n${show(plain(lines))}\ntriggers:\n${show(h.triggers())}\ntickets:\n${show(h.tickets())}\nhits file:\n${show(h.hits())}\nexpected: one silent below-cost line, nothing new on the second beat, no trigger, no ticket` };
		} finally {
			await h.stop();
			await model.close();
		}
	});

	await lane(4, "off-watchlist", async () => {
		const model = await FakeModel.start({ router: [on("AMD 止损开任务", /来源 stock-ta\/quotes/, (c: string) => [byWatchTask(c, "AMD 持仓止损")])], workers: [worker("AMD 持仓止损", on("汇报", /[\s\S]/, () => [report("ready", "这是技术分析，不是交易指令。")]))], ignore: /./ });
		const h = await boot({ models: harness.fakeModels, fake: model, watch: [{ symbol: "NVDA" }, { symbol: "AMD" }, { symbol: "NVDA", removedAt: DAY, note: "NVDA 从自选股拿掉" }], at: "11:15" });
		try {
			h.hold([{ symbol: "NVDA", cost: 150, stopPrice: 138, note: "NVDA 成本 150，止损 138" }, { symbol: "AMD", cost: 100, stopPrice: 95, note: "AMD 成本 100，止损 95" }]);
			h.quote({ NVDA: 140, AMD: 96 }, { NVDA: 145, AMD: 98 }, { NVDA: { o: 145, h: 146, l: 137 }, AMD: { o: 98, h: 98.5, l: 94.5 } }, "11:00");
			await h.beat();
			await within(10_000, () => holdingLines(h.phone()).length > 0);
			await sleep(1500);
			const lines = holdingLines(h.phone());
			const triggers = h.triggers();
			const pass = lines.length === 1 && lines[0]!.text.includes("AMD 触到你的止损线 95.00") && !h.phone().some((m) => m.text.includes("NVDA")) && triggers.every((t) => !String(t["external_id"]).includes("NVDA"));
			return { pass, evidence: `watchlist rows: NVDA, AMD, then NVDA with removedAt ${DAY}\nholdings: NVDA cost 150 stop 138; AMD cost 100 stop 95\nbeat (11:00 ET): NVDA 140 low 137 (prev close 145); AMD 96 low 94.50 (prev close 98)\nholding lines on Telegram:\n${show(plain(lines))}\ntriggers:\n${show(triggers)}\nall Telegram messages:\n${show(plain(h.phone()))}\nhits file:\n${show(h.hits())}\nexpected: AMD's stop rings in the same beat; nothing about NVDA` };
		} finally {
			await h.stop();
			await model.close();
		}
	});
}

async function real(): Promise<void> {
	await lane(5, "real-holding", async () => {
		const h = await boot({ models: REAL, watch: [{ symbol: "NVDA" }], at: "11:15" });
		try {
			const said = "stock-ta 里记一下我的持仓：NVDA 成本 150，止损 138";
			const saidAt = Date.now();
			h.tg.userSays(USER, said);
			const row = await within(600_000, () => h.holdings().find((r) => { const f = JSON.stringify(r); return f.includes('"symbol":"NVDA"') && /"cost":150\b/.test(f) && /"stopPrice":138\b/.test(f); }), 1000);
			const rowSeconds = ((Date.now() - saidAt) / 1000).toFixed(0);
			await sleep(5000);
			const answered = plain(h.phone());
			h.quote({ NVDA: 140 }, { NVDA: 145 }, { NVDA: { o: 145, h: 146, l: 137.5 } }, "11:00");
			await h.beat();
			const ticket = await within(300_000, () => h.tickets().find((t) => String(t["threads"]).includes(`thr_stock-ta:NVDA:${DAY}:holding`)), 1000);
			const brief = ticket ? h.briefs().filter((b) => b["ticket_id"] === ticket["id"]).map((b) => String(b["body"])) : [];
			const card = ticket ? await within(300_000, () => h.phone().find((m) => m.buttons !== null), 2000) : undefined;
			const ring = holdingLines(h.phone());
			const numbers = card ? ["138.00", "150.00", "140.00"].map((n) => `${n} ${card.text.includes(n) ? "yes" : "no"}`).join(", ") : "(no card)";
			const pass = row !== undefined && ring.length === 1 && !ring[0]!.silent && ticket !== undefined && brief.some((b) => b.includes("holding-ask"));
			return { pass, evidence: `real models ${JSON.stringify(REAL)}\nthe user said on Telegram 「${said}」\nholdings row after ${rowSeconds} s:\n${show([row ?? "(none)"])}\nall holdings rows:\n${show(h.holdings())}\nTelegram after the row:\n${show(answered)}\nbeat (11:00 ET): NVDA 140, prev close 145, day low 137.50\nholding lines:\n${show(plain(ring))}\ntriggers:\n${show(h.triggers())}\ntickets:\n${show(h.tickets())}\nticket inputs:\n${show(brief)}\nquestion card carries stop, cost, price: ${numbers}\nquestion card (recorded, not required):\n${show([card ? { text: card.text, buttons: card.buttons?.flat().map((b) => b.text) } : "(none within 5 min)"])}\nall Telegram messages:\n${show(plain(h.phone()))}` };
		} finally {
			writeFileSync(join(outDir, "p4-real-host.log"), scrub(h.host.log()));
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
writeFileSync(join(outDir, `p4-${mode}-summary.txt`), `${results.join("\n")}\n`);
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
