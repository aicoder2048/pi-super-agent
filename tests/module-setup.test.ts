import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { problemLine, scanPackage } from "../src/modules/validate.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const venvName = (lock: string) => `venv-${sha(lock).slice(0, 12)}`;

const FAKE_UV = `#!${process.execPath}
const fs = require("node:fs");
const env = process.env.UV_PROJECT_ENVIRONMENT;
fs.appendFileSync(process.env.FAKE_UV_LOG, JSON.stringify({ argv: process.argv.slice(2), env, markedBefore: fs.existsSync(env + "/.psa-lock"), leftover: fs.existsSync(env + "/half") }) + "\\n");
if (process.env.FAKE_UV_FAIL) { console.error("fatal: could not read Username for 'https://github.com'"); process.exit(2); }
fs.mkdirSync(env + "/bin", { recursive: true });
fs.writeFileSync(env + "/bin/sample", "#!/bin/sh\\n");
`;

function setting(t: TestContext, { py = true, lock = "version = 1\n" }: { py?: boolean; lock?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "psa-setup-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const pkg = join(dir, "modules", "alpha");
	mkdirSync(join(pkg, "py"), { recursive: true });
	writeFileSync(join(pkg, "module.json"), JSON.stringify({ schema: 1, name: "alpha", version: "0.1.0", title: "alpha", description: "module setup" }));
	if (py) {
		writeFileSync(join(pkg, "py/pyproject.toml"), `[project]\nname = "sample"\nversion = "0"\n`);
		writeFileSync(join(pkg, "py/uv.lock"), lock);
	} else rmSync(join(pkg, "py"), { recursive: true });
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin/uv"), FAKE_UV);
	chmodSync(join(dir, "bin/uv"), 0o755);
	const log = join(dir, "uv.log");
	const files = join(dir, "modules-data/alpha/files");
	return {
		dir,
		pkg,
		files,
		relock: (text: string) => writeFileSync(join(pkg, "py/uv.lock"), text),
		calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; env: string; markedBefore: boolean; leftover: boolean }) : []),
		venvs: () => (existsSync(files) ? readdirSync(files).sort() : []),
		setup(name = "alpha", { uv = true, fail = false } = {}) {
			const env = { PATH: `${uv ? `${join(dir, "bin")}:` : ""}${dirname(process.execPath)}`, HOME: process.env["HOME"] ?? "", PSA_STATE_DIR: dir, FAKE_UV_LOG: log, ...(fail && { FAKE_UV_FAIL: "1" }) };
			const run = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/cli/module.ts", "setup", name], { env, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
			return { status: run.status, out: run.stdout + run.stderr, lines: run.stdout.trim().split("\n") };
		},
	};
}

function snapshot(dir: string): string {
	return (readdirSync(dir, { recursive: true }) as string[]).sort().map((path) => (statSync(join(dir, path)).isFile() ? `${path}\n${sha(readFileSync(join(dir, path), "utf8"))}` : path)).join("\n");
}

test("just module setup：按锁文件调 uv sync，环境建在数据目录的 files/venv-<12 位>，最后写 .psa-lock，包目录不变，打印一行", (t) => {
	const s = setting(t);
	const before = snapshot(s.pkg);
	const run = s.setup();
	assert.equal(run.status, 0, run.out);
	const venv = join(s.files, venvName("version = 1\n"));
	assert.deepEqual(s.calls(), [{ argv: ["sync", "--frozen", "--compile-bytecode", "--project", join(s.pkg, "py")], env: venv, markedBefore: false, leftover: false }]);
	assert.equal(readFileSync(join(venv, ".psa-lock"), "utf8"), sha("version = 1\n"));
	assert.ok(existsSync(join(venv, "bin/sample")));
	assert.equal(snapshot(s.pkg), before);
	assert.equal(run.lines.length, 1, run.out);
	assert.match(run.lines[0] ?? "", /装好了 alpha 的 Python 环境.*venv-[0-9a-f]{12}/);
});

test("just module setup：同一个锁文件重跑，不再调 uv，什么都不变", (t) => {
	const s = setting(t);
	s.setup();
	const before = snapshot(s.files);
	const mark = statSync(join(s.files, venvName("version = 1\n"), ".psa-lock")).mtimeMs;
	const run = s.setup();
	assert.equal(run.status, 0, run.out);
	assert.equal(s.calls().length, 1);
	assert.equal(snapshot(s.files), before);
	assert.equal(statSync(join(s.files, venvName("version = 1\n"), ".psa-lock")).mtimeMs, mark);
	assert.match(run.out, /已经装好/);
});

test("just module setup：没有 .psa-lock 的 venv 算没装完，删掉重装", (t) => {
	const s = setting(t);
	const venv = join(s.files, venvName("version = 1\n"));
	mkdirSync(venv, { recursive: true });
	writeFileSync(join(venv, "half"), "x");
	const run = s.setup();
	assert.equal(run.status, 0, run.out);
	assert.deepEqual(s.calls().map((c) => c.leftover), [false]);
	assert.ok(!existsSync(join(venv, "half")));
	assert.equal(readFileSync(join(venv, ".psa-lock"), "utf8"), sha("version = 1\n"));
});

test("just module setup：锁文件换了就多一个 venv，只留当前和上一个，没装完的也删", (t) => {
	const s = setting(t);
	s.setup();
	mkdirSync(join(s.files, "venv-000000000000"), { recursive: true });
	writeFileSync(join(s.files, "kept-by-module"), "x");
	s.relock("version = 2\n");
	assert.equal(s.setup().status, 0);
	assert.deepEqual(s.venvs(), ["kept-by-module", venvName("version = 1\n"), venvName("version = 2\n")].sort());
	s.relock("version = 3\n");
	assert.equal(s.setup().status, 0);
	assert.deepEqual(s.venvs(), ["kept-by-module", venvName("version = 2\n"), venvName("version = 3\n")].sort());
});

test("just module setup：PATH 里没有 uv 时一行说明怎么办，以 1 退出", (t) => {
	const s = setting(t);
	const run = s.setup("alpha", { uv: false });
	assert.equal(run.status, 1, run.out);
	assert.equal(run.out.trim().split("\n").length, 1, run.out);
	assert.match(run.out, /找不到 uv.*docs\/modules\/stock-ta\.md/);
	assert.deepEqual(s.venvs(), []);
});

test("just module setup：uv 没装成时说明先让 git 拿到私有仓库，以 1 退出，不留 .psa-lock，下次重装", (t) => {
	const s = setting(t);
	const run = s.setup("alpha", { fail: true });
	assert.equal(run.status, 1, run.out);
	assert.match(run.lines.at(-1) ?? "", /uv 没装成.*git.*docs\/modules\/stock-ta\.md/);
	assert.ok(!existsSync(join(s.files, venvName("version = 1\n"), ".psa-lock")));
	assert.equal(s.setup().status, 0);
	assert.equal(s.calls().length, 2);
});

test("just module setup：包里没有 py/ 时一行说明不用装；没有这个模块时一行拒绝", (t) => {
	const s = setting(t, { py: false });
	const none = s.setup();
	assert.equal(none.status, 0, none.out);
	assert.match(none.out, /alpha 没有 py\/ 子项目，不用装/);
	const unknown = s.setup("no-such-module");
	assert.equal(unknown.status, 1, unknown.out);
	assert.match(unknown.out, /no-such-module 不是已发现的新布局模块/);
	assert.deepEqual(s.calls(), []);
});

test("just module check：py/ 里有 pyproject.toml 没有 uv.lock 时拒绝并说明，反过来也一样；setup 不装没通过检查的包", (t) => {
	const s = setting(t);
	rmSync(join(s.pkg, "py/uv.lock"));
	const noLock = scanPackage(s.pkg);
	assert.match(noLock.ok ? "" : noLock.problems.map(problemLine).join("\n"), /^py: needs py\/uv\.lock/);
	const run = s.setup();
	assert.equal(run.status, 1, run.out);
	assert.deepEqual(s.calls(), []);
	s.relock("version = 1\n");
	rmSync(join(s.pkg, "py/pyproject.toml"));
	const noProject = scanPackage(s.pkg);
	assert.match(noProject.ok ? "" : noProject.problems.map(problemLine).join("\n"), /^py: needs py\/pyproject\.toml/);
});
