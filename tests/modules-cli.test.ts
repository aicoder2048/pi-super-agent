import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, loadModules } from "../src/host/config.ts";
import { startLiveModules } from "../src/host/live-modules.ts";
import { openStore } from "../src/kernel/store.ts";
import { KEY_NAMES } from "../src/sources/market/key.ts";
import { until } from "./helpers/fakes.ts";

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
const scaffold = (dir: string, name: string) => cli("src/cli/module-new.ts", dir, [name]);
const lineOf = (out: string, name: string) => out.split("\n").find((l) => l.startsWith(`${name} `)) ?? "";

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

test("just module-new：生成能干净加载的模块，打印生成的文件和下一步", (t) => {
	const dir = stateDir(t);
	const run = scaffold(dir, "demo");
	assert.equal(run.status, 0, run.stderr);
	const root = join(dir, "modules", "demo");
	for (const file of ["module.json", "rules.md", join("skills", "README.txt")]) {
		assert.ok(existsSync(join(root, file)), file);
		assert.match(run.stdout, new RegExp(file.replace(".", "\\.")));
	}
	assert.match(run.stdout, /重启宿主/);
	assert.match(run.stdout, /just modules/);
	const demo = loadModules(loadConfig(dir)).found.find((m) => m.name === "demo")!;
	assert.deepEqual(demo.state, { enabled: true, by: "default" });
	assert.deepEqual(demo.rules.map((r) => [r.id, r.sources]), [["demo/example", ["demo"]]]);
	assert.deepEqual(demo.manifest.sources?.map((s) => [s.name, s.feed]), [["demo", undefined]]);
	assert.match(lineOf(list(dir).stdout, "demo"), /启用（默认）/);
});

test("just module-new：目录已存在时拒绝并以 1 退出，不改已有文件", (t) => {
	const dir = stateDir(t);
	mkdirSync(join(dir, "modules", "demo"), { recursive: true });
	writeFileSync(join(dir, "modules", "demo", "rules.md"), "mine");
	const run = scaffold(dir, "demo");
	assert.equal(run.status, 1);
	assert.match(run.stderr, /已存在/);
	assert.equal(readFileSync(join(dir, "modules", "demo", "rules.md"), "utf8"), "mine");
	assert.deepEqual(readdirSync(join(dir, "modules", "demo")), ["rules.md"]);
});

test("just module-new：和已有模块重名时拒绝", (t) => {
	const dir = stateDir(t);
	const run = scaffold(dir, "toy-market");
	assert.equal(run.status, 1);
	assert.match(run.stderr, /toy-market/);
	assert.ok(!existsSync(join(dir, "modules", "toy-market")));
});

test("just module-new：名字不合法时拒绝，不在任何地方建目录", (t) => {
	const dir = stateDir(t);
	for (const name of ["../evil", "中文", "-x"]) {
		const run = scaffold(dir, name);
		assert.equal(run.status, 1, name);
		assert.match(run.stderr, /模块名/, name);
	}
	assert.ok(!existsSync(join(dir, "evil")));
	assert.ok(!existsSync(join(dir, "modules")) || readdirSync(join(dir, "modules")).length === 0);
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

const SAMPLE = join(import.meta.dirname, "..", "docs", "modules", "architecture", "sample");
const check = (dir: string) => cli("src/cli/module.ts", tmpdir(), ["check", dir]);

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
	assert.match(after.stdout, /^模块 4 个，启用 3 个；/m);
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
