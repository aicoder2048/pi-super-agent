import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, loadModules } from "../src/host/config.ts";
import { startLiveModules } from "../src/host/live-modules.ts";
import { openStore } from "../src/kernel/store.ts";
import { KEY_NAMES } from "../src/sources/market/key.ts";
import { until } from "./helpers/fakes.ts";
import { FakeModel, domainTool, fakeAgentEnv, on, openTicket, report, reply, worker, type Script } from "./e2e/fake-model.ts";

function stateDir(t: import("node:test").TestContext, config?: object): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-modcli-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	if (config) writeFileSync(join(dir, "config.json"), JSON.stringify(config));
	return dir;
}

function cli(script: string, dir: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
	const env = { ...process.env, PSA_STATE_DIR: dir, ...extraEnv };
	for (const k of KEY_NAMES) if (!(k in extraEnv)) delete env[k];
	return spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", script, ...args], { env, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
}

const list = (dir: string, env?: Record<string, string>) => cli("src/cli/modules.ts", dir, [], env);
const lineOf = (out: string, name: string) => out.split("\n").find((l) => l.startsWith(`${name} `)) ?? "";
const SAMPLE = join(import.meta.dirname, "..", "docs", "modules", "architecture", "sample");
const check = (dir: string) => cli("src/cli/module.ts", tmpdir(), ["check", dir]);

test("just modules：不连宿主列出仓库模块，toy-market 默认关闭，us-market 没有密钥时看盘停用", (t) => {
	const run = list(stateDir(t));
	assert.equal(run.status, 0, run.stderr);
	assert.match(lineOf(run.stdout, "toy-market"), /停用（模块默认关闭）\s+modules\/toy-market$/);
	assert.match(lineOf(run.stdout, "us-market"), /启用（默认）\s+modules\/us-market$/);
	assert.match(run.stdout, /来源\s+us-market\s+massive-stocks：未配置行情密钥，看盘停用/);
	assert.match(run.stdout, /来源\s+toy-market\s+投递/);
	assert.match(run.stdout, /规则\s+toy-market\/big-move/);
	assert.match(run.stdout, /技能\s+toy-market\n/);
});

test("just modules：列出模块在 module.json 里开的工具，没开的写无", (t) => {
	const run = list(stateDir(t));
	assert.equal(run.status, 0, run.stderr);
	const block = (name: string) => run.stdout.split(/\n(?=\S)/).find((b) => b.startsWith(`${name} `)) ?? "";
	assert.match(block("us-market"), /\n  工具\s+lookup、tripwire\n/);
	assert.match(block("toy-market"), /\n  工具\s+无\n/);
});

test("just modules：按 config.json 的开关显示启用原因，停用模块的来源写模块停用", (t) => {
	const run = list(stateDir(t, { modules: { "toy-market": true, "us-market": false } }));
	assert.equal(run.status, 0, run.stderr);
	assert.match(lineOf(run.stdout, "toy-market"), /启用（config\.json 打开）/);
	assert.match(lineOf(run.stdout, "us-market"), /停用（config\.json 关闭）/);
	assert.match(run.stdout, /来源\s+us-market\s+massive-stocks：模块停用/);
});

test("just modules：列出状态目录里的模块，名字、状态和目录三列对齐", (t) => {
	const dir = stateDir(t);
	mkdirSync(join(dir, "modules", "mail", "skills", "triage"), { recursive: true });
	writeFileSync(join(dir, "modules", "mail", "module.json"), JSON.stringify({ name: "mail", sources: [{ name: "mail" }] }));
	writeFileSync(join(dir, "modules", "mail", "rules.md"), "## urgent\n加急邮件开任务\n\n## digest\n每天汇总\n");
	writeFileSync(join(dir, "modules", "mail", "skills", "triage", "SKILL.md"), "---\nname: triage\ndescription: x\n---\n");
	const run = list(dir);
	assert.equal(run.status, 0, run.stderr);
	assert.match(lineOf(run.stdout, "mail"), new RegExp(`启用（默认）\\s+${join(dir, "modules", "mail").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
	assert.match(run.stdout, /规则\s+mail\/urgent、mail\/digest/);
	assert.match(run.stdout, /技能\s+triage/);
	const heads = ["mail", "toy-market", "us-market"].map((n) => lineOf(run.stdout, n));
	assert.equal(new Set(heads.map((l) => l.match(/启用|停用/)?.index)).size, 1, heads.join("\n"));
});

test("just modules：有密钥时只写密钥来源，不打印密钥", (t) => {
	const run = list(stateDir(t), { MASSIVE_API_KEY: "sk-list-secret" });
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /massive-stocks：密钥来自 环境变量 MASSIVE_API_KEY/);
	assert.doesNotMatch(run.stdout + run.stderr, /sk-list-secret/);
});

test("just modules：config.json 写了没发现的模块名时只打印一句说明并以 1 退出", (t) => {
	const run = list(stateDir(t, { modules: { nope: false } }));
	assert.equal(run.status, 1);
	assert.match(run.stderr, /modules\.nope 不是已发现的模块/);
	assert.doesNotMatch(run.stderr, /^\s+at /m);
});

const newModule = (dir: string, args: string[]) => cli("src/cli/module.ts", dir, ["new", ...args]);
const kinds = (dir: string) => readdirSync(dir).filter((k) => !k.includes(".")).sort();

test("just module new：三种模板生成的包都通过检查，名字改成新名字，显示为已停用", (t) => {
	const dir = stateDir(t);
	for (const [template, expected] of [
		["notes", ["knowledge", "skills"]],
		["team", ["agents", "evals", "knowledge", "skills"]],
		["full", ["agents", "evals", "knowledge", "skills", "tools"]],
	] as const) {
		const name = `demo-${template}`;
		const run = newModule(dir, [name, "--template", template]);
		assert.equal(run.status, 0, run.stdout + run.stderr);
		const root = join(dir, "modules", name);
		assert.deepEqual(kinds(root), expected, template);
		assert.equal(JSON.parse(readFileSync(join(root, "module.json"), "utf8")).name, name);
		const checked = check(root);
		assert.equal(checked.status, 0, checked.stdout);
		assert.match(checked.stdout, new RegExp(`^ok ${name}@0\\.1\\.0 `));
		assert.match(lineOf(list(dir).stdout, name), /新布局\s+已停用\s/);
	}
});

test("just module new：不写 --template 时用 notes", (t) => {
	const dir = stateDir(t);
	const run = newModule(dir, ["demo"]);
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.deepEqual(kinds(join(dir, "modules", "demo")), ["knowledge", "skills"]);
});

test("just module new：重名时一行拒绝并以 1 退出，原目录不变", (t) => {
	const dir = stateDir(t);
	mkdirSync(join(dir, "modules", "demo"), { recursive: true });
	writeFileSync(join(dir, "modules", "demo", "notes.txt"), "mine");
	for (const name of ["demo", "toy-market"]) {
		const run = newModule(dir, [name, "--template", "team"]);
		assert.equal(run.status, 1, name);
		assert.equal((run.stdout + run.stderr).trim().split("\n").length, 1, run.stdout + run.stderr);
		assert.match(run.stdout + run.stderr, new RegExp(name));
	}
	assert.deepEqual(readdirSync(join(dir, "modules", "demo")), ["notes.txt"]);
	assert.deepEqual(readdirSync(join(dir, "modules")), ["demo"]);
});

test("just module new：名字不合法或模板不存在时拒绝，不建目录", (t) => {
	const dir = stateDir(t);
	for (const args of [["../evil"], ["中文"], ["-x"], ["demo", "--template", "nope"]]) {
		const run = newModule(dir, args);
		assert.notEqual(run.status, 0, args.join(" "));
		assert.match(run.stdout + run.stderr, args[2] === "nope" ? /notes、team、full/ : /模块名/, args.join(" "));
	}
	assert.ok(!existsSync(join(dir, "evil")));
	assert.ok(!existsSync(join(dir, "modules")) || readdirSync(join(dir, "modules")).length === 0);
});

test("模板不会被当成模块加载", (t) => {
	const modules = loadModules(loadConfig(stateDir(t)));
	const names = [...modules.found, ...modules.packages].map((m) => m.name);
	for (const template of ["notes", "team", "full"]) assert.ok(!names.includes(template), names.join(", "));
	assert.ok(!names.includes("templates"), names.join(", "));
});

test("just toy-feed：toy-market 关闭时说明怎么打开并以 1 退出，不投递；打开后照常投递", (t) => {
	const off = stateDir(t);
	const run = cli("modules/toy-market/feed.ts", off);
	assert.equal(run.status, 1);
	assert.match(run.stderr, /"modules": \{ "toy-market": true \}/);
	assert.ok(!existsSync(join(off, "inbox")) || readdirSync(join(off, "inbox")).length === 0);
	const on = stateDir(t, { modules: { "toy-market": true } });
	assert.equal(cli("modules/toy-market/feed.ts", on).status, 0);
	assert.equal(readdirSync(join(on, "inbox")).filter((f) => f.endsWith(".json")).length, 1);
});


test("just module check：好包打印一行 ok 名字@版本 和各类组件数，以 0 退出", () => {
	const run = check(join(SAMPLE, "personal-tax"));
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /^ok personal-tax@0\.1\.0 \| knowledge=0 data=1 tools=1 .*digest=[0-9a-f]{12}\n$/);
});

test("just module check：坏包每个问题一行，带路径和原因，以 1 退出", () => {
	const run = check(join(SAMPLE, "broken", "unknown-key"));
	assert.equal(run.status, 1);
	assert.match(run.stdout, /^module\.json: unknown key "descripton"/m);
	assert.match(run.stdout, /^rejected unknown-key: 1 problem\(s\)$/m);
});

test("just module check：目录不存在时一行原因，以 1 退出", () => {
	const run = check(join(SAMPLE, "no-such-package"));
	assert.equal(run.status, 1);
	assert.equal(run.stdout.trim().split("\n").length, 1);
	assert.match(run.stdout, /no-such-package/);
});

test("just modules：状态目录里的新布局包列成新布局，没打开的写已停用，无效的写原因；旧模块照列", (t) => {
	const dir = stateDir(t);
	mkdirSync(join(dir, "modules"));
	cpSync(join(SAMPLE, "personal-tax"), join(dir, "modules", "personal-tax"), { recursive: true });
	mkdirSync(join(dir, "modules", "bad"));
	writeFileSync(join(dir, "modules", "bad", "module.json"), JSON.stringify({ schema: 1, name: "bad", version: "0.1.0", descripton: "拼错" }));
	const run = list(dir);
	assert.equal(run.status, 0, run.stderr);
	assert.match(lineOf(run.stdout, "us-market"), /启用（默认）/);
	assert.match(lineOf(run.stdout, "personal-tax"), /新布局\s+已停用\s+\S*modules\/personal-tax$/);
	assert.match(lineOf(run.stdout, "bad"), /新布局\s+无效\s+\S*modules\/bad$/);
	assert.match(run.stdout, /\n  module\.json: unknown key "descripton"/);
});

test("just module check 的 --previous 指向不存在的目录：打印一行说明，以 1 退出，不打印堆栈", (t) => {
	const dir = stateDir(t);
	const run = cli("src/cli/module.ts", dir, ["check", "docs/modules/architecture/sample/personal-tax", "--previous", join(dir, "no-such-version")]);
	assert.equal(run.status, 1);
	assert.equal(`${run.stdout}${run.stderr}`.trim(), `${join(dir, "no-such-version")}: no such folder`);
});

test("just modules：新布局包按生命周期显示，没跑过工具用例的包不说有效；宿主把它打开以后显示运行中", async (t) => {
	const dir = stateDir(t);
	cpSync("docs/modules/architecture/sample/personal-tax", join(dir, "modules/personal-tax"), { recursive: true });
	const before = lineOf(list(dir).stdout, "personal-tax");
	assert.match(before, /新布局\s+已停用\s/);
	assert.doesNotMatch(before, /有效/);

	assert.equal(cli("src/cli/module.ts", dir, ["on", "personal-tax"]).status, 0);
	const db = openStore(join(dir, "state.db"));
	const config = loadConfig(dir);
	const modules = startLiveModules({ db, stateDir: dir, roots: config.modulesDirs, discovered: loadModules(config), configSwitches: config.moduleSwitches, log: () => {} });
	await until(() => modules.live.current().book.has("personal-tax"), "personal-tax 的工具用例跑完、开始服务", 15_000);
	modules.stop();
	db.close();
	const after = list(dir);
	assert.match(lineOf(after.stdout, "personal-tax"), /新布局\s+运行中\s/);
	assert.match(lineOf(after.stdout, "us-market"), /\s运行中\s/);
	assert.match(lineOf(after.stdout, "toy-market"), /\s已停用\s/);
	assert.match(after.stdout, /开关模块：just module on <名字> 或 just module off <名字>/);
	assert.match(after.stdout, /^模块 5 个，启用 4 个；/m);
});

test("just modules：运行中的新布局包写出正在服务的版本和摘要；存坏了以后仍写运行中，并写出新版本没通过的原因", async (t) => {
	const dir = stateDir(t);
	cpSync("docs/modules/architecture/sample/personal-tax", join(dir, "modules/personal-tax"), { recursive: true });
	assert.equal(cli("src/cli/module.ts", dir, ["on", "personal-tax"]).status, 0);
	const boot = async () => {
		const db = openStore(join(dir, "state.db"));
		const config = loadConfig(dir);
		const modules = startLiveModules({ db, stateDir: dir, roots: config.modulesDirs, discovered: loadModules(config), configSwitches: config.moduleSwitches, log: () => {} });
		await until(() => modules.live.current().book.has("personal-tax"), "personal-tax 在服务", 15_000);
		modules.stop();
		db.close();
	};
	await boot();
	const serving = readdirSync(join(dir, "module-store/personal-tax"))[0]!;
	const good = list(dir).stdout;
	assert.match(good, new RegExp(`\\n  版本  0\\.1\\.0（${serving.slice(0, 12)}）\\n`));

	writeFileSync(join(dir, "modules/personal-tax/module.json"), '{"schema":1,');
	await boot();
	const bad = list(dir).stdout;
	assert.match(lineOf(bad, "personal-tax"), /新布局\s+运行中\s/);
	assert.match(bad, new RegExp(`\\n  版本  0\\.1\\.0（${serving.slice(0, 12)}）\\n`));
	assert.match(bad, /\n  说明  0\.1\.0 在运行；你刚改的版本无效：module\.json：is not valid JSON/);
});

const GUIDE = "2022-aha-acc-hfsa-hf";

function healthState(t: import("node:test").TestContext) {
	const dir = stateDir(t);
	cpSync("docs/modules/architecture/sample/personal-health", join(dir, "modules/personal-health"), { recursive: true });
	const file = join(dir, "guide.md");
	writeFileSync(file, "# 心衰指南\n\n## 射血分数降低\n\n四联药物治疗。\n");
	return { dir, file };
}

test("just module import：把全文复制进实例数据并建好索引，包里不多文件，打印一行", (t) => {
	const { dir, file } = healthState(t);
	const run = cli("src/cli/module.ts", dir, ["import", "personal-health", GUIDE, file]);
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.match(run.stdout.trim(), /^导入了 personal-health 的 2022-aha-acc-hfsa-hf：1 个 Markdown 文件/);
	assert.equal(run.stdout.trim().split("\n").length, 1);
	assert.deepEqual(readdirSync(join(dir, "modules-data/personal-health/knowledge", GUIDE)).length, 1);
	assert.ok(existsSync(join(dir, "modules-data/personal-health/index/knowledge.db")));
	assert.deepEqual(readdirSync(join(dir, "modules/personal-health/knowledge", GUIDE)), ["source.json"]);
});

test("just module import 经过 just：文件名带空格时照常导入", (t) => {
	const { dir } = healthState(t);
	const file = join(dir, "TA02 - 心衰 指南.md");
	writeFileSync(file, "# 心衰指南\n\n## 射血分数降低\n\n四联药物治疗。\n");
	const run = spawnSync("just", ["module", "import", "personal-health", GUIDE, file], { encoding: "utf8", env: { ...process.env, PSA_STATE_DIR: dir } });
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.deepEqual(readdirSync(join(dir, "modules-data/personal-health/knowledge", GUIDE)), ["TA02 - 心衰 指南.md"]);
});

test("just module import：给的是一个不是 .md 的文件，一行拒绝并以 1 退出，之前导入的不动", (t) => {
	const { dir, file } = healthState(t);
	assert.equal(cli("src/cli/module.ts", dir, ["import", "personal-health", GUIDE, file]).status, 0);
	const notes = join(dir, "notes.txt");
	writeFileSync(notes, "四联药物治疗。");
	const run = cli("src/cli/module.ts", dir, ["import", "personal-health", GUIDE, notes]);
	assert.equal(run.status, 1, run.stdout + run.stderr);
	assert.equal((run.stdout + run.stderr).trim().split("\n").length, 1);
	assert.match(run.stdout, /只收 Markdown 文件（\.md）/);
	assert.doesNotMatch(run.stdout, /导入了/);
	assert.deepEqual(readdirSync(join(dir, "modules-data/personal-health/knowledge", GUIDE)), ["guide.md"]);
});

test("just module import：知识名不是 user-import 的、包里没有的、模块不存在的，各一行拒绝并以 1 退出", (t) => {
	const { dir, file } = healthState(t);
	for (const [module, doc, reason] of [
		["personal-health", "tumor-marker-basics", /tumor-marker-basics 随模块自带全文（license 是 bundled），不用导入/],
		["personal-health", "no-such-doc", /personal-health 没有叫 no-such-doc 的知识，有：2022-aha-acc-hfsa-hf、tumor-marker-basics/],
		["no-such-module", GUIDE, /no-such-module 不是已发现的新布局模块/],
	] as const) {
		const run = cli("src/cli/module.ts", dir, ["import", module, doc, file]);
		assert.equal(run.status, 1, `${module} ${doc}`);
		assert.match(run.stdout + run.stderr, reason);
		assert.equal((run.stdout + run.stderr).trim().split("\n").length, 1);
	}
	assert.ok(!existsSync(join(dir, "modules-data")));
});

const QUESTION = /^\[对话\][\s\S]*应税所得大概是 25000/;
const opensTaxTicket = on("开任务", QUESTION, (card) => {
	const open = openTicket(card, "预演算税");
	const decisions = (open.args.decisions as object[]).map((d) => ({ ...d, domain: "personal-tax" }));
	return [{ ...open, args: { decisions } }, reply(card, "好")];
});

function snapshot(dir: string): string {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.map((e) => join(e.parentPath, e.name))
		.sort()
		.map((path) => (statSync(path).isFile() ? `${path}\n${readFileSync(path, "utf8")}` : path))
		.join("\n");
}

type Rehearsal = { models?: { router: string; worker: string; fallback: string }; pkg?: string; secrets?: string; during?: (child: import("node:child_process").ChildProcess, fake: FakeModel, scratch: string) => Promise<void>; seed?: (dir: string) => void };

async function rehearse(t: import("node:test").TestContext, script: Script, { models = { router: "psa-fake/router", worker: "psa-fake/worker", fallback: "psa-fake/fallback" }, pkg = join(SAMPLE, "personal-tax"), secrets, during, seed }: Rehearsal = {}) {
	const fake = await FakeModel.start(script);
	t.after(() => fake.close());
	const dir = stateDir(t, { models, ...(secrets !== undefined && { secretsFile: "secrets.env" }) });
	if (secrets !== undefined) writeFileSync(join(dir, "secrets.env"), secrets);
	cpSync(pkg, join(dir, "modules", "personal-tax"), { recursive: true });
	seed?.(dir);
	const scratch = mkdtempSync(join(tmpdir(), "psa-tt-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const pi = mkdtempSync(join(tmpdir(), "psa-pi-"));
	t.after(() => rmSync(pi, { recursive: true, force: true }));
	const before = snapshot(dir);
	const env = { ...process.env, ...fakeAgentEnv(fake, pi), PSA_STATE_DIR: dir, TMPDIR: scratch };
	const child = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/cli/module.ts", "try", "personal-tax"], { env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	const tryDirs = () => readdirSync(scratch).filter((f) => f.startsWith("psa-try-"));
	let leftWhenSaidGone: string[] | undefined;
	child.stdout.setEncoding("utf8").on("data", (s: string) => {
		out += s;
		if (leftWhenSaidGone === undefined && out.includes("临时状态目录已删")) leftWhenSaidGone = tryDirs();
	});
	child.stderr.setEncoding("utf8").on("data", (s: string) => (out += s));
	const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
	const closed = new Promise<number | null>((done) => child.once("close", done));
	await during?.(child, fake, scratch);
	const status = await closed;
	clearTimeout(timer);
	return { status, out, leftover: tryDirs(), leftWhenSaidGone, userDirChanged: snapshot(dir) !== before };
}

test("just module try：假模型调了考题要的工具、汇报里有该有的话，判通过，临时状态目录删掉，使用者的状态目录不变", async (t) => {
	const run = await rehearse(t, {
		router: [opensTaxTicket],
		workers: [worker("预演算税", on("调工具", /^\[任务说明\]/, () => [domainTool("tax-bracket", { taxableIncome: 25000 })]), on("汇报", /^\[模块工具\]/, () => [report("ready", "落在第 2 档，估算税额 4000 美元")]))],
	});
	assert.equal(run.status, 0, run.out);
	assert.match(run.out, /^PASS bracket-uses-tool/m);
	assert.match(run.out, /落在第 2 档，估算税额 4000 美元/);
	assert.deepEqual(run.leftover, []);
	assert.deepEqual(run.leftWhenSaidGone, [], "说临时状态目录已删时它已经删了");
	assert.equal(run.userDirChanged, false);
});

test("just module try：临时状态目录里的 files/ 是真实 files/ 的副本，venv 是指向真实 venv 的符号链接", async (t) => {
	let seen: { note: string; venvIsLink: boolean; venvTarget: string } | undefined;
	let real = "";
	const run = await rehearse(
		t,
		{
			router: [opensTaxTicket],
			workers: [worker("预演算税", on("调工具", /^\[任务说明\]/, () => [domainTool("tax-bracket", { taxableIncome: 25000 })]), on("汇报", /^\[模块工具\]/, () => [report("ready", "落在第 2 档，估算税额 4000 美元")]))],
		},
		{
			seed: (dir) => {
				real = join(dir, "modules-data/personal-tax/files");
				mkdirSync(join(real, "venv-aaaaaaaaaaaa/bin"), { recursive: true });
				writeFileSync(join(real, "venv-aaaaaaaaaaaa/.psa-lock"), "a");
				writeFileSync(join(real, "note.txt"), "kept by the module");
			},
			during: async (_child, fake, scratch) => {
				await until(() => fake.exchanges.length > 0, "临时宿主开始问模型", 20_000);
				const temp = join(scratch, readdirSync(scratch).find((f) => f.startsWith("psa-try-")) ?? "", "modules-data/personal-tax/files");
				if (!existsSync(join(temp, "note.txt"))) return;
				seen = { note: readFileSync(join(temp, "note.txt"), "utf8"), venvIsLink: lstatSync(join(temp, "venv-aaaaaaaaaaaa")).isSymbolicLink(), venvTarget: realpathSync(join(temp, "venv-aaaaaaaaaaaa")) };
			},
		},
	);
	assert.equal(run.status, 0, run.out);
	assert.deepEqual(seen, { note: "kept by the module", venvIsLink: true, venvTarget: realpathSync(join(real, "venv-aaaaaaaaaaaa")) });
	assert.equal(run.userDirChanged, false);
});

test("just module try：工具要密钥时，检查用假密钥跑用例，预演照常判通过", async (t) => {
	const pkg = mkdtempSync(join(tmpdir(), "psa-keyed-"));
	t.after(() => rmSync(pkg, { recursive: true, force: true }));
	cpSync(join(SAMPLE, "personal-tax"), pkg, { recursive: true });
	for (const [path, content] of Object.entries({
		"tools/probe/tool.json": JSON.stringify({ title: "probe", description: "reads its key", input: { x: { type: "number", title: "x" } }, output: { y: { type: "number", title: "y" } }, secrets: ["PERSONAL_TAX__LAB_KEY"] }),
		"tools/probe/index.ts": `export default async () => ({ y: process.env.PERSONAL_TAX__LAB_KEY ? 1 : 0 });`,
		"tools/probe/cases.json": JSON.stringify([{ name: "has-key", input: { x: 1 }, expect: { y: 1 } }]),
	})) {
		mkdirSync(join(pkg, path, ".."), { recursive: true });
		writeFileSync(join(pkg, path), content);
	}
	const run = await rehearse(
		t,
		{
			router: [opensTaxTicket],
			workers: [worker("预演算税", on("调工具", /^\[任务说明\]/, () => [domainTool("tax-bracket", { taxableIncome: 25000 })]), on("汇报", /^\[模块工具\]/, () => [report("ready", "落在第 2 档，估算税额 4000 美元")]))],
		},
		{ pkg, secrets: "PERSONAL_TAX__LAB_KEY=k\n" },
	);
	assert.equal(run.status, 0, run.out);
	assert.match(run.out, /^PASS bracket-uses-tool/m);
});

test("just module try：没调考题要的工具时判失败，写出没用到哪一项，以 1 退出", async (t) => {
	const run = await rehearse(t, {
		router: [opensTaxTicket],
		workers: [worker("预演算税", on("直接汇报", /^\[任务说明\]/, () => [report("ready", "第 2 档，估算 4000 美元")]))],
	});
	assert.equal(run.status, 1, run.out);
	assert.match(run.out, /^FAIL bracket-uses-tool：.*没用到 tools\/tax-bracket/m);
	assert.doesNotMatch(run.out, /汇报里没有/);
	assert.deepEqual(run.leftover, []);
});

test("just module try：config.json 的模型按量计费时一行拒绝，不起宿主", async (t) => {
	const run = await rehearse(t, { router: [] }, { models: { router: "openai-codex/gpt-6.1-terra", worker: "deepseek/deepseek-flash", fallback: "openai-codex/gpt-6.1-sol" } });
	assert.equal(run.status, 1, run.out);
	assert.equal(run.out.trim().split("\n").length, 1, run.out);
	assert.match(run.out, /deepseek\/deepseek-flash.*按量计费/);
	assert.deepEqual(run.leftover, []);
});

const groupAlive = (pgid: number) => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	test(`just module try：等汇报时收到 ${signal}，停掉临时宿主、删掉临时状态目录，以 130 退出，不打印堆栈`, async (t) => {
		let host = 0;
		const run = await rehearse(t, {
			router: [opensTaxTicket],
			workers: [worker("预演算税", on("想很久", /^\[任务说明\]/, () => [report("ready", "第 2 档")], 20_000))],
		}, {
			during: async (child, fake) => {
				await until(() => fake.exchanges.some((e) => e.cards.some((c) => c.startsWith("[任务说明]"))), "Worker 开始干活", 20_000);
				host = Number(spawnSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).stdout.trim().split("\n")[0]);
				// SIGSTOP makes the host slow to stop, like one running real Workers, so try must wait for host.stop() before exiting.
				process.kill(host, "SIGSTOP");
				child.kill(signal);
				await new Promise((done) => setTimeout(done, 500));
				process.kill(host, "SIGCONT");
			},
		});
		assert.equal(run.status, 130, run.out);
		assert.doesNotMatch(run.out, /Error|    at /);
		assert.deepEqual(run.leftover, []);
		assert.ok(host > 0 && !groupAlive(host), `临时宿主 ${host} 还活着`);
	});
}

test("just module try：模块打开后临时宿主退出，写出一行原因和宿主的报错，删掉临时状态目录，以 1 退出", async (t) => {
	const pkg = join(stateDir(t), "team");
	cpSync(join(import.meta.dirname, "..", "src", "modules", "templates", "team"), pkg, { recursive: true });
	writeFileSync(join(pkg, "module.json"), readFileSync(join(pkg, "module.json"), "utf8").replace('"name": "team"', '"name": "personal-tax"'));
	const run = await rehearse(t, { router: [] }, { pkg, models: { router: "psa-fake/no-such-model", worker: "psa-fake/worker", fallback: "psa-fake/fallback" } });
	assert.equal(run.status, 1, run.out);
	assert.match(run.out, /临时宿主.*退出/);
	assert.match(run.out, /找不到模型 psa-fake\/no-such-model/);
	assert.doesNotMatch(run.out, /unsettled top-level await|临时状态目录已删/);
	assert.deepEqual(run.leftover, []);
});
