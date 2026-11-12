/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/f4-live.ts [lanes|perf] [outDir]
 * Lane 10 calls real openai-codex models and needs the Pi login in ~/.pi/agent.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const SAMPLES = join(HEAD, "docs/modules/architecture/sample");
const HEALTH = "modules/personal-health";
const GUIDE = "2022-aha-acc-hfsa-hf";
const SYNTHETIC = "synthetic-1000";
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const CASES = JSON.parse(readFileSync(join(SAMPLES, "personal-tax/tools/tax-bracket/cases.json"), "utf8")) as { input: { taxableIncome: number }; expect: Record<string, number> }[];
const [mode = "lanes", outDir = "/tmp/swarm-f4/owner"] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
mkdirSync(outDir, { recursive: true });

const { fakeModels } = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, domainTool, dispatch, fakeAgentEnv, knowledge, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { buildIndex, importKnowledge } = await import(join(HEAD, "src/modules/knowledge.ts"));
const { scanPackage } = await import(join(HEAD, "src/modules/validate.ts"));
type Fake = InstanceType<typeof FakeModel>;
type Host = Awaited<ReturnType<(typeof import("../../tests/e2e/harness.ts"))["startHost"]>>;
type Call = { name: string; args: Record<string, unknown> };
type Exchange = import("../../tests/e2e/fake-model.ts").Exchange;

function trunk(): string {
	if (!existsSync(TRUNK)) {
		spawnSync("git", ["worktree", "add", "--detach", TRUNK, "main"], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
	}
	return TRUNK;
}

function syntheticDoc(file: string): void {
	const lines: string[] = ["# 合成指南"];
	for (let s = 1; lines.length < 1000; s++) {
		lines.push(`## 第 ${s} 节 血压与心率`);
		for (let i = 0; i < 19 && lines.length < 1000; i++) lines.push(`第 ${s}.${i} 条：血压控制目标和心率随访，复查间隔按风险分层，药物剂量逐步调整。`);
	}
	writeFileSync(file, lines.join("\n"));
}

function stateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-f4-"));
	for (const name of ["personal-health", "personal-tax"]) cpSync(join(SAMPLES, name), join(dir, "modules", name), { recursive: true });
	mkdirSync(join(dir, HEALTH, "knowledge", SYNTHETIC));
	writeFileSync(
		join(dir, HEALTH, "knowledge", SYNTHETIC, "source.json"),
		JSON.stringify({ title: "合成长文档", version: "1", published: "2026-11-12", authority: "reference", license: "user-import", origin: "f4-live 生成" }),
	);
	return dir;
}

function just(state: string, args: string[], cwd = HEAD) {
	const run = spawnSync("just", args, { cwd, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300" }, encoding: "utf8", timeout: 60_000 });
	return { status: run.status, out: run.stdout + run.stderr };
}

function query<T>(state: string, sql: string): T[] {
	const db = new DatabaseSync(join(state, "state.db"), { readOnly: true });
	try {
		return db.prepare(sql).all() as T[];
	} finally {
		db.close();
	}
}

const moduleState = (state: string, name: string): { at: string; serving?: { digest: string } } | undefined => {
	const [row] = query<{ record: string | null }>(state, `SELECT record FROM module_records WHERE name = '${name}'`);
	return row?.record ? (JSON.parse(row.record) as { state: { at: string; serving?: { digest: string } } }).state : undefined;
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function within(limitMs: number, ok: () => boolean): Promise<number> {
	const started = performance.now();
	while (performance.now() - started < limitMs) {
		if (ok()) return Math.round(performance.now() - started);
		await sleep(20);
	}
	return ok() ? Math.round(performance.now() - started) : -1;
}

async function turnOn(state: string): Promise<number> {
	for (const name of ["personal-health", "personal-tax"]) just(state, ["module", "on", name]);
	return within(20_000, () => moduleState(state, "personal-health")?.at === "active" && moduleState(state, "personal-tax")?.at === "active");
}

async function boot(state: string, fake: Fake | null, tree = HEAD): Promise<Host> {
	const harness = await import(join(tree, "tests/e2e/harness.ts"));
	const env = fake === null ? {} : fakeAgentEnv(fake, join(state, "pi"));
	return harness.startHost({ models: fake === null ? REAL : fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0 }, env, timeoutMs: 60_000 });
}

const results: string[] = [];
async function lane(n: number, slug: string, body: () => Promise<{ pass: boolean | "inconclusive"; evidence: string }>): Promise<void> {
	let verdict: { pass: boolean | "inconclusive"; evidence: string };
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const word = verdict.pass === "inconclusive" ? "INCONCLUSIVE" : verdict.pass ? "PASS" : "FAIL";
	const file = join(outDir, `f4-${slug}.txt`);
	writeFileSync(file, `${word} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

const inDomain = (call: Call, domain: string) => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain, basis: "request" })) } });
const opens = (word: string, brief: string, domain = "personal-health") =>
	on(`开 ${brief}`, new RegExp(`^\\[对话\\][\\s\\S]*${word}`), (c: string) => [inDomain(openTicket(c, brief), domain), reply(c, "好")]);
const exchangesOf = (fake: Fake, conversation: string): Exchange[] => fake.exchanges.filter((e: Exchange) => e.conversation === conversation);
const cardsOf = (fake: Fake, conversation: string, tag: string) => exchangesOf(fake, conversation).flatMap((e) => e.cards.filter((c) => c.startsWith(tag)));
const resultsOf = (fake: Fake, conversation: string) => exchangesOf(fake, conversation).flatMap((e) => e.toolResults);
const offered = (fake: Fake, conversation: string): string[] => exchangesOf(fake, conversation)[0]?.tools ?? [];
const gatewayLines = (state: string) => readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[gateway]"));
const asks = (label: string, q: string) => on(label, /^\[(任务说明|派活)\]/, () => [knowledge(q)]);
const reports = (label: string) => on(label, /^\[模块知识\]/, (c: string) => [report("ready", c)]);

async function lanes(): Promise<void> {
	const state = stateDir();
	const B = {
		tax: "L1 算税", three: "L2 三字", two: "L3 两字", missing: "L4 没导入", imported: "L5 导入后", other: "L6 别的模块",
		reindex: "L7 改知识", uses: "L8 派给影像科", member: "L8 影像科查", empty: "L9 查不到",
	};
	const fake = await FakeModel.start({
		router: [
			opens("L1", B.tax, "personal-tax"), opens("L2", B.three), opens("L3", B.two), opens("L4", B.missing), opens("L5", B.imported),
			opens("L6", B.other, "personal-tax"), opens("L7", B.reindex), opens("L8", B.uses), opens("L9", B.empty),
		],
		workers: [
			worker(B.tax, on("L1 调用", /^\[任务说明\]/, () => [domainTool("tax-bracket", CASES[1]!.input)]), on("L1 汇报", /^\[模块工具\]/, (c: string) => [report("ready", c)])),
			worker(B.three, asks("L2 查", "同一家实验室"), reports("L2 汇报")),
			worker(B.two, asks("L3 查", "复查"), reports("L3 汇报")),
			worker(B.missing, asks("L4 查", "射血分数"), reports("L4 汇报")),
			worker(B.imported, asks("L5 查", "射血分数"), reports("L5 汇报")),
			worker(B.other, asks("L6 查", "同一家实验室")),
			worker(B.reindex, asks("L7 查", "连续两次上升"), reports("L7 汇报")),
			worker(B.uses, on("L8 派活", /^\[任务说明\]/, () => [dispatch("radiologist", B.member)]), on("L8 汇报", /^\[成员回复\]/, (c: string) => [report("ready", c)])),
			worker(B.member, asks("L8 成员查", "同一家实验室")),
			worker(B.empty, asks("L9 查", "量子纠缠"), reports("L9 汇报")),
		],
	});
	const host = await boot(state, fake);
	const run = async (word: string, brief: string, done: () => boolean, limitMs = 30_000) => {
		just(state, ["say", `${word} 请处理`]);
		return within(limitMs, done);
	};
	const knowledgeCard = async (word: string, brief: string) => {
		const took = await run(word, brief, () => cardsOf(fake, brief, "[模块知识]").length > 0);
		return { took, card: cardsOf(fake, brief, "[模块知识]")[0] ?? "" };
	};
	try {
		const on = await turnOn(state);
		if (on < 0) throw new Error(`modules did not turn on: ${JSON.stringify([moduleState(state, "personal-health"), moduleState(state, "personal-tax")])}`);

		await lane(1, "regression", async () => {
			const trunkTools = spawnSync("git", ["show", "main:src/worker/tools.ts"], { cwd: HEAD, encoding: "utf8" }).stdout;
			const took = await run("L1", B.tax, () => cardsOf(fake, B.tax, "[模块工具]").length > 0);
			const card = cardsOf(fake, B.tax, "[模块工具]")[0] ?? "";
			const output = card.includes("：{") ? JSON.parse(card.slice(card.indexOf("：") + 1)) : null;
			const same = JSON.stringify(output) === JSON.stringify(CASES[1]!.expect);
			return {
				pass: !/"knowledge"/.test(trunkTools) && took >= 0 && same,
				evidence: `trunk src/worker/tools.ts lists knowledge: ${/"knowledge"/.test(trunkTools)}\nhead tax-bracket card after ${took} ms: ${card}\ncases.json (F3 lane 2) expects ${JSON.stringify(CASES[1]!.expect)}`,
			};
		});

		await lane(2, "three", async () => {
			const { took, card } = await knowledgeCard("L2", B.three);
			return { pass: took >= 0 && /章节：肿瘤标志物跟踪要点 > 看趋势，不看单次/.test(card) && /tumor-marker-basics，版本 0\.1/.test(card), evidence: `helper offered: ${offered(fake, B.three).join(", ")}\ncard after ${took} ms:\n${card}` };
		});

		await lane(3, "two", async () => {
			const { took, card } = await knowledgeCard("L3", B.two);
			return { pass: took >= 0 && /章节：肿瘤标志物跟踪要点 > 什么算需要提醒/.test(card), evidence: `query 复查 (2 characters), card after ${took} ms:\n${card}` };
		});

		await lane(4, "missing", async () => {
			const { took, card } = await knowledgeCard("L4", B.missing);
			return { pass: took >= 0 && /还没导入/.test(card) && card.includes(`just module import personal-health ${GUIDE} <文件或目录>`), evidence: `card after ${took} ms:\n${card}` };
		});

		await lane(5, "import", async () => {
			const file = join(state, "guide.md");
			writeFileSync(file, "# 心衰指南\n\n## 7.3 射血分数降低的心衰\n\n推荐四联药物治疗，逐步加量。\n");
			const imported = just(state, ["module", "import", "personal-health", GUIDE, file]);
			const { took, card } = await knowledgeCard("L5", B.imported);
			const pkgFiles = spawnSync("ls", [join(state, HEALTH, "knowledge", GUIDE)], { encoding: "utf8" }).stdout.trim();
			return {
				pass: imported.status === 0 && took >= 0 && /章节：心衰指南 > 7\.3 射血分数降低的心衰/.test(card) && !/还没导入.*2022-aha/.test(card) && pkgFiles === "source.json",
				evidence: `just module import: exit ${imported.status}\n${imported.out}\npackage folder still holds: ${pkgFiles}\ncard after ${took} ms:\n${card}`,
			};
		});

		await lane(6, "other", async () => {
			const took = await run("L6", B.other, () => resultsOf(fake, B.other).length > 0);
			const tools = offered(fake, B.other);
			const result = resultsOf(fake, B.other).join("\n");
			return { pass: took >= 0 && !tools.includes("knowledge") && !/肿瘤标志物/.test(result), evidence: `personal-tax helper offered: ${tools.join(", ")}\nits knowledge call: ${result}` };
		});

		await lane(7, "reindex", async () => {
			const before = moduleState(state, "personal-health")?.serving?.digest;
			const file = join(state, HEALTH, "knowledge/tumor-marker-basics/overview.md");
			writeFileSync(file, `${readFileSync(file, "utf8")}\n## 新加的提醒条件\n\n连续两次上升也提醒去复查。\n`);
			const swapped = await within(20_000, () => moduleState(state, "personal-health")?.serving?.digest !== before);
			const { took, card } = await knowledgeCard("L7", B.reindex);
			const after = moduleState(state, "personal-health")?.serving?.digest;
			return { pass: swapped >= 0 && took >= 0 && /章节：肿瘤标志物跟踪要点 > 新加的提醒条件/.test(card), evidence: `serving ${before?.slice(0, 12)} -> ${after?.slice(0, 12)} after ${swapped} ms\nnew ticket card after ${took} ms:\n${card}` };
		});

		await lane(8, "uses", async () => {
			const took = await run("L8", B.uses, () => resultsOf(fake, B.member).length > 0);
			const tools = offered(fake, B.member);
			const result = resultsOf(fake, B.member).join("\n");
			return { pass: took >= 0 && !tools.includes("knowledge") && !/肿瘤标志物/.test(result), evidence: `radiologist (uses: data/documents) offered: ${tools.join(", ")}\nits knowledge call: ${result}` };
		});

		await lane(9, "empty", async () => {
			const { took, card } = await knowledgeCard("L9", B.empty);
			const line = gatewayLines(state).at(-1) ?? "";
			return { pass: took >= 0 && /没有找到和「量子纠缠」相关的段落/.test(card) && !/^\d+\. 《/m.test(card), evidence: `card after ${took} ms:\n${card}\naccess log: ${line}` };
		});
	} finally {
		writeFileSync(join(outDir, "f4-fake.jsonl"), fake.jsonl());
		writeFileSync(join(outDir, "f4-gateway.log"), `${gatewayLines(state).join("\n")}\n`);
		await host.stop();
		await fake.close();
	}

	await lane(10, "real", async () => {
		const real = stateDir();
		let host: Host;
		try {
			host = await boot(real, null);
		} catch (error) {
			return { pass: "inconclusive", evidence: `a real host could not start: ${String((error as Error).stack ?? error)}` };
		}
		try {
			await turnOn(real);
			just(real, ["say", "我的肿瘤标志物 CEA 单次比参考范围略高一点，按个人医疗健康模块的知识，要不要紧？什么情况才需要提醒去复查？请注明依据出自哪份资料哪一节。"]);
			const took = await within(300_000, () => query(real, "SELECT id FROM reports WHERE status IN ('ready', 'blocked', 'failed', 'no_action')").length > 0);
			const rows = query<{ status: string; summary: string }>(real, "SELECT status, summary FROM reports ORDER BY seq");
			const tickets = query(real, "SELECT id, domain, title FROM tickets");
			const access = gatewayLines(real);
			const searched = access.some((l) => / knowledge .* ok /.test(l));
			const cited = rows.some((r) => /肿瘤标志物跟踪要点|tumor-marker-basics/.test(r.summary));
			return { pass: took >= 0 && searched && cited, evidence: `models ${JSON.stringify(REAL)}\nreport after ${took} ms\ntickets: ${JSON.stringify(tickets)}\naccess log:\n${access.join("\n")}\nreports:\n${rows.map((r) => `${r.status}: ${r.summary}`).join("\n")}` };
		} finally {
			await host.stop();
		}
	});
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (name: string, xs: number[], unit: string) => `${name}: median ${median(xs).toFixed(1)} ${unit}, runs ${xs.map((t) => t.toFixed(1)).join(" ")}, spread ${(Math.max(...xs) - Math.min(...xs)).toFixed(1)} ${unit}`;
const knowledgeMs = (state: string) => gatewayLines(state).flatMap((l) => (/personal-health knowledge .* ok /.test(l) ? [Number(l.match(/(\d+) ms$/)![1])] : []));

/** Trunk cannot load a new-layout package, so the like-for-like baseline boots an empty state. */
async function bootMs(tree: string, packages: boolean): Promise<number> {
	const state = packages ? importedState() : mkdtempSync(join(tmpdir(), "psa-f4-boot-"));
	const started = performance.now();
	const host = await boot(state, null, tree);
	const took = performance.now() - started;
	await host.stop();
	return took;
}

function importedState(): string {
	const state = stateDir();
	syntheticDoc(join(state, "synthetic.md"));
	writeFileSync(join(state, "guide.md"), "# 心衰指南\n\n## 7.3 射血分数降低的心衰\n\n推荐四联药物治疗，逐步加量。\n");
	just(state, ["module", "import", "personal-health", GUIDE, join(state, "guide.md")]);
	just(state, ["module", "import", "personal-health", SYNTHETIC, join(state, "synthetic.md")]);
	return state;
}

async function perf(): Promise<void> {
	const N = 20;
	const out: string[] = [];
	const tree = trunk();
	const trunkBoot: number[] = [];
	const headBoot: number[] = [];
	const headPackagesBoot: number[] = [];
	for (let i = 0; i < 5; i++) {
		trunkBoot.push(await bootMs(tree, false));
		headBoot.push(await bootMs(HEAD, false));
		headPackagesBoot.push(await bootMs(HEAD, true));
	}

	const state = importedState();
	const synthetic = join(state, "synthetic.md");

	const scan = scanPackage(join(state, HEALTH), { runCases: false });
	if (!scan.ok) throw new Error(JSON.stringify(scan.problems));
	const docs = scan.scan.components.filter((c: { kind: string }) => c.kind === "knowledge");
	const build: number[] = [];
	for (let i = 0; i < 5; i++) {
		const dataDir = mkdtempSync(join(tmpdir(), "psa-f4-build-"));
		importKnowledge(dataDir, SYNTHETIC, synthetic);
		importKnowledge(dataDir, GUIDE, join(state, "guide.md"));
		const started = performance.now();
		buildIndex({ module: "personal-health", digest: scan.scan.digest, copyDir: join(state, HEALTH), dataDir, docs });
		build.push(performance.now() - started);
	}

	const queries = ["复查", "血压控制", "射血分数", "心率", "同一家实验室"];
	const calls = Array.from({ length: N }, (_, i) => knowledge(queries[i % queries.length]!));
	const fake = await FakeModel.start({ router: [opens("查知识", "查知识")], workers: [worker("查知识", on("20 次 knowledge", /^\[任务说明\]/, () => calls))] });
	const host = await boot(state, fake);
	try {
		await turnOn(state);
		just(state, ["say", "查知识 请处理"]);
		await within(120_000, () => knowledgeMs(state).length >= N);
	} finally {
		await host.stop();
		await fake.close();
	}
	const q = knowledgeMs(state);
	const lines = readFileSync(synthetic, "utf8").split("\n").length;
	const slower = median(headBoot) - median(trunkBoot);
	const pass = q.length === N && median(q) <= 50 && Math.max(...build) <= 2000 && slower <= 200;
	out.push(
		`${pass ? "PASS" : "FAIL"} perf: knowledge query host side (request reaching the Gateway to its reply, first one builds the index), index build with a ${lines}-line synthetic doc plus both personal-health docs, host boot trunk vs head (rule: query median over 50 ms, a build over 2 s, or boot over 200 ms slower fails)`,
		line("  trunk host boot (baseline)", trunkBoot, "ms"),
		line("  head host boot", headBoot, "ms"),
		line("  head host boot with personal-health, personal-tax and both imports", headPackagesBoot, "ms"),
		line(`  head knowledge query x${q.length} (${queries.join(" / ")})`, q, "ms"),
		line("  head index build x5", build, "ms"),
	);
	const text = out.join("\n");
	writeFileSync(join(outDir, "f4-perf.txt"), `${text}\n`);
	console.log(text);
}

await (mode === "perf" ? perf() : lanes());
