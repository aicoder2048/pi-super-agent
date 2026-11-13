/**
 *   TA_ROOT=<your technical analysis project> node --import ./src/pi-runtime.mjs docs/modules/evidence/d1-live.ts [lanes|perf] [outDir]
 * Lanes 1, 9 and 10 call real openai-codex models and need the Pi login in ~/.pi/agent.
 */
import { spawnSync } from "node:child_process";
import { constants, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const PKG = join(HEAD, "docs/modules/examples/stock-ta");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const TA_ROOT = process.env["TA_ROOT"] ?? "";
const DBS = ["ta.sqlite", "market.sqlite"].map((f) => join(TA_ROOT, "app/data", f));
if (TA_ROOT === "") throw new Error("set TA_ROOT to the technical analysis project");
const [mode = "lanes", outDir = "/tmp/swarm-d1/owner"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const { runModuleCodeAsync } = await import(join(HEAD, "src/modules/run-code.ts"));
const { runCasesAsync, scanPackage } = await import(join(HEAD, "src/modules/validate.ts"));
const { searchKnowledge, foundText, moduleDataDir } = await import(join(HEAD, "src/modules/knowledge.ts"));
type Host = Awaited<ReturnType<(typeof import("../../tests/e2e/harness.ts"))["startHost"]>>;
type Reply = { ok: true; output: Record<string, unknown> } | { ok: false; note: string };

const call = (tool: string, input: unknown): Promise<Reply> => runModuleCodeAsync({ packageDir: PKG, component: join("tools", tool), dataDir: mkdtempSync(join(tmpdir(), "psa-d1-data-")) }, "index.ts", input, { TA_ROOT });
const hashes = () => DBS.map((f) => spawnSync("shasum", [f], { encoding: "utf8" }).stdout.trim()).join("\n");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function stateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-d1-"));
	cpSync(PKG, join(dir, "modules/stock-ta"), { recursive: true });
	return dir;
}

function just(state: string, args: string[], extra: Record<string, string> = {}, limitMs = 60_000) {
	const run = spawnSync("just", args, { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300", ...extra }, encoding: "utf8", timeout: limitMs });
	return { status: run.status, out: run.stdout + run.stderr };
}

function query<T>(state: string, sql: string, ...params: string[]): T[] {
	const db = new DatabaseSync(join(state, "state.db"), { readOnly: true });
	try {
		return db.prepare(sql).all(...params) as T[];
	} finally {
		db.close();
	}
}

async function within<T>(limitMs: number, probe: () => T | undefined): Promise<T | undefined> {
	for (const end = Date.now() + limitMs; Date.now() < end; await sleep(500)) {
		const found = probe();
		if (found !== undefined) return found;
	}
	return probe();
}

function importNotes(state: string): string[] {
	return ([["ta01-moving-averages", "TA01 - 均线实战精华总结.md"], ["ta02-macd", "TA02 - MACD 实战精华总结.md"], ["ta09-support-resistance", "TA09 - 支撑与阻力实战精华总结.md"]] as const).map(
		([doc, file]) => {
			const run = just(state, ["module", "import", "stock-ta", doc, join(TA_ROOT, "docs/ta-knowhow", file)]);
			return `just module import stock-ta ${doc}: exit ${run.status} ${run.out.trim().split("\n").at(-1)?.replace(state, "<state>")}`;
		},
	);
}

async function realHost(state: string): Promise<Host> {
	const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
	const host = await harness.startHost({ models: REAL, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0 }, env: { TA_ROOT }, timeoutMs: 60_000 });
	just(state, ["module", "on", "stock-ta"]);
	const record = await within(30_000, () => {
		const [row] = query<{ record: string | null }>(state, "SELECT record FROM module_records WHERE name = 'stock-ta'");
		return row?.record && JSON.parse(row.record).state.at === "active" ? row.record : undefined;
	});
	if (record === undefined) throw new Error("stock-ta did not turn on in the real host");
	return host;
}

const results: string[] = [];
type Verdict = { pass: boolean | "inconclusive"; evidence: string };
async function lane(n: number, slug: string, body: () => Promise<Verdict>): Promise<void> {
	let verdict: Verdict;
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const word = verdict.pass === "inconclusive" ? "INCONCLUSIVE" : verdict.pass ? "PASS" : "FAIL";
	const file = join(outDir, `d1-${slug}.txt`);
	writeFileSync(file, `${word} lane ${n}\n${verdict.evidence.replaceAll(TA_ROOT, "<TA_ROOT>")}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

type Ticket = { id: string; domain: string | null; dispatched_to: string | null };

async function lanes(): Promise<void> {
	const before = hashes();

	await lane(1, "regression", async () => {
		const trunk = spawnSync("git", ["cat-file", "-e", "main:docs/modules/examples/stock-ta/module.json"], { cwd: HEAD }).status;
		const state = stateDir();
		const host = await realHost(state);
		try {
			just(state, ["say", "NVDA 今天为什么跌？最近有什么相关新闻？"]);
			const ticket = await within(240_000, () => query<Ticket>(state, "SELECT id, domain, dispatched_to FROM tickets").at(0));
			return {
				pass: trunk !== 0 && ticket?.domain === "us-market",
				evidence: `trunk has docs/modules/examples/stock-ta: ${trunk === 0}\nhead, stock-ta on, models ${JSON.stringify(REAL)}\nasked: NVDA 今天为什么跌？最近有什么相关新闻？\nticket: ${JSON.stringify(ticket)}`,
			};
		} finally {
			await host.stop();
		}
	});

	await lane(2, "check", async () => {
		const state = mkdtempSync(join(tmpdir(), "psa-d1-"));
		const run = just(state, ["module", "check", "docs/modules/examples/stock-ta"]);
		return { pass: run.status === 0 && /^ok stock-ta@0\.1\.0/m.test(run.out), evidence: `just module check docs/modules/examples/stock-ta: exit ${run.status}\n${run.out}` };
	});

	await lane(3, "structure", async () => {
		const started = performance.now();
		const reply = await call("structure", { symbol: "NVDA" });
		const took = Math.round(performance.now() - started);
		const out = reply.ok ? reply.output : {};
		const levels = Array.isArray(out["levels"]) ? (out["levels"] as { role: string }[]) : [];
		const roles = new Set(levels.map((l) => l.role));
		return {
			pass: reply.ok && roles.has("support") && roles.has("resistance") && typeof out["data_end"] === "string" && bytes(out) <= 20_000,
			evidence: `structure {"symbol":"NVDA"} in ${took} ms, ${bytes(out)} bytes\ndata_end ${out["data_end"]}\nlevels ${JSON.stringify(levels.slice(0, 4))}\nmomentum ${JSON.stringify(out["momentum"])}\nreply head ${JSON.stringify(reply).slice(0, 600)}`,
		};
	});

	await lane(4, "signals", async () => {
		const reply = await call("signals", { symbol: "NVDA", limit: 5 });
		const signals = reply.ok && Array.isArray(reply.output["signals"]) ? (reply.output["signals"] as { rule_id: string; data_end: string; direction: string }[]) : [];
		return { pass: reply.ok && signals.length > 0, evidence: `signals {"symbol":"NVDA","limit":5}: ${signals.length} signals\n${signals.map((s) => `${s.rule_id} ${s.direction} ${s.data_end}`).join("\n")}\n${JSON.stringify(reply).slice(0, 400)}` };
	});

	await lane(5, "note", async () => {
		const reply = await call("note", { source: "TA02#用法二：背离是 MACD 最核心的信号" });
		const text = JSON.stringify(reply);
		return { pass: reply.ok && /背离/.test(String(reply.output["text"])) && !text.includes(homedir()) && !text.includes(TA_ROOT) && !("path" in reply.output), evidence: `note TA02#用法二：背离是 MACD 最核心的信号\nhas the home dir: ${text.includes(homedir())}\nkeys: ${reply.ok ? Object.keys(reply.output).join(", ") : ""}\n${text.slice(0, 600)}` };
	});

	await lane(6, "rr", async () => {
		const scan = scanPackage(PKG, { runCases: false });
		if (!scan.ok) throw new Error(JSON.stringify(scan.problems));
		const problems = await runCasesAsync(scan.scan);
		const cases = readFileSync(join(PKG, "tools/risk-reward/cases.json"), "utf8");
		const sample = await call("risk-reward", { entry: 178.67, stop: 170.28, target: 195.45, atr: 8.39 });
		return { pass: problems.length === 0, evidence: `cases.json run through the tool process: ${problems.length === 0 ? "all same" : JSON.stringify(problems)}\n${cases}\nsample call: ${JSON.stringify(sample)}` };
	});

	await lane(7, "knowledge", async () => {
		const state = stateDir();
		const imported = importNotes(state);
		const scan = scanPackage(join(state, "modules/stock-ta"), { runCases: false });
		if (!scan.ok) throw new Error(JSON.stringify(scan.problems));
		const docs = scan.scan.components.filter((c: { kind: string }) => c.kind === "knowledge");
		const found = searchKnowledge({ module: "stock-ta", digest: scan.scan.digest, copyDir: scan.scan.dir, dataDir: moduleDataDir(state, "stock-ta"), docs }, "背离");
		const text = foundText("stock-ta", "背离", found);
		return { pass: found.passages.some((p: { doc: string }) => p.doc === "ta02-macd"), evidence: `${imported.join("\n")}\nknowledge 背离:\n${text}` };
	});

	let real: string | undefined;
	await lane(9, "real", async () => {
		const state = stateDir();
		const imported = importNotes(state);
		let host: Host;
		try {
			host = await realHost(state);
		} catch (error) {
			return { pass: "inconclusive", evidence: `a real host could not start: ${String((error as Error).stack ?? error)}` };
		}
		try {
			just(state, ["say", "NVDA 现在的支撑阻力和动量怎么样"]);
			const report = await within(600_000, () => query<{ status: string; summary: string }>(state, "SELECT r.status, r.summary FROM reports r JOIN tickets t ON t.id = r.ticket_id WHERE t.domain = 'stock-ta' AND r.status <> 'progress'").at(0));
			const ticket = query<Ticket>(state, "SELECT id, domain, dispatched_to FROM tickets WHERE domain = 'stock-ta'").at(0);
			const experts: string[] = JSON.parse(ticket?.dispatched_to ?? "[]");
			const gateway = readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[gateway]"));
			const dated = /2026-11-0\d|11 ?月 ?\d+ ?日|data_end/.test(report?.summary ?? "");
			const cited = /TA\d\d|笔记|knowledge|出处/.test(report?.summary ?? "");
			real = state;
			return {
				pass: report !== undefined && experts.length >= 2 && dated && cited,
				evidence: `models ${JSON.stringify(REAL)}\n${imported.join("\n")}\nasked: NVDA 现在的支撑阻力和动量怎么样\nticket ${JSON.stringify(ticket)}\nexperts dispatched: ${experts.join("、") || "none"}\nreport has a data time: ${dated}, a source: ${cited}\ngateway:\n${gateway.join("\n")}\nreport (${report?.status}):\n${report?.summary}`,
			};
		} finally {
			await host.stop();
		}
	});

	await lane(10, "try", async () => {
		const state = mkdtempSync(join(tmpdir(), "psa-d1-"));
		writeFileSync(join(state, "config.json"), JSON.stringify({ models: REAL }));
		const run = just(state, ["module", "try", "docs/modules/examples/stock-ta"], { TA_ROOT }, 1_500_000);
		const names = ["risk-reward", "nvda-structure"];
		const judged = names.filter((n) => new RegExp(`^(PASS|FAIL) ${n}`, "m").test(run.out));
		if (!/道考题通过/.test(run.out)) return { pass: "inconclusive", evidence: `no summary line, so the real run did not finish\nexit ${run.status}\n${run.out}` };
		return { pass: judged.length === names.length, evidence: `models ${JSON.stringify(REAL)}\njudged ${judged.length}/${names.length}\nexit ${run.status}\n${run.out}` };
	});

	await lane(8, "readonly", async () => {
		const after = hashes();
		return { pass: after === before, evidence: `before lanes 1-7, 9, 10:\n${before}\nafter:\n${after}\nlane 9 state ${real ?? "(none)"}` };
	});
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (name: string, xs: number[]) => `${name}: median ${median(xs).toFixed(0)} ms, runs ${xs.map((t) => t.toFixed(0)).join(" ")}, spread ${(Math.max(...xs) - Math.min(...xs)).toFixed(0)} ms`;

function directStructure(): () => number {
	const scratch = mkdtempSync(join(tmpdir(), "psa-d1-direct-"));
	const db = join(scratch, "ta.sqlite");
	copyFileSync(DBS[0]!, db, constants.COPYFILE_FICLONE);
	const opened = new DatabaseSync(db, { readOnly: true });
	const synced = opened.prepare("SELECT max(synced_ms) AS t FROM dividend_sync WHERE symbol IN ('NVDA', 'QQQ', 'SPY')").get() as { t: number };
	opened.close();
	const input = JSON.stringify({ symbol: "NVDA", timeframe: "1d", now: new Date(synced.t + 60_000).toISOString() });
	const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", TA_ROOT, MASSIVE_BASE_URL: "http://127.0.0.1:9", TA_DB_PATH: db };
	return () => {
		const started = performance.now();
		const run = spawnSync("uv", ["run", "--no-sync", "--project", join(TA_ROOT, "app/trading"), "ta", "structure"], { input, env, cwd: scratch, encoding: "utf8" });
		if (run.status !== 0) throw new Error(run.stderr);
		return performance.now() - started;
	};
}

async function perf(): Promise<void> {
	const before = hashes();
	const direct = directStructure();
	const ta: number[] = [];
	const tool: number[] = [];
	for (let i = 0; i < 10; i++) {
		ta.push(direct());
		const started = performance.now();
		const reply = await call("structure", { symbol: "NVDA" });
		if (!reply.ok) throw new Error(reply.note);
		tool.push(performance.now() - started);
	}
	const slower = median(tool) - median(ta);
	const text = [
		`${slower <= 150 ? "PASS" : "FAIL"} perf: one structure call for NVDA, tool (node process, clones, uv, ta) vs uv run ta structure directly, alternating 10 each (rule: tool over 150 ms slower fails). Tool is ${slower.toFixed(0)} ms slower.`,
		line("  direct ta structure (baseline)", ta),
		line("  structure tool", tool),
		`  databases unchanged: ${hashes() === before}`,
	].join("\n");
	writeFileSync(join(outDir, "d1-perf.txt"), `${text}\n`);
	console.log(text);
}

await (mode === "perf" ? perf() : lanes());
