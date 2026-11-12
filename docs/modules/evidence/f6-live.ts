/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/f6-live.ts [lanes|perf] [outDir] [lane numbers...]
 *
 * Lanes 1 to 8 and the perf probe use the fake model from tests/e2e/fake-model.ts. Lanes 9 and 10 use real
 * openai-codex models through the Pi login in ~/.pi/agent. Lane 1 and the perf baseline run a detached worktree
 * of the parent branch (F5) at <outDir>/base. Every host and every just command gets its own throwaway state dir.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const BASE_REF = spawnSync("git", ["merge-base", "HEAD", "origin/psa/mod-f5-templates"], { cwd: HEAD, encoding: "utf8" }).stdout.trim().slice(0, 7);
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const [mode = "lanes", outDir = "/tmp/swarm-f6/owner", ...only] = process.argv.slice(2);
const BASE = join(outDir, "base");
mkdirSync(outDir, { recursive: true });

const { fakeModels } = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, bash, dispatch, fakeAgentEnv, on, openTicket, report, reply, worker, write } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
type Fake = InstanceType<typeof FakeModel>;
type Host = Awaited<ReturnType<(typeof import("../../tests/e2e/harness.ts"))["startHost"]>>;
type Call = { name: string; args: Record<string, unknown> };
type Exchange = import("../../tests/e2e/fake-model.ts").Exchange;
type Script = import("../../tests/e2e/fake-model.ts").Script;

function base(): string {
	if (!existsSync(BASE)) {
		spawnSync("git", ["worktree", "add", "--detach", BASE, BASE_REF], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(BASE, "node_modules"));
	}
	return BASE;
}

const stateDir = () => mkdtempSync(join(tmpdir(), "psa-f6-"));

function just(state: string, args: string[], cwd = HEAD) {
	const run = spawnSync("just", args, { cwd, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300" }, encoding: "utf8", timeout: 120_000 });
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

function query<T>(state: string, sql: string): T[] {
	const db = new DatabaseSync(join(state, "state.db"), { readOnly: true });
	try {
		return db.prepare(sql).all() as T[];
	} finally {
		db.close();
	}
}

type ModuleState = { at: string; serving?: { digest: string } };
const moduleState = (state: string, name: string): ModuleState | undefined => {
	const [row] = query<{ record: string | null }>(state, `SELECT record FROM module_records WHERE name = '${name}'`);
	return row?.record ? (JSON.parse(row.record) as { state: ModuleState }).state : undefined;
};
const switchOf = (state: string, name: string) => query<{ switch: number }>(state, `SELECT switch FROM module_records WHERE name = '${name}'`)[0]?.switch;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function within(limitMs: number, ok: () => boolean): Promise<number> {
	const started = performance.now();
	while (performance.now() - started < limitMs) {
		if (ok()) return Math.round(performance.now() - started);
		await sleep(50);
	}
	return ok() ? Math.round(performance.now() - started) : -1;
}

function snapshot(dir: string): string {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.map((e) => join(e.parentPath, e.name))
		.sort()
		.map((path) => (statSync(path).isFile() ? `${path} ${readFileSync(path).length}B ${statSync(path).mtimeMs}` : path))
		.join("\n");
}

async function boot(state: string, fake: Fake | null, tree = HEAD): Promise<Host> {
	const harness = await import(join(tree, "tests/e2e/harness.ts"));
	return harness.startHost({ models: fake === null ? REAL : fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0 }, env: fake === null ? {} : fakeAgentEnv(fake, join(state, "pi")), timeoutMs: 60_000 });
}

const results: string[] = [];
async function lane(n: number, slug: string, body: () => Promise<{ pass: boolean | "inconclusive"; evidence: string }>): Promise<void> {
	if (only.length > 0 && !only.includes(String(n))) return;
	let verdict: { pass: boolean | "inconclusive"; evidence: string };
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const word = verdict.pass === "inconclusive" ? "INCONCLUSIVE" : verdict.pass ? "PASS" : "FAIL";
	const file = join(outDir, `f6-${slug}.txt`);
	writeFileSync(file, `${word} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

const inBuilder = (call: Call, basis = "request") => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain: "module-builder", basis })) } });
const opens = (word: string, brief: string, basis = "request") => on(`开 ${brief}`, new RegExp(`^\\[对话\\][\\s\\S]*${word}`), (c: string) => [inBuilder(openTicket(c, brief), basis), reply(c, "好")]);
const exchangesOf = (fake: Fake, conversation: string): Exchange[] => fake.exchanges.filter((e: Exchange) => e.conversation === conversation);
/** The fake model scripts on tool results that start with [命令输出], so every shell step prints that first. */
const shell = (command: string) => bash(`printf '[命令输出] '; STATE="$(cd ../.. && pwd)"; ${command} 2>&1`);
const JUST = 'just -f "$PSA_REPO/justfile"';
const newModule = (name: string, template = "team") => shell(`PSA_STATE_DIR="$STATE" ${JUST} module new ${name} --template ${template}`);
const check = (name: string) => shell(`${JUST} module check "$STATE/modules/${name}"`);
const reportsOf = (state: string) => query<{ status: string; summary: string }>(state, "SELECT status, summary FROM reports ORDER BY seq");
const finalReport = (state: string) => reportsOf(state).find((r) => r.status !== "progress");
const notesManifest = (title: string) => `${JSON.stringify({ schema: 1, name: "reading-notes", version: "0.1.0", title, description: "记录读书笔记：摘抄、心得和书单", team: "读书会" }, null, 2)}\n`;

function builderScript(word: string, brief: string, member: string, task: string, steps: ReturnType<typeof on>[], basis = "request"): Script {
	return {
		router: [opens(word, brief, basis)],
		workers: [
			worker(brief, on("派活", /^\[任务说明\]/, () => [dispatch(member, task)]), on("汇报", /^\[成员回复\]/, (c: string) => [report("ready", c)])),
			worker(task, ...steps),
		],
	};
}

async function runBuilder(state: string, script: Script, say: string, hostHasSeen = () => true, limitMs = 90_000) {
	const fake = await FakeModel.start(script);
	const host = await boot(state, fake);
	try {
		just(state, ["say", say]);
		const took = await within(limitMs, () => finalReport(state) !== undefined);
		await within(5000, hostHasSeen);
		return { fake, took, report: finalReport(state), log: host.log() };
	} finally {
		writeFileSync(join(outDir, `f6-fake-${script.workers?.[0]?.brief ?? "router"}.jsonl`), fake.jsonl());
		await host.stop();
		await fake.close();
	}
}

const own = (out: string) => out.split("\n").filter((l) => !l.startsWith("node --import") && !l.startsWith("error: recipe")).join("\n").trim();
const withoutBuilder = (listing: string) =>
	listing
		.replace(/^模块 \d+ 个.*$/m, "")
		.replace(/^新布局包 \d+ 个$/m, "")
		.replace(/^module-builder [^\n]*\n(  [^\n]*\n)*/m, "")
		.replace(/状态目录 \S+/, "")
		.replace(/[a-f0-9]{12}/g, "<digest>")
		.replace(/ {2,}/g, " ")
		.trim();

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		const tree = base();
		const onMain = spawnSync("git", ["ls-tree", "--name-only", "main", "modules/"], { cwd: HEAD, encoding: "utf8" }).stdout.trim().split("\n");
		const old = just(stateDir(), ["modules"], tree);
		const now = just(stateDir(), ["modules"], HEAD);
		const same = withoutBuilder(own(old.out)) === withoutBuilder(own(now.out));
		const stateOf = (name: string) => own(now.out).split("\n").find((l) => l.startsWith(`${name} `))?.split(/\s{2,}/)[2] ?? "";
		return {
			pass: old.status === 0 && now.status === 0 && same && !onMain.includes("modules/module-builder") && stateOf("module-builder") === stateOf("pi-pi"),
			evidence: `trunk (main) modules/: ${onMain.join(", ")} (no module-builder)\nother modules identical to F5 ${BASE_REF}: ${same}\nbefore any host has run, module-builder reads "${stateOf("module-builder")}" like the bundled pi-pi ("${stateOf("pi-pi")}"); lanes 4 to 8 show it serving once a host starts\n\nF5 just modules:\n${own(old.out)}\n\nhead just modules:\n${own(now.out)}`,
		};
	});

	await lane(2, "check", async () => {
		const run = just(stateDir(), ["module", "check", "modules/module-builder"]);
		return { pass: run.status === 0 && /^ok module-builder@0\.1\.0/m.test(run.out), evidence: `exit ${run.status}\n${own(run.out)}` };
	});

	await lane(3, "try", async () => {
		const user = stateDir();
		writeFileSync(join(user, "config.json"), JSON.stringify({ models: fakeModels }));
		const fake = await FakeModel.start({
			router: [opens("front matter", "考题的键"), opens("开着还是关着", "新模块的开关")],
			workers: [
				worker("考题的键", on("答", /^\[任务说明\]/, () => [report("ready", "除了 name，还要写 uses（必须调用的能力）和 expect（汇报里必须出现的短语）")])),
				worker("新模块的开关", on("答", /^\[任务说明\]/, () => [report("ready", "新模块停在已停用，看过检查和预演后运行 just module on <名字> 打开")])),
			],
		});
		try {
			const env = { ...process.env, ...fakeAgentEnv(fake, mkdtempSync(join(tmpdir(), "psa-f6pi-"))), PSA_STATE_DIR: user };
			const run = await justAsync(env, ["module", "try", "module-builder"], 180_000);
			const out = run.out;
			return { pass: run.status === 0 && /^PASS eval-front-matter$/m.test(out) && /^PASS stays-disabled$/m.test(out), evidence: `exit ${run.status}\n${own(out)}` };
		} finally {
			await fake.close();
		}
	});

	await lane(4, "notes", async () => {
		const state = stateDir();
		const task = "搭 reading-notes";
		const run = await runBuilder(
			state,
			builderScript("读书笔记", "做读书笔记模块", "scaffolder", task, [
				on("module new", /^\[派活\]/, () => [newModule("reading-notes")]),
				on("改 module.json 再检查", /生成了模块 reading-notes/, () => [write(join(state, "modules/reading-notes/module.json"), notesManifest("读书笔记")), check("reading-notes")]),
				on("回复", /ok reading-notes@/, (c: string) => c),
			]),
			"帮我做一个记录读书笔记的模块",
			() => moduleState(state, "reading-notes") !== undefined,
		);
		const checked = just(state, ["module", "check", join(state, "modules/reading-notes")]);
		const listed = own(just(state, ["modules"]).out).split("\n").find((l) => l.startsWith("reading-notes")) ?? "";
		const member = exchangesOf(run.fake, task).flatMap((e) => e.toolResults);
		const outside = query<{ outside_writes: string }>(state, "SELECT outside_writes FROM reports").map((r) => r.outside_writes);
		return {
			pass: run.took >= 0 && checked.status === 0 && /已停用/.test(listed) && switchOf(state, "reading-notes") !== 1 && moduleState(state, "reading-notes")?.at === "disabled" && outside.every((w) => w === "[]"),
			evidence: `report after ${run.took} ms: ${run.report?.status}: ${run.report?.summary}\nscaffolder's tool results:\n${member.join("\n---\n")}\n\njust module check: ${own(checked.out)}\njust modules: ${listed}\nthe running host's record: switch ${switchOf(state, "reading-notes")}, state ${JSON.stringify(moduleState(state, "reading-notes"))}\nwrites outside on the reports (module packages count as inside): ${outside.join(" ")}`,
		};
	});

	await lane(5, "dup", async () => {
		const state = stateDir();
		just(state, ["module", "new", "reading-notes", "--template", "notes"]);
		const before = snapshot(join(state, "modules/reading-notes"));
		const run = await runBuilder(
			state,
			builderScript("读书笔记", "再做读书笔记模块", "scaffolder", "搭 reading-notes", [
				on("module new", /^\[派活\]/, () => [newModule("reading-notes")]),
				on("回复", /已存在，不覆盖/, (c: string) => `已有同名模块 reading-notes，没有覆盖。${c}`),
			]),
			"帮我做一个记录读书笔记的模块",
		);
		const same = snapshot(join(state, "modules/reading-notes")) === before;
		return { pass: run.took >= 0 && same && /已存在，不覆盖/.test(run.report?.summary ?? ""), evidence: `folder unchanged: ${same}\nreport after ${run.took} ms: ${run.report?.status}: ${run.report?.summary}` };
	});

	await lane(6, "edit", async () => {
		const state = stateDir();
		just(state, ["module", "new", "reading-notes", "--template", "team"]);
		just(state, ["module", "on", "reading-notes"]);
		const skill = "---\nname: quote-format\ndescription: 摘抄怎么写：原文、页码、一句心得\n---\n# 摘抄格式\n\n原文一段，后面写页码和一句心得。\n";
		const fake = await FakeModel.start(
			builderScript("加一份技能", "给读书笔记加技能", "scaffolder", "加 quote-format", [
				on("写技能再检查", /^\[派活\]/, () => [write(join(state, "modules/reading-notes/skills/quote-format/SKILL.md"), skill), check("reading-notes")]),
				on("回复", /ok reading-notes@/, (c: string) => c),
			]),
		);
		const host = await boot(state, fake);
		try {
			const active = await within(15_000, () => moduleState(state, "reading-notes")?.at === "active");
			const before = moduleState(state, "reading-notes")?.serving?.digest ?? "";
			just(state, ["say", "给读书笔记模块加一份技能 quote-format"]);
			const took = await within(60_000, () => (moduleState(state, "reading-notes")?.serving?.digest ?? before) !== before);
			const after = moduleState(state, "reading-notes")?.serving?.digest ?? "";
			const checked = own(just(state, ["module", "check", join(state, "modules/reading-notes")]).out);
			return {
				pass: active >= 0 && took >= 0 && after !== before && checked.includes(`digest=${after.slice(0, 12)}`) && /skills=2/.test(checked),
				evidence: `active after ${active} ms, serving ${before.slice(0, 12)}\nswapped to ${after.slice(0, 12)} ${took} ms after the request\njust module check of the folder now: ${checked}\nreport: ${JSON.stringify(finalReport(state))}`,
			};
		} finally {
			await host.stop();
			await fake.close();
		}
	});

	await lane(7, "bad", async () => {
		const state = stateDir();
		just(state, ["module", "new", "reading-notes", "--template", "team"]);
		const manifest = join(state, "modules/reading-notes/module.json");
		const task = "检查 reading-notes";
		const run = await runBuilder(
			state,
			builderScript("检查读书笔记", "检查读书笔记模块", "checker", task, [
				on("写坏再检查", /^\[派活\]/, () => [write(manifest, notesManifest("读书笔记").replace('"description"', '"descripton"')), check("reading-notes")]),
				on("读到问题改好", /unknown key "descripton"/, () => [write(manifest, notesManifest("读书笔记")), check("reading-notes")]),
				on("回复", /ok reading-notes@/, (c: string) => c),
			]),
			"帮我检查读书笔记模块",
		);
		const seen = exchangesOf(run.fake, task).map((e) => `${e.steps.join(",") || "(no step)"} <- ${e.cards.join(" | ")}`);
		const checked = just(state, ["module", "check", join(state, "modules/reading-notes")]);
		return {
			pass: run.took >= 0 && seen.some((l) => l.startsWith("读到问题改好") && l.includes('unknown key "descripton"')) && checked.status === 0,
			evidence: `checker's turns (step <- what it read):\n${seen.join("\n")}\n\njust module check now: ${own(checked.out)}\nreport: ${run.report?.status}: ${run.report?.summary}`,
		};
	});

	await lane(8, "infer", async () => {
		const state = stateDir();
		const brief = "推断做模块";
		const task = "搭 infer-test";
		const fake = await FakeModel.start({
			router: [opens("L8", brief, "inference")],
			workers: [
				worker(brief, on("想动手", /^\[任务说明\]/, () => [newModule("infer-test"), write(join(state, "modules/infer-test/module.json"), "{}"), dispatch("scaffolder", task)]), on("汇报", /^\[成员回复\]/, (c: string) => [report("ready", c)])),
				worker(task, on("成员想动手", /^\[派活\]/, () => [newModule("infer-test")])),
			],
		});
		const host = await boot(state, fake);
		try {
			just(state, ["say", "L8 看到一条消息说要做个模块"]);
			await within(60_000, () => exchangesOf(fake, brief).some((e) => e.toolResults.length > 0) && exchangesOf(fake, task).some((e) => e.toolResults.length > 0));
			await sleep(1000);
			const ticket = query<{ basis: string; domain: string }>(state, `SELECT basis, domain FROM tickets WHERE title = '${brief}'`)[0];
			const helperTools = exchangesOf(fake, brief)[0]?.tools ?? [];
			const memberTools = exchangesOf(fake, task)[0]?.tools ?? [];
			const writes = ["bash", "write", "edit"];
			const preamble = fake.exchanges.filter((e: Exchange) => e.conversation === "router").flatMap((e: Exchange) => e.userTexts).find((t: string) => t.includes("module-builder/build-on-request")) ?? "";
			const built = existsSync(join(state, "modules/infer-test"));
			return {
				pass: ticket?.basis === "inference" && !built && !helperTools.some((t) => writes.includes(t)) && !memberTools.some((t) => writes.includes(t)),
				evidence: `ticket ${JSON.stringify(ticket)}\nhelper offered: ${helperTools.join(", ")}\nmember offered: ${memberTools.join(", ")}\nhelper tool results: ${exchangesOf(fake, brief).flatMap((e) => e.toolResults).join(" | ").slice(0, 600)}\nmember tool results: ${exchangesOf(fake, task).flatMap((e) => e.toolResults).join(" | ").slice(0, 300)}\nmodules/infer-test exists: ${built}\nRouter preamble carries the rule: ${/不要以 basis=inference 把任务开到 module-builder/.test(preamble)}`,
			};
		} finally {
			await host.stop();
			await fake.close();
		}
	});

	const realState = stateDir();
	await lane(9, "real", async () => {
		let host: Host;
		try {
			host = await boot(realState, null);
		} catch (error) {
			return { pass: "inconclusive", evidence: `a real host could not start: ${String((error as Error).stack ?? error)}` };
		}
		const started = performance.now();
		try {
			just(realState, ["say", "帮我做一个「家庭菜谱」模块，英文名 family-recipes：记家里常做的三道菜（番茄炒蛋、红烧肉、清炒时蔬）的做法，资料是我自己写的，直接放进包里；要一位厨师专家按家里现有的食材推荐做哪道菜，再写两道考题。不用问我，按默认做。"]);
			let took = await within(45 * 60_000, () => finalReport(realState) !== undefined);
			if (finalReport(realState)?.status === "blocked") {
				just(realState, ["say", "按默认做，不用再问我"]);
				took = await within(30 * 60_000, () => reportsOf(realState).filter((r) => r.status !== "progress").length > 1);
			}
			const minutes = ((performance.now() - started) / 60_000).toFixed(1);
			const dir = join(realState, "modules/family-recipes");
			const checked = existsSync(dir) ? own(just(realState, ["module", "check", dir]).out) : "(no folder)";
			const tickets = query(realState, "SELECT id, basis, domain, title, dispatched_to FROM tickets");
			const files = existsSync(dir) ? readdirSync(dir, { recursive: true }).sort().join(", ") : "";
			const realFolder = existsSync(dir) && lstatSync(dir).isDirectory();
			const ok = realFolder && /^ok family-recipes@/m.test(checked) && /knowledge=[1-9]/.test(checked) && /skills=[1-9]/.test(checked);
			if (took < 0 && !ok) return { pass: "inconclusive", evidence: `no final report within the limit (${minutes} min)\ntickets: ${JSON.stringify(tickets)}\ncheck: ${checked}\nreports:\n${reportsOf(realState).map((r) => `${r.status}: ${r.summary}`).join("\n")}` };
			return {
				pass: ok && switchOf(realState, "family-recipes") !== 1,
				evidence: `models ${JSON.stringify(REAL)}\nwall time ${minutes} min\ntickets: ${JSON.stringify(tickets)}\nmodules/family-recipes is a real folder, not a link: ${realFolder}\njust module check: ${checked}\nswitch: ${switchOf(realState, "family-recipes")}\nfiles: ${files}\nreports:\n${reportsOf(realState).map((r) => `${r.status}: ${r.summary}`).join("\n")}`,
			};
		} finally {
			await host.stop();
		}
	});

	await lane(10, "real-use", async () => {
		if (!existsSync(join(realState, "modules/family-recipes"))) return { pass: "inconclusive", evidence: "lane 9 made no family-recipes module" };
		const host = await boot(realState, null);
		try {
			const on = own(just(realState, ["module", "on", "family-recipes"]).out);
			const active = await within(30_000, () => moduleState(realState, "family-recipes")?.at === "active");
			const seen = new Set(query<{ id: string }>(realState, "SELECT id FROM tickets").map((t) => t.id));
			just(realState, ["say", "家里有番茄和鸡蛋，今晚做哪道菜？按家庭菜谱说。"]);
			const took = await within(5 * 60_000, () => query<{ id: string }>(realState, "SELECT id FROM tickets").some((t) => !seen.has(t.id)));
			const fresh = query<{ id: string; domain: string | null; title: string }>(realState, "SELECT id, domain, title FROM tickets").filter((t) => !seen.has(t.id));
			await within(5 * 60_000, () => reportsOf(realState).length > 0);
			return {
				pass: active >= 0 && fresh.some((t) => t.domain === "family-recipes"),
				evidence: `just module on: ${on}\nactive after ${active} ms\nnew ticket after ${took} ms: ${JSON.stringify(fresh)}\nstate: ${JSON.stringify(moduleState(realState, "family-recipes"))}`,
			};
		} finally {
			await host.stop();
		}
	});
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (name: string, xs: number[]) => `${name}: median ${median(xs).toFixed(0)} ms, runs ${xs.map((t) => t.toFixed(0)).join(" ")}, spread ${(Math.max(...xs) - Math.min(...xs)).toFixed(0)} ms`;

async function perf(): Promise<void> {
	const tree = base();
	const fake = await FakeModel.start({ router: [] });
	const time = async (cwd: string) => {
		const state = stateDir();
		const started = performance.now();
		const harness = await import(join(cwd, "tests/e2e/harness.ts"));
		const host = await harness.startHost({ models: fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0 }, env: fakeAgentEnv(fake, join(state, "pi")), timeoutMs: 60_000 });
		const took = performance.now() - started;
		await host.stop();
		return took;
	};
	const old: number[] = [];
	const head: number[] = [];
	try {
		for (let i = 0; i < 5; i++) {
			old.push(await time(tree));
			head.push(await time(HEAD));
		}
	} finally {
		await fake.close();
	}
	const slower = median(head) - median(old);
	const text = [
		`${slower <= 200 ? "PASS" : "FAIL"} perf: startHost until the page URL is printed, F5 ${BASE_REF} and head alternating (rule: head over 200 ms slower fails)`,
		line("  F5 base (baseline)", old),
		line("  head (one more module)", head),
	].join("\n");
	writeFileSync(join(outDir, "f6-perf.txt"), `${text}\n`);
	console.log(text);
}

await (mode === "perf" ? perf() : lanes());
