/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/proactive-live.ts [fake|real] [outDir]
 *
 * fake  Lanes 1 to 5 on the fake model: a local server stands in for Massive, a small script for `ta`, a fake Telegram.
 *       The host clock comes from proactive-clock-preload.mjs, so the market can be open or closed at any real hour.
 * real  Lane 6 on openai-codex models through the Pi login in ~/.pi/agent: a scan signal reaches the real Router, which
 *       opens a ticket by rule ma-break. The experts read a seed data dir (PROACTIVE_SEED, default /tmp/swarm-r3/owner/seed).
 * PROACTIVE_LANES=1,3 runs only those lanes. Lane 7 (R5's replay parity) needs a pre-R5 trunk; see r5-parity.ts.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const SEED = process.env["PROACTIVE_SEED"] ?? "/tmp/swarm-r3/owner/seed";
const USER = 42;
const DAY = "2026-11-12";
const EVENING = "2026-11-12T23:00:00.000Z";
const HOUR = 3_600_000;
const [mode = "fake", outDir = "/tmp/swarm-proactive/owner"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, fakeAgentEnv, on, openTicket, report, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const { Modules } = await import(join(HEAD, "src/modules.ts"));
const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
type Host = Awaited<ReturnType<typeof harness.startHost>>;
type Row = Record<string, unknown>;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const show = (rows: unknown[]) => rows.map((r) => `  ${typeof r === "string" ? r : JSON.stringify(r)}`).join("\n") || "  (none)";
const ny = (hhmm: string, date = DAY) => Date.parse(`${date}T${hhmm}:00-05:00`);
const close = (date: string) => Date.parse(`${date}T21:00:00Z`);
const made: string[] = [];

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

const results: string[] = [];
type Verdict = { pass: boolean; evidence: string };
const only = process.env["PROACTIVE_LANES"]?.split(",");
async function lane(n: number, slug: string, body: () => Promise<Verdict>): Promise<void> {
	if (only && !only.includes(String(n))) return;
	let verdict: Verdict;
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const file = join(outDir, `proactive-${slug}.txt`);
	writeFileSync(file, `${verdict.pass ? "PASS" : "FAIL"} lane ${n}\n${verdict.evidence.replaceAll(/\/tmp\/psa-pro-\w+/g, "<state>")}\n`);
	results.push(`${verdict.pass ? "PASS" : "FAIL"}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

async function fakeMassive() {
	const market = { prices: {} as Record<string, number>, prevClose: {} as Record<string, number>, at: 0, fail: false, hits: 0 };
	const server = createServer((req, res) => {
		market.hits++;
		if (market.fail) return void res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ status: "ERROR" }));
		const asked = new URL(req.url ?? "", "http://x").searchParams.get("tickers")?.split(",") ?? [];
		const tickers = asked.filter((s) => s in market.prices).map((s) => ({ ticker: s, lastTrade: { p: market.prices[s], t: market.at * 1e6 }, min: { c: market.prices[s], t: market.at, v: 1000 }, day: { c: market.prices[s], v: 5e6 }, prevDay: { c: market.prevClose[s], v: 3.9e7 } }));
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "DELAYED", tickers }));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { market, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((done) => server.close(done)) };
}

const FAKE_TA = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const plan = JSON.parse(readFileSync(new URL("./plan.json", import.meta.url), "utf8"));
let text = "";
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text || "{}");
if (process.argv[2] === "calendar") {
	const weekday = new Date(input.date + "T12:00:00Z").getUTCDay();
	const trading = weekday >= 1 && weekday <= 5;
	console.log(JSON.stringify({ date: input.date, is_trading_day: trading, close: trading ? input.date + "T21:00:00+00:00" : null }));
} else {
	if (!existsSync(process.env.TA_DB_PATH)) writeFileSync(process.env.TA_DB_PATH, "");
	console.log(JSON.stringify({ scan_id: 1, symbol_count: input.symbols.length, new_signals: plan.signals, errors: plan.down ? input.symbols.map((symbol) => ({ symbol, error: { code: "MARKET_UNAVAILABLE" } })) : [] }));
}
`;

const signal = (symbol: string, rule_id: string, kind: string, direction: string, date: string, price: number) => ({ id: 1, symbol, rule_id, timeframe: "1d", kind, direction, data_start_ms: close(date) - 23_400_000, data_end_ms: close(date), discovered_ms: close(date) + 960_000, price, attention: "key", read: 0 });

type Boot = { models: typeof REAL | typeof harness.fakeModels; fake?: InstanceType<typeof FakeModel>; watch: string[]; now: number; stepMs?: number; key?: boolean; seed?: string; signals?: unknown[]; bands?: unknown };

async function boot(o: Boot) {
	const state = mkdtempSync("/tmp/psa-pro-");
	made.push(state);
	const massive = await fakeMassive();
	const pkg = join(state, "modules", "stock-ta");
	cpSync(join(HEAD, "docs/modules/examples/stock-ta"), pkg, { recursive: true });
	const taDir = join(state, "fake-ta");
	mkdirSync(taDir);
	writeFileSync(join(taDir, "ta.mjs"), FAKE_TA);
	const plan = (p: { signals?: unknown[]; down?: boolean }) => writeFileSync(join(taDir, "plan.json"), JSON.stringify({ signals: [], ...p }));
	plan({ signals: o.signals ?? [] });
	const edit = (feed: string, settings: Record<string, unknown>) => {
		const path = join(pkg, "feeds", feed, "feed.json");
		const json = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...json, settings: { ...json.settings, ...settings } }, null, 2));
	};
	edit("quotes", { baseUrl: massive.base });
	edit("scan", { ta: join(taDir, "ta.mjs"), now: EVENING });
	if (o.seed) {
		mkdirSync(join(state, "modules-data"), { recursive: true });
		if (spawnSync("cp", ["-cR", join(o.seed, "modules-data/stock-ta"), join(state, "modules-data/stock-ta")]).status !== 0) throw new Error(`could not clone the seed ${o.seed}`);
		const seeded = new DatabaseSync(join(state, "modules-data/stock-ta/data.db"));
		seeded.exec(`DELETE FROM "_feeds" WHERE "source" = 'stock-ta/scan'`);
		seeded.close();
	}
	const entry = servedAsHost(Modules.load([join(state, "modules")])).feeds().find((e: { source: string }) => e.source === "stock-ta/quotes");
	const watch = (...symbols: string[]) => instanceData(state).write("stock-ta", entry.components, "watchlist", symbols.map((symbol) => ({ symbol })), "使用者口述", "proactive-live");
	watch(...o.watch);
	const tg = await FakeTelegram.start();
	writeFileSync(join(state, "secrets.env"), `${o.key === false ? "" : "POLYGON_API_KEY=fake-key\n"}TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`, { mode: 0o600 });
	const host: Host = await harness.startHost({
		models: o.models, stateDir: state, logFile: join(state, "host.log"), timeoutMs: 60_000,
		config: { webPort: 0, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } },
		env: { ...(o.fake ? fakeAgentEnv(o.fake, join(state, "pi")) : {}), PSA_E2E_TELEGRAM_URL: tg.url, PSA_PROACTIVE_NOW: new Date(o.now).toISOString(), PSA_PROACTIVE_STEP_MS: String(o.stepMs ?? 60_000) },
		imports: ["./tests/e2e/telegram-preload.mjs", "./docs/modules/evidence/proactive-clock-preload.mjs"],
	});
	const db = join(state, "state.db");
	const beats = (source: string) => (host.log().match(new RegExp(`\\[feeds\\] ${source}`, "g")) ?? []).length;
	tg.userSays(USER, "/start");
	await within(10_000, () => tg.sent.length > 0);
	spawnSync("just", ["module", "on", "stock-ta"], { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: state }, encoding: "utf8", timeout: 120_000 });
	if (!(await within(30_000, () => query(db, "SELECT record FROM module_records WHERE name = 'stock-ta'").some((r) => String(r["record"]).includes('"at":"active"'))))) throw new Error("stock-ta did not turn on");
	return {
		state, host, tg, massive, plan, watch, edit,
		phone: () => tg.sent.filter((m: { chatId: number }) => m.chatId === USER).map((m: { text: string }) => m.text),
		async beat(source: string) {
			const before = beats(source);
			process.kill(host.pid, "SIGUSR2");
			if (!(await within(30_000, () => beats(source) > before))) throw new Error(`no ${source} beat; log tail:\n${host.log().split("\n").slice(-8).join("\n")}`);
		},
		firstBeat: (source: string) => within(30_000, () => beats(source) > 0),
		triggers: (source: string) => query(db, `SELECT external_id, body FROM triggers WHERE source = '${source}' ORDER BY rowid`),
		notices: (source: string) => query(db, `SELECT text FROM host_lines WHERE kind = 'notice' AND source = '${source}' ORDER BY rowid`).map((r) => String(r["text"])),
		alerts: () => query(db, "SELECT external_id, text FROM host_lines WHERE kind = 'alert' ORDER BY rowid"),
		tickets: () => query(db, "SELECT id, title, domain, basis, rule_id, dispatched_to FROM tickets ORDER BY rowid"),
		scanRuns: () => query(join(state, "modules-data/stock-ta/data.db"), `SELECT "tradingDate", "outcome", "newSignals", "errors" FROM "scan-runs" ORDER BY "_id"`),
		async stop() {
			await host.stop();
			await tg.close();
			await massive.close();
		},
	};
}

const maBreakTicket = (c: string, title: string) => {
	const open = openTicket(c, title);
	const [d] = open.args.decisions as Row[];
	return { ...open, args: { decisions: [{ ...d, basis: "rule", ruleId: "stock-ta/ma-break", domain: "stock-ta" }] } };
};
const ignore = (c: string) => ({ name: "route", args: { decisions: [{ kind: "ignore", triggerId: /\btrg_[\w-]+/.exec(c)?.[0] ?? "trg_missing", reason: "站上 50 日线，规则 ma-break 不开任务" }] } });

async function fake(): Promise<void> {
	await lane(1, "scan-trigger", async () => {
		const fakeModel = await FakeModel.start({
			router: [on("跌破开任务", /来源 stock-ta\/scan[\s\S]*bearish/, (c: string) => [maBreakTicket(c, "NVDA 跌破 50 日线")]), on("站上忽略", /来源 stock-ta\/scan[\s\S]*bullish/, (c: string) => [ignore(c)])],
			workers: [worker("NVDA 跌破 50 日线", on("汇报", /[\s\S]/, () => [report("ready", "结构：跌破 50 日线。这是技术分析，不是交易指令。")]))],
		});
		const backfill = [signal("NVDA", "R-MA-2-50", "跌破 MA50", "bearish", DAY, 150.2), signal("NVDA", "R-MA-2-50", "站上 MA50", "bullish", "2025-06-02", 120)];
		const h = await boot({ models: harness.fakeModels, fake: fakeModel, watch: ["NVDA"], now: Date.parse(EVENING), stepMs: HOUR, signals: backfill });
		try {
			await h.firstBeat("stock-ta/scan");
			const afterFirst = h.triggers("stock-ta/scan").length;
			h.plan({ signals: [signal("NVDA", "R-MA-2-50", "跌破 MA50", "bearish", DAY, 150.2), signal("AMD", "R-MA-2-50", "站上 MA50", "bullish", DAY, 160.5), signal("NVDA", "R-MACD-2", "死叉", "bearish", DAY, 150.2), signal("SPY", "R-MA-2-50", "跌破 MA50", "bearish", DAY, 580)] });
			h.watch("AMD");
			await h.beat("stock-ta/scan");
			const ticket = await within(30_000, () => h.tickets().find((t) => t["rule_id"] === "stock-ta/ma-break"));
			h.watch("MSFT");
			await h.beat("stock-ta/scan");
			await sleep(1500);
			const triggers = h.triggers("stock-ta/scan");
			const ids = triggers.map((t) => String(t["external_id"]));
			const want = [`signal:AMD:R-MA-2-50:1d:${DAY}:bullish`, `signal:NVDA:R-MA-2-50:1d:${DAY}:bearish`];
			const pass = afterFirst === 0 && JSON.stringify([...ids].sort()) === JSON.stringify(want) && h.tickets().length === 1 && ticket !== undefined;
			return { pass, evidence: `host on the fake model, evening ${EVENING}; scan via a stand-in ta\nfirst scan of an empty database (backfill with a ${DAY} and a 2025 signal): ${afterFirst} triggers\nthen AMD added (rescan): ta returned NVDA MA50 down, AMD MA50 up, NVDA MACD (not in settings), SPY MA50 (not in the watchlist)\nthen MSFT added (rescan, same signals again)\ntriggers from stock-ta/scan:\n${show(triggers)}\nscan-runs:\n${show(h.scanRuns())}\ntickets:\n${show(h.tickets())}\nexpected trigger ids ${want.join(", ")}, one ma-break ticket` };
		} finally {
			await h.stop();
		}
	});

	await lane(2, "no-key", async () => {
		const h = await boot({ models: harness.fakeModels, fake: await FakeModel.start({ router: [] }), watch: ["NVDA"], now: ny("10:00"), key: false });
		try {
			await h.firstBeat("stock-ta/scan");
			for (let i = 0; i < 3; i++) await h.beat("stock-ta/quotes");
			await sleep(1000);
			const quotes = h.notices("stock-ta/quotes");
			const scan = h.notices("stock-ta/scan");
			const phone = h.phone().filter((t) => t.includes("POLYGON_API_KEY"));
			const pass = quotes.length === 1 && scan.length === 1 && phone.length === 2 && h.massive.market.hits === 0;
			return { pass, evidence: `no POLYGON_API_KEY in secrets.env; host clock 10:00 ET on ${DAY}; 4 quotes beats, 1 scan beat\nnotice lines from stock-ta/quotes:\n${show(quotes)}\nnotice lines from stock-ta/scan:\n${show(scan)}\nTelegram lines naming the key:\n${show(phone)}\nMassive requests: ${h.massive.market.hits}` };
		} finally {
			await h.stop();
		}
	});

	await lane(3, "massive-down", async () => {
		const h = await boot({ models: harness.fakeModels, fake: await FakeModel.start({ router: [] }), watch: ["NVDA"], now: ny("10:00") });
		try {
			Object.assign(h.massive.market, { prices: { NVDA: 101, SPY: 501, QQQ: 401 }, prevClose: { NVDA: 100, SPY: 500, QQQ: 400 } });
			const fresh = async () => {
				h.massive.market.at = ny("10:05");
				await h.beat("stock-ta/quotes");
			};
			await h.firstBeat("stock-ta/quotes");
			h.massive.market.fail = true;
			const counts: number[] = [];
			for (let i = 0; i < 7; i++) {
				await h.beat("stock-ta/quotes");
				counts.push(h.notices("stock-ta/quotes").length);
			}
			h.massive.market.fail = false;
			await fresh();
			const afterRecovery = h.notices("stock-ta/quotes").length;
			h.massive.market.fail = true;
			for (let i = 0; i < 5; i++) await h.beat("stock-ta/quotes");
			await sleep(500);
			const lines = h.notices("stock-ta/quotes");
			const pass = JSON.stringify(counts) === JSON.stringify([0, 0, 0, 0, 1, 1, 1]) && afterRecovery === 1 && lines.length === 2 && lines.every((l) => l.includes("连着 5 轮"));
			return { pass, evidence: `Massive answers HTTP 500 for 7 beats, recovers for one, fails 5 more\nnotice count after each failing beat: ${JSON.stringify(counts)}\nafter recovery: ${afterRecovery}\nnotice lines:\n${show(lines)}\nTelegram:\n${show(h.phone().filter((t) => t.includes("报价")))}` };
		} finally {
			await h.stop();
		}
	});

	await lane(4, "stale", async () => {
		const h = await boot({ models: harness.fakeModels, fake: await FakeModel.start({ router: [] }), watch: ["NVDA"], now: ny("10:00") });
		try {
			Object.assign(h.massive.market, { prices: { NVDA: 101, SPY: 501, QQQ: 401 }, prevClose: { NVDA: 100, SPY: 500, QQQ: 400 }, at: ny("09:45") });
			await h.firstBeat("stock-ta/quotes");
			const counts: number[] = [];
			for (let i = 0; i < 21; i++) {
				await h.beat("stock-ta/quotes");
				counts.push(h.notices("stock-ta/quotes").length);
			}
			h.massive.market.at = ny("10:07");
			await h.beat("stock-ta/quotes");
			await h.beat("stock-ta/quotes");
			const lines = h.notices("stock-ta/quotes");
			const firstAt = counts.indexOf(1) + 1;
			const pass = firstAt === 20 && lines.length === 1 && lines[0]!.includes("20 分钟");
			return { pass, evidence: `quote data time frozen at 09:45 ET from the 10:00 beat on, one beat a minute\nnotice count after each beat: ${JSON.stringify(counts)} (first notice ${firstAt} minutes after the data stopped moving)\nthen data time 10:07: no new notice\nnotice lines:\n${show(lines)}` };
		} finally {
			await h.stop();
		}
	});

	await lane(5, "bands-hot", async () => {
		const fakeModel = await FakeModel.start({ router: [on("到档开任务", /来源 stock-ta\/quotes/, (c: string) => [{ ...openTicket(c, "NVDA 到 3% 档"), args: { decisions: [{ ...(openTicket(c, "NVDA 到 3% 档").args.decisions as Row[])[0], basis: "rule", ruleId: "stock-ta/big-move", domain: "stock-ta" }] } }])], workers: [worker("NVDA 到 3% 档", on("汇报", /[\s\S]/, () => [report("ready", "这是技术分析，不是交易指令。")]))] });
		const h = await boot({ models: harness.fakeModels, fake: fakeModel, watch: ["NVDA"], now: ny("10:00") });
		try {
			Object.assign(h.massive.market, { prices: { NVDA: 103.2, SPY: 501, QQQ: 401 }, prevClose: { NVDA: 100, SPY: 500, QQQ: 400 }, at: ny("09:50") });
			await h.firstBeat("stock-ta/quotes");
			const before = h.alerts().length;
			const saved = Date.now();
			h.edit("quotes", { bands: { default: [3, 6], bySymbol: { SPY: [2, 3], QQQ: [2, 3] } } });
			const receipt = await within(10_000, () => h.host.log().split("\n").find((l) => l.includes("收据：stock-ta") && l.includes("feeds/quotes/feed.json")));
			const receiptMs = Date.now() - saved;
			h.massive.market.at = ny("09:51");
			await h.beat("stock-ta/quotes");
			const ticket = await within(20_000, () => h.tickets().find((t) => t["rule_id"] === "stock-ta/big-move"));
			const alerts = h.alerts();
			const pass = before === 0 && receipt !== undefined && alerts.length === 1 && String(alerts[0]!["external_id"]) === `band:NVDA:${DAY}:up3` && h.triggers("stock-ta/quotes").length === 1 && ticket !== undefined;
			return { pass, evidence: `NVDA +3.2% with the shipped bands [5, 8]: ${before} alert lines\nedited settings.bands.default to [3, 6] in the state dir copy; receipt after about ${receiptMs} ms: ${receipt}\nnext beat:\nalert lines:\n${show(alerts)}\ntriggers:\n${show(h.triggers("stock-ta/quotes"))}\ntickets:\n${show(h.tickets())}` };
		} finally {
			await h.stop();
		}
	});
}

async function real(): Promise<void> {
	await lane(6, "real-ma-break", async () => {
		const h = await boot({ models: REAL, watch: ["NVDA", "AMD"], now: Date.parse(EVENING), stepMs: HOUR, seed: SEED, signals: [signal("NVDA", "R-MA-2-50", "跌破 MA50", "bearish", DAY, 150.2), signal("AMD", "R-MA-2-50", "站上 MA50", "bullish", DAY, 160.5)] });
		try {
			const sentAt = Date.now();
			await h.firstBeat("stock-ta/scan");
			const ticket = await within(300_000, () => h.tickets().find((t) => t["domain"] === "stock-ta"));
			const members = await within(300_000, () => {
				const to = h.tickets().find((t) => t["domain"] === "stock-ta")?.["dispatched_to"];
				const names = to ? (JSON.parse(String(to)) as string[]) : [];
				return names.length > 0 ? names : undefined;
			});
			const firstReport = await within(600_000, () => h.phone().find((t) => /技术分析，不是交易指令/.test(t)));
			await sleep(3000);
			const tickets = h.tickets();
			const pass = ticket?.["basis"] === "rule" && ticket?.["rule_id"] === "stock-ta/ma-break" && /NVDA/.test(String(ticket?.["title"])) && tickets.filter((t) => t["domain"] === "stock-ta").length === 1;
			return { pass, evidence: `real models ${JSON.stringify(REAL)}, seed data, scan signals NVDA MA50 down and AMD MA50 up on ${DAY}\ntriggers:\n${show(h.triggers("stock-ta/scan"))}\nticket after ${ticket ? "" : "never "}${((Date.now() - sentAt) / 1000).toFixed(0)} s total wait:\n${show(tickets)}\ndispatched to: ${JSON.stringify(members)}\nfirst report on Telegram: ${firstReport ?? "none within 10 minutes"}\nTelegram:\n${show(h.phone())}` };
		} finally {
			writeFileSync(join(outDir, "proactive-real-host.log"), h.host.log());
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
writeFileSync(join(outDir, `proactive-${mode}-summary.txt`), `${results.join("\n")}\n`);
// The fake model servers stay listening, so leave explicitly.
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
