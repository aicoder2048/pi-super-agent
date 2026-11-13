/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/s3-live.ts [lanes|perf] [outDir] [lane numbers...]
 *
 * The prelude installs stock-ta in a throwaway state dir with the real `uv` (`just module setup stock-ta`), puts
 * NVDA and AMD on the watchlist and runs the `scan` feed once against real Massive (the backfill `now`), with
 * POLYGON_API_KEY from the secrets file of PSA_KEY_STATE (default ~/.pi-super-agent, only read). Massive requests
 * go through a local forwarder that counts them. Lanes 1 to 8 read that database.
 * Lane 1, lane 3 and perf need TA_PROJECT (the technical-analysis checkout, only read: its app/trading is linked
 * and the prelude's database cloned beside it, so trunk's tools run on the same data) and a worktree of S3_TRUNK
 * (default origin/main) at <outDir>/trunk. Lane 4 imports TA02 from TA_PROJECT's docs. Lane 10 calls real
 * openai-codex models through the Pi login in ~/.pi/agent.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const PKG = join(HEAD, "docs/modules/examples/stock-ta");
const TRUNK_REF = process.env["S3_TRUNK"] ?? "origin/main";
const [mode = "lanes", outDir = "/tmp/swarm-s3/owner", ...only] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
mkdirSync(outDir, { recursive: true });

const { Modules } = await import(join(HEAD, "src/modules.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
const { lockOf, venvDir, venvsIn } = await import(join(HEAD, "src/modules/files.ts"));
const { runFeed } = await import(join(HEAD, "src/modules/feed-runner.ts"));
const { runModuleCodeAsync } = await import(join(HEAD, "src/modules/run-code.ts"));
const { secretLookup } = await import(join(HEAD, "src/secrets.ts"));
const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
type Reply = { ok: true; output: Record<string, unknown> } | { ok: false; note: string };

const sha = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");
const fileSha = (path: string) => (existsSync(path) ? sha(readFileSync(path)) : "(absent)");
const stateDir = () => mkdtempSync(join(tmpdir(), "psa-s3-"));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
async function within(limitMs: number, ok: () => boolean, stepMs = 50): Promise<number> {
	const started = performance.now();
	while (performance.now() - started < limitMs) {
		if (ok()) return Math.round(performance.now() - started);
		await sleep(stepMs);
	}
	return ok() ? Math.round(performance.now() - started) : -1;
}
function just(state: string, args: string[]) {
	const started = performance.now();
	const run = spawnSync("just", args, { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: state }, encoding: "utf8", timeout: 600_000 });
	return { status: run.status, ms: Math.round(performance.now() - started), out: (run.stdout + run.stderr).split("\n").filter((l) => !l.startsWith("node --import")).join("\n").trim() };
}
function trunk(): string {
	if (!existsSync(TRUNK)) {
		spawnSync("git", ["worktree", "add", "--detach", TRUNK, TRUNK_REF], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
	}
	return TRUNK;
}
function query(db: string, sql: string): Record<string, unknown>[] {
	const store = new DatabaseSync(db, { readOnly: true });
	try {
		return store.prepare(sql).all() as Record<string, unknown>[];
	} finally {
		store.close();
	}
}

const dataDir = (state: string) => join(state, "modules-data", "stock-ta");
const liveDb = (state: string) => join(dataDir(state), "files", "ta", "ta.sqlite");
const pkgOf = (state: string) => join(state, "modules", "stock-ta");

/** The quotes feed points at a closed port so no lane asks Massive for snapshots. */
function stockTa(state: string, baseUrl: string): string {
	const pkg = pkgOf(state);
	cpSync(PKG, pkg, { recursive: true });
	for (const [feed, settings] of [["quotes", { baseUrl: "http://127.0.0.1:9" }], ["scan", { baseUrl }]] as const) {
		const file = join(pkg, "feeds", feed, "feed.json");
		const json = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify({ ...json, settings: { ...json.settings, ...settings } }));
	}
	return pkg;
}
const scanEntry = (state: string) => servedAsHost(Modules.load([join(state, "modules")])).feeds().find((e: { source: string }) => e.source === "stock-ta/scan");
function watch(state: string, ...symbols: string[]): void {
	instanceData(state).write("stock-ta", scanEntry(state).components, "watchlist", symbols.map((symbol) => ({ symbol })), "使用者口述", "lane");
}
const scanRuns = (state: string) => query(join(dataDir(state), "data.db"), `SELECT * FROM "scan-runs" ORDER BY rowid`).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_"))));
const scanOnce = (state: string, key: string) => runFeed(scanEntry(state), [], { data: instanceData(state), submit: () => undefined, alert: () => undefined, secret: (n: string) => (n === "POLYGON_API_KEY" ? key : undefined), now: () => Date.now() });

/** Calls a tool the way the host does: `packageDir` is the copy a ticket is pinned to. */
const tool = (name: string, input: unknown, state: string, packageDir = pkgOf(state), data = dataDir(state)): Promise<Reply> =>
	runModuleCodeAsync({ packageDir, component: join("tools", name), dataDir: data }, "index.ts", input);

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

/** Trunk's tools read TA_ROOT: the checkout's app/trading, linked, and a clone of the prelude's database. */
function taRoot(state: string): string {
	const project = process.env["TA_PROJECT"];
	if (!project) throw new Error("set TA_PROJECT to the technical-analysis checkout");
	const root = mkdtempSync(join(tmpdir(), "psa-s3-root-"));
	mkdirSync(join(root, "app", "data"), { recursive: true });
	symlinkSync(join(project, "app", "trading"), join(root, "app", "trading"));
	copyFileSync(liveDb(state), join(root, "app", "data", "ta.sqlite"), constants.COPYFILE_FICLONE);
	return root;
}
async function trunkTool(name: string, input: unknown, root: string): Promise<Reply> {
	const tree = trunk();
	const run = await import(join(tree, "src/modules/run-code.ts"));
	return run.runModuleCodeAsync({ packageDir: join(tree, "docs/modules/examples/stock-ta"), component: join("tools", name), dataDir: mkdtempSync(join(tmpdir(), "psa-s3-td-")) }, "index.ts", input, { TA_ROOT: root });
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
	const file = join(outDir, `s3-${slug}.txt`);
	writeFileSync(file, `${verdict.pass ? "PASS" : "FAIL"} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${verdict.pass ? "PASS" : "FAIL"}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}
const outOf = (reply: Reply) => (reply.ok ? reply.output : { note: reply.note });
const show = (value: unknown, max = 600) => JSON.stringify(value).slice(0, max);

async function prelude(): Promise<{ state: string; key: string; counter: Awaited<ReturnType<typeof massiveCounter>>; text: string }> {
	const key = realKey();
	const counter = await massiveCounter();
	const state = stateDir();
	stockTa(state, counter.base);
	const setup = just(state, ["module", "setup", "stock-ta"]);
	watch(state, "NVDA", "AMD");
	const started = performance.now();
	const run = await scanOnce(state, key);
	const text = [
		`prelude state <state>; setup exit ${setup.status} in ${setup.ms} ms: ${setup.out.replaceAll(state, "<state>")}`,
		`first scan via runFeed: ${run.ok ? "ok" : `failed ${run.note}`} in ${Math.round(performance.now() - started)} ms, ${counter.paths.length} Massive requests`,
		`scan-runs: ${show(scanRuns(state))}`,
		`daily bars: ${show(query(liveDb(state), "SELECT symbol, count(*) AS n, max(session_date) AS last FROM bars WHERE timeframe = '1d' GROUP BY symbol"))}`,
	].join("\n");
	writeFileSync(join(outDir, "s3-prelude.txt"), `${text}\n`);
	console.log(text);
	return { state, key, counter, text };
}

async function lanes(): Promise<void> {
	const { state, key, counter } = await prelude();
	const levelsOf = (reply: Reply) => (reply.ok ? { levels: reply.output["levels"], momentum: reply.output["momentum"] } : { note: reply.note });

	await lane(1, "regression", async () => {
		const root = taRoot(state);
		const trunkReply = await trunkTool("structure", { symbol: "NVDA" }, root);
		const headReply = await tool("structure", { symbol: "NVDA" }, state);
		const [a, b] = [levelsOf(trunkReply), levelsOf(headReply)];
		const same = trunkReply.ok && headReply.ok && JSON.stringify(a) === JSON.stringify(b);
		return { pass: same, evidence: `trunk ${TRUNK_REF} with TA_ROOT (checkout's app/trading + clone of the prelude db): ok ${trunkReply.ok}, levels+momentum sha ${sha(JSON.stringify(a))}\nhead reading files/ta/: ok ${headReply.ok}, levels+momentum sha ${sha(JSON.stringify(b))}, data_end ${headReply.ok ? headReply.output["data_end"] : "-"}\nidentical: ${same}\ntrunk: ${show(outOf(trunkReply), 400)}\nhead: ${show(outOf(headReply), 400)}` };
	});

	await lane(2, "prices", async () => {
		const before = fileSha(liveDb(state));
		const reply = await tool("prices", { symbols: "NVDA,QQQ" }, state);
		const after = fileSha(liveDb(state));
		const prices = reply.ok ? (reply.output["prices"] as Record<string, unknown>[]) : [];
		const ok = reply.ok && ["NVDA", "QQQ"].every((s) => prices.some((p) => p["symbol"] === s && typeof p["price"] === "number" && typeof p["data_time"] === "string")) && before === after;
		return { pass: ok, evidence: `prices NVDA,QQQ: ${show(outOf(reply), 1200)}\nfiles/ta/ta.sqlite sha256 before ${before}\nafter  ${after}` };
	});

	await lane(3, "signals-rules", async () => {
		const root = taRoot(state);
		const lines: string[] = [];
		let same = true;
		for (const [name, input] of [["signals", { symbol: "NVDA" }], ["conditions", { symbol: "NVDA" }]] as const) {
			const [h, t] = [await tool(name, input, state), await trunkTool(name, input, root)];
			const equal = h.ok && t.ok && JSON.stringify(h.output) === JSON.stringify(t.output);
			same &&= equal;
			lines.push(`${name} NVDA: head ok ${h.ok}, same as trunk on the same data: ${equal}; head ${show(outOf(h), 500)}`);
		}
		const first = await tool("signals", { symbol: "NVDA", limit: 1 }, state);
		const ruleId = first.ok ? String((first.output["signals"] as Record<string, unknown>[])[0]?.["rule_id"] ?? "R-MACD-1") : "R-MACD-1";
		const rules = await tool("rules", { rule_id: ruleId }, state);
		const rule = rules.ok ? (rules.output["rules"] as Record<string, unknown>[])[0] : undefined;
		const defined = rule !== undefined && JSON.stringify(rule).includes("TA");
		lines.push(`rules ${ruleId}: ${show(outOf(rules), 800)}\nhas a definition and TA sources: ${defined}`);
		return { pass: same && defined, evidence: lines.join("\n") };
	});

	await lane(4, "note", async () => {
		const project = process.env["TA_PROJECT"];
		if (!project) throw new Error("set TA_PROJECT");
		const imported = just(state, ["module", "import", "stock-ta", "ta02-macd", join(project, "docs/ta-knowhow/TA02 - MACD 实战精华总结.md")]);
		const reply = await tool("note", { source: "TA02#用法二：背离是 MACD 最核心的信号" }, state);
		const text = reply.ok ? String(reply.output["text"]) : "";
		const ok = reply.ok && text.startsWith("#") && text.includes("背离") && !("path" in reply.output);
		return { pass: ok, evidence: `just module import stock-ta ta02-macd <TA_PROJECT>/docs/ta-knowhow/TA02 ...: exit ${imported.status}\nnote reply keys: ${reply.ok ? Object.keys(reply.output).join(",") : reply.note}\nhas path: ${reply.ok && "path" in reply.output}\ntext (first 400 chars):\n${text.slice(0, 400)}` };
	});

	await lane(5, "note-missing", async () => {
		const reply = await tool("note", { source: "TA09" }, state);
		const ok = !reply.ok && /TA09 还没导入.*just module import stock-ta ta09-support-resistance/.test(reply.note) && !reply.note.includes("\n");
		return { pass: ok, evidence: `note TA09 (only TA02 imported): ${show(outOf(reply))}` };
	});

	await lane(6, "no-venv", async () => {
		const bare = mkdtempSync(join(tmpdir(), "psa-s3-bare-"));
		mkdirSync(join(bare, "files", "ta"), { recursive: true });
		copyFileSync(liveDb(state), join(bare, "files", "ta", "ta.sqlite"), constants.COPYFILE_FICLONE);
		const reply = await tool("structure", { symbol: "NVDA" }, state, pkgOf(state), bare);
		const ok = !reply.ok && /先跑 just module setup stock-ta/.test(reply.note);
		return { pass: ok, evidence: `data dir with the database and no files/venv-*: venvs ${JSON.stringify(venvsIn(bare))}\nstructure NVDA: ${show(outOf(reply))}` };
	});

	await lane(7, "lock-changed", async () => {
		const pinned = mkdtempSync(join(tmpdir(), "psa-s3-pinned-"));
		cpSync(pkgOf(state), pinned, { recursive: true });
		appendFileSync(join(pkgOf(state), "py", "uv.lock"), "# lane 7: a new lock hash\n");
		const [oldLock, newLock] = [lockOf(pinned), lockOf(pkgOf(state))];
		const beforeSetup = await tool("structure", { symbol: "NVDA" }, state);
		const oldBefore = await tool("structure", { symbol: "NVDA" }, state, pinned);
		const setup = just(state, ["module", "setup", "stock-ta"]);
		const afterSetup = await tool("structure", { symbol: "NVDA" }, state);
		const oldAfter = await tool("structure", { symbol: "NVDA" }, state, pinned);
		const venvs = venvsIn(dataDir(state));
		const ok = !beforeSetup.ok && /包里钉的 ta 版本变了.*重跑 just module setup stock-ta/.test(beforeSetup.note) && oldBefore.ok && setup.status === 0 && afterSetup.ok && oldAfter.ok && venvs.length === 2 && [oldLock, newLock].every((l) => existsSync(venvDir(dataDir(state), l)));
		return {
			pass: ok,
			evidence: [
				"the host runs a pinned ticket's tool with packageDir = its pinned copy; this lane calls the tool the same way with the old copy and the updated one",
				`old lock ${oldLock.slice(0, 12)}, new lock ${newLock.slice(0, 12)}`,
				`new copy before setup: ${show(outOf(beforeSetup))}`,
				`pinned old copy before setup: ok ${oldBefore.ok}`,
				`just module setup stock-ta: exit ${setup.status} in ${setup.ms} ms: ${setup.out.replaceAll(state, "<state>")}`,
				`new copy after setup: ok ${afterSetup.ok}; pinned old copy after setup: ok ${oldAfter.ok}`,
				`venvs: ${venvs.join(" ")}`,
			].join("\n"),
		};
	});

	await lane(8, "concurrent", async () => {
		const store = new DatabaseSync(join(dataDir(state), "data.db"));
		store.prepare("UPDATE _feeds SET cursor = NULL WHERE source = 'stock-ta/scan'").run();
		store.close();
		const before = counter.paths.length;
		let scanning = true;
		const scan = scanOnce(state, key).finally(() => (scanning = false));
		const replies: { ok: boolean; during: boolean; note?: string }[] = [];
		for (let i = 0; i < 20; i++) {
			const during = scanning;
			const reply = await tool("prices", { symbols: "NVDA,AMD" }, state);
			replies.push({ ok: reply.ok, during, ...(!reply.ok && { note: reply.note }) });
			await sleep(150);
		}
		const run = await scan;
		const runs = scanRuns(state);
		const ok = replies.every((r) => r.ok) && replies.filter((r) => r.during).length >= 5 && run.ok;
		return { pass: ok, evidence: `scan (cursor cleared) ${run.ok ? "ok" : run.note}, ${counter.paths.length - before} Massive requests; last scan-runs row ${show(runs.at(-1))}\n20 prices calls: ${replies.filter((r) => r.ok).length} ok, ${replies.filter((r) => r.during).length} started while the scan was running\n${replies.map((r, i) => `${i + 1}: ok ${r.ok} during ${r.during}${r.note ? ` ${r.note}` : ""}`).join("\n")}` };
	});

	await lane(9, "cleanup", async () => {
		const rg = (pattern: string) => spawnSync("rg", ["-n", pattern, "docs/modules/examples/stock-ta"], { cwd: HEAD, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
		const words = rg("screen|ta-screen|技术分析项目|TA_ROOT");
		const intraday = rg("5m|OR30");
		const allowed = (line: string) => /\/knowledge\/[^/]+\/source\.json:\d+:\s+"origin"/.test(line) || /\/knowledge\/glossary\/glossary\.md:/.test(line);
		const stray = [...words, ...intraday].filter((l) => !allowed(l));
		return { pass: stray.length === 0, evidence: `rg 'screen|ta-screen|技术分析项目|TA_ROOT': ${words.length} lines\n${words.join("\n")}\n\nrg '5m|OR30': ${intraday.length} lines\n${intraday.join("\n")}\n\nlines outside knowledge/*/source.json "origin" and the bundled glossary text: ${stray.length}\n${stray.join("\n")}` };
	});

	await lane(10, "real-ask", async () => {
		const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
		const host = await harness.startHost({ models: REAL, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0 }, env: {}, timeoutMs: 60_000 });
		try {
			just(state, ["module", "on", "stock-ta"]);
			const on = await within(30_000, () => query(join(state, "state.db"), "SELECT record FROM module_records WHERE name = 'stock-ta'").some((r) => String(r["record"]).includes('"at":"active"')), 500);
			if (on < 0) throw new Error("stock-ta did not turn on");
			const asked = "NVDA 现在的支撑阻力和动量怎么样，数据是哪天的";
			just(state, ["say", asked]);
			const final = () => query(join(state, "state.db"), "SELECT r.status, r.summary, t.dispatched_to, t.domain FROM reports r JOIN tickets t ON t.id = r.ticket_id WHERE t.domain = 'stock-ta' AND r.status <> 'progress' ORDER BY r.rowid DESC").at(0);
			await within(900_000, () => final() !== undefined, 2_000);
			const found = final();
			const text = String(found?.["summary"] ?? "");
			const experts: string[] = JSON.parse(String(found?.["dispatched_to"] ?? "[]"));
			const tradingDate = String(scanRuns(state).at(-1)?.["tradingDate"] ?? "?");
			const [, m, d] = tradingDate.split("-");
			const secrets = readdirSync(state).filter((f) => f.endsWith(".env")).map((f) => readFileSync(join(state, f), "utf8")).join("\n");
			const checks = {
				"结构与形态 and 趋势与动量 dispatched": ["结构与形态", "趋势与动量"].every((e) => experts.includes(e)),
				[`names the latest scan-runs date ${tradingDate}`]: text.includes(tradingDate) || (m !== undefined && new RegExp(`${Number(m)}\\s*月\\s*${Number(d)}`).test(text)),
				"no TA_ROOT in the host env or a secrets file": process.env["TA_ROOT"] === undefined && !secrets.includes("TA_ROOT"),
			};
			const gateway = readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[gateway]"));
			return { pass: Object.values(checks).every(Boolean), evidence: `models ${JSON.stringify(REAL)}\nasked: ${asked}\nchecks: ${JSON.stringify(checks)}\ndispatched to: ${experts.join("、")}\ngateway log:\n${gateway.join("\n")}\nreport (${found?.["status"]}):\n${text}` };
		} finally {
			await host.stop();
		}
	});

	await counter.close();
	console.log(`\n${results.join("\n")}`);
}

async function perf(): Promise<void> {
	const { state, counter } = await prelude();
	await counter.close();
	const root = taRoot(state);
	const timed = async (call: () => Promise<Reply>) => {
		const started = performance.now();
		const reply = await call();
		if (!reply.ok) throw new Error(reply.note);
		return performance.now() - started;
	};
	const head = () => tool("structure", { symbol: "NVDA" }, state);
	const base = () => trunkTool("structure", { symbol: "NVDA" }, root);
	await timed(base);
	await timed(head);
	const [t, h]: number[][] = [[], []];
	for (let i = 0; i < 10; i++) {
		t.push(await timed(base));
		h.push(await timed(head));
	}
	const pass = median(h) - median(t) <= 100;
	const text = `${pass ? "PASS" : "FAIL"} structure NVDA through the tool, alternating 10 runs each after one warm-up each, same cloned data\ntrunk ${TRUNK_REF} (uv run --no-sync): median ${median(t).toFixed(0)} ms, runs ${t.map((x) => x.toFixed(0)).join("/")}\nhead (venv's ta directly): median ${median(h).toFixed(0)} ms, runs ${h.map((x) => x.toFixed(0)).join("/")}\nhead minus trunk ${(median(h) - median(t)).toFixed(0)} ms (rule: over 100 ms slower fails)`;
	console.log(text);
	writeFileSync(join(outDir, "s3-perf.txt"), `${text}\n`);
}

await (mode === "perf" ? perf() : lanes());
process.exit(0);
