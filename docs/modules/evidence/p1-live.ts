/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/p1-live.ts [fake|real] [outDir]
 *
 * A real temp host with the repo's fake Massive and fake Bot API (pattern of proactive-live.ts); the host clock comes from
 * proactive-clock-preload.mjs, so the market is open at any real hour.
 * fake  Lane 1: NVDA +5.31% arrives silent on Telegram and opens one task by watch-task; +8.10% rings and joins that task.
 *       Lane 2: a rule-levels row (TSLA first band 7%) takes effect on the next beat, no restart.
 * real  Lane 3 on openai-codex models through the Pi login: the user says on Telegram 「把 TSLA 的第一档改成 7%」; the Worker
 *       writes the rule-levels row and the next beat uses 7%.
 * P1_LANES=1,3 runs only those lanes.
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
const [mode = "fake", outDir = "/tmp/swarm-p1/live"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, fakeAgentEnv, on, openTicket, report, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const { Modules } = await import(join(HEAD, "src/modules.ts"));
const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
type Row = Record<string, unknown>;
type Sent = { chatId: number; text: string; silent: boolean };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const show = (rows: unknown[]) => rows.map((r) => `  ${typeof r === "string" ? r : JSON.stringify(r)}`).join("\n") || "  (none)";
const ny = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00-05:00`);
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
const only = process.env["P1_LANES"]?.split(",");
async function lane(n: number, slug: string, body: () => Promise<Verdict>): Promise<void> {
	if (only && !only.includes(String(n))) return;
	let verdict: Verdict;
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const file = join(outDir, `p1-${slug}.txt`);
	writeFileSync(file, `${verdict.pass ? "PASS" : "FAIL"} lane ${n}\n${verdict.evidence.replaceAll(/\/tmp\/psa-p1-\w+/g, "<state>")}\n`);
	results.push(`${verdict.pass ? "PASS" : "FAIL"}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

async function fakeMassive() {
	const market = { prices: {} as Record<string, number>, prevClose: {} as Record<string, number>, at: 0 };
	const server = createServer((req, res) => {
		const asked = new URL(req.url ?? "", "http://x").searchParams.get("tickers")?.split(",") ?? [];
		const tickers = asked.filter((s) => s in market.prices).map((s) => ({ ticker: s, lastTrade: { p: market.prices[s], t: market.at * 1e6 }, min: { c: market.prices[s], t: market.at, v: 1000 }, day: { c: market.prices[s], v: 5e6 }, prevDay: { c: market.prevClose[s], v: 3.9e7 } }));
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "DELAYED", tickers }));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return { market, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((done) => server.close(done)) };
}

async function boot(o: { models: unknown; fake?: { close?: () => unknown }; watch: string[] }) {
	const state = mkdtempSync("/tmp/psa-p1-");
	made.push(state);
	const massive = await fakeMassive();
	const pkg = join(state, "modules", "stock-ta");
	cpSync(join(HEAD, "docs/modules/examples/stock-ta"), pkg, { recursive: true });
	const feedJson = join(pkg, "feeds/quotes/feed.json");
	const json = JSON.parse(readFileSync(feedJson, "utf8"));
	writeFileSync(feedJson, JSON.stringify({ ...json, settings: { ...json.settings, baseUrl: massive.base } }, null, 2));
	const entry = servedAsHost(Modules.load([join(state, "modules")])).feeds().find((e: { source: string }) => e.source === "stock-ta/quotes");
	const data = instanceData(state);
	data.write("stock-ta", entry.components, "watchlist", o.watch.map((symbol) => ({ symbol })), "使用者口述", "p1-live");
	const tg = await FakeTelegram.start();
	writeFileSync(join(state, "secrets.env"), `POLYGON_API_KEY=fake-key\nTELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`, { mode: 0o600 });
	const host = await harness.startHost({
		models: o.models, stateDir: state, logFile: join(state, "host.log"), timeoutMs: 60_000,
		config: { webPort: 0, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } },
		env: { ...(o.fake ? fakeAgentEnv(o.fake, join(state, "pi")) : {}), PSA_E2E_TELEGRAM_URL: tg.url, PSA_PROACTIVE_NOW: new Date(ny("10:00")).toISOString(), PSA_PROACTIVE_STEP_MS: "60000" },
		imports: ["./tests/e2e/telegram-preload.mjs", "./docs/modules/evidence/proactive-clock-preload.mjs"],
	});
	const db = join(state, "state.db");
	const beats = () => (host.log().match(/\[feeds\] stock-ta\/quotes/g) ?? []).length;
	tg.userSays(USER, "/start");
	await within(10_000, () => tg.sent.length > 0);
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
		quote(prices: Record<string, number>, hhmm: string) {
			Object.assign(this.massive.market, { prices: { SPY: 501, QQQ: 401, ...prices }, prevClose: { NVDA: 100, TSLA: 100, AMD: 100, SPY: 500, QQQ: 400 }, at: ny(hhmm) });
		},
		alerts: () => query(db, "SELECT external_id, push, text FROM host_lines WHERE kind = 'alert' ORDER BY rowid"),
		triggers: () => query(db, "SELECT t.external_id, t.disposition, t.body, i.ticket_id FROM triggers t LEFT JOIN ticket_inputs i ON i.trigger_id = t.id WHERE t.source = 'stock-ta/quotes' ORDER BY t.rowid"),
		tickets: () => query(db, "SELECT id, title, basis, rule_id, domain, worker_state FROM tickets ORDER BY rowid"),
		levels: () => query(join(state, "modules-data/stock-ta/data.db"), `SELECT "_id", "rule", "symbol", "level", "threshold", "note", "removedAt" FROM "rule-levels" ORDER BY "_id"`),
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
const bandLines = (sent: Sent[]) => sent.filter((m) => m.text.includes("档。"));

async function fake(): Promise<void> {
	await lane(1, "silent-then-ring", async () => {
		const model = await FakeModel.start({
			router: [on("到档开任务", /来源 stock-ta\/quotes/, (c: string) => [byWatchTask(c, "NVDA 到档")])],
			workers: [worker("NVDA 到档", on("汇报", /[\s\S]/, () => [report("ready", "盘面：个股行情。这是技术分析，不是交易指令。")], 20_000))],
		});
		const h = await boot({ models: harness.fakeModels, fake: model, watch: ["NVDA"] });
		try {
			h.quote({ NVDA: 105.31 }, "09:50");
			await h.beat();
			const ticket = await within(20_000, () => h.tickets().find((t) => t["rule_id"] === "stock-ta/watch-task"));
			h.quote({ NVDA: 108.1 }, "09:51");
			await h.beat();
			await within(10_000, () => bandLines(h.phone()).length >= 2);
			await within(10_000, () => h.triggers().every((t) => t["ticket_id"] !== null));
			const lines = bandLines(h.phone());
			const triggers = h.triggers();
			const tickets = h.tickets().filter((t) => t["domain"] === "stock-ta");
			const pass =
				lines.length === 2 && lines[0]!.text.includes("+5%") && lines[0]!.silent === true && lines[1]!.text.includes("+8%") && lines[1]!.silent === false &&
				triggers.length === 2 && String(triggers[0]!["body"]).endsWith("（规则 move-1，层级 5，做法 band-move）") && String(triggers[1]!["body"]).endsWith("（规则 move-2，层级 5，做法 band-move）") &&
				tickets.length === 1 && ticket !== undefined && triggers.every((t) => t["ticket_id"] === ticket["id"]);
			return { pass, evidence: `host on the fake model, host clock 10:00 ET ${DAY}; fake Massive NVDA prev close 100\nbeat 1: NVDA 105.31 (09:50 ET), beat 2: NVDA 108.10 (09:51 ET)\nTelegram band lines (silent = disable_notification):\n${show(lines)}\nhost_lines alerts:\n${show(h.alerts())}\ntriggers with the ticket each went to:\n${show(triggers)}\ntickets:\n${show(h.tickets())}\nexpected: 5% silent, 8% ringing, both triggers in the one watch-task ticket` };
		} finally {
			await h.stop();
		}
	});

	await lane(2, "rule-levels-row", async () => {
		const model = await FakeModel.start({ router: [on("到档开任务", /来源 stock-ta\/quotes/, (c: string) => [byWatchTask(c, "到档")])], workers: [worker("到档", on("汇报", /[\s\S]/, () => [report("ready", "这是技术分析，不是交易指令。")]))] });
		const h = await boot({ models: harness.fakeModels, fake: model, watch: ["TSLA"] });
		try {
			h.data.write("stock-ta", h.entry.components, "rule-levels", [{ rule: "move-1", symbol: "TSLA", threshold: 7, note: "TSLA 的第一档改成 7%" }], "使用者口述", "p1-live");
			h.quote({ TSLA: 105.5 }, "09:50");
			await h.beat();
			const at55 = h.alerts().length;
			h.quote({ TSLA: 107.1 }, "09:51");
			await h.beat();
			await within(10_000, () => bandLines(h.phone()).length >= 1);
			const alerts = h.alerts();
			const pass = at55 === 0 && alerts.length === 1 && alerts[0]!["external_id"] === `band:TSLA:${DAY}:up7` && alerts[0]!["push"] === "silent" && bandLines(h.phone())[0]?.silent === true;
			return { pass, evidence: `rule-levels row written while the host runs (as the Worker would):\n${show(h.levels())}\nTSLA +5.5%: ${at55} alert lines\nTSLA +7.1%:\n${show(alerts)}\nTelegram:\n${show(bandLines(h.phone()))}` };
		} finally {
			await h.stop();
		}
	});
}

async function real(): Promise<void> {
	await lane(3, "real-chat-edit", async () => {
		const h = await boot({ models: REAL, watch: ["TSLA"] });
		try {
			const saidAt = Date.now();
			h.tg.userSays(USER, "把 stock-ta 里 TSLA 的第一档改成 7%");
			const row = await within(600_000, () => h.levels().find((r) => r["rule"] === "move-1" && String(r["symbol"]).toUpperCase() === "TSLA" && r["threshold"] === 7), 1000);
			const rowSeconds = ((Date.now() - saidAt) / 1000).toFixed(0);
			await within(300_000, () => h.phone().some((m) => m.text.includes("7")), 1000);
			h.quote({ TSLA: 105.5 }, "10:20");
			await h.beat();
			const at55 = h.alerts().length;
			h.quote({ TSLA: 107.1 }, "10:21");
			await h.beat();
			await sleep(1500);
			const alerts = h.alerts();
			const pass = row !== undefined && at55 === 0 && alerts.some((a) => a["external_id"] === `band:TSLA:${DAY}:up7` && a["push"] === "silent");
			return { pass, evidence: `real models ${JSON.stringify(REAL)}; the user said on Telegram 「把 stock-ta 里 TSLA 的第一档改成 7%」\nrule-levels rows after ${rowSeconds} s:\n${show(h.levels())}\ntickets:\n${show(h.tickets())}\nthen TSLA +5.5%: ${at55} alert lines; TSLA +7.1%:\n${show(alerts)}\nTelegram:\n${show(h.phone())}` };
		} finally {
			writeFileSync(join(outDir, "p1-real-host.log"), h.host.log().replaceAll(/\/tmp\/psa-p1-\w+/g, "<state>"));
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
writeFileSync(join(outDir, `p1-${mode}-summary.txt`), `${results.join("\n")}\n`);
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
