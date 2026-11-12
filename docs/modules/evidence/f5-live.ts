/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/f5-live.ts [lanes|perf] [outDir]
 * Lane 9 calls real openai-codex models and needs the Pi login in ~/.pi/agent.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const TAX = join(HEAD, "docs/modules/architecture/sample/personal-tax");
const FAKE = { router: "psa-fake/router", worker: "psa-fake/worker", fallback: "psa-fake/fallback" };
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const [mode = "lanes", outDir = "/tmp/swarm-f5/owner"] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
mkdirSync(outDir, { recursive: true });

const { FakeModel, domainTool, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
type Script = import("../../tests/e2e/fake-model.ts").Script;

function trunk(): string {
	if (!existsSync(TRUNK)) {
		spawnSync("git", ["worktree", "add", "--detach", TRUNK, "main"], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
	}
	return TRUNK;
}

function stateDir(models?: object): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-f5-"));
	if (models) writeFileSync(join(dir, "config.json"), JSON.stringify({ models }));
	return dir;
}

function just(state: string, args: string[], cwd = HEAD) {
	const run = spawnSync("just", args, { cwd, env: { ...process.env, PSA_STATE_DIR: state }, encoding: "utf8", timeout: 60_000 });
	return { status: run.status, out: run.stdout + run.stderr };
}

// Async so the fake model in this process keeps answering while `just` runs.
function justAsync(env: NodeJS.ProcessEnv, args: string[], limitMs: number): Promise<{ status: number | null; out: string }> {
	const child = spawn("just", args, { cwd: HEAD, env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	for (const s of [child.stdout, child.stderr]) s.setEncoding("utf8").on("data", (t: string) => (out += t));
	const timer = setTimeout(() => child.kill("SIGKILL"), limitMs);
	return new Promise((done) => child.once("close", (status) => (clearTimeout(timer), done({ status, out }))));
}

function snapshot(dir: string): string {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.map((e) => join(e.parentPath, e.name))
		.sort()
		.map((path) => (statSync(path).isFile() ? `${path} ${readFileSync(path).length}B ${statSync(path).mtimeMs}` : path))
		.join("\n");
}

const own = (out: string) => out.trim().split("\n").filter((l) => !l.startsWith("node --import") && !l.startsWith("error: recipe"));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const results: string[] = [];
async function lane(n: number, slug: string, body: () => Promise<{ pass: boolean | "inconclusive"; evidence: string }>): Promise<void> {
	let verdict: { pass: boolean | "inconclusive"; evidence: string };
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const word = verdict.pass === "inconclusive" ? "INCONCLUSIVE" : verdict.pass ? "PASS" : "FAIL";
	const file = join(outDir, `f5-${slug}.txt`);
	writeFileSync(file, `${word} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

const QUESTION = /^\[对话\][\s\S]*应税所得大概是 25000/;
const opensTax = on("开任务", QUESTION, (card: string) => {
	const open = openTicket(card, "预演算税");
	return [{ ...open, args: { decisions: (open.args.decisions as object[]).map((d) => ({ ...d, domain: "personal-tax" })) } }, reply(card, "好")];
});

// TMPDIR is ours so leftover psa-try- dirs are visible.
async function rehearse(models: object, script: Script | null, limitMs = 60_000) {
	const user = stateDir(models);
	cpSync(TAX, join(user, "modules/personal-tax"), { recursive: true });
	const scratch = mkdtempSync(join(tmpdir(), "psa-f5t-"));
	const fake = script && (await FakeModel.start(script));
	const before = snapshot(user);
	try {
		const env = { ...process.env, ...(fake ? fakeAgentEnv(fake, mkdtempSync(join(tmpdir(), "psa-f5pi-"))) : {}), PSA_STATE_DIR: user, TMPDIR: scratch };
		const run = await justAsync(env, ["module", "try", "personal-tax"], limitMs);
		return { ...run, user, leftover: readdirSync(scratch).filter((f) => f.startsWith("psa-try-")), unchanged: snapshot(user) === before };
	} finally {
		await fake?.close();
	}
}

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		const t = stateDir();
		const old = just(t, ["module-new", "demo"], trunk());
		const h = stateDir();
		const made = just(h, ["module", "new", "demo", "--template", "notes"]);
		const checked = just(h, ["module", "check", join(h, "modules/demo")]);
		return {
			pass: old.status === 0 && existsSync(join(t, "modules/demo/module.json")) && made.status === 0 && checked.status === 0 && /^ok demo@0\.1\.0/m.test(checked.out),
			evidence: `trunk just module-new demo: exit ${old.status}\n${old.out}\nhead just module new demo --template notes: exit ${made.status}\n${made.out}\nhead just module check: exit ${checked.status}\n${checked.out}`,
		};
	});

	for (const [n, template] of [[2, "team"], [3, "full"]] as const) {
		await lane(n, template, async () => {
			const s = stateDir();
			const made = just(s, ["module", "new", "demo", "--template", template]);
			const checked = just(s, ["module", "check", join(s, "modules/demo")]);
			const listed = just(s, ["modules"]).out.split("\n").find((l) => l.startsWith("demo ")) ?? "";
			const want = template === "team" ? /agents=1 evals=1/ : /tools=1 .*agents=1 evals=2/;
			return {
				pass: made.status === 0 && checked.status === 0 && want.test(checked.out) && /已停用/.test(listed),
				evidence: `just module new demo --template ${template}: exit ${made.status}\n${made.out}\njust module check (runs the tool cases): exit ${checked.status}\n${checked.out}just modules: ${listed}\nfiles: ${readdirSync(join(s, "modules/demo"), { recursive: true }).sort().join(", ")}`,
			};
		});
	}

	await lane(4, "dup", async () => {
		const s = stateDir();
		just(s, ["module", "new", "demo", "--template", "team"]);
		const before = snapshot(join(s, "modules/demo"));
		const again = just(s, ["module", "new", "demo", "--template", "full"]);
		const same = snapshot(join(s, "modules/demo")) === before;
		return { pass: again.status === 1 && own(again.out).length === 1 && same, evidence: `second just module new demo: exit ${again.status}\n${again.out}folder unchanged: ${same}` };
	});

	await lane(5, "hot", async () => {
		const s = stateDir(FAKE);
		const fake = await FakeModel.start({ router: [] });
		const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
		const host = await harness.startHost({ models: FAKE, stateDir: s, logFile: join(s, "host.log"), config: { webPort: 0 }, env: fakeAgentEnv(fake, join(s, "pi")), timeoutMs: 60_000 });
		try {
			const started = performance.now();
			const made = just(s, ["module", "new", "hot", "--template", "team"]);
			const madeAt = performance.now();
			let at = "";
			while (performance.now() - madeAt < 2000) {
				const db = new DatabaseSync(join(s, "state.db"), { readOnly: true });
				const row = db.prepare("SELECT record FROM module_records WHERE name = 'hot'").get() as { record: string | null } | undefined;
				db.close();
				at = row?.record ? (JSON.parse(row.record) as { state: { at: string } }).state.at : "";
				if (at === "disabled") break;
				await sleep(20);
			}
			const took = Math.round(performance.now() - madeAt);
			return { pass: made.status === 0 && at === "disabled" && took <= 2000, evidence: `just module new hot (${Math.round(madeAt - started)} ms): ${made.out}running host's record for hot: ${at || "(none)"} after ${took} ms` };
		} finally {
			await host.stop();
			await fake.close();
		}
	});

	await lane(6, "try-fake", async () => {
		const run = await rehearse(FAKE, {
			router: [opensTax],
			workers: [worker("预演算税", on("调工具", /^\[任务说明\]/, () => [domainTool("tax-bracket", { taxableIncome: 25000 })]), on("汇报", /^\[模块工具\]/, () => [report("ready", "落在第 2 档，估算税额 4000 美元")]))],
		});
		return { pass: run.status === 0 && /^PASS bracket-uses-tool$/m.test(run.out), evidence: `exit ${run.status}\n${run.out}` };
	});

	await lane(7, "try-fail", async () => {
		const run = await rehearse(FAKE, { router: [opensTax], workers: [worker("预演算税", on("直接汇报", /^\[任务说明\]/, () => [report("ready", "第 2 档，估算 4000 美元")]))] });
		return { pass: run.status === 1 && /^FAIL bracket-uses-tool：没用到 tools\/tax-bracket$/m.test(run.out), evidence: `exit ${run.status}\n${run.out}` };
	});

	await lane(8, "paid", async () => {
		const run = await rehearse({ ...REAL, worker: "deepseek/deepseek-flash" }, null);
		return { pass: run.status === 1 && own(run.out).length === 1 && /按量计费/.test(run.out) && run.leftover.length === 0, evidence: `config models worker deepseek/deepseek-flash\nexit ${run.status}\n${run.out}throwaway dirs made: ${run.leftover.length}` };
	});

	let real: Awaited<ReturnType<typeof rehearse>> | undefined;
	await lane(9, "try-real", async () => {
		real = await rehearse(REAL, null, 900_000);
		const judged = /^(PASS|FAIL) bracket-uses-tool/m.test(real.out);
		const transcript = /^ {2}(汇报|Router)/m.test(real.out);
		if (!judged) return { pass: "inconclusive", evidence: `no verdict line, so the real run did not get that far\nexit ${real.status}\n${real.out}` };
		return { pass: transcript, evidence: `models ${JSON.stringify(REAL)}\nexit ${real.status}\n${real.out}` };
	});

	await lane(10, "clean", async () => {
		if (real === undefined) return { pass: "inconclusive", evidence: "lane 9 did not run" };
		return { pass: real.leftover.length === 0 && real.unchanged, evidence: `after the real try: psa-try-* left in its TMPDIR: ${real.leftover.join(", ") || "none"}\nuser state dir ${real.user} unchanged (files, sizes, mtimes): ${real.unchanged}` };
	});
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (name: string, xs: number[]) => `${name}: median ${median(xs).toFixed(0)} ms, runs ${xs.map((t) => t.toFixed(0)).join(" ")}, spread ${(Math.max(...xs) - Math.min(...xs)).toFixed(0)} ms`;

async function perf(): Promise<void> {
	const tree = trunk();
	const time = (args: string[], cwd: string) => {
		const s = stateDir();
		const started = performance.now();
		const run = just(s, args, cwd);
		if (run.status !== 0) throw new Error(run.out);
		return performance.now() - started;
	};
	const old: number[] = [];
	const head: number[] = [];
	for (let i = 0; i < 5; i++) {
		old.push(time(["module-new", "demo"], tree));
		head.push(time(["module", "new", "demo", "--template", "full"], HEAD));
	}
	const slower = median(head) - median(old);
	const text = [
		`${slower <= 1000 ? "PASS" : "FAIL"} perf: wall time of the whole just command, trunk and head alternating (rule: head over 1 s slower than trunk fails)`,
		line("  trunk just module-new demo (baseline)", old),
		line("  head just module new demo --template full", head),
	].join("\n");
	writeFileSync(join(outDir, "f5-perf.txt"), `${text}\n`);
	console.log(text);
}

await (mode === "perf" ? perf() : lanes());
