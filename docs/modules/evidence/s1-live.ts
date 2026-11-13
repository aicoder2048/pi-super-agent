/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/s1-live.ts [lanes|perf] [outDir] [lane numbers...]
 *
 * Every lane runs in its own throwaway state dir, hosts on the fake model from tests/e2e/fake-model.ts.
 * Lanes 3 to 5 run the real `uv` against PyPI (the sample's one dependency is `six`). Lane 1 and perf also
 * run a detached worktree of S1_TRUNK (default origin/psa/mod-g5-quotes, the branch S1 stacks on) at <outDir>/trunk.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const SAMPLE = join(HEAD, "docs/modules/architecture/sample");
const TRUNK_REF = process.env["S1_TRUNK"] ?? "origin/psa/mod-g5-quotes";
const [mode = "lanes", outDir = "/tmp/swarm-s1/owner", ...only] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
mkdirSync(outDir, { recursive: true });

const { fakeModels } = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, domainTool, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
type Fake = InstanceType<typeof FakeModel>;
type Host = Awaited<ReturnType<(typeof import("../../tests/e2e/harness.ts"))["startHost"]>>;
type Call = { name: string; args: Record<string, unknown> };
type Exchange = import("../../tests/e2e/fake-model.ts").Exchange;

function trunk(): string {
	if (!existsSync(TRUNK)) {
		spawnSync("git", ["worktree", "add", "--detach", TRUNK, TRUNK_REF], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
	}
	return TRUNK;
}

const sha = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");
const stateDir = () => mkdtempSync(join(tmpdir(), "psa-s1-"));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function within(limitMs: number, ok: () => boolean): Promise<number> {
	const started = performance.now();
	while (performance.now() - started < limitMs) {
		if (ok()) return Math.round(performance.now() - started);
		await sleep(20);
	}
	return ok() ? Math.round(performance.now() - started) : -1;
}

function just(state: string, args: string[], { cwd = HEAD, env = {} as Record<string, string> } = {}) {
	const started = performance.now();
	const run = spawnSync("just", args, { cwd, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300", ...env }, encoding: "utf8", timeout: 300_000 });
	return { status: run.status, ms: Math.round(performance.now() - started), out: (run.stdout + run.stderr).split("\n").filter((l) => !l.startsWith("node --import")).join("\n").trim() };
}

function snapshot(dir: string): string {
	if (!existsSync(dir)) return "(absent)";
	return (readdirSync(dir, { recursive: true }) as string[]).sort().flatMap((path) => {
		const stat = lstatSync(join(dir, path));
		return stat.isSymbolicLink() ? [`${path} -> link`] : stat.isFile() ? [`${path} ${sha(readFileSync(join(dir, path)))}`] : [];
	}).join("\n");
}

const filesOf = (state: string, name: string) => join(state, "modules-data", name, "files");
const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const venvsOf = (state: string, name: string) => ls(filesOf(state, name)).filter((f) => f.startsWith("venv-"));

type Record_ = { state: { at: string; serving?: { digest: string; label: string }; update?: unknown; stage?: { at: string; problems?: { where: string; reason: string }[] } } };
function record(state: string, name: string): Record_ | undefined {
	if (!existsSync(join(state, "state.db"))) return undefined;
	const db = new DatabaseSync(join(state, "state.db"), { readOnly: true });
	try {
		const row = db.prepare("SELECT record FROM module_records WHERE name = ?").get(name) as { record: string | null } | undefined;
		return row?.record ? (JSON.parse(row.record) as Record_) : undefined;
	} finally {
		db.close();
	}
}
const active = (state: string, name: string) => () => record(state, name)?.state.at === "active";

async function boot(state: string, fake: Fake, tree = HEAD): Promise<Host> {
	const harness = await import(join(tree, "tests/e2e/harness.ts"));
	return harness.startHost({ models: fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0 }, env: fakeAgentEnv(fake, join(state, "pi")), timeoutMs: 60_000 });
}
async function turnOn(state: string, name: string, tree = HEAD): Promise<number> {
	just(state, ["module", "on", name], { cwd: tree });
	return within(20_000, active(state, name));
}

const WHERE = {
	"tool.json": JSON.stringify({ title: "数据在哪", description: "说出这个模块的数据目录和 Python 环境", input: { x: { type: "number", title: "x" } }, output: { data: { type: "text", title: "data" } }, effect: "read" }),
	"index.ts": `import { existsSync } from "node:fs";\nimport { join } from "node:path";\nexport default () => ({ data: process.env.PSA_MODULE_DATA ?? null, venv: process.env.PSA_MODULE_VENV ?? null, filesReady: existsSync(join(process.env.PSA_MODULE_DATA ?? "", "files")) });\n`,
};
const RUNS = JSON.stringify({ title: "运行", kind: "record", class: "shareable", fields: { note: { type: "text", title: "说明" } } });
const WRITER = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default async ({ settings }) => {
	const data = process.env.PSA_MODULE_DATA;
	const startedAt = Date.now();
	await new Promise((done) => setTimeout(done, settings.sleepMs));
	writeFileSync(join(data, "files", "written-by-" + settings.mark), JSON.stringify({ startedAt, endedAt: Date.now() }));
	if (settings.out) writeFileSync(settings.out, data);
	return { records: [{ id: "run-" + startedAt, note: settings.mark }] };
};
`;
const pyproject = (six: string) => `[project]\nname = "sample-py"\nversion = "0.1.0"\nrequires-python = ">=3.9"\ndependencies = ["six==${six}"]\n`;

type Pack = { py?: string; feed?: { sleepMs?: number; limit?: string; fixtureOut?: string }; exam?: boolean };
function writePackage(root: string, name: string, { py, feed, exam }: Pack = {}): string {
	const dir = join(root, name);
	const put = (path: string, text: string) => (mkdirSync(dirname(join(dir, path)), { recursive: true }), writeFileSync(join(dir, path), text));
	put("module.json", JSON.stringify({ schema: 1, name, version: "0.1.0", title: name, description: "S1 的样例模块" }));
	for (const [file, text] of Object.entries(WHERE)) put(`tools/where/${file}`, text);
	if (feed !== undefined) {
		put("data/runs/collection.json", RUNS);
		put("feeds/write/feed.json", JSON.stringify({ title: "写文件", handler: "index.ts", every: "1h", into: "runs", settings: { mark: "real", out: "", sleepMs: feed.sleepMs ?? 0 }, ...(feed.limit !== undefined && { limit: feed.limit }) }));
		put("feeds/write/index.ts", WRITER);
		if (feed.fixtureOut !== undefined) put("feeds/write/fixtures/once.json", JSON.stringify({ input: { settings: { mark: "fixture", out: feed.fixtureOut, sleepMs: 0 } }, responses: {} }));
	}
	if (exam) put("evals/where-uses-tool.md", "---\nname: where-uses-tool\nuses: tools/where\nexpect: files\n---\n这个模块的数据目录在哪？\n");
	if (py !== undefined) {
		put("py/pyproject.toml", pyproject(py));
		lock(dir);
	}
	return dir;
}
function lock(pkg: string): void {
	const run = spawnSync("uv", ["lock", "--project", join(pkg, "py")], { encoding: "utf8" });
	if (run.status !== 0) throw new Error(`uv lock failed: ${run.error?.message ?? run.stderr}`);
}
const lockSha = (pkg: string) => sha(readFileSync(join(pkg, "py/uv.lock")));

const results: string[] = [];
async function lane(n: number, slug: string, body: () => Promise<{ pass: boolean; evidence: string }>): Promise<void> {
	if (only.length > 0 && !only.includes(String(n))) return;
	let verdict: { pass: boolean; evidence: string };
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const file = join(outDir, `s1-${slug}.txt`);
	writeFileSync(file, `${verdict.pass ? "PASS" : "FAIL"} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${verdict.pass ? "PASS" : "FAIL"}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

const exchangesOf = (fake: Fake, conversation: string): Exchange[] => fake.exchanges.filter((e: Exchange) => e.conversation === conversation);
const inDomain = (call: Call, domain: string) => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain, basis: "request" })) } });
const toolCard = (fake: Fake, brief: string) => exchangesOf(fake, brief).flatMap((e) => e.cards).find((c) => c.startsWith("[模块工具]")) ?? "";
const asks = (names: readonly string[], tool: string, input: Record<string, unknown>) => ({
	router: names.map((name) => on(`开 ${name}`, new RegExp(`^\\[对话\\][\\s\\S]*问 ${name} `), (c: string) => [inDomain(openTicket(c, `问 ${name}`), name), reply(c, "好")])),
	workers: names.map((name) => worker(`问 ${name}`, on("调用", /^\[任务说明\]/, () => [domainTool(tool, input)]), on("汇报", /^\[模块工具\]/, (c: string) => [report("ready", c)]))),
});
async function ask(state: string, fake: Fake, name: string, tree = HEAD): Promise<string> {
	just(state, ["say", `问 ${name} 一件事`], { cwd: tree });
	await within(30_000, () => toolCard(fake, `问 ${name}`) !== "");
	return toolCard(fake, `问 ${name}`);
}

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		const cards: string[] = [];
		const lines: string[] = [];
		for (const [name, tree] of [["trunk", trunk()], ["head", HEAD]] as const) {
			const state = stateDir();
			cpSync(join(SAMPLE, "personal-tax"), join(state, "modules/personal-tax"), { recursive: true });
			const fake = await FakeModel.start(asks(["personal-tax"], "tax-bracket", { taxableIncome: 60000 }));
			let host: Host | undefined;
			try {
				host = await boot(state, fake, tree);
				const took = await turnOn(state, "personal-tax", tree);
				cards.push(await ask(state, fake, "personal-tax", tree));
				lines.push(`${name}${name === "trunk" ? ` (${TRUNK_REF})` : ""}: serving after ${took} ms; tool card ${cards.at(-1)}`);
			} finally {
				await host?.stop();
				await fake.close();
			}
		}
		return { pass: cards[0] !== "" && cards[0] === cards[1], evidence: lines.join("\n") };
	});

	await lane(2, "env", async () => {
		const state = stateDir();
		writePackage(join(state, "modules"), "sample-py", { py: "1.16.0" });
		writePackage(join(state, "modules"), "other");
		const fake = await FakeModel.start(asks(["sample-py", "other"], "where", { x: 1 }));
		const host = await boot(state, fake);
		try {
			const lines: string[] = [];
			let pass = true;
			for (const name of ["sample-py", "other"]) {
				await turnOn(state, name);
				const card = await ask(state, fake, name);
				const own = join(state, "modules-data", name);
				const venv = name === "sample-py" ? join(own, "files", `venv-${lockSha(join(state, "modules/sample-py")).slice(0, 12)}`) : null;
				const ok = card.includes(`"data":"${own}"`) && card.includes(`"venv":${JSON.stringify(venv)}`) && card.includes(`"filesReady":true`) && existsSync(join(own, "files"));
				pass &&= ok;
				lines.push(`${name}: ${ok ? "its own data dir" : "WRONG"}; expected data ${own}, venv ${venv}; card ${card}; files/ exists ${existsSync(join(own, "files"))}`);
			}
			return { pass, evidence: lines.join("\n") };
		} finally {
			await host.stop();
			await fake.close();
		}
	});

	const setupState = stateDir();
	const setupPkg = () => join(setupState, "modules/sample-py");
	await lane(3, "setup", async () => {
		const pkg = writePackage(join(setupState, "modules"), "sample-py", { py: "1.16.0" });
		const before = snapshot(pkg);
		const run = just(setupState, ["module", "setup", "sample-py"]);
		const venv = join(filesOf(setupState, "sample-py"), `venv-${lockSha(pkg).slice(0, 12)}`);
		const mark = existsSync(join(venv, ".psa-lock")) ? readFileSync(join(venv, ".psa-lock"), "utf8") : "(absent)";
		const listing = just(setupState, ["modules"]).out.split("\n").filter((l) => /sample-py|py:/.test(l)).join("\n");
		const pass = run.status === 0 && existsSync(join(venv, "bin/python")) && mark === lockSha(pkg) && snapshot(pkg) === before && !/is not a component kind|无效/.test(listing);
		return { pass, evidence: `just module setup sample-py: exit ${run.status}, ${run.ms} ms\n${run.out}\nvenv ${venv}\nbin/: ${ls(join(venv, "bin")).join(" ")}\n.psa-lock ${mark}\nsha256(py/uv.lock) ${lockSha(pkg)}\npackage files unchanged: ${snapshot(pkg) === before}\njust modules:\n${listing}` };
	});

	await lane(4, "setup-again", async () => {
		const pkg = setupPkg();
		const [files, listing, check] = [snapshot(filesOf(setupState, "sample-py")), just(setupState, ["modules"]).out, just(setupState, ["module", "check", pkg]).out];
		const run = just(setupState, ["module", "setup", "sample-py"]);
		const sameFiles = snapshot(filesOf(setupState, "sample-py")) === files;
		mkdirSync(join(pkg, "py/__pycache__"), { recursive: true });
		writeFileSync(join(pkg, "py/__pycache__/x.pyc"), "bytecode");
		const [listingAfter, checkAfter] = [just(setupState, ["modules"]).out, just(setupState, ["module", "check", pkg]).out];
		rmSync(join(pkg, "py/__pycache__"), { recursive: true });
		const pass = run.status === 0 && run.ms < 2000 && sameFiles && listingAfter === listing && checkAfter === check && /digest=[0-9a-f]{12}/.test(check);
		return { pass, evidence: `second just module setup: exit ${run.status}, ${run.ms} ms (rule: under 2000)\n${run.out}\nfiles/ unchanged: ${sameFiles}\nwith py/__pycache__/x.pyc in the package:\njust module check before: ${check}\njust module check after:  ${checkAfter}\njust modules output unchanged: ${listingAfter === listing}` };
	});

	await lane(5, "venv-retention", async () => {
		const pkg = setupPkg();
		const lines = [`start (six 1.16.0): ${venvsOf(setupState, "sample-py").join(" ")}`];
		const names: string[] = [`venv-${lockSha(pkg).slice(0, 12)}`];
		const counts: number[] = [];
		for (const six of ["1.15.0", "1.17.0"]) {
			writeFileSync(join(pkg, "py/pyproject.toml"), pyproject(six));
			lock(pkg);
			const run = just(setupState, ["module", "setup", "sample-py"]);
			names.push(`venv-${lockSha(pkg).slice(0, 12)}`);
			counts.push(venvsOf(setupState, "sample-py").length);
			lines.push(`six ${six}: setup exit ${run.status}, ${run.ms} ms; venvs now: ${venvsOf(setupState, "sample-py").join(" ")}`);
		}
		const left = venvsOf(setupState, "sample-py");
		const pass = counts[0] === 2 && counts[1] === 2 && new Set(names).size === 3 && left.includes(names[1]!) && left.includes(names[2]!) && !left.includes(names[0]!);
		return { pass, evidence: `${lines.join("\n")}\nin order of install: ${names.join(" ")}\nleft: current ${names[2]} and previous ${names[1]}; first ${names[0]} deleted: ${!left.includes(names[0]!)}` };
	});

	await lane(6, "no-uv", async () => {
		const state = stateDir();
		writePackage(join(state, "modules"), "sample-py", { py: "1.16.0" });
		const bin = join(state, "bin");
		mkdirSync(bin);
		symlinkSync(spawnSync("which", ["just"], { encoding: "utf8" }).stdout.trim(), join(bin, "just"));
		const path = [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
		const uvThere = spawnSync("which", ["uv"], { env: { PATH: path }, encoding: "utf8" }).status === 0;
		const run = just(state, ["module", "setup", "sample-py"], { env: { PATH: path } });
		const said = run.out.split("\n").filter((l) => !l.startsWith("error: recipe"));
		return { pass: !uvThere && run.status !== 0 && said.length === 1 && /找不到 uv/.test(said[0] ?? ""), evidence: `uv on this PATH: ${uvThere}\nexit ${run.status}\n${run.out}\nvenvs: ${venvsOf(state, "sample-py").join(" ") || "(none)"}` };
	});

	await lane(7, "limit", async () => {
		const state = stateDir();
		writePackage(join(state, "modules"), "slow", { feed: { sleepMs: 30_000, limit: "1m" } });
		const fake = await FakeModel.start({ router: [] });
		const host = await boot(state, fake);
		try {
			await turnOn(state, "slow");
			const written = join(filesOf(state, "slow"), "written-by-real");
			const waited = await within(90_000, () => existsSync(written));
			const times = existsSync(written) ? (JSON.parse(readFileSync(written, "utf8")) as { startedAt: number; endedAt: number }) : undefined;
			await sleep(1500);
			const db = new DatabaseSync(join(state, "modules-data/slow/data.db"), { readOnly: true });
			const rows = db.prepare(`SELECT note FROM "runs"`).all().map((r) => JSON.stringify({ ...r }));
			db.close();
			const ran = times ? times.endedAt - times.startedAt : -1;
			const feedLog = host.log().split("\n").filter((l: string) => /slow\/write|limit of/.test(l)).join("\n");
			return { pass: ran >= 30_000 && rows.length === 1 && !/limit of/.test(feedLog), evidence: `feed.json limit "1m", handler sleeps 30 s\nhandler ran ${ran} ms (file appeared ${waited} ms after the module was on)\nrows in runs: ${rows.join(" ") || "(none)"}\nhost log lines about the feed:\n${feedLog || "(none)"}` };
		} finally {
			await host.stop();
			await fake.close();
		}
	});

	await lane(8, "check", async () => {
		const state = stateDir();
		const out = join(state, "given-data-dir");
		const pkg = writePackage(join(state, "modules"), "sample-py", { py: "1.16.0", feed: { fixtureOut: out } });
		const run = just(state, ["module", "check", pkg]);
		const given = existsSync(out) ? readFileSync(out, "utf8") : "(the handler did not run)";
		const real = filesOf(state, "sample-py");
		const pass = run.status === 0 && /^ok sample-py@/m.test(run.out) && !/is not a component kind/.test(run.out) && given !== join(state, "modules-data/sample-py") && !existsSync(given) && !existsSync(join(real, "written-by-fixture"));
		return { pass, evidence: `just module check: exit ${run.status}\n${run.out}\nthe fixture's handler was given PSA_MODULE_DATA=${given}\nthat dir still exists: ${existsSync(given)}\nreal data dir ${join(state, "modules-data/sample-py")} has files/written-by-fixture: ${existsSync(join(real, "written-by-fixture"))}` };
	});

	await lane(9, "host-check", async () => {
		const state = stateDir();
		const out = join(state, "given-data-dir");
		const fake = await FakeModel.start({ router: [] });
		const host = await boot(state, fake);
		try {
			const pkg = writePackage(join(state, "modules"), "sample-py", { py: "1.16.0", feed: { fixtureOut: out } });
			const took = await turnOn(state, "sample-py");
			await within(10_000, () => existsSync(join(filesOf(state, "sample-py"), "written-by-real")));
			const given = existsSync(out) ? readFileSync(out, "utf8") : "(the handler did not run)";
			const serving = record(state, "sample-py")?.state.serving?.digest;
			mkdirSync(join(pkg, "py/__pycache__"), { recursive: true });
			writeFileSync(join(pkg, "py/__pycache__/x.pyc"), "bytecode");
			await sleep(3000);
			const after = record(state, "sample-py");
			const log = host.log();
			const real = ls(filesOf(state, "sample-py"));
			const pass = took >= 0 && !/is not a component kind/.test(log) && given !== join(state, "modules-data/sample-py") && !existsSync(given) && !real.includes("written-by-fixture") && real.includes("written-by-real") && after?.state.serving?.digest === serving && !after?.state.update;
			return { pass, evidence: `module active ${took} ms after just module on; record ${JSON.stringify(record(state, "sample-py")?.state)}\nhost log mentions "is not a component kind": ${/is not a component kind/.test(log)}\nhost log lines about the module:\n${log.split("\n").filter((l: string) => l.includes("sample-py")).join("\n")}\nthe fixture's handler was given PSA_MODULE_DATA=${given}; still exists: ${existsSync(given)}\nreal files/: ${real.join(" ")}\n3 s after py/__pycache__/x.pyc appeared in the package: serving digest unchanged ${after?.state.serving?.digest === serving}, update ${JSON.stringify(after?.state.update ?? null)}` };
		} finally {
			await host.stop();
			await fake.close();
		}
	});

	await lane(10, "try-purge", async () => {
		const state = stateDir();
		const pkg = writePackage(join(state, "modules"), "sample-py", { py: "1.16.0", feed: { fixtureOut: "" }, exam: true });
		const setup = just(state, ["module", "setup", "sample-py"]);
		const real = filesOf(state, "sample-py");
		writeFileSync(join(real, "kept.txt"), "the module's own file");
		const before = snapshot(real);
		const fake = await FakeModel.start({
			router: [on("开任务", /^\[对话\][\s\S]*数据目录在哪/, (c: string) => [inDomain(openTicket(c, "预演问目录"), "sample-py"), reply(c, "好")])],
			workers: [worker("预演问目录", on("调用", /^\[任务说明\]/, () => [domainTool("where", { x: 1 })]), on("汇报", /^\[模块工具\]/, (c: string) => [report("ready", `数据目录下有 files：${c}`)], 4000))],
		});
		writeFileSync(join(state, "config.json"), JSON.stringify({ models: fakeModels }));
		const scratch = mkdtempSync(join(tmpdir(), "psa-s1-try-"));
		let out = "";
		let seen = "(the rehearsal's files/ was never seen)";
		let ok = false;
		try {
			const child = spawn("just", ["module", "try", "sample-py"], { cwd: HEAD, env: { ...process.env, ...fakeAgentEnv(fake, join(state, "pi")), PSA_STATE_DIR: state, TMPDIR: scratch }, stdio: ["ignore", "pipe", "pipe"] });
			for (const stream of [child.stdout, child.stderr]) stream.setEncoding("utf8").on("data", (s: string) => (out += s));
			const closed = new Promise<number | null>((done) => child.once("close", done));
			const temp = () => join(scratch, ls(scratch).find((f) => f.startsWith("psa-try-")) ?? "none", "modules-data/sample-py/files");
			let status: number | null | undefined;
			void closed.then((code) => (status = code));
			while (status === undefined) {
				if (existsSync(temp())) seen = `rehearsal files/ at ${temp()}: ${ls(temp()).join(" ")}`;
				if (existsSync(join(temp(), "written-by-fixture"))) {
					const venv = ls(temp()).find((f) => f.startsWith("venv-")) ?? "";
					const link = venv !== "" && lstatSync(join(temp(), venv)).isSymbolicLink();
					ok = link && existsSync(join(temp(), "kept.txt")) && !lstatSync(join(temp(), "kept.txt")).isSymbolicLink();
					seen = `rehearsal files/ at ${temp()}: ${ls(temp()).join(" ")}; ${venv} is a symlink: ${link}; kept.txt is a copy: ${existsSync(join(temp(), "kept.txt"))}`;
				}
				await sleep(50);
			}
			const unchanged = snapshot(real) === before;
			const off = just(state, ["module", "off", "sample-py"]);
			const purge = just(state, ["module", "purge", "sample-py", "--confirm", "sample-py"]);
			const gone = !existsSync(join(state, "modules-data/sample-py"));
			return {
				pass: setup.status === 0 && status === 0 && ok && unchanged && purge.status === 0 && gone && existsSync(pkg),
				evidence: `setup exit ${setup.status}\njust module try: exit ${status}\n${out.trim()}\n${seen}\nreal files/ unchanged after the rehearsal (no written-by-fixture, same hashes): ${unchanged}\njust module off: ${off.out}\njust module purge: exit ${purge.status} ${purge.out}\nmodules-data/sample-py gone (files/ and every venv): ${gone}; package still there: ${existsSync(pkg)}`,
			};
		} finally {
			await fake.close();
			rmSync(scratch, { recursive: true, force: true });
		}
	});
	console.log(`\n${results.join("\n")}`);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (name: string, xs: number[]) => `${name}: median ${median(xs).toFixed(1)} ms, min ${Math.min(...xs).toFixed(1)}, max ${Math.max(...xs).toFixed(1)}, spread ${(Math.max(...xs) - Math.min(...xs)).toFixed(1)} ms, runs ${xs.length}`;

/** A real host process from `tree` with both sample packages switched on; ms until it prints its URL. */
async function bootOnce(tree: string): Promise<number> {
	const state = stateDir();
	for (const name of ["personal-tax", "personal-health"]) {
		cpSync(join(SAMPLE, name), join(state, "modules", name), { recursive: true });
		just(state, ["module", "on", name], { cwd: tree });
	}
	const fake = await FakeModel.start({ router: [] });
	const started = performance.now();
	const host = await boot(state, fake, tree);
	const took = performance.now() - started;
	await host.stop();
	await fake.close();
	rmSync(state, { recursive: true, force: true });
	return took;
}

/** `tree`'s own gateway over one package with a tool that does nothing; each call is the host-side time of one tool call. */
async function caller(tree: string, py: boolean): Promise<() => Promise<number>> {
	const { scanPackage } = await import(join(tree, "src/modules/validate.ts"));
	const { ModuleStore } = await import(join(tree, "src/modules/live.ts"));
	const { createGateway } = await import(join(tree, "src/modules/gateway.ts"));
	const { instanceData } = await import(join(tree, "src/modules/instance-data.ts"));
	const { moduleDataDir } = await import(join(tree, "src/modules/knowledge.ts"));
	const root = stateDir();
	const pkg = join(root, "modules/empty");
	mkdirSync(join(pkg, "tools/noop"), { recursive: true });
	writeFileSync(join(pkg, "module.json"), JSON.stringify({ schema: 1, name: "empty", version: "0.1.0", title: "empty", description: "perf" }));
	writeFileSync(join(pkg, "tools/noop/tool.json"), JSON.stringify({ title: "空", description: "什么都不做", input: { x: { type: "number", title: "x" } }, output: { y: { type: "number", title: "y" } }, effect: "read" }));
	writeFileSync(join(pkg, "tools/noop/index.ts"), "export default () => ({ y: 0 });\n");
	if (py) {
		mkdirSync(join(pkg, "py"));
		writeFileSync(join(pkg, "py/pyproject.toml"), pyproject("1.16.0"));
		writeFileSync(join(pkg, "py/uv.lock"), "x".repeat(200_000));
	}
	const scan = scanPackage(pkg, { runCases: false });
	if (!scan.ok) throw new Error(JSON.stringify(scan.problems));
	const store = new ModuleStore(join(root, "store"));
	store.keep("empty", scan.scan.digest, pkg);
	const gateway = createGateway({ copyDir: (m: string, d: string) => store.dirOf(m, d), serving: () => scan.scan.digest, dataDir: (m: string) => moduleDataDir(join(root, "state"), m), rows: instanceData(join(root, "state")), secret: () => undefined, log: () => {} });
	const who = { who: "worker", ticket: "tkt_1", pin: { module: "empty", digest: scan.scan.digest }, basis: "request", member: null, heardOthers: false };
	return async () => {
		const started = performance.now();
		const reply = await gateway.call(who, { kind: "tool", name: "noop", input: { x: 1 } });
		if (!reply.ok) throw new Error(JSON.stringify(reply));
		return performance.now() - started;
	};
}

async function perf(): Promise<void> {
	const base = trunk();
	const boots = { trunk: [] as number[], head: [] as number[] };
	for (let i = 0; i < 5; i++) {
		boots.trunk.push(await bootOnce(base));
		boots.head.push(await bootOnce(HEAD));
	}
	const call = { trunk: await caller(base, false), head: await caller(HEAD, false), headPy: await caller(HEAD, true) };
	const calls = { trunk: [] as number[], head: [] as number[], headPy: [] as number[] };
	for (const key of ["trunk", "head", "headPy"] as const) await call[key]();
	for (let i = 0; i < 20; i++) for (const key of ["trunk", "head", "headPy"] as const) calls[key].push(await call[key]());
	const bootExtra = median(boots.head) - median(boots.trunk);
	const callExtra = median(calls.head) - median(calls.trunk);
	const pyExtra = median(calls.headPy) - median(calls.trunk);
	const text = [
		`${bootExtra <= 200 ? "PASS" : "FAIL"} host start to URL with both sample packages switched on, trunk and head alternating 5 times each (rule: head median over trunk by more than 200 ms fails); head - trunk = ${bootExtra.toFixed(1)} ms`,
		line(`  trunk (${TRUNK_REF})`, boots.trunk),
		line("  head", boots.head),
		`${callExtra <= 20 && pyExtra <= 20 ? "PASS" : "FAIL"} one call of a tool that does nothing, through each tree's gateway, trunk and head alternating 20 times each after one warm-up (rule: head median over trunk by more than 20 ms fails); head - trunk = ${callExtra.toFixed(1)} ms, head with a 200 KB py/uv.lock - trunk = ${pyExtra.toFixed(1)} ms`,
		line("  trunk", calls.trunk),
		line("  head", calls.head),
		line("  head, package with py/uv.lock (hashed on every call)", calls.headPy),
	].join("\n");
	writeFileSync(join(outDir, "s1-perf.txt"), `${text}\n`);
	console.log(text);
}

try {
	await (mode === "perf" ? perf() : lanes());
} finally {
	if (existsSync(TRUNK)) spawnSync("git", ["worktree", "remove", "--force", TRUNK], { cwd: HEAD });
}
