/**
 *   R3_SECRETS=<host secrets .env> node --import ./src/pi-runtime.mjs docs/modules/evidence/r3-live.ts [tools|real|perf] [outDir]
 *
 * R3_SECRETS names a .env file the script reads FINNHUB_API_KEY and POLYGON_API_KEY from; the environment wins over the file. Nothing prints a value.
 * Trunk is a detached worktree of origin/main at <outDir>/trunk. The real-model lanes need a seeded data dir at <outDir>/seed
 * (stock-ta set up and scanned once, as r2b-live.ts builds it); copy one in or let `real` build it.
 *
 * tools  Lanes 1, 2, 3, 4, 7, 9, 10 offline (fixtures, a stand-in Finnhub, the fake model); lanes 5 and 8 and the tool probe on real Finnhub.
 * real   Lane 6: `just module try` runs evals/earnings-gap.md alone on openai-codex models with real Finnhub.
 * perf   The 风险计划 input tokens: the same question on a real host, trunk and head alternating 3 each.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const PLAN_Q = "让风险与交易计划看一下：NVDA 在 170 进、160 止损、190 目标，打算拿两周，怎么看";
const [mode = "tools", outDir = "/tmp/swarm-r3/owner"] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
const SEED = join(outDir, "seed");
mkdirSync(outDir, { recursive: true });

const { readSecret } = await import(join(HEAD, "src/secrets.ts"));
const { runModuleCodeAsync } = await import(join(HEAD, "src/modules/run-code.ts"));
const { scanPackage } = await import(join(HEAD, "src/modules/validate.ts"));
const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, dispatch, domainTool, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
type Host = Awaited<ReturnType<typeof harness.startHost>>;
type Reply = { ok: true; output: Record<string, unknown> } | { ok: false; note: string };

const secret = (name: string) => readSecret([name], name, process.env, process.env["R3_SECRETS"])?.key ?? "";
const FINNHUB = secret("FINNHUB_API_KEY");
const POLYGON = secret("POLYGON_API_KEY");
const pkgOf = (tree: string) => join(tree, "docs/modules/examples/stock-ta");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const temp = () => mkdtempSync(join(tmpdir(), "psa-r3-"));
const shaOf = (tree: string) => spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: tree, encoding: "utf8" }).stdout.trim();

function just(state: string, args: string[], tree = HEAD, limitMs = 600_000) {
	const run = spawnSync("just", args, { cwd: tree, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300" }, encoding: "utf8", timeout: limitMs });
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

async function within<T>(limitMs: number, probe: () => T | undefined, stepMs = 200): Promise<T | undefined> {
	for (const end = Date.now() + limitMs; Date.now() < end; await sleep(stepMs)) {
		const found = probe();
		if (found !== undefined) return found;
	}
	return probe();
}

async function standIn(body: () => unknown) {
	const { createServer } = await import("node:http");
	const urls: string[] = [];
	const server = createServer((req, res) => {
		urls.push(req.url ?? "");
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body()));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	return { urls, base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) };
}

function installPackage(state: string, tree: string, finnhubBase?: string): string {
	const pkg = join(state, "modules/stock-ta");
	cpSync(pkgOf(tree), pkg, { recursive: true });
	if (finnhubBase !== undefined) writeFileSync(join(pkg, "tools/earnings-date/finnhub.json"), JSON.stringify({ baseUrl: finnhubBase }));
	return pkg;
}

const fixture = (name: string) => JSON.parse(readFileSync(join(pkgOf(HEAD), "tools/earnings-date/fixtures", `${name}.json`), "utf8")).body;
const earnings = (pkg: string, input: unknown, key = FINNHUB): Promise<Reply> =>
	runModuleCodeAsync({ packageDir: pkg, component: "tools/earnings-date", dataDir: temp() }, "index.ts", input, key === "" ? {} : { FINNHUB_API_KEY: key });

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
	const file = join(outDir, `r3-${slug}.txt`);
	let text = verdict.evidence;
	for (const key of [FINNHUB, POLYGON]) if (key !== "") text = text.replaceAll(key, "<key>");
	writeFileSync(file, `${word} lane ${n}\n${text.replaceAll(tmpdir(), "<tmp>").replaceAll(HEAD, "<repo>")}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

function trunkTree(): string {
	if (!existsSync(join(TRUNK, "justfile"))) {
		spawnSync("git", ["fetch", "-q", "origin", "main"], { cwd: HEAD });
		const add = spawnSync("git", ["worktree", "add", "--detach", TRUNK, "origin/main"], { cwd: HEAD, encoding: "utf8" });
		if (add.status !== 0) throw new Error(add.stderr);
		symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
	}
	return TRUNK;
}

async function tools(): Promise<void> {
	await lane(1, "regression", async () => {
		const trunk = trunkTree();
		const inputs = [{ entry: 170, stop: 160, target: 190 }, { entry: 170, stop: 160, target: 190, atr: 6.2 }, { entry: 100, stop: 105, target: 90 }];
		const lines: string[] = [];
		let same = true;
		for (const input of inputs) {
			const [t, h] = await Promise.all([trunk, HEAD].map((tree) => runModuleCodeAsync({ packageDir: pkgOf(tree), component: "tools/risk-reward", dataDir: temp() }, "index.ts", input)));
			const a = JSON.stringify(t), b = JSON.stringify(h);
			same &&= a === b;
			lines.push(`${a === b ? "same" : "DIFF"}  ${JSON.stringify(input)}\n  trunk ${a}\n  head  ${b}`);
		}
		const trunkHas = existsSync(join(pkgOf(trunk), "tools/earnings-date"));
		return { pass: same && !trunkHas, evidence: `trunk ${shaOf(trunk)}, head ${shaOf(HEAD)}; risk-reward with the same entry, stop and target on both\n${lines.join("\n")}\ntrunk has tools/earnings-date: ${trunkHas} (lanes 2 to 9 cover the new tool)` };
	});

	const finnhub = await standIn(() => answer);
	let answer: unknown = fixture("nvda");
	try {
		const pkg = installPackage(temp(), HEAD, finnhub.base);
		await lane(2, "near", async () => {
			answer = fixture("nvda");
			const r = await earnings(pkg, { symbol: "NVDA", now: "2026-11-12T16:00:00Z" }, "fixture-key");
			const out = r.ok ? r.output : {};
			return { pass: r.ok && out["date"] === "2026-11-17" && out["time"] === "盘后" && out["tradingDays"] === 3, evidence: `fixture nvda.json (real Finnhub reply, two rows, unsorted), now 2026-11-12 11:00 美东\n${JSON.stringify(r)}\nrequest ${finnhub.urls.at(-1)}` };
		});
		await lane(3, "none", async () => {
			answer = fixture("spy-none");
			const r = await earnings(pkg, { symbol: "SPY", now: "2026-11-13T16:00:00Z" }, "fixture-key");
			return { pass: r.ok && r.output["note"] === "120 天内没有已公布的财报日" && !("date" in r.output), evidence: `fixture spy-none.json (empty calendar)\n${JSON.stringify(r)}` };
		});
		await lane(4, "no-key", async () => {
			const before = finnhub.urls.length;
			const r = await earnings(pkg, { symbol: "NVDA" }, "");
			return { pass: !r.ok && r.note.split("\n").length === 1 && /FINNHUB_API_KEY/.test(r.note) && /密钥文件/.test(r.note) && finnhub.urls.length === before, evidence: `no FINNHUB_API_KEY: ${JSON.stringify(r)}\nrequests to the stand-in Finnhub during the call: ${finnhub.urls.length - before}` };
		});
	} finally {
		await finnhub.close();
	}

	await lane(5, "real", async () => {
		if (FINNHUB === "") return { pass: "inconclusive", evidence: "no FINNHUB_API_KEY in the environment or R3_SECRETS" };
		const asked = new Date().toISOString();
		const got = Object.fromEntries(await Promise.all(["NVDA", "MSFT", "SPY"].map(async (s) => [s, await earnings(pkgOf(HEAD), { symbol: s })] as const)));
		const dated = (s: string) => got[s]!.ok && /^\d{4}-\d{2}-\d{2}$/.test(String(got[s]!.output["date"]));
		const spy = got["SPY"]!;
		return { pass: dated("NVDA") && dated("MSFT") && spy.ok && spy.output["note"] === "120 天内没有已公布的财报日", evidence: `real Finnhub, asked ${asked}\n${Object.entries(got).map(([s, r]) => `${s}: ${JSON.stringify(r)}`).join("\n")}` };
	});

	await lane(7, "uses", async () => {
		const finnhub = await standIn(() => fixture("nvda"));
		const state = temp();
		installPackage(state, HEAD, finnhub.base);
		const brief = "NVDA 财报日";
		const structureTask = "看 NVDA 的形态";
		const riskTask = "给 NVDA 一个计划";
		const fake = await FakeModel.start({
			router: [on("开任务", /^\[对话\][\s\S]*NVDA 财报日/, (c: string) => {
				const open = openTicket(c, brief);
				return [{ ...open, args: { decisions: (open.args.decisions as object[]).map((d) => ({ ...d, domain: "stock-ta" })) } }, reply(c, "好")];
			})],
			workers: [
				worker(brief, on("派给结构形态", /^\[任务说明\]/, () => [dispatch("structure-pattern", structureTask)]), on("再派风险计划", /^\[成员回复\]/, () => [dispatch("risk-plan", riskTask)]), on("汇报", /^\[成员回复\]/, (c: string) => [report("ready", c)])),
				worker(structureTask, on("越出 uses 调 earnings-date", /^\[派活\]/, () => [domainTool("earnings-date", { symbol: "NVDA" })]), on("交回", /[\s\S]/, (c: string) => `结构形态拿到：${c.slice(0, 300)}`)),
				worker(riskTask, on("调 earnings-date", /^\[派活\]/, () => [domainTool("earnings-date", { symbol: "NVDA" })]), on("交回", /[\s\S]/, (c: string) => `风险计划拿到：${c.slice(0, 300)}`)),
			],
		});
		let host: Host | undefined;
		try {
			writeFileSync(join(state, "secrets.env"), "FINNHUB_API_KEY=fixture-key\n", { mode: 0o600 });
			host = await harness.startHost({ models: harness.fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0, modulesDirs: [join(state, "modules")], secretsFile: "secrets.env" }, env: fakeAgentEnv(fake, join(state, "pi")), timeoutMs: 60_000 });
			just(state, ["module", "on", "stock-ta"]);
			await within(30_000, () => (query(join(state, "state.db"), "SELECT record FROM module_records WHERE name = 'stock-ta'").some((r) => JSON.parse(String(r["record"])).state.at === "active") ? true : undefined));
			just(state, ["say", "NVDA 财报日"]);
			const done = await within(120_000, () => query(join(state, "state.db"), "SELECT summary FROM reports WHERE status = 'ready'").at(0)?.["summary"] as string | undefined);
			const gateway = readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[gateway]") && l.includes("earnings-date"));
			const refused = gateway.filter((l) => /structure-pattern.* not-in-uses /.test(l));
			const allowed = gateway.filter((l) => / risk-plan request ok /.test(l));
			return { pass: refused.length === 1 && allowed.length >= 1, evidence: `the fake 结构形态 called domain_tool earnings-date (not in its uses), then the fake 风险计划 did (in its uses)\ngateway:\n${gateway.join("\n")}\nreport:\n${done ?? "(none)"}` };
		} finally {
			await host?.stop();
			await fake.close();
			await finnhub.close();
		}
	});

	await lane(8, "repeat", async () => {
		if (FINNHUB === "") return { pass: "inconclusive", evidence: "no FINNHUB_API_KEY" };
		const runs: Reply[] = [];
		for (let i = 0; i < 5; i++) runs.push(await earnings(pkgOf(HEAD), { symbol: "NVDA" }));
		const texts = runs.map((r) => JSON.stringify(r));
		return { pass: runs.every((r) => r.ok) && new Set(texts).size === 1 && !texts.some((t) => /429/.test(t)), evidence: `real Finnhub, NVDA five times back to back\n${texts.join("\n")}` };
	});

	await lane(9, "schema", async () => {
		const descriptor = JSON.parse(readFileSync(join(pkgOf(HEAD), "tools/earnings-date/tool.json"), "utf8"));
		const schema = JSON.stringify(descriptor.output);
		const banned = /eps|revenue|estimate|actual|surprise|营收|预期|实际|EPS/i;
		return { pass: !banned.test(schema) && !/stock\/earnings/.test(readFileSync(join(pkgOf(HEAD), "tools/earnings-date/index.ts"), "utf8")), evidence: `tools/earnings-date/tool.json output fields: ${Object.keys(descriptor.output).join(", ")}\n${JSON.stringify(descriptor.output, null, 2)}\nno EPS, revenue or estimate field; index.ts never requests /stock/earnings` };
	});

	await lane(10, "check", async () => {
		const run = just(temp(), ["module", "check", pkgOf(HEAD)]);
		return { pass: run.status === 0 && /^ok stock-ta@/m.test(run.out) && /tools=10\b/.test(run.out), evidence: run.out };
	});

	await lane("perf-tool", "perf-tool", async () => {
		if (FINNHUB === "") return { pass: "inconclusive", evidence: "no FINNHUB_API_KEY" };
		const times: number[] = [];
		const failed: string[] = [];
		for (let i = 0; i < 20; i++) {
			const t0 = performance.now();
			const r = await earnings(pkgOf(HEAD), { symbol: i % 2 ? "MSFT" : "NVDA" });
			times.push(performance.now() - t0);
			if (!r.ok) failed.push(r.note);
		}
		return { pass: median(times) <= 2000 && failed.length === 0, evidence: `earnings-date host-side time (runModuleCodeAsync, child process + one real Finnhub request), 20 calls alternating NVDA and MSFT (rule: median over 2 s fails)\nmedian ${Math.round(median(times))} ms, min ${Math.round(Math.min(...times))}, max ${Math.round(Math.max(...times))}\nruns ${times.map(Math.round).join(" ")}\nfailed ${failed.length} ${failed.join(" | ")}` };
	});
}

function seededState(tree: string): string {
	if (!existsSync(join(SEED, "modules-data/stock-ta/files/ta/ta.sqlite"))) throw new Error(`no seeded data dir at ${SEED}: copy one built by r2b-live.ts`);
	const state = mkdtempSync(join(tmpdir(), "psa-r3-real-"));
	mkdirSync(join(state, "modules-data"), { recursive: true });
	if (spawnSync("cp", ["-cR", join(SEED, "modules-data/stock-ta"), join(state, "modules-data/stock-ta")]).status !== 0) throw new Error("could not clone the seed data dir");
	installPackage(state, tree);
	writeFileSync(join(state, "secrets.env"), `POLYGON_API_KEY=${POLYGON}\nFINNHUB_API_KEY=${FINNHUB}\n`, { mode: 0o600 });
	return state;
}

async function real(): Promise<void> {
	await lane(6, "eval", async () => {
		if (FINNHUB === "") return { pass: "inconclusive", evidence: "no FINNHUB_API_KEY" };
		const state = seededState(HEAD);
		const evals = join(state, "modules/stock-ta/evals");
		for (const f of readdirSync(evals)) if (f !== "earnings-gap.md") rmSync(join(evals, f));
		writeFileSync(join(state, "config.json"), JSON.stringify({ models: REAL, secretsFile: "secrets.env" }));
		const tool = await earnings(pkgOf(HEAD), { symbol: "NVDA" });
		const date = tool.ok ? String(tool.output["date"]) : "(none)";
		const run = just(state, ["module", "try", join(state, "modules/stock-ta")], HEAD, 1_200_000);
		const block = /(PASS|FAIL) earnings-gap[\s\S]*?(?=\n\d+\/\d+ 道考题)/.exec(run.out)?.[0] ?? run.out;
		const line = block.split("\n").find((l) => l.includes("财报日") && l.includes("跳空")) ?? "";
		const checks: Record<string, boolean> = {
			"the rehearsal judged earnings-gap PASS (stock-ta ticket, used earnings-date and risk-reward, 财报日 and 跳空 in the report)": /^PASS earnings-gap/.test(block),
			"a line names the earnings date and the gap risk": line !== "",
			[`the date matches the tool's real answer (${date})`]: block.includes(date) || block.includes(date.slice(5).replace("-", "月") + "日") || block.includes(`${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`) || block.includes(`${Number(date.slice(5, 7))}/${Number(date.slice(8))}`),
		};
		return { pass: Object.values(checks).every(Boolean), evidence: `just module try, evals/earnings-gap.md alone (openai-codex models ${JSON.stringify(REAL)}, real Finnhub and Massive)\nearnings-date NVDA right before: ${JSON.stringify(tool)}\nchecks:\n${Object.entries(checks).map(([k, v]) => `${v ? "ok  " : "FAIL"} ${k}`).join("\n")}\nthe line: ${line}\n\nfull output:\n${run.out.replace(/临时状态目录 \S+/g, "临时状态目录 <tmp>")}` };
	});
}

type Usage = { input: number; cacheRead?: number; cacheWrite?: number };
/** Counts cacheRead and cacheWrite as prompt tokens, so trunk and head compare whole prompts. */
function riskPlanTokens(state: string): { first: number; total: number; calls: number } | undefined {
	const root = join(state, "workers");
	if (!existsSync(root)) return undefined;
	const dirs = readdirSync(root).map((t) => join(root, t, "team", "risk-plan")).filter(existsSync);
	const usages = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(d, f), "utf8").split("\n").filter(Boolean).flatMap((l) => {
		const m = JSON.parse(l).message as { role?: string; usage?: Usage } | undefined;
		return m?.role === "assistant" && m.usage ? [m.usage.input + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0)] : [];
	})));
	return usages.length === 0 ? undefined : { first: usages[0]!, total: usages.reduce((a, b) => a + b, 0), calls: usages.length };
}

async function perf(): Promise<void> {
	const trunk = trunkTree();
	const runs: { tree: string; first: number; total: number; calls: number; tools: string[] }[] = [];
	for (let i = 0; i < 3; i++) {
		for (const [name, tree] of [["trunk", trunk], ["head", HEAD]] as const) {
			const state = seededState(tree);
			const host = await harness.startHost({ models: REAL, stateDir: state, logFile: join(state, "host.log"), repo: tree, timeoutMs: 60_000, config: { webPort: 0, secretsFile: "secrets.env" } });
			try {
				just(state, ["module", "off", "us-market"], tree);
				just(state, ["module", "on", "stock-ta"], tree);
				await within(30_000, () => (query(join(state, "state.db"), "SELECT record FROM module_records WHERE name = 'stock-ta'").some((r) => JSON.parse(String(r["record"])).state.at === "active") ? true : undefined));
				just(state, ["say", PLAN_Q], tree);
				await within(60_000, () => (query(join(state, "state.db"), "SELECT 1 FROM tickets").length > 0 ? true : undefined), 1000);
				await within(600_000, () => (query(join(state, "state.db"), "SELECT 1 FROM tickets WHERE worker_state IN ('queued', 'running')").length === 0 ? true : undefined), 2000);
				const tokens = riskPlanTokens(state);
				const tools = readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[gateway]") && l.includes("risk-plan")).map((l) => /tools\/[\w-]+/.exec(l)?.[0] ?? "?");
				if (tokens) runs.push({ tree: name, ...tokens, tools });
				console.log(`${name} run ${i + 1}: ${JSON.stringify(tokens)} ${tools.join(" ")}`);
			} finally {
				await host.stop();
			}
		}
	}
	await lane("perf-tokens", "perf-tokens", async () => {
		const of = (tree: string, k: "first" | "total") => runs.filter((r) => r.tree === tree).map((r) => r[k]);
		const line = (tree: string, k: "first" | "total") => `${tree} ${k}: median ${median(of(tree, k))}, runs ${of(tree, k).join(" ")}`;
		const growth = median(of("head", "total")) / median(of("trunk", "total")) - 1;
		return {
			pass: of("trunk", "total").length === 3 && of("head", "total").length === 3 && growth <= 0.15,
			evidence: `风险计划 input tokens (prompt + cache, every model call in its member session), the same question on a real host, trunk ${shaOf(trunk)} and head ${shaOf(HEAD)} alternating 3 each (rule: head total median more than 15% over trunk fails)\nquestion: ${PLAN_Q}\n${line("trunk", "first")}\n${line("head", "first")}\n${line("trunk", "total")}\n${line("head", "total")}\nhead over trunk, total median: ${(growth * 100).toFixed(1)}%\nper run:\n${runs.map((r) => `${r.tree} calls ${r.calls} first ${r.first} total ${r.total} tools ${r.tools.join(" ")}`).join("\n")}`,
		};
	});
}

await (mode === "real" ? real() : mode === "perf" ? perf() : tools());
process.exit(0);
