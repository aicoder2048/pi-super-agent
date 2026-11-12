/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/f1-live.ts [lanes|perf] [outDir]
 *
 * Lane 1 and the probe compare against a detached worktree of `main` at <outDir>/trunk.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HEAD = resolve(import.meta.dirname, "../../..");
const SAMPLE = join(HEAD, "docs/modules/architecture/sample");
const [mode = "lanes", outDir = "/tmp/swarm-f1/owner"] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
mkdirSync(outDir, { recursive: true });

function trunk(): string {
	if (!existsSync(TRUNK)) {
		spawnSync("git", ["worktree", "add", "--detach", TRUNK, "main"], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
	}
	return TRUNK;
}

function stateDir(packages: Record<string, object> = {}, samples: string[] = []): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-f1-"));
	for (const [name, manifest] of Object.entries(packages)) {
		mkdirSync(join(dir, "modules", name), { recursive: true });
		writeFileSync(join(dir, "modules", name, "module.json"), JSON.stringify(manifest));
	}
	for (const name of samples) cpSync(join(SAMPLE, name), join(dir, "modules", name), { recursive: true });
	return dir;
}

function just(args: string[], { cwd = HEAD, state = stateDir() } = {}) {
	const run = spawnSync("just", args, { cwd, env: { ...process.env, PSA_STATE_DIR: state }, encoding: "utf8", timeout: 60_000 });
	return { status: run.status, stdout: run.stdout, out: run.stdout + run.stderr };
}

const results: string[] = [];
function lane(n: number, slug: string, body: () => { pass: boolean; evidence: string }): void {
	let verdict: { pass: boolean; evidence: string };
	try {
		verdict = body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const file = join(outDir, `f1-${slug}.txt`);
	writeFileSync(file, `${verdict.pass ? "PASS" : "FAIL"} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${verdict.pass ? "PASS" : "FAIL"}  lane ${n} ${slug}  ${file}`);
}

function hostOnce(state: string): { status: number | null; out: string } {
	const run = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/host/main.ts"], { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: state }, encoding: "utf8", timeout: 20_000 });
	return { status: run.status, out: run.stderr };
}

async function lanes(): Promise<void> {
	const checkMjs = spawnSync(process.execPath, ["docs/modules/architecture/check.mjs"], { cwd: HEAD, encoding: "utf8" });

	lane(1, "regression", () => {
		const state = stateDir();
		const head = just(["modules"], { state });
		const base = just(["modules"], { cwd: trunk(), state });
		return { pass: head.status === 0 && head.out === base.out, evidence: `trunk exit ${base.status}, head exit ${head.status}, identical=${head.out === base.out}\n--- head\n${head.out}--- trunk\n${base.out}` };
	});

	lane(2, "health", () => {
		const run = just(["module", "check", join(SAMPLE, "personal-health")]);
		const recorded = /personal-health sample package validates: (.*)$/m.exec(checkMjs.stdout)?.[1];
		return { pass: run.status === 0 && run.stdout.startsWith("ok personal-health@0.1.0") && run.stdout.trim() === recorded, evidence: `exit ${run.status}\n${run.out}check.mjs recorded: ${recorded}` };
	});

	lane(3, "broken", () => {
		const expected = JSON.parse(readFileSync(join(SAMPLE, "broken/expected.json"), "utf8")) as Record<string, string>;
		const lines = Object.entries(expected).map(([name, reason]) => {
			const run = just(["module", "check", join(SAMPLE, "broken", name)]);
			return { ok: run.status === 1 && run.out.includes(reason), line: `${name}: exit ${run.status}, has reason=${run.out.includes(reason)}\n${run.out}` };
		});
		return { pass: lines.length === 13 && lines.every((l) => l.ok), evidence: lines.map((l) => l.line).join("\n") };
	});

	lane(5, "list", () => {
		const run = just(["modules"], { state: stateDir({}, ["personal-tax"]) });
		const row = run.out.split("\n").find((l) => l.startsWith("personal-tax ")) ?? "";
		return { pass: run.status === 0 && /新布局\s+有效，已停用/.test(row), evidence: run.out };
	});

	lane(6, "dup", () => {
		const fresh = hostOnce(stateDir({ "us-market": { schema: 1, name: "us-market", version: "0.1.0" } }));
		const today = hostOnce(stateDir({ "us-market": { name: "us-market" } }));
		const same = (r: { status: number | null; out: string }) => r.status === 1 && /模块重名：us-market 也定义在 .*modules\/us-market/.test(r.out);
		return { pass: same(fresh) && same(today), evidence: `new layout vs legacy: exit ${fresh.status}\n${fresh.out}\ntwo legacy modules: exit ${today.status}\n${today.out}` };
	});

	lane(7, "missing", () => {
		const run = just(["module", "check", join(SAMPLE, "no-such-package")]);
		return { pass: run.status === 1 && run.stdout.trim().split("\n").length === 1, evidence: `exit ${run.status}\n${run.out}` };
	});

	lane(8, "typo", () => {
		const run = just(["module", "check", join(SAMPLE, "broken/unknown-key")]);
		return { pass: run.status === 1 && run.out.includes(`unknown key "descripton"`), evidence: `exit ${run.status}\n${run.out}` };
	});

	lane(9, "case", () => {
		const run = just(["module", "check", join(SAMPLE, "broken/tool-case-fails")]);
		return { pass: run.status === 1 && /test case 1 "70 千克、1\.75 米" failed: expected \{/.test(run.out), evidence: `exit ${run.status}\n${run.out}` };
	});

	lane(10, "check", () => ({ pass: checkMjs.status === 0 && !checkMjs.stdout.includes("FAIL"), evidence: checkMjs.stdout + checkMjs.stderr }));

	const { startHost, fakeModels } = await import(join(HEAD, "tests/e2e/harness.ts"));
	const { FakeModel, fakeAgentEnv } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
	const fake = await FakeModel.start({ router: [], workers: [] });
	try {
		const state = stateDir({ bad: { schema: 1, name: "bad", version: "0.1.0", descripton: "拼错" } });
		const logFile = join(outDir, "f1-boot-bad.host.log");
		const host = await startHost({ models: fakeModels, stateDir: state, logFile, config: { webPort: 0 }, env: fakeAgentEnv(fake, join(state, "pi")) });
		const log: string = host.log();
		await host.stop();
		const lines = log.split("\n").filter((l) => l.includes("bad"));
		writeFileSync(join(outDir, "f1-boot-bad.txt"), `${lines.length === 1 && /新布局包 bad 无效：module\.json: unknown key "descripton"/.test(lines[0] ?? "") ? "PASS" : "FAIL"} lane 4\nhost ready at ${host.url.origin}\n${log}`);
		results.splice(3, 0, `${readFileSync(join(outDir, "f1-boot-bad.txt"), "utf8").slice(0, 4)}  lane 4 boot-bad  ${join(outDir, "f1-boot-bad.txt")}`);
	} finally {
		await fake.close();
	}
	console.log(results.join("\n"));
}

/** Trunk loads the sample packages as old-layout modules and stops, so trunk boots the repo's three modules and head boots those plus both samples. */
async function perf(runs = 5): Promise<void> {
	const trees = { trunk: trunk(), head: HEAD };
	const times: Record<string, number[]> = { trunk: [], head: [] };
	const { FakeModel, fakeAgentEnv } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
	const fake = await FakeModel.start({ router: [], workers: [] });
	try {
		for (let i = 0; i < runs; i++) {
			for (const [name, tree] of Object.entries(trees)) {
				const { startHost, fakeModels } = await import(join(tree, "tests/e2e/harness.ts"));
				const state = stateDir({}, name === "head" ? ["personal-health", "personal-tax"] : []);
				const started = performance.now();
				const host = await startHost({ models: fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0 }, env: fakeAgentEnv(fake, join(state, "pi")) });
				times[name]!.push(performance.now() - started);
				await host.stop();
			}
		}
	} finally {
		await fake.close();
	}
	const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
	const line = (name: string) => `${name}: median ${median(times[name]!).toFixed(0)} ms, runs ${times[name]!.map((t) => t.toFixed(0)).join(" ")}, spread ${(Math.max(...times[name]!) - Math.min(...times[name]!)).toFixed(0)} ms`;
	const delta = median(times.head!) - median(times.trunk!);
	const report = `${delta > 200 ? "FAIL" : "PASS"} perf: head - trunk = ${delta.toFixed(0)} ms (rule: fail above 200 ms)\n${line("trunk")}\n${line("head")}\n`;
	writeFileSync(join(outDir, "f1-perf.txt"), report);
	console.log(report);
}

await (mode === "perf" ? perf() : lanes());
