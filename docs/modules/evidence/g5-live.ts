/**
 *   G5_SECRETS=<host secrets .env> node --import ./src/pi-runtime.mjs docs/modules/evidence/g5-live.ts [lanes|real|market] [outDir]
 *
 * G5_SECRETS names a .env file the script reads TA_ROOT and the Massive key from (MASSIVE_API_KEY, or the
 * host's other names for it such as POLYGON_API_KEY); the environment wins over the file. Nothing prints a value.
 *
 * lanes   Lane 1 calls the structure tool from origin/main's package and this tree's. Lanes 2 to 7 and 11 run
 *         in-process hosts with a fake clock, a fake Router that opens a ticket on every request and on every
 *         candidate that has a rule, and a local server standing in for Massive. No real model, no network.
 * real    Lane 10b. A real host process on openai-codex models, stock-ta in fixture mode (the feed runs its
 *         fixture once, NVDA -5.2%), so the big-move ticket goes through the real Router and team at any hour.
 * market  Lanes 8, 9, 10a and perf. Real Massive quotes and real models; refuses to start outside 9:30 to
 *         16:20 New York on a weekday.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const PKG = join(HEAD, "docs/modules/examples/stock-ta");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const USER = 42;
const [mode = "lanes", outDir = "/tmp/swarm-g5/owner"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const { readSecret } = await import(join(HEAD, "src/secrets.ts"));
const { readMarketKey } = await import(join(HEAD, "src/sources/market/key.ts"));
const { inPollWindow } = await import(join(HEAD, "src/sources/market/session.ts"));
const { startLiveModules } = await import(join(HEAD, "src/host/live-modules.ts"));
const { Modules } = await import(join(HEAD, "src/modules.ts"));
const { openStore } = await import(join(HEAD, "src/kernel/store.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
const { runFeed } = await import(join(HEAD, "src/modules/feed-runner.ts"));
const { runModuleCodeAsync } = await import(join(HEAD, "src/modules/run-code.ts"));
const { createGateway } = await import(join(HEAD, "src/modules/gateway.ts"));
const { ModuleStore } = await import(join(HEAD, "src/modules/live.ts"));
const { moduleDataDir } = await import(join(HEAD, "src/modules/knowledge.ts"));
const { ids, servedAsHost, startHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
const { snapshotBody, tickerRow } = await import(join(HEAD, "tests/helpers/market.ts"));

const SECRETS = process.env["G5_SECRETS"];
const TA_ROOT = readSecret(["TA_ROOT"], "TA_ROOT", process.env, SECRETS)?.key ?? "";
const MINUTE = 60_000;
const MONDAY_10AM_NY = Date.parse("2026-11-09T15:00:00Z");

function just(state: string, args: string[], extra: Record<string, string> = {}, limitMs = 60_000) {
	const run = spawnSync("just", args, { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300", ...extra }, encoding: "utf8", timeout: limitMs });
	return { status: run.status, out: (run.stdout + run.stderr).trim() };
}

function query(path: string, sql: string): Record<string, unknown>[] {
	if (!existsSync(path)) return [];
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(sql).all().map((r) => ({ ...r }));
	} finally {
		db.close();
	}
}
const show = (rows: Record<string, unknown>[]) => rows.map((r) => JSON.stringify(r)).join("\n") || "(none)";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function within(limitMs: number, ok: () => boolean, stepMs = 50): Promise<number> {
	const started = performance.now();
	while (performance.now() - started < limitMs) {
		if (ok()) return Math.round(performance.now() - started);
		await sleep(stepMs);
	}
	return ok() ? Math.round(performance.now() - started) : -1;
}

const results: string[] = [];
type Verdict = { pass: boolean | "inconclusive"; evidence: string };
async function lane(n: number | string, slug: string, body: () => Promise<Verdict>): Promise<void> {
	let verdict: Verdict;
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const word = verdict.pass === "inconclusive" ? "INCONCLUSIVE" : verdict.pass ? "PASS" : "FAIL";
	const file = join(outDir, `g5-${slug}.txt`);
	const evidence = TA_ROOT === "" ? verdict.evidence : verdict.evidence.replaceAll(TA_ROOT, "<TA_ROOT>");
	writeFileSync(file, `${word} lane ${n}\n${evidence}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

function copyPackage(state: string, baseUrl?: string): string {
	const dir = join(state, "modules", "stock-ta");
	cpSync(PKG, dir, { recursive: true });
	if (baseUrl !== undefined) {
		const feedJson = join(dir, "feeds", "quotes", "feed.json");
		writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), settings: { baseUrl } }));
	}
	return dir;
}

async function fakeMassive() {
	const state = { prices: {} as Record<string, number>, prevClose: {} as Record<string, number>, at: 0, urls: [] as string[] };
	const server = createServer((req, res) => {
		state.urls.push(req.url ?? "");
		if (req.headers.authorization === undefined) return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ status: "ERROR" }));
		const asked = new URL(req.url ?? "", "http://x").searchParams.get("tickers")?.split(",") ?? [];
		const rows = asked.filter((s) => s in state.prices).map((s) => tickerRow(s, state.prices[s], state.prevClose[s], state.at));
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(snapshotBody(rows)));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	return { state, url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) };
}

function routerOpensTickets(cards: string[]) {
	return cards.flatMap((card) => {
		const triggerId = ids(card, "trg");
		if (card.startsWith("[对话]")) {
			const title = card.split("使用者：")[1]?.split("\n")[0] ?? "任务";
			return [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId, title, brief: title, domain: "stock-ta" }] } }];
		}
		if (!card.startsWith("[候选触发]")) return [];
		const ruleId = /适用规则：(stock-ta\/[\w-]+)/.exec(card)?.[1];
		const thread = /线程 (\S+?)(?: ·|,|$)/m.exec(card)?.[1];
		if (ruleId === undefined) return [];
		return [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "rule", ruleId, triggerId, title: `看 ${card.match(/自选股 (\S+)/)?.[1] ?? ""} 的大涨跌`, brief: "按规则看", domain: "stock-ta", threads: thread ? [thread] : [] }] } }];
	});
}

type FakeWorker = { inputs: string[]; request(method: string, params: unknown): Promise<unknown>; report(r: object): void; settle(): void };
async function script(worker: FakeWorker, input: string) {
	if (input.includes("把 AAPL 加进自选股")) await worker.request("worker.data", { op: "write", collection: "watchlist", rows: [{ symbol: "AAPL" }], from: "使用者口述" });
	if (input.includes("NVDA 跌破 171 提醒我")) await worker.request("worker.watch", { op: "set", collection: "quotes", key: "NVDA", condition: { when: "below", value: 171 } });
	worker.report({ status: "ready", summary: "看过了" });
	worker.settle();
}

async function feedHost(o: { fixtures: boolean; baseUrl?: string; secret: (name: string) => string | undefined }) {
	const state = mkdtempSync(join(tmpdir(), "psa-g5-"));
	copyPackage(state, o.baseUrl);
	const on = just(state, ["module", "on", "stock-ta"]);
	if (on.status !== 0) throw new Error(on.out);
	const logs: string[] = [];
	const log = (line: string) => void logs.push(line);
	const modulesDir = join(state, "modules");
	const live = startLiveModules({ db: openStore(join(state, "state.db")), stateDir: state, roots: [modulesDir], discovered: Modules.load([modulesDir]), configSwitches: {}, log });
	const clock = { now: MONDAY_10AM_NY };
	const current = () => live.live.current();
	const serving = await within(20_000, () => {
		live.tick();
		return current().feeds().some((f: { source: string }) => f.source === "stock-ta/quotes");
	}, 200);
	if (serving < 0) throw new Error(`stock-ta did not start serving:\n${logs.join("\n")}`);
	const { host } = await startHost(routerOpensTickets, script, {
		stateDir: state,
		log,
		clock: { now: () => clock.now },
		sourcePolicy: (t: never) => current().sourcePolicy(t),
		domains: { book: () => current().book, kitFor: (d: string) => current().kitFor(d) },
		ruleAllows: (id: string, source: string) => current().ruleAllows(id, source),
		rulesFor: (source: string) => current().rulesFor(source),
		moduleFeeds: { feeds: () => current().feeds(), fixtures: o.fixtures, tickMs: 3_600_000, secret: o.secret },
		gateway: createGateway({
			copyDir: (module: string, digest: string) => new ModuleStore(join(state, "module-store")).dirOf(module, digest),
			serving: (module: string) => current().book.get(module)?.digest,
			dataDir: (module: string) => moduleDataDir(state, module),
			rows: instanceData(state),
			secret: o.secret,
			log,
		}),
	});
	const db = join(state, "state.db");
	const dataDb = join(state, "modules-data", "stock-ta", "data.db");
	return {
		state, host, clock, logs, live,
		entry: () => current().feeds().find((f: { source: string }) => f.source === "stock-ta/quotes"),
		async round(ms = clock.now + MINUTE) {
			clock.now = ms;
			await host.feedScheduler.tick();
			await host.settled();
		},
		say: async (text: string) => {
			host.say(text);
			await within(10_000, () => query(db, `SELECT 1 FROM tickets WHERE title = '${text}' AND worker_state = 'idle'`).length > 0 || query(db, `SELECT 1 FROM reports r JOIN tickets t ON t.id = r.ticket_id WHERE t.title = '${text}'`).length > 0);
			await host.settled();
		},
		quotes: () => query(dataDb, "SELECT symbol, price, changePct, at, _from FROM quotes ORDER BY _id"),
		triggers: () => query(db, "SELECT external_id, body, disposition FROM triggers WHERE source = 'stock-ta/quotes' ORDER BY rowid"),
		tickets: () => query(db, "SELECT id, title, basis, rule_id, domain FROM tickets ORDER BY rowid"),
		alerts: () => query(db, "SELECT external_id, text FROM host_lines WHERE kind = 'alert' AND source = 'module:stock-ta' ORDER BY rowid"),
		conditions: () => query(dataDb, "SELECT key, kind, params FROM _conditions"),
		async stop() {
			await host.stop();
			live.stop();
			writeFileSync(join(outDir, `g5-host-${o.fixtures ? "fixtures" : "network"}.log`), logs.join("\n"));
			rmSync(state, { recursive: true, force: true });
		},
	};
}

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		if (TA_ROOT === "") return { pass: "inconclusive", evidence: "TA_ROOT is not set in the environment or in G5_SECRETS" };
		const trunk = mkdtempSync(join(tmpdir(), "psa-g5-trunk-"));
		const archive = spawnSync("sh", ["-c", `git archive origin/main docs/modules/examples/stock-ta | tar -x -C '${trunk}'`], { cwd: HEAD, encoding: "utf8" });
		if (archive.status !== 0) throw new Error(archive.stderr);
		const call = (pkg: string) => runModuleCodeAsync(join(pkg, "tools", "structure"), "index.ts", { symbol: "NVDA" }, { TA_ROOT });
		const before = await call(join(trunk, "docs/modules/examples/stock-ta"));
		const after = await call(PKG);
		rmSync(trunk, { recursive: true, force: true });
		const same = JSON.stringify(before) === JSON.stringify(after);
		return { pass: before.ok && same, evidence: `structure {"symbol":"NVDA"} from origin/main's package and from this tree's, same TA_ROOT\nsame reply: ${same}\ntrunk: ${JSON.stringify(before).slice(0, 500)}\nhead:  ${JSON.stringify(after).slice(0, 500)}` };
	});

	await lane(2, "check", async () => {
		const state = mkdtempSync(join(tmpdir(), "psa-g5-"));
		const ok = just(state, ["module", "check", PKG], { MASSIVE_API_KEY: "" });
		const broken = copyPackage(state);
		const fixture = join(broken, "feeds", "quotes", "fixtures", "nvda-down-5.json");
		writeFileSync(fixture, JSON.stringify({ ...JSON.parse(readFileSync(fixture, "utf8")), responses: {} }));
		const bad = just(state, ["module", "check", broken], { MASSIVE_API_KEY: "" });
		rmSync(state, { recursive: true, force: true });
		return {
			pass: ok.status === 0 && /^ok stock-ta@0\.1\.0 .*feeds=1/m.test(ok.out) && bad.status !== 0 && bad.out.includes("tickers?tickers=AMD,NVDA"),
			evidence: `just module check docs/modules/examples/stock-ta, MASSIVE_API_KEY empty: exit ${ok.status}\n${ok.out}\nsame package with the fixture's responses emptied, so the handler's request has no answer: exit ${bad.status}\n${bad.out}`,
		};
	});

	const rehearsal = await feedHost({ fixtures: true, secret: () => undefined });
	try {
		await lane(3, "fixture", async () => {
			await rehearsal.round(MONDAY_10AM_NY);
			const quotes = rehearsal.quotes();
			const symbols = quotes.map((q) => q.symbol).sort();
			return { pass: JSON.stringify(symbols) === '["AMD","NVDA"]' && quotes.every((q) => q._from === "stock-ta/quotes"), evidence: `fixture mode (just module try's path), feeds/quotes/fixtures/nvda-down-5.json, no key\nquotes:\n${show(quotes)}\nlog:\n${rehearsal.logs.filter((l) => l.includes("[feeds]")).join("\n")}` };
		});

		await lane(4, "dedupe", async () => {
			const entry = rehearsal.entry();
			const ports = { data: instanceData(rehearsal.state), submit: () => {}, alert: () => {}, secret: () => undefined, now: () => rehearsal.clock.now };
			const again = await runFeed(entry, [], ports, entry.fixtures[0]);
			const quotes = rehearsal.quotes();
			return { pass: again.ok && quotes.length === 2, evidence: `the same fixture once more, same data time\nrun: ${JSON.stringify(again)}\nquotes still:\n${show(quotes)}` };
		});
	} finally {
		await rehearsal.stop();
	}

	const massive = await fakeMassive();
	const key = { on: true };
	const net = await feedHost({ fixtures: false, baseUrl: massive.url, secret: (name) => (name === "MASSIVE_API_KEY" && key.on ? "sk-fake" : undefined) });
	const market = (prices: Record<string, number>) => {
		Object.assign(massive.state.prices, prices);
		massive.state.at = net.clock.now + MINUTE - 15 * MINUTE;
	};
	try {
		const entry = net.entry();
		instanceData(net.state).write("stock-ta", entry.components, "watchlist", [{ symbol: "NVDA" }, { symbol: "AMD" }], "使用者口述", "g5-live");
		Object.assign(massive.state.prevClose, { NVDA: 176, AMD: 150, AAPL: 229 });
		market({ NVDA: 180.4, AMD: 151.5, AAPL: 230 });
		await net.round(MONDAY_10AM_NY);

		await lane(5, "watchlist", async () => {
			await net.say("把 AAPL 加进自选股");
			market({});
			await net.round();
			const latest = massive.state.urls.at(-1) ?? "";
			const aapl = net.quotes().filter((q) => q.symbol === "AAPL");
			return { pass: latest.includes("AAPL") && aapl.length === 1, evidence: `the user said 把 AAPL 加进自选股; the fake Worker wrote it through worker.data\nwatchlist: ${show(query(join(net.state, "modules-data/stock-ta/data.db"), "SELECT symbol, removedAt, _from FROM watchlist"))}\nsnapshot requests:\n${massive.state.urls.join("\n")}\nAAPL quotes:\n${show(aapl)}` };
		});

		await lane(6, "alert", async () => {
			await net.say("NVDA 跌破 171 提醒我");
			const conditions = net.conditions();
			market({ NVDA: 170 });
			await net.round();
			const alerts = net.alerts();
			const text = String(alerts[0]?.text ?? "");
			const at = String(net.quotes().findLast((q) => q.symbol === "NVDA")?.at);
			return { pass: conditions.length === 1 && alerts.length === 1 && text.includes("NVDA 170") && text.includes(at), evidence: `the user said NVDA 跌破 171 提醒我 (request ticket, worker.watch set); NVDA was 180.4, the next round brings 170\nconditions: ${show(conditions)}\nthe 170 row's data time: ${at}\nalerts:\n${show(alerts)}` };
		});

		await lane(7, "nokey", async () => {
			key.on = false;
			const rows = net.quotes().length;
			market({});
			await net.round();
			const note = net.logs.filter((l) => l.includes("stock-ta/quotes") && l.includes("MASSIVE_API_KEY"));
			const alive = Array.isArray(net.host.kernel.listTickets()) && net.host.snapshot() !== undefined;
			key.on = true;
			market({});
			await net.round();
			return { pass: note.length === 1 && alive && net.quotes().length > rows, evidence: `the host's secrets have no MASSIVE_API_KEY for one round\nlog: ${note.join("\n")}\nhost still answers snapshot(): ${alive}\nwith the key back the next round stored again: ${rows} -> ${net.quotes().length} rows` };
		});

		await lane(11, "big-move", async () => {
			const before = { triggers: net.triggers().length, tickets: net.tickets().length };
			market({ NVDA: 166.84 });
			await net.round();
			const first = { triggers: net.triggers(), tickets: net.tickets() };
			market({ NVDA: 166 });
			await net.round();
			const second = { triggers: net.triggers(), tickets: net.tickets() };
			market({ NVDA: 184.8 });
			await net.round();
			const third = { triggers: net.triggers(), tickets: net.tickets() };
			const ruled = third.tickets.filter((t) => t.rule_id === "stock-ta/big-move");
			const book = net.live.live.current().book.get("stock-ta");
			return {
				pass: before.triggers === 0 && first.triggers.length === 1 && String(first.triggers[0]!.external_id) === "big-move:NVDA:2026-11-09:down" && second.triggers.length === 1 && second.tickets.length === first.tickets.length && third.triggers.length === 2 && String(third.triggers[1]!.external_id) === "big-move:NVDA:2026-11-09:up" && ruled.length === 2 && ruled.every((t) => t.domain === "stock-ta") && book?.team === "技术分析研究组",
				evidence: `NVDA prevClose 176: 166.84 (-5.20%), then 166 (-5.68%) the same day, then 184.8 (+5.00%)\nafter -5.20%:\ntriggers:\n${show(first.triggers)}\ntickets:\n${show(first.tickets)}\nafter -5.68%: ${second.triggers.length} trigger(s), ${second.tickets.length} ticket(s)\nafter +5.00%:\ntriggers:\n${show(third.triggers)}\ntickets:\n${show(third.tickets)}\nstock-ta's team: ${book?.team}`,
			};
		});
	} finally {
		await net.stop();
		await massive.close();
	}
	console.log(`\n${results.join("\n")}`);
}

type Host = { stop(): Promise<void> };

async function realHost(state: string, config: Record<string, unknown>, env: Record<string, string>, imports: string[] = []): Promise<Host> {
	const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
	const host = await harness.startHost({ models: REAL, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0, ...config }, env: { TA_ROOT, ...env }, timeoutMs: 60_000, imports });
	just(state, ["module", "on", "stock-ta"]);
	const on = await within(30_000, () => {
		const [row] = query(join(state, "state.db"), "SELECT record FROM module_records WHERE name = 'stock-ta'");
		return row?.record !== undefined && JSON.parse(String(row.record)).state.at === "active";
	}, 500);
	if (on < 0) throw new Error("stock-ta did not turn on in the real host");
	return host;
}

type Report = { status: string; summary: string };
const finalReport = (state: string, where: string) => query(join(state, "state.db"), `SELECT r.status, r.summary FROM reports r JOIN tickets t ON t.id = r.ticket_id WHERE ${where} AND r.status <> 'progress' ORDER BY r.rowid DESC`).at(0) as Report | undefined;

async function real(): Promise<void> {
	await lane("10b", "real-big-move", async () => {
		if (TA_ROOT === "") return { pass: "inconclusive", evidence: "TA_ROOT is not set in the environment or in G5_SECRETS" };
		const state = mkdtempSync(join(tmpdir(), "psa-g5-real-"));
		copyPackage(state);
		const host = await realHost(state, { feedFixtures: true }, {});
		try {
			const report = await within(900_000, () => finalReport(state, "t.rule_id = 'stock-ta/big-move'") !== undefined, 2_000);
			const found = finalReport(state, "t.rule_id = 'stock-ta/big-move'");
			const ticket = query(join(state, "state.db"), "SELECT id, title, basis, rule_id, domain, dispatched_to FROM tickets WHERE rule_id = 'stock-ta/big-move'").at(0);
			const experts: string[] = JSON.parse(String(ticket?.dispatched_to ?? "[]"));
			const text = found?.summary ?? "";
			const checks = {
				"结构与形态 and 趋势与动量 dispatched": ["结构与形态", "趋势与动量"].every((e) => experts.includes(e)),
				"data time": /10:44|15:44|2026-11-12/.test(text),
				"15 minute delay": /延迟/.test(text),
				"not a trade instruction": /不是交易指令/.test(text),
			};
			const gateway = readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[gateway]") || l.includes("[feeds]"));
			return {
				pass: report >= 0 && ticket?.domain === "stock-ta" && Object.values(checks).every(Boolean),
				evidence: `models ${JSON.stringify(REAL)}; stock-ta in fixture mode, fixture nvda-down-5 (NVDA 166.84 vs 176, data time 2026-11-12 10:44 New York)\ntriggers: ${show(query(join(state, "state.db"), "SELECT external_id, body FROM triggers WHERE source = 'stock-ta/quotes'"))}\nticket: ${JSON.stringify(ticket)}\nchecks: ${JSON.stringify(checks)}\nhost log:\n${gateway.join("\n")}\nreport (${found?.status}):\n${text}`,
			};
		} finally {
			await host.stop();
		}
	});
	console.log(`\n${results.join("\n")}`);
}

async function marketLanes(): Promise<void> {
	if (!inPollWindow(Date.now())) throw new Error("the market lanes call Massive and need US trading hours (9:30 to 16:20 New York, weekdays); nothing was called");
	const massiveKey = readMarketKey(process.env, SECRETS)?.key;
	if (massiveKey === undefined || TA_ROOT === "") throw new Error("set G5_SECRETS to a .env holding TA_ROOT and MASSIVE_API_KEY (or POLYGON_API_KEY)");
	const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
	const state = mkdtempSync(join(tmpdir(), "psa-g5-market-"));
	copyPackage(state);
	const entry = servedAsHost(Modules.load([join(state, "modules")])).feeds()[0];
	const { components } = entry;
	const data = instanceData(state);
	data.write("stock-ta", components, "watchlist", ["NVDA", "AAPL", "AMD"].map((symbol) => ({ symbol })), "使用者口述", "g5-live");
	data.watch("stock-ta", components, { kind: "watch", collection: "quotes", op: "set", watch: { key: "NVDA", condition: { when: "above", value: 0.01 } } }, "g5-live");
	writeFileSync(join(state, "secrets.env"), `MASSIVE_API_KEY=${massiveKey}\nTELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`, { mode: 0o600 });
	const tg = await FakeTelegram.start();
	const phone = () => tg.sent.filter((m: { chatId: number }) => m.chatId === USER).map((m: { text: string }) => m.text);
	const host = await realHost(state, { secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } }, { PSA_E2E_TELEGRAM_URL: tg.url }, ["./tests/e2e/telegram-preload.mjs"]);
	const rounds = () => readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[feeds] stock-ta/quotes"));
	const quotes = () => query(join(state, "modules-data/stock-ta/data.db"), "SELECT symbol, price, changePct, volume, at FROM quotes ORDER BY _id");
	try {
		tg.userSays(USER, "/start");
		await lane(8, "real-quotes", async () => {
			await within(200_000, () => rounds().length >= 2, 1_000);
			const now = Date.now();
			const rows = quotes();
			const lags = rows.map((r) => Math.round((now - Date.parse(String(r.at))) / MINUTE));
			const symbols = new Set(rows.map((r) => r.symbol));
			return { pass: rounds().length >= 2 && ["NVDA", "AAPL", "AMD"].every((s) => symbols.has(s)) && lags.every((m) => m >= 10 && m <= 30), evidence: `now ${new Date(now).toISOString()}\nfeed rounds:\n${rounds().join("\n")}\nquotes:\n${show(rows)}\nminutes behind now: ${lags.join(", ")}` };
		});

		await lane(9, "real-alert", async () => {
			const alerts = () => query(join(state, "state.db"), "SELECT external_id, text FROM host_lines WHERE kind = 'alert' AND source = 'module:stock-ta'");
			await within(30_000, () => alerts().length > 0 && phone().some((m: string) => m.includes("NVDA")), 500);
			return { pass: alerts().length > 0 && phone().some((m: string) => m.includes("NVDA")), evidence: `condition NVDA above 0.01 on quotes, set before the first round\nhost_lines alerts:\n${show(alerts())}\nTelegram recorder:\n${phone().join("\n")}` };
		});

		await lane("10a", "real-ask", async () => {
			const asked = "NVDA 现在多少，离 170 还有多远";
			just(state, ["say", asked]);
			await within(600_000, () => finalReport(state, "t.domain = 'stock-ta' AND t.basis = 'request'") !== undefined, 2_000);
			const found = finalReport(state, "t.domain = 'stock-ta' AND t.basis = 'request'");
			const text = found?.summary ?? "";
			const read = readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[gateway]") && l.includes("quotes"));
			return { pass: read.length > 0 && /延迟/.test(text) && /\d{1,2}:\d{2}/.test(text), evidence: `models ${JSON.stringify(REAL)}\nasked: ${asked}\ngateway reads of quotes:\n${read.join("\n")}\nreport (${found?.status}):\n${text}` };
		});
	} finally {
		await host.stop();
		await tg.close?.();
	}

	const ports = { data, submit: () => {}, alert: () => {}, secret: () => massiveKey, now: () => Date.now() };
	const url = `https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers?tickers=AAPL,AMD,NVDA`;
	const api: number[] = [];
	const total: number[] = [];
	for (let i = 0; i < 10; i++) {
		let started = performance.now();
		const reply = await fetch(url, { headers: { Authorization: `Bearer ${massiveKey}` } });
		await reply.json();
		api.push(performance.now() - started);
		await sleep(1_000);
		started = performance.now();
		const run = await runFeed(entry, [], ports);
		if (!run.ok) throw new Error(run.note);
		total.push(performance.now() - started);
		await sleep(1_000);
	}
	const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
	const line = (name: string, xs: number[]) => `${name}: median ${median(xs).toFixed(0)} ms, runs ${xs.map((t) => t.toFixed(0)).join(" ")}, spread ${(Math.max(...xs) - Math.min(...xs)).toFixed(0)} ms`;
	const extra = median(total) - median(api);
	const report = [
		`${extra <= 300 && Math.max(...total) <= 10_000 ? "PASS" : "FAIL"} perf: one quotes round (process, one snapshot request, store, conditions) vs the bare snapshot request, alternating 10 each (rule: over 300 ms more, or any round over 10 s, fails). The round is ${extra.toFixed(0)} ms more.`,
		line("  bare snapshot request (baseline)", api),
		line("  runFeed round", total),
	].join("\n");
	writeFileSync(join(outDir, "g5-perf.txt"), `${report}\n`);
	console.log(report);
	rmSync(state, { recursive: true, force: true });
	console.log(`\n${results.join("\n")}`);
}

await (mode === "market" ? marketLanes() : mode === "real" ? real() : lanes());
