/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/s2-live.ts [lanes|perf] [outDir] [lane numbers...]
 *
 * Every lane runs in its own throwaway state dir and hosts on the fake model from tests/e2e/fake-model.ts.
 * Lanes 3 to 9 use the fake `ta` from tests/helpers/fake-ta.ts. Lane 1 needs TA_PROJECT (the technical-analysis
 * checkout, only read: its app/trading is linked and its app/data/ta.sqlite cloned) and a worktree of S2_TRUNK
 * (default origin/main) at <outDir>/trunk. Lanes 2 and 10 and perf run the real `uv`, the real `ta` and,
 * for 10 and perf, real Massive with POLYGON_API_KEY from the secrets file of PSA_KEY_STATE (default ~/.pi-super-agent,
 * only read). Massive requests go through a local forwarder that counts them.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const PKG = join(HEAD, "docs/modules/examples/stock-ta");
const TRUNK_REF = process.env["S2_TRUNK"] ?? "origin/main";
const [mode = "lanes", outDir = "/tmp/swarm-s2/owner", ...only] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
mkdirSync(outDir, { recursive: true });

const { fakeModels } = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, domainTool, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { fakeTa } = await import(join(HEAD, "tests/helpers/fake-ta.ts"));
const { Modules } = await import(join(HEAD, "src/modules.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
const { lockOf, venvDir } = await import(join(HEAD, "src/modules/files.ts"));
const { secretLookup } = await import(join(HEAD, "src/secrets.ts"));
const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
type Fake = InstanceType<typeof FakeModel>;
type Host = Awaited<ReturnType<(typeof import("../../tests/e2e/harness.ts"))["startHost"]>>;
type Plan = import("../../tests/helpers/fake-ta.ts").ScanPlan;
type Call = { name: string; args: Record<string, unknown> };
type Exchange = import("../../tests/e2e/fake-model.ts").Exchange;

const sha = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");
const fileSha = (path: string) => (existsSync(path) ? sha(readFileSync(path)) : "(absent)");
const stateDir = () => mkdtempSync(join(tmpdir(), "psa-s2-"));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function within(limitMs: number, ok: () => boolean): Promise<number> {
	const started = performance.now();
	while (performance.now() - started < limitMs) {
		if (ok()) return Math.round(performance.now() - started);
		await sleep(50);
	}
	return ok() ? Math.round(performance.now() - started) : -1;
}

function just(state: string, args: string[], { cwd = HEAD, env = {} as Record<string, string> } = {}) {
	const started = performance.now();
	const run = spawnSync("just", args, { cwd, env: { ...process.env, PSA_STATE_DIR: state, ...env }, encoding: "utf8", timeout: 600_000 });
	return { status: run.status, ms: Math.round(performance.now() - started), out: (run.stdout + run.stderr).split("\n").filter((l) => !l.startsWith("node --import")).join("\n").trim() };
}

function trunk(): string {
	if (!existsSync(TRUNK)) {
		spawnSync("git", ["worktree", "add", "--detach", TRUNK, TRUNK_REF], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
	}
	return TRUNK;
}

async function boot(state: string, fake: Fake, env: Record<string, string> = {}, tree = HEAD): Promise<Host> {
	const harness = await import(join(tree, "tests/e2e/harness.ts"));
	return harness.startHost({ models: fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0 }, env: { ...fakeAgentEnv(fake, join(state, "pi")), ...env }, timeoutMs: 60_000 });
}
function moduleState(state: string, name: string): string | undefined {
	if (!existsSync(join(state, "state.db"))) return undefined;
	const db = new DatabaseSync(join(state, "state.db"), { readOnly: true });
	try {
		const row = db.prepare("SELECT record FROM module_records WHERE name = ?").get(name) as { record: string | null } | undefined;
		return row?.record ? (JSON.parse(row.record) as { state: { at: string } }).state.at : undefined;
	} finally {
		db.close();
	}
}
async function turnOn(state: string, name: string, tree = HEAD): Promise<number> {
	just(state, ["module", "on", name], { cwd: tree });
	return within(30_000, () => moduleState(state, name) === "active");
}

const dataDir = (state: string) => join(state, "modules-data", "stock-ta");
const liveDb = (state: string) => join(dataDir(state), "files", "ta", "ta.sqlite");
const leftovers = (state: string) => [".next", ".next-journal", ".next.scan.lock"].filter((s) => existsSync(liveDb(state) + s));

type Copy = { ta?: string; now?: string; every?: string; scanSeconds?: number; baseUrl?: string };
/** The quotes feed points at a closed port so no lane asks Massive for snapshots. */
function stockTa(state: string, copy: Copy = {}): string {
	const pkg = join(state, "modules", "stock-ta");
	cpSync(PKG, pkg, { recursive: true });
	const quotesJson = join(pkg, "feeds", "quotes", "feed.json");
	writeFileSync(quotesJson, JSON.stringify({ ...JSON.parse(readFileSync(quotesJson, "utf8")), settings: { baseUrl: "http://127.0.0.1:9" } }));
	const feedJson = join(pkg, "feeds", "scan", "feed.json");
	const feed = JSON.parse(readFileSync(feedJson, "utf8"));
	const { every, ...settings } = copy;
	writeFileSync(feedJson, JSON.stringify({ ...feed, ...(every !== undefined && { every }), settings: { ...feed.settings, ...settings } }));
	return pkg;
}
function entryOf(state: string) {
	const entry = servedAsHost(Modules.load([join(state, "modules")])).feeds().find((e: { source: string }) => e.source === "stock-ta/scan");
	if (entry === undefined) throw new Error("stock-ta/scan not found");
	return entry;
}
function watch(state: string, ...symbols: string[]): void {
	instanceData(state).write("stock-ta", entryOf(state).components, "watchlist", symbols.map((symbol) => ({ symbol })), "使用者口述", "lane");
}
function scanRuns(state: string): Record<string, unknown>[] {
	const db = join(dataDir(state), "data.db");
	if (!existsSync(db)) return [];
	const store = new DatabaseSync(db, { readOnly: true });
	try {
		return store.prepare(`SELECT * FROM "scan-runs"`).all().map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_") || k === "_id")));
	} catch {
		return [];
	} finally {
		store.close();
	}
}
function cursorOf(state: string): string | null {
	const db = join(dataDir(state), "data.db");
	if (!existsSync(db)) return null;
	const store = new DatabaseSync(db, { readOnly: true });
	try {
		return (store.prepare("SELECT cursor FROM _feeds WHERE source = ?").get("stock-ta/scan") as { cursor: string | null } | undefined)?.cursor ?? null;
	} catch {
		return null;
	} finally {
		store.close();
	}
}
function seedOldDb(state: string, rows: number): string {
	mkdirSync(join(dataDir(state), "files", "ta"), { recursive: true });
	const db = new DatabaseSync(liveDb(state));
	db.exec("CREATE TABLE bars (symbol TEXT, n INTEGER)");
	for (let i = 0; i < rows; i++) db.prepare("INSERT INTO bars VALUES (?, ?)").run("OLD", i);
	db.close();
	return fileSha(liveDb(state));
}
function count(path: string, sql: string): number {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return (db.prepare(sql).get() as { n: number }).n;
	} finally {
		db.close();
	}
}
const scanLog = (host: Host) => host.log().split("\n").filter((l: string) => l.includes("stock-ta/scan")).join("\n");
const scanLines = (host: Host) => scanLog(host).split("\n").filter((l: string) => /\[feeds\] stock-ta\/scan[：:]|stock-ta\/scan 这一次失败/.test(l));

async function hostTicks(state: string, ticks: number, between: (tick: number) => void = () => undefined, limitMs = 90_000): Promise<{ log: string; lines: string[] }> {
	const fake = await FakeModel.start({ router: [] });
	const host = await boot(state, fake, { POLYGON_API_KEY: "lane-fake-key" });
	try {
		await turnOn(state, "stock-ta");
		for (let tick = 1; tick <= ticks; tick++) {
			await within(limitMs, () => scanLines(host).length >= tick);
			if (tick < ticks) between(tick);
		}
		return { log: scanLog(host), lines: scanLines(host) };
	} finally {
		await host.stop();
		await fake.close();
	}
}

const results: string[] = [];
async function lane(n: number, slug: string, body: () => Promise<{ pass: boolean; evidence: string }>): Promise<void> {
	if (only.length > 0 && !only.includes(String(n))) return;
	let verdict: { pass: boolean; evidence: string };
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const file = join(outDir, `s2-${slug}.txt`);
	writeFileSync(file, `${verdict.pass ? "PASS" : "FAIL"} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${verdict.pass ? "PASS" : "FAIL"}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

const exchangesOf = (fake: Fake, conversation: string): Exchange[] => fake.exchanges.filter((e: Exchange) => e.conversation === conversation);
const inDomain = (call: Call, domain: string) => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain, basis: "request" })) } });
const toolCard = (fake: Fake, brief: string) => exchangesOf(fake, brief).flatMap((e) => e.cards).find((c) => c.startsWith("[模块工具]")) ?? "";

function taRoot(): string {
	const project = process.env["TA_PROJECT"];
	if (!project) throw new Error("set TA_PROJECT to the technical-analysis checkout");
	const root = mkdtempSync(join(tmpdir(), "psa-s2-taroot-"));
	mkdirSync(join(root, "app", "data"), { recursive: true });
	symlinkSync(join(project, "app", "trading"), join(root, "app", "trading"));
	copyFileSync(join(project, "app", "data", "ta.sqlite"), join(root, "app", "data", "ta.sqlite"), constants.COPYFILE_FICLONE);
	return root;
}

function realKey(): string {
	const keyState = process.env["PSA_KEY_STATE"] ?? join(homedir(), ".pi-super-agent");
	const config = JSON.parse(readFileSync(join(keyState, "config.json"), "utf8")) as { secretsFile?: string };
	const key = config.secretsFile === undefined ? undefined : secretLookup(resolve(keyState, config.secretsFile), {})("POLYGON_API_KEY");
	if (!key) throw new Error("POLYGON_API_KEY is not in the host's secrets file");
	return key;
}

/** Logs paths only: no query, no headers. */
async function massiveCounter() {
	const paths: string[] = [];
	const server = createServer(async (req, res) => {
		paths.push((req.url ?? "").split("?")[0] ?? "");
		try {
			const reply = await fetch(`https://api.massive.com${req.url}`, { headers: { accept: "application/json", authorization: String(req.headers.authorization ?? "") }, redirect: "manual" });
			res.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await reply.arrayBuffer()));
		} catch (error) {
			res.writeHead(502).end(String(error));
		}
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	return { base: `http://127.0.0.1:${port}`, paths, close: () => new Promise((done) => server.close(done)) };
}

function realTa(state: string, sub: string, input: unknown): Record<string, unknown> {
	const ta = join(venvDir(dataDir(state), lockOf(join(state, "modules", "stock-ta"))!), "bin", "ta");
	const run = spawnSync(ta, [sub], { input: JSON.stringify(input), encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" } });
	return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
}
/** The latest close + 16 min not after `ms`, from the real calendar: what lane 10 expects the backfill to pass. */
function expectedBackfill(state: string, ms: number): string {
	for (let back = 0; back < 10; back++) {
		const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms - back * 86_400_000));
		const c = realTa(state, "calendar", { date: day }) as { is_trading_day: boolean; close: string | null };
		if (c.is_trading_day && c.close && Date.parse(c.close) + 16 * 60_000 <= ms) return new Date(Date.parse(c.close) + 16 * 60_000).toISOString();
	}
	return "(none)";
}
const marketLabel = (ms: number) => {
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
	const minute = Number(parts.hour) * 60 + Number(parts.minute);
	return ["Sat", "Sun"].includes(parts.weekday) || minute < 570 || minute >= 960 ? `off-hours (${parts.weekday} ${parts.hour}:${parts.minute} ET)` : `market hours (${parts.weekday} ${parts.hour}:${parts.minute} ET)`;
};

const TEN = ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "AMD", "AVGO", "NFLX"];

async function setupReal(state: string): Promise<ReturnType<typeof just>> {
	return just(state, ["module", "setup", "stock-ta"]);
}

async function firstRealScan(counter: Awaited<ReturnType<typeof massiveCounter>>, key: string) {
	const state = stateDir();
	stockTa(state, { baseUrl: counter.base });
	const setup = await setupReal(state);
	watch(state, ...TEN);
	const fake = await FakeModel.start({ router: [] });
	const started = Date.now();
	const host = await boot(state, fake, { POLYGON_API_KEY: key });
	let tookMs = -1;
	try {
		just(state, ["module", "on", "stock-ta"]);
		tookMs = await within(300_000, () => scanLines(host).length >= 1);
		return { state, setup, started, tookMs, log: scanLog(host) };
	} finally {
		await host.stop();
		await fake.close();
	}
}

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		const root = taRoot();
		const lines: string[] = [];
		const answers: { levels: unknown; momentum: unknown }[] = [];
		for (const [name, tree] of [["trunk", trunk()], ["head", HEAD]] as const) {
			const state = stateDir();
			cpSync(join(tree, "docs/modules/examples/stock-ta"), join(state, "modules/stock-ta"), { recursive: true });
			const fake = await FakeModel.start({
				router: [on("开 stock-ta", /^\[对话\][\s\S]*问 stock-ta /, (c: string) => [inDomain(openTicket(c, "问 stock-ta"), "stock-ta"), reply(c, "好")])],
				workers: [worker("问 stock-ta", on("调用", /^\[任务说明\]/, () => [domainTool("structure", { symbol: "NVDA", timeframe: "1d" })]), on("汇报", /^\[模块工具\]/, (c: string) => [report("ready", c)]))],
			});
			const host = await boot(state, fake, { TA_ROOT: root }, tree);
			try {
				await turnOn(state, "stock-ta", tree);
				just(state, ["say", "问 stock-ta NVDA 的结构"], { cwd: tree });
				await within(60_000, () => toolCard(fake, "问 stock-ta") !== "");
				const card = toolCard(fake, "问 stock-ta");
				const answer = (function find(v: unknown): Record<string, unknown> | undefined {
					if (v === null || typeof v !== "object") return undefined;
					if ("levels" in v) return v as Record<string, unknown>;
					return Object.values(v).map(find).find(Boolean);
				})(JSON.parse(card.slice(card.indexOf("{"))));
				answers.push({ levels: answer?.["levels"], momentum: answer?.["momentum"] });
				const checked = just(state, ["module", "check", join(state, "modules/stock-ta")], { cwd: tree }).out.split("\n").find((l) => l.startsWith("ok stock-ta")) ?? "";
				lines.push(`${name}${name === "trunk" ? ` (${TRUNK_REF})` : ""}: levels+momentum sha ${sha(JSON.stringify(answers.at(-1)))}; just module check: ${checked.replace(/ \| digest=.*/, "")}`);
			} finally {
				await host.stop();
				await fake.close();
			}
		}
		const same = answers.length === 2 && answers[0]!.levels !== undefined && JSON.stringify(answers[0]) === JSON.stringify(answers[1]);
		const headFeeds = /feeds=2/.test(lines[1] ?? "") && /feeds=1/.test(lines[0] ?? "");
		return { pass: same && headFeeds, evidence: `${lines.join("\n")}\nlevels and momentum identical: ${same}\nhead has one more feed (scan): ${headFeeds}` };
	});

	await lane(2, "setup", async () => {
		const state = stateDir();
		const pkg = stockTa(state);
		const before = sha(JSON.stringify(readdirSync(pkg, { recursive: true }).sort()));
		const run = await setupReal(state);
		const lock = lockOf(pkg)!;
		const venv = venvDir(dataDir(state), lock);
		const mark = existsSync(join(venv, ".psa-lock")) ? readFileSync(join(venv, ".psa-lock"), "utf8") : "";
		const token = /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|x-access-token|:[^@\s]+@github\.com/.test(run.out);
		const ok = run.status === 0 && existsSync(join(venv, "bin", "ta")) && mark === lock && !token && sha(JSON.stringify(readdirSync(pkg, { recursive: true }).sort())) === before;
		return { pass: ok, evidence: `just module setup stock-ta: exit ${run.status} in ${run.ms} ms\n${run.out.replaceAll(state, "<state>")}\nbin/ta exists: ${existsSync(join(venv, "bin", "ta"))}\n.psa-lock equals sha256(py/uv.lock): ${mark === lock}\ntoken-looking text in the output: ${token}` };
	});

	await lane(3, "check", async () => {
		const state = stateDir();
		const pkg = stockTa(state);
		const run = just(state, ["module", "check", pkg]);
		const broken = stateDir();
		const brokenPkg = stockTa(broken);
		rmSync(join(brokenPkg, "feeds", "scan", "fake-ta.mjs"));
		const control = just(broken, ["module", "check", brokenPkg]);
		const realData = dataDir(state);
		const ok = run.status === 0 && /^ok stock-ta@/m.test(run.out) && control.status !== 0 && /fixtures\/first-scan\.json/.test(control.out) && !existsSync(join(realData, "files", "ta"));
		return { pass: ok, evidence: `just module check: exit ${run.status}\n${run.out.replaceAll(state, "<state>")}\ncontrol with fake-ta.mjs removed (proves the fixture runs the stand-in ta): exit ${control.status}\n${control.out.replaceAll(broken, "<state>")}\nreal data dir has files/ta: ${existsSync(join(realData, "files", "ta"))}` };
	});

	await lane(4, "network-down", async () => {
		const state = stateDir();
		const ta = fakeTa(join(state, "fake"), { kind: "down" } satisfies Plan);
		stockTa(state, { ta: ta.script, now: "2026-11-12T22:00:00Z" });
		watch(state, "NVDA", "AMD", "TSM");
		const before = seedOldDb(state, 5);
		const { log } = await hostTicks(state, 1);
		const rows = scanRuns(state);
		const ok = fileSha(liveDb(state)) === before && leftovers(state).length === 0 && rows.length === 1 && rows[0]!["outcome"] === "失败" && /MARKET_UNAVAILABLE/.test(String(rows[0]!["errors"]));
		return { pass: ok, evidence: `fake ta answers MARKET_UNAVAILABLE for every symbol, exit 0\nold ta.sqlite sha before ${before}\nafter ${fileSha(liveDb(state))}\nleftovers: ${leftovers(state).join(",") || "(none)"}\nscan-runs: ${JSON.stringify(rows)}\nhost log:\n${log}` };
	});

	await lane(5, "skipped", async () => {
		const state = stateDir();
		const ta = fakeTa(join(state, "fake"), { kind: "skip" } satisfies Plan);
		stockTa(state, { ta: ta.script, now: "2026-11-14T15:00:00Z" });
		watch(state, "NVDA");
		const before = seedOldDb(state, 5);
		const { log } = await hostTicks(state, 1);
		const ok = ta.scans().length === 1 && fileSha(liveDb(state)) === before && scanRuns(state).length === 0 && cursorOf(state) === null && leftovers(state).length === 0;
		return { pass: ok, evidence: `fake ta answers skipped\nta scan calls: ${ta.scans().length}\nold ta.sqlite unchanged: ${fileSha(liveDb(state)) === before}\nscan-runs rows: ${scanRuns(state).length}\ncursor: ${cursorOf(state)}\nleftovers: ${leftovers(state).join(",") || "(none)"}\nhost log:\n${log}` };
	});

	await lane(6, "leftover-journal", async () => {
		const state = stateDir();
		const ta = fakeTa(join(state, "fake"), { kind: "ok", rows: 7000 } satisfies Plan);
		stockTa(state, { ta: ta.script, now: "2026-11-12T22:00:00Z" });
		watch(state, "NVDA");
		const next = `${liveDb(state)}.next`;
		mkdirSync(join(dataDir(state), "files", "ta"), { recursive: true });
		const seed = new DatabaseSync(next);
		seed.exec("PRAGMA journal_mode=DELETE; CREATE TABLE bars (symbol TEXT, n INTEGER)");
		seed.exec("BEGIN");
		for (let i = 0; i < 5000; i++) seed.prepare("INSERT INTO bars VALUES (?, ?)").run("CRASH", i);
		seed.exec("COMMIT");
		seed.close();
		// A writer killed mid-transaction leaves a hot journal: the next open rolls the file back.
		const crash = spawnSync(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(next)}); db.exec("PRAGMA cache_size=1; BEGIN; DELETE FROM bars;"); for (let i = 0; i < 20000; i++) db.prepare("INSERT INTO bars VALUES ('X', ?)").run(i); process.kill(process.pid, "SIGKILL");`]);
		const hot = existsSync(`${next}-journal`);
		const probe = mkdtempSync(join(tmpdir(), "psa-s2-probe-"));
		copyFileSync(next, join(probe, "db"));
		copyFileSync(`${next}-journal`, join(probe, "db-journal"));
		const opened = new DatabaseSync(join(probe, "db"));
		const rolledBack = (opened.prepare("SELECT count(*) AS n FROM bars").get() as { n: number }).n;
		opened.close();
		writeFileSync(`${next}.scan.lock`, "");
		const { log } = await hostTicks(state, 1);
		const rows = existsSync(liveDb(state)) ? count(liveDb(state), "SELECT count(*) AS n FROM bars") : -1;
		const ok = hot && crash.signal === "SIGKILL" && rows === 7000 && leftovers(state).length === 0;
		return { pass: ok, evidence: `left a ta.sqlite.next (5000 rows committed, then a writer SIGKILLed mid-transaction: ${crash.signal}) with a hot -journal: ${hot}, and a .scan.lock\ncontrol: a copy of that pair opened as is reads ${rolledBack} rows (the journal rolls it back)\nfake ta then wrote 7000 rows\nswapped-in ta.sqlite has ${rows} rows\nleftovers after: ${leftovers(state).join(",") || "(none)"}\nhost log:\n${log}` };
	});

	await lane(7, "timeout", async () => {
		const state = stateDir();
		const ta = fakeTa(join(state, "fake"), { kind: "sleep" } satisfies Plan);
		stockTa(state, { ta: ta.script, now: "2026-11-12T22:00:00Z", scanSeconds: 3, every: "10s" });
		watch(state, "NVDA");
		const before = seedOldDb(state, 5);
		let afterFirst = { sha: "", leftovers: [] as string[] };
		const { log } = await hostTicks(state, 2, () => {
			afterFirst = { sha: fileSha(liveDb(state)), leftovers: leftovers(state) };
			ta.setPlan({ kind: "ok" });
		});
		const rows = scanRuns(state);
		const late = rows.find((r) => r["outcome"] === "失败");
		const ok = /超时/.test(String(late?.["errors"])) && afterFirst.sha === before && afterFirst.leftovers.length === 0 && rows.length === 2 && rows.some((r) => r["outcome"] === "换上");
		return { pass: ok, evidence: `feed copy: scanSeconds 3, every 10s; fake ta sleeps 60 s on the first tick, answers ok on the next\nafter the first tick: old ta.sqlite unchanged ${afterFirst.sha === before}, leftovers ${afterFirst.leftovers.join(",") || "(none)"}\nscan-runs: ${JSON.stringify(rows)}\nhost log:\n${log}` };
	});

	await lane(8, "second-tick", async () => {
		const state = stateDir();
		const ta = fakeTa(join(state, "fake"), { kind: "ok" } satisfies Plan);
		stockTa(state, { ta: ta.script, now: "2026-11-12T22:00:00Z", every: "5s" });
		watch(state, "NVDA");
		const counts: number[] = [];
		const { log } = await hostTicks(state, 3, (tick) => {
			counts.push(ta.calls().length, scanRuns(state).length);
			if (tick === 2) watch(state, "AMD");
		});
		const last = ta.scans().at(-1)?.input["symbols"] as string[] | undefined;
		const [callsAfter1, rowsAfter1, callsAfter2, rowsAfter2] = counts;
		const ok = callsAfter1 === callsAfter2 && rowsAfter1 === 1 && rowsAfter2 === 1 && ta.scans().length === 2 && (last ?? []).includes("AMD") && scanRuns(state).length === 2;
		return { pass: ok, evidence: `feed copy: every 5s, settings.now fixed at 2026-11-12T22:00:00Z\nafter tick 1: ta calls ${callsAfter1}, scan-runs ${rowsAfter1}\nafter tick 2: ta calls ${callsAfter2}, scan-runs ${rowsAfter2}\nAMD added to watchlist; tick 3 scanned ${JSON.stringify(last)}, scan-runs ${scanRuns(state).length}\nhost log:\n${log}` };
	});

	await lane(9, "empty-watchlist", async () => {
		const state = stateDir();
		const ta = fakeTa(join(state, "fake"), { kind: "ok" } satisfies Plan);
		stockTa(state, { ta: ta.script, now: "2026-11-12T22:00:00Z" });
		const { log } = await hostTicks(state, 1);
		const rows = scanRuns(state);
		const symbols = ta.scans()[0]?.input["symbols"];
		const ok = JSON.stringify(symbols) === JSON.stringify(["QQQ", "SPY"]) && rows.length === 1 && rows[0]!["watchlist"] === 0 && /自选股是空的/.test(String(rows[0]!["note"]));
		return { pass: ok, evidence: `empty watchlist\nfake ta got symbols ${JSON.stringify(symbols)}\nscan-runs: ${JSON.stringify(rows)}\nhost log:\n${log}` };
	});

	await lane(10, "backfill", async () => {
		const key = realKey();
		const counter = await massiveCounter();
		try {
			const run = await firstRealScan(counter, key);
			const db = liveDb(run.state);
			const passed = existsSync(db) ? count(db, "SELECT count(*) AS n FROM scans") : 0;
			const bars = existsSync(db) ? (new DatabaseSync(db, { readOnly: true }).prepare("SELECT symbol, count(*) AS n, max(session_date) AS last FROM bars WHERE timeframe = '1d' GROUP BY symbol ORDER BY symbol").all() as { symbol: string; n: number; last: string }[]) : [];
			const rows = scanRuns(run.state);
			const expected = expectedBackfill(run.state, run.started);
			const scanNow = existsSync(db) ? (new DatabaseSync(db, { readOnly: true }).prepare("SELECT * FROM scans ORDER BY rowid DESC LIMIT 1").get() as Record<string, unknown>) : {};
			const symbols = new Set(bars.map((b) => b.symbol));
			const scannedAt = typeof scanNow["started_ms"] === "number" ? new Date(scanNow["started_ms"]).toISOString() : "(none)";
			const ok = run.tookMs >= 0 && run.tookMs <= 300_000 && scannedAt === expected && rows.length === 1 && rows[0]!["outcome"] === "换上" && [...TEN, "QQQ", "SPY"].every((s) => symbols.has(s)) && bars.every((b) => b.n >= 480 && b.n <= 520);
			return {
				pass: ok,
				evidence: [
					`run at ${new Date(run.started).toISOString()}, ${marketLabel(run.started)}`,
					`setup: exit ${run.setup.status} in ${run.setup.ms} ms`,
					`first scan finished ${run.tookMs} ms after the module was switched on`,
					`expected backfill now (latest close + 16 min, from the real ta calendar): ${expected}`,
					`ta's scans table records the now it scanned at as started_ms = ${scannedAt}; row ${JSON.stringify(scanNow)}; scans rows ${passed}`,
					`daily bars per symbol: ${bars.map((b) => `${b.symbol} ${b.n} (last ${b.last})`).join(", ")}`,
					`scan-runs: ${JSON.stringify(rows)}`,
					`Massive requests: ${counter.paths.length}\n${counter.paths.map((p) => p.replace(/\/\d{4}-\d{2}-\d{2}/g, "/<date>")).join("\n")}`,
					`host log:\n${run.log}`,
				].join("\n"),
			};
		} finally {
			await counter.close();
		}
	});

	console.log(`\n${results.join("\n")}`);
}

async function perf(): Promise<void> {
	const lines: string[] = [];
	const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
	const key = realKey();
	const counter = await massiveCounter();
	try {
		const first = await firstRealScan(counter, key);
		lines.push(`${first.tookMs >= 0 && first.tookMs <= 120_000 ? "PASS" : "FAIL"} first scan (10 + QQQ, SPY), host on to scan-runs row: ${first.tookMs} ms, ${counter.paths.length} Massive requests (rule: over 120 s fails); ${marketLabel(first.started)}`);
		const ta = join(venvDir(dataDir(first.state), lockOf(join(first.state, "modules", "stock-ta"))!), "bin", "ta");
		const now = expectedBackfill(first.state, first.started);
		const daily: number[] = [];
		const before = counter.paths.length;
		for (let i = 0; i < 3; i++) {
			const started = performance.now();
			spawnSync(ta, ["scan"], { input: JSON.stringify({ mode: "daily", symbols: [...TEN, "QQQ", "SPY"], now }), encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", TA_DB_PATH: liveDb(first.state), MASSIVE_API_KEY: key, MASSIVE_BASE_URL: counter.base } });
			daily.push(performance.now() - started);
		}
		lines.push(`${median(daily) <= 20_000 ? "PASS" : "FAIL"} daily scan with no new day of data (same now ${now}, 3 runs straight on the module's db): median ${median(daily).toFixed(0)} ms, runs ${daily.map((d) => d.toFixed(0)).join("/")}, ${counter.paths.length - before} Massive requests (rule: median over 20 s fails)`);
	} finally {
		await counter.close();
	}

	const dir = mkdtempSync(join(tmpdir(), "psa-s2-clone-"));
	const db = new DatabaseSync(join(dir, "ta.sqlite"));
	db.exec("CREATE TABLE pad (x BLOB)");
	db.exec("BEGIN");
	for (let i = 0; i < 1300; i++) db.prepare("INSERT INTO pad VALUES (randomblob(4000))").run();
	db.exec("COMMIT");
	db.close();
	const size = statSync(join(dir, "ta.sqlite")).size;
	const clones: number[] = [];
	for (let i = 0; i < 20; i++) {
		const started = performance.now();
		copyFileSync(join(dir, "ta.sqlite"), join(dir, "ta.sqlite.next"), constants.COPYFILE_FICLONE);
		renameSync(join(dir, "ta.sqlite.next"), join(dir, "ta.sqlite"));
		clones.push(performance.now() - started);
	}
	lines.push(`${Math.max(...clones) <= 200 ? "PASS" : "FAIL"} clone + rename of a ${(size / 1e6).toFixed(1)} MB db, 20 times: median ${median(clones).toFixed(2)} ms, max ${Math.max(...clones).toFixed(2)} ms (rule: over 200 ms fails)`);

	const state = stateDir();
	const fake = fakeTa(join(state, "fake"), { kind: "ok" } satisfies Plan);
	stockTa(state, { ta: fake.script, now: "2026-11-12T22:00:00Z" });
	watch(state, ...TEN);
	const { runFeed } = await import(join(HEAD, "src/modules/feed-runner.ts"));
	const entry = servedAsHost(Modules.load([join(state, "modules")])).feeds().find((e: { source: string }) => e.source === "stock-ta/scan");
	const ports = { data: instanceData(state), submit: () => undefined, alert: () => undefined, secret: () => "lane-fake-key", now: () => Date.now() };
	await runFeed(entry, [], ports);
	const hits: number[] = [];
	const callsBefore = fake.calls().length;
	for (let i = 0; i < 10; i++) {
		const started = performance.now();
		await runFeed(entry, [], ports);
		hits.push(performance.now() - started);
	}
	lines.push(`${median(hits) <= 2000 && fake.calls().length === callsBefore ? "PASS" : "FAIL"} cursor-hit tick through runFeed (one handler process), 10 times: median ${median(hits).toFixed(0)} ms, runs ${hits.map((h) => h.toFixed(0)).join("/")}, ta started ${fake.calls().length - callsBefore} times (rule: median over 2 s fails)`);

	const text = lines.join("\n");
	console.log(text);
	writeFileSync(join(outDir, "s2-perf.txt"), `${text}\n`);
}

await (mode === "perf" ? perf() : lanes());
process.exit(0);
