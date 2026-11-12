import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, loadModules } from "../src/host/config.ts";
import { KEY_NAMES } from "../src/sources/market/key.ts";

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
