/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/p3-live.ts [fake|real] [outDir]
 *
 * Phase 3 of the stock-ta rules on a real temp host: a fake Massive, the repo's fake Bot API, the repo's fake `ta`
 * (tests/helpers/fake-ta.ts, answering a plan of signals and complete daily bars) and a host clock set by p3-clock-preload.mjs,
 * which jumps to the time a lane writes into a file on each SIGUSR2. The feed handlers take the host clock from their input.
 * Session: Thursday 2026-11-12. NVDA and AMD each have 260 daily bars ending at 100 (52-week range 85 to 105, 20-day volume
 * 1,000,000, the 50-day average above the 200-day so no cross fires).
 * fake  One host, three lanes. 15:45 ET NVDA -5.2%: a silent band line and a watch-task ticket on thr_stock-ta:NVDA:2026-11-12.
 *       At 16:21 ET the scan grades Thursday: ta reports NVDA R-MA-2-200 bearish on a 2.4x volume day and AMD R-MA-2-50 bearish.
 *       Lane 1 band-then-200: the 200-day trigger lands in the band's thread and is delivered into the open ticket, with
 *       放量确认 and 做法 structure-trend. Lane 2 ma50-silent: AMD gets one silent line and no trigger. Lane 3 digest-once: one
 *       silent 收盘小结 line, none more on the tick ten minutes later.
 * real  Lane 4 on openai-codex models through the Pi login: the scan alone at 16:21 ET; the Router reads the 200-day trigger and
 *       opens a ticket whose brief names structure-trend. The host stops once the ticket opens, before the team runs.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const USER = 42;
const DAY = "2026-11-12";
const THREAD = `thr_stock-ta:NVDA:${DAY}`;
const [mode = "fake", outDir = "/tmp/swarm-p3/live"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, fakeAgentEnv, on, openTicket, report, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const { fakeTa } = await import(join(HEAD, "tests/helpers/fake-ta.ts"));
const { Modules } = await import(join(HEAD, "src/modules.ts"));
const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
type Row = Record<string, unknown>;
type Sent = { chatId: number; text: string; silent: boolean };
type Bar = { symbol: string; date: string; close: number; volume: number };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const show = (rows: unknown[]) => rows.map((r) => `  ${typeof r === "string" ? r : JSON.stringify(r)}`).join("\n") || "  (none)";
const ny = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00-05:00`);
const made: string[] = [];

function query(path: string, sql: string): Row[] {
	try {
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			return db.prepare(sql).all().map((r) => ({ ...r }));
		} finally {
			db.close();
		}
	} catch {
		return [];
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
function record(n: number, slug: string, verdict: Verdict): void {
	const file = join(outDir, `p3-${slug}.txt`);
	writeFileSync(file, `${verdict.pass ? "PASS" : "FAIL"} lane ${n}\n${verdict.evidence.replaceAll(/\/tmp\/psa-p3-\w+/g, "<state>")}\n`);
	results.push(`${verdict.pass ? "PASS" : "FAIL"}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

/** 260 sessions ending the day before `last` at 100 (older ones swing 85 to 105, the last 50 swing 99 to 101), then `last`. */
function history(symbol: string, last: { date: string; close: number; volume: number } | undefined, through: string): Bar[] {
	const dates: string[] = [];
	for (let ms = Date.parse(`${through}T12:00:00Z`); dates.length < 260; ms -= 86_400_000) {
		const day = new Date(ms).getUTCDay();
		if (day !== 0 && day !== 6) dates.unshift(new Date(ms).toISOString().slice(0, 10));
	}
	const bars = dates.map((date, i) => {
		const recent = i >= 210;
		const close = i === 259 ? 100 : recent ? (i % 2 ? 101 : 99) : i % 2 ? 105 : 85;
		return { symbol, date, close, volume: 1_000_000 };
	});
	return last === undefined ? bars : [...bars, { symbol, ...last }];
}

const signal = (symbol: string, period: number, close: number, average: number) => {
	const end = Date.parse(`${DAY}T21:00:00Z`);
	return { id: 1, symbol, rule_id: `R-MA-2-${period}`, timeframe: "1d", kind: `跌破 MA${period}`, direction: "bearish", data_start_ms: end - 23_400_000, data_end_ms: end, discovered_ms: end + 960_000, price: close, attention: "normal", values: { left: close, right: average }, read: 0 };
};

async function fakeMassive() {
	const market = { prices: {} as Record<string, number>, prevClose: {} as Record<string, number>, at: 0 };
	const server = createServer((req, res) => {
		const asked = new URL(req.url ?? "", "http://x").searchParams.get("tickers")?.split(",") ?? [];
		const tickers = asked.filter((s) => s in market.prices).map((s) => {
			const [p, c] = [market.prices[s]!, market.prevClose[s]!];
			return { ticker: s, lastTrade: { p, t: market.at * 1e6 }, min: { c: p, t: market.at, v: 1000 }, day: { o: c, h: Math.max(p, c), l: Math.min(p, c), c: p, v: 100_000 }, prevDay: { c, v: 3.9e7 } };
		});
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "DELAYED", tickers }));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { market, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((done) => server.close(done)) };
}

const WATCH = ["NVDA", "AMD"];
const wednesday = () => [...WATCH, "SPY", "QQQ"].flatMap((s) => history(s, undefined, "2026-11-11"));
const thursday = () => [
	...history("NVDA", { date: DAY, close: 94.8, volume: 2_400_000 }, "2026-11-11"),
	...history("AMD", { date: DAY, close: 97, volume: 1_000_000 }, "2026-11-11"),
	...["SPY", "QQQ"].flatMap((s) => history(s, { date: DAY, close: 100, volume: 1_000_000 }, "2026-11-11")),
];

async function boot(o: { models: unknown; fake?: { close?: () => unknown }; at: string }) {
	const state = mkdtempSync("/tmp/psa-p3-");
	made.push(state);
	const massive = await fakeMassive();
	const ta = fakeTa(join(state, "fake-ta"), { kind: "ok", bars: wednesday() });
	const pkg = join(state, "modules", "stock-ta");
	cpSync(join(HEAD, "docs/modules/examples/stock-ta"), pkg, { recursive: true });
	for (const [feed, settings] of [["quotes", { baseUrl: massive.base }], ["scan", { ta: ta.script }]] as const) {
		const file = join(pkg, `feeds/${feed}/feed.json`);
		const json = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify({ ...json, settings: { ...json.settings, ...settings } }, null, 2));
	}
	const entry = servedAsHost(Modules.load([join(state, "modules")])).feeds().find((e: { source: string }) => e.source === "stock-ta/quotes");
	const data = instanceData(state);
	data.write("stock-ta", entry.components, "watchlist", WATCH.map((symbol) => ({ symbol })), "使用者口述", "p3-live");
	const tg = await FakeTelegram.start();
	writeFileSync(join(state, "secrets.env"), `POLYGON_API_KEY=fake-key\nTELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`, { mode: 0o600 });
	const clockFile = join(state, "clock.txt");
	writeFileSync(clockFile, new Date(ny(o.at)).toISOString());
	const host = await harness.startHost({
		models: o.models, stateDir: state, logFile: join(state, "host.log"), timeoutMs: 60_000,
		config: { webPort: 0, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } },
		env: { ...(o.fake ? fakeAgentEnv(o.fake, join(state, "pi")) : {}), PSA_E2E_TELEGRAM_URL: tg.url, PSA_P3_NOW: new Date(ny(o.at)).toISOString(), PSA_P3_CLOCK_FILE: clockFile },
		imports: ["./tests/e2e/telegram-preload.mjs", "./docs/modules/evidence/p3-clock-preload.mjs"],
	});
	const db = join(state, "state.db");
	const runs = (feed: string) => (host.log().match(new RegExp(`\\[feeds\\] stock-ta/${feed}`, "g")) ?? []).length;
	tg.userSays(USER, "/start");
	await within(10_000, () => tg.sent.length > 0);
	const { spawnSync } = await import("node:child_process");
	spawnSync("just", ["module", "on", "stock-ta"], { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: state }, encoding: "utf8", timeout: 120_000 });
	if (!(await within(30_000, () => query(db, "SELECT record FROM module_records WHERE name = 'stock-ta'").some((r) => String(r["record"]).includes('"at":"active"'))))) throw new Error("stock-ta did not turn on");
	if (!(await within(60_000, () => runs("scan") > 0))) throw new Error("the scan feed never ran");
	return {
		state, host, tg, massive, ta, data,
		phone: (): Sent[] => tg.sent.filter((m: Sent) => m.chatId === USER).map((m: Sent) => ({ chatId: m.chatId, text: m.text, silent: m.silent })),
		/** Sets the host clock to `hhmm` ET and waits for `feed` to run once more. */
		async at(hhmm: string, feed: "quotes" | "scan") {
			const before = runs(feed);
			writeFileSync(clockFile, new Date(ny(hhmm)).toISOString());
			process.kill(host.pid, "SIGUSR2");
			if (!(await within(60_000, () => runs(feed) > before))) throw new Error(`no ${feed} run after ${hhmm}; log tail:\n${host.log().split("\n").slice(-8).join("\n")}`);
			await sleep(800);
		},
		quote(prices: Record<string, number>, prevClose: Record<string, number>, hhmm: string) {
			Object.assign(massive.market, { prices: { SPY: 501, QQQ: 399, ...prices }, prevClose: { SPY: 500, QQQ: 400, ...prevClose }, at: ny(hhmm) });
		},
		triggers: () => query(db, "SELECT t.source, t.external_id, t.disposition, tt.thread_id, i.ticket_id, t.body FROM triggers t LEFT JOIN trigger_threads tt ON tt.trigger_id = t.id LEFT JOIN ticket_inputs i ON i.trigger_id = t.id WHERE t.source LIKE 'stock-ta/%' ORDER BY t.rowid"),
		tickets: () => query(db, "SELECT k.id, k.title, k.rule_id, k.worker_state, k.closed_at, group_concat(s.thread_id) AS threads FROM tickets k LEFT JOIN subscriptions s ON s.ticket_id = k.id GROUP BY k.id ORDER BY k.rowid"),
		briefs: () => query(db, "SELECT ticket_id, kind, body FROM ticket_inputs WHERE kind = 'brief' ORDER BY rowid"),
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

async function fake(): Promise<void> {
	const model = await FakeModel.start({
		router: [on("到档开任务", /来源 stock-ta\/quotes/, (c: string) => [byWatchTask(c, "NVDA 跌到档")]), on("收盘不该到幕僚长", /来源 stock-ta\/scan/, () => [])],
		// The report waits so the band's ticket is still open when the close-of-day trigger comes.
		workers: [worker("NVDA 跌到档", on("汇报", /[\s\S]/, () => [report("ready", "这是技术分析，不是交易指令。")], 300_000))],
	});
	const h = await boot({ models: harness.fakeModels, fake: model, at: "15:50" });
	try {
		h.quote({ NVDA: 94.8, AMD: 99.5 }, { NVDA: 100, AMD: 100 }, "15:45");
		await h.at("15:51", "quotes");
		const ticket = await within(20_000, () => h.tickets().find((t) => t["rule_id"] === "stock-ta/watch-task"));
		const bandLines = h.phone().filter((m) => m.text.includes("到达 -5% 档"));
		h.ta.setPlan({ kind: "ok", bars: thursday(), signals: [signal("NVDA", 200, 94.8, 96.1), signal("AMD", 50, 97, 98.5)] });
		h.quote({}, {}, "15:45");
		await h.at("16:21", "scan");
		await within(15_000, () => h.triggers().some((t) => String(t["external_id"]).startsWith("R-MA-2-200")) && h.phone().some((m) => m.text.includes("收盘小结")));
		await sleep(1500);
		const triggers = h.triggers();
		const band = triggers.find((t) => String(t["external_id"]).startsWith("band:NVDA"));
		const ma200 = triggers.find((t) => String(t["external_id"]) === `R-MA-2-200:NVDA:${DAY}`);
		const body = String(ma200?.["body"] ?? "");
		record(1, "band-then-200", {
			pass: ticket !== undefined && bandLines.length === 1 && bandLines[0]!.silent && band?.["thread_id"] === THREAD && ma200?.["thread_id"] === THREAD && ma200?.["disposition"] === "delivered" && ma200?.["ticket_id"] === ticket["id"] && body.includes("放量确认（收盘成交量是 20 日均量的 2.4 倍）") && body.includes("做法 structure-trend") && String(ticket["threads"]).includes(THREAD),
			evidence: `host clock 15:51 ET ${DAY}: NVDA 94.80 (-5.2%) quoted at 15:45; at 16:21 ET the scan reports NVDA R-MA-2-200 bearish (close 94.80, 200-day 96.10) on 2,400,000 shares (20-day average 1,000,000)\nband lines on Telegram:\n${show(bandLines)}\ntickets with their threads:\n${show(h.tickets())}\ntriggers (source, id, disposition, thread, ticket, body):\n${show(triggers)}\nexpected: band trigger and 200-day trigger both on ${THREAD}; the 200-day one delivered into the band's open ticket, with 放量确认 and 做法 structure-trend`,
		});
		const amdLines = h.phone().filter((m) => m.text.includes("AMD 收盘跌破 50 日线") && !m.text.includes("收盘小结"));
		const amdTriggers = triggers.filter((t) => String(t["external_id"]).includes(":AMD:"));
		record(2, "ma50-silent", {
			pass: amdLines.length === 1 && amdLines[0]!.silent && amdTriggers.length === 0 && !h.tickets().some((t) => String(t["title"]).includes("AMD")),
			evidence: `AMD R-MA-2-50 bearish on a 1,000,000-share day\nAMD lines on Telegram (silent = disable_notification):\n${show(amdLines)}\nAMD triggers:\n${show(amdTriggers)}\nexpected: one silent line, no trigger, no ticket`,
		});
		const first = h.phone().filter((m) => m.text.includes(`收盘小结 11-12（美东）`));
		await h.at("16:31", "scan");
		await sleep(1500);
		const digests = h.phone().filter((m) => m.text.includes(`收盘小结 11-12（美东）`));
		record(3, "digest-once", {
			pass: first.length === 1 && first[0]!.silent && digests.length === 1 && /NVDA .*收盘跌破 200 日线.*已开任务/.test(first[0]!.text) && first[0]!.text.includes("AMD 收盘跌破 50 日线"),
			evidence: `digest after the 16:21 ET scan:\n${show(first)}\nall digest lines after another scan tick at 16:31 ET:\n${show(digests)}\nexpected: one silent 收盘小结 line naming NVDA's task and AMD's 50-day break, none more`,
		});
	} finally {
		writeFileSync(join(outDir, "p3-fake-host.log"), h.host.log().replaceAll(/\/tmp\/psa-p3-\w+/g, "<state>"));
		await h.stop();
		await model.close?.();
	}
}

async function real(): Promise<void> {
	const h = await boot({ models: REAL, at: "15:50" });
	try {
		h.ta.setPlan({ kind: "ok", bars: thursday(), signals: [signal("NVDA", 200, 94.8, 96.1)] });
		const saidAt = Date.now();
		await h.at("16:21", "scan");
		const ticket = await within(600_000, () => h.tickets().find((t) => String(t["threads"]).includes(THREAD)), 1000);
		const seconds = ((Date.now() - saidAt) / 1000).toFixed(0);
		const brief = h.briefs().find((b) => b["ticket_id"] === ticket?.["id"]);
		record(4, "real-200-day", {
			pass: ticket !== undefined && ticket["rule_id"] === "stock-ta/watch-task" && String(brief?.["body"] ?? "").includes("structure-trend"),
			evidence: `real models ${JSON.stringify(REAL)}\nat 16:21 ET the scan reports NVDA R-MA-2-200 bearish on a 2.4x volume day; ticket after ${seconds} s:\n${show(h.tickets())}\nbrief:\n${String(brief?.["body"] ?? "(none)")}\ntriggers:\n${show(h.triggers())}`,
		});
	} finally {
		writeFileSync(join(outDir, "p3-real-host.log"), h.host.log().replaceAll(/\/tmp\/psa-p3-\w+/g, "<state>"));
		await h.stop();
	}
}

try {
	if (mode === "fake") await fake();
	else if (mode === "real") await real();
	else throw new Error(`unknown mode ${mode}`);
} catch (error) {
	results.push(`FAIL  ${String((error as Error).stack ?? error)}`);
	console.log(results.at(-1));
} finally {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
}
writeFileSync(join(outDir, `p3-${mode}-summary.txt`), `${results.join("\n")}\n`);
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
