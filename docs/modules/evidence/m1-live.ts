/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/m1-live.ts [lanes|perf|<lane numbers, e.g. 4 or 1,4>] [outDir]
 *
 * Lane 1 and perf leave a worktree of origin/main at /tmp/psa-m1-trunk for reruns.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fakeModels, writeConfig } from "../../../tests/e2e/harness.ts";
import { authWorld, runGoogleAuth, startFakeGoogle, type AuthWorld, type FakeGoogle, type FakeGoogleOptions } from "../../../tests/helpers/fake-google.ts";

const HEAD = resolve(import.meta.dirname, "../../..");
const TRUNK = "/tmp/psa-m1-trunk";
const [mode = "lanes", outDir = "/tmp/swarm-m1/owner"] = process.argv.slice(2);
const LANES = mode === "lanes" ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : /^\d+(,\d+)*$/.test(mode) ? mode.split(",").map(Number) : [];
const STOCK_TA = "docs/modules/examples/stock-ta";
mkdirSync(outDir, { recursive: true });

type Verdict = { pass: boolean | "pending"; evidence: string };
const made: string[] = [];
const fakes: FakeGoogle[] = [];
const outputs: string[] = [];

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (label: string, xs: number[]) => `${label}: median ${median(xs).toFixed(0)} ms, min ${Math.min(...xs).toFixed(0)}, max ${Math.max(...xs).toFixed(0)}, runs ${xs.map((x) => x.toFixed(0)).join(" ")}`;

function trunk(): string {
	if (!existsSync(TRUNK)) {
		const added = spawnSync("git", ["worktree", "add", "--detach", TRUNK, "origin/main"], { cwd: HEAD, stdio: "inherit" });
		if (added.status !== 0) throw new Error(`git worktree add ${TRUNK} failed`);
		symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
	}
	return TRUNK;
}

function scratch(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	made.push(dir);
	return dir;
}

function write(root: string, files: Record<string, string>): string {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

async function world(options: FakeGoogleOptions = {}, extra = ""): Promise<AuthWorld> {
	const fake = await startFakeGoogle(options);
	fakes.push(fake);
	return authWorld(fake, scratch("m1-st-"), `GOOGLE_OAUTH_CLIENT_ID=${fake.client.id}\nGOOGLE_OAUTH_CLIENT_SECRET=${fake.client.secret}\n${extra}`, { models: fakeModels });
}

function just(cwd: string, state: string, args: string[]): { status: number | null; out: string } {
	const run = spawnSync("just", args, { cwd, env: { ...process.env, PSA_STATE_DIR: state }, encoding: "utf8", timeout: 120_000 });
	const out = `$ just ${args.join(" ")}\n${run.stdout}${run.stderr}(exit ${run.status})`;
	outputs.push(out);
	return { status: run.status, out };
}

function auth(w: AuthWorld, args: string[], { cwd = HEAD, timeoutMs = 20_000 } = {}) {
	const run = runGoogleAuth(w, ["just", "google-auth"], args, { cwd, timeoutMs });
	void run.done.then((result) => outputs.push(result.out));
	return run;
}

const redirectOf = (url: URL) => url.searchParams.get("redirect_uri")!;
const portClosed = (redirect: string) => fetch(redirect).then(() => false, () => true);

async function lane(n: number, slug: string, body: () => Promise<Verdict>): Promise<void> {
	if (!LANES.includes(n)) return;
	let verdict: Verdict;
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: `threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` };
	}
	const word = verdict.pass === "pending" ? "PENDING" : verdict.pass ? "PASS" : "FAIL";
	const text = `${word} lane ${n} ${slug}\n${verdict.evidence}\n`;
	writeFileSync(join(outDir, `m1-${slug}.txt`), text);
	console.log(text);
}

const count = (out: string, what: "pass" | "fail") => Number(out.match(new RegExp(`^ℹ ${what} (\\d+)$`, "m"))?.[1] ?? NaN);
const passed = (out: string) => new Set(out.split("\n").flatMap((l) => (l.startsWith("✔ ") ? [l.slice(2).replace(/ \([\d.]+m?s\)$/, "")] : [])));

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		const base = trunk();
		const list = spawnSync("just", ["--list"], { cwd: base, encoding: "utf8" }).stdout;
		const trunkHas = /^\s*google-auth\b/m.test(list);
		const w = await world();
		const run = auth(w, ["read"]);
		await fetch(await run.url);
		const head = await run.done;
		const wrote = /^GMAIL_READ_REFRESH_TOKEN=/m.test(readFileSync(w.secrets, "utf8"));
		const checks = [base, HEAD].map((dir) => just(dir, scratch("m1-st-"), ["module", "check", STOCK_TA]));
		const tests = [base, HEAD].map((dir) => just(dir, scratch("m1-st-"), ["test"]));
		const [before, after] = tests.map((t) => passed(t.out)) as [Set<string>, Set<string>];
		const added = [...after].filter((name) => !before.has(name));
		const removed = [...before].filter((name) => !after.has(name));
		const delta = count(tests[1]!.out, "pass") - count(tests[0]!.out, "pass");
		const pass = !trunkHas && head.status === 0 && wrote && checks.every((c) => c.status === 0) && delta === added.length - removed.length && count(tests[1]!.out, "fail") === 0;
		return {
			pass,
			evidence: [
				`trunk just --list has google-auth: ${trunkHas}`,
				head.out,
				`secretsFile has GMAIL_READ_REFRESH_TOKEN line: ${wrote}`,
				...checks.map((c, i) => `${i === 0 ? "trunk" : "head"} ${c.out.split("\n").slice(1).join(" ")}`),
				`just test pass: trunk ${count(tests[0]!.out, "pass")} (fail ${count(tests[0]!.out, "fail")}), head ${count(tests[1]!.out, "pass")} (fail ${count(tests[1]!.out, "fail")}); head - trunk = ${delta}; passed only on head ${added.length}, only on trunk ${removed.length}`,
				`only on head (new or renamed):\n  ${added.join("\n  ")}`,
				`only on trunk (removed or renamed):\n  ${removed.join("\n  ")}`,
				...tests.flatMap((t, i) => t.out.split("\n").filter((l) => l.startsWith("✖")).map((l) => `${i === 0 ? "trunk" : "head"} ${l}`)),
			].join("\n"),
		};
	});

	await lane(2, "draft", async () => {
		const w = await world();
		const run = auth(w, ["draft"]);
		const scope = (await run.url).searchParams.get("scope");
		await fetch(await run.url);
		const result = await run.done;
		const file = readFileSync(w.secrets, "utf8");
		const pass = result.status === 0 && scope === "https://www.googleapis.com/auth/gmail.compose" && /^GMAIL_DRAFT_REFRESH_TOKEN=/m.test(file) && !/GMAIL_READ_REFRESH_TOKEN/.test(file);
		return { pass, evidence: `requested scope: ${scope}\n${result.out}\nsecretsFile names: ${file.match(/^[A-Z_]+(?==)/gm)?.join(", ")}` };
	});

	await lane(3, "extra-scope", async () => {
		const w = await world({ grant: () => ({ scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose" }) });
		const before = sha(w.secrets);
		const run = auth(w, ["read"]);
		await fetch(await run.url);
		const result = await run.done;
		const pass = result.status !== 0 && /^Google 给的 scope 是 gmail\.readonly gmail\.compose，不是只有 gmail\.readonly，什么都没写$/m.test(result.out) && sha(w.secrets) === before;
		return { pass, evidence: `${result.out}\nsecretsFile sha256 before ${before}\nsecretsFile sha256 after  ${sha(w.secrets)}` };
	});

	await lane(4, "state", async () => {
		const w = await world();
		const before = sha(w.secrets);
		const run = auth(w, ["read"]);
		const forged = new URL(redirectOf(await run.url));
		forged.searchParams.set("state", "forged-state");
		forged.searchParams.set("code", "4/forged-code");
		const wrong = await fetch(forged);
		const unchanged = sha(w.secrets) === before;
		await fetch(await run.url);
		const result = await run.done;
		const wrote = /^GMAIL_READ_REFRESH_TOKEN=/m.test(readFileSync(w.secrets, "utf8"));
		const pass = wrote && unchanged && wrong.status === 400 && result.status === 0;
		return { pass, evidence: `wrong state: HTTP ${wrong.status} ${(await wrong.text()).trim()}; secretsFile unchanged after it: ${unchanged}\n${result.out}\nright state wrote the line: ${wrote}\nfake log: ${w.fake.log.join(", ")}` };
	});

	await lane(5, "timeout", async () => {
		const w = await world();
		const before = sha(w.secrets);
		const run = auth(w, ["read"], { timeoutMs: 1500 });
		const redirect = redirectOf(await run.url);
		const result = await run.done;
		const closed = await portClosed(redirect);
		const pass = result.status !== 0 && closed && sha(w.secrets) === before;
		return { pass, evidence: `PSA_GOOGLE_AUTH_TIMEOUT_MS=1500\n${result.out}\nport ${redirect} closed: ${closed}\nsecretsFile unchanged: ${sha(w.secrets) === before}` };
	});

	await lane(6, "replace", async () => {
		const others = Array.from({ length: 10 }, (_, i) => `LANE6_KEY_${i}=value-${i}`).join("\n");
		const w = await world({}, `GMAIL_READ_REFRESH_TOKEN=1//old-token\n${others}\n`);
		const before = readFileSync(w.secrets, "utf8").split("\n");
		const run = auth(w, ["read"]);
		await fetch(await run.url);
		const result = await run.done;
		const after = readFileSync(w.secrets, "utf8").split("\n");
		const changed = after.flatMap((l, i) => (l === before[i] ? [] : [i]));
		const mode = (statSync(w.secrets).mode & 0o777).toString(8);
		const pass = result.status === 0 && before.length === after.length && changed.length === 1 && after[changed[0]!]!.startsWith("GMAIL_READ_REFRESH_TOKEN=1//fake-refresh-") && mode === "600";
		return { pass, evidence: `${result.out}\nlines before ${before.length}, after ${after.length}; changed line numbers ${changed.join(",")} (${changed.map((i) => after[i]!.split("=")[0]).join(",")}); mode ${mode}` };
	});

	await lane(7, "owners", async () => {
		const runs: { status: number | null; out: string; expect: RegExp }[] = [];
		for (const [module, secret, expect] of [
			["lab7-polygon", "POLYGON_API_KEY", /POLYGON_API_KEY 属于模块 stock-ta，别的模块不能用/],
			["lab7-draft", "GMAIL_DRAFT_REFRESH_TOKEN", /GMAIL_DRAFT_REFRESH_TOKEN 属于宿主，模块不能用/],
			["lab7-foo", "FOO_KEY", /FOO_KEY 不在密钥归属表里，本模块自己的密钥要以 LAB7_FOO__ 开头/],
			["lab7", "LAB7_FOO_KEY", /LAB7_FOO_KEY 不在密钥归属表里，本模块自己的密钥要以 LAB7__ 开头/],
		] as const) {
			const pkg = write(join(scratch("m1-pkg-"), module), {
				"module.json": JSON.stringify({ schema: 1, name: module, version: "0.1.0", title: module, description: module }),
				"tools/probe/tool.json": JSON.stringify({ title: "probe", description: "probe", input: { x: { type: "number", title: "x" } }, output: { y: { type: "number", title: "y" } }, secrets: [secret] }),
				"tools/probe/index.ts": "export default async () => ({ y: 1 });\n",
				"tools/probe/cases.json": JSON.stringify([{ name: "one", input: { x: 1 }, expect: { y: 1 } }]),
			});
			const state = scratch("m1-st-");
			writeConfig(state, fakeModels);
			for (const command of ["check", "try"]) runs.push({ ...just(HEAD, state, ["module", command, pkg]), expect });
		}
		const pass = runs.length === 8 && runs.every((r) => r.status !== 0 && r.expect.test(r.out) && !/预演 lab7/.test(r.out));
		return { pass, evidence: runs.map((r) => r.out).join("\n\n") };
	});

	await lane(8, "no-leak", async () => {
		const w = await world({}, "LAB8__ECHO_KEY=value-from-secrets-file-lane8\n");
		const pkg = write(join(scratch("m1-pkg-"), "lab8"), {
			"module.json": JSON.stringify({ schema: 1, name: "lab8", version: "0.1.0", title: "lab8", description: "lab8" }),
			"tools/echo/tool.json": JSON.stringify({ title: "echo", description: "echoes its key", input: { x: { type: "number", title: "x" } }, output: { got: { type: "text", title: "got" } }, secrets: ["LAB8__ECHO_KEY"] }),
			"tools/echo/index.ts": "export default async () => ({ got: process.env.LAB8__ECHO_KEY ?? null });\n",
			"tools/echo/cases.json": JSON.stringify([{ name: "echo", input: { x: 1 }, expect: { got: "value-from-secrets-file-lane8" } }]),
		});
		const check = just(HEAD, w.state, ["module", "check", pkg]);
		const echoedFixture = /got \{"got":"fixture"\}/.test(check.out);
		const echoedReal = /got \{"got":"value-from-secrets-file-lane8"\}|^ok lab8/m.test(check.out);
		const issued = fakes.flatMap((f) => f.issued);
		const all = outputs.join("\n");
		const leaked = issued.filter((value) => all.includes(value));
		const pass = echoedFixture && !echoedReal && issued.length > 0 && leaked.length === 0;
		return {
			pass,
			evidence: `the case expects the secretsFile value, so the check's failure line shows what the tool got:\n${check.out}\ntool got the fixture value: ${echoedFixture}; got the secretsFile value: ${echoedReal}\nscanned ${outputs.length} command outputs from this run for ${issued.length} codes and tokens the fakes issued: ${leaked.length} found`,
		};
	});

	await lane(9, "real-read", async () => ({
		pass: "pending",
		evidence: [
			"真账号, 时段 1. The coordinator runs this with the user present, on the laptop, at this PR's head:",
			"  cd <worktree at the PR head> && PSA_STATE_DIR=<the laptop's state dir with secretsFile> just google-auth read",
			"  (user opens the printed URL, clicks Advanced > Go to PSA mail (unsafe), allows; screenshot the 127.0.0.1 page to /tmp/swarm-m1/worker-9/m1-real-read.png)",
			"  PSA_STATE_DIR=<same> just google-auth read --check",
			"Pass when the first prints 已写入 secretsFile 的 GMAIL_READ_REFRESH_TOKEN（gmail.readonly） and --check prints 能换到 access token（gmail.readonly，...）.",
		].join("\n"),
	}));

	await lane(10, "real-copy", async () => ({
		pass: "pending",
		evidence: [
			"真账号, 时段 1, after lane 9. Default route of docs/deploy/gmail.md section 2:",
			"  the copy command in the section 给旧 Mac（默认：笔记本上授权，复制三行）, run as written with ssh -o BatchMode=yes: it replaces same-named lines on the old Mac and is safe to rerun",
			"  ssh -o BatchMode=yes <old Mac> 'cd <repo checkout with this PR> && just google-auth read --check' > /tmp/swarm-m1/worker-10/m1-real-copy.txt",
			"Pass when the old Mac prints 能换到 access token（gmail.readonly，...） and m1-real-copy.txt contains no token (rg '1//|ya29\\.' finds nothing).",
		].join("\n"),
	}));
}

async function perf(): Promise<void> {
	const base = trunk();
	const callbacks: number[] = [];
	for (let i = 0; i < 10; i++) {
		const w = await world();
		const run = auth(w, ["read"]);
		const url = await run.url;
		const started = performance.now();
		await fetch(url);
		const result = await run.done;
		callbacks.push(performance.now() - started);
		if (result.status !== 0) throw new Error(result.out);
	}
	const checks = { trunk: [] as number[], head: [] as number[] };
	for (let i = 0; i < 5; i++) {
		for (const [side, dir] of [["trunk", base], ["head", HEAD]] as const) {
			const started = performance.now();
			const run = just(dir, scratch("m1-st-"), ["module", "check", STOCK_TA]);
			checks[side].push(performance.now() - started);
			if (run.status !== 0) throw new Error(run.out);
		}
	}
	const extra = median(checks.head) - median(checks.trunk);
	const text = [
		`baseline (trunk ${base}, origin/main): just module check ${STOCK_TA} median ${median(checks.trunk).toFixed(0)} ms`,
		`${median(callbacks) <= 500 ? "PASS" : "FAIL"} callback to exit: the browser's callback request sent to \`just google-auth read\` exiting (token exchange with the fake, writeSecret, process exit), 10 runs (rule: median over 500 ms fails, budget inferred)`,
		line("  head", callbacks),
		`${extra <= 200 ? "PASS" : "FAIL"} just module check ${STOCK_TA} (includes \`just\` and node start-up), trunk and head alternating 5 times each (rule: head median over trunk by more than 200 ms fails); head - trunk = ${extra.toFixed(0)} ms`,
		line("  trunk", checks.trunk),
		line("  head", checks.head),
	].join("\n");
	writeFileSync(join(outDir, "m1-perf.txt"), `${text}\n`);
	console.log(text);
}

try {
	await (mode === "perf" ? perf() : lanes());
} finally {
	await Promise.all(fakes.map((f) => f.close()));
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
}
