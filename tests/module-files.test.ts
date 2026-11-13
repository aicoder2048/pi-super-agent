import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { startLiveModules } from "../src/host/live-modules.ts";
import { moduleRows, openStore, setModuleSwitch } from "../src/kernel/store.ts";
import { Modules } from "../src/modules.ts";
import { runFeed } from "../src/modules/feed-runner.ts";
import { cloneFiles } from "../src/modules/files.ts";
import { createGateway } from "../src/modules/gateway.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { moduleDataDir } from "../src/modules/knowledge.ts";
import { describe } from "../src/modules/lifecycle.ts";
import { ModuleStore } from "../src/modules/live.ts";
import type { ComponentName, Digest, ModuleName } from "../src/modules/manifest.ts";
import type { WorkerCaller } from "../src/modules/protocol.ts";
import { digestOf, problemLine, scanPackage } from "../src/modules/validate.ts";
import { servedAsHost, until } from "./helpers/fakes.ts";

function files(root: string, tree: Record<string, string>): void {
	for (const [path, content] of Object.entries(tree)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

function scratch(t: TestContext): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "psa-files-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const WHERE_TOOL = {
	"tool.json": JSON.stringify({ title: "where", description: "says where its data is", input: { x: { type: "number", title: "x" } }, output: { data: { type: "text", title: "data" } }, effect: "read" }),
	"index.ts": `export default () => ({ data: process.env.PSA_MODULE_DATA ?? null, venv: process.env.PSA_MODULE_VENV ?? null });`,
};

/** The handler writes into `files/` and leaves the data dir it was given in the file `settings.out` names. */
const WRITING_FEED = (limit?: string) => ({
	"feed.json": JSON.stringify({ title: "写文件", handler: "index.ts", every: "1h", into: "runs", settings: { out: "", sleepMs: 0 }, ...(limit !== undefined && { limit }) }),
	"index.ts": `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default async ({ settings }) => {
	const data = process.env.PSA_MODULE_DATA;
	writeFileSync(join(data, "files", "written-by-feed"), "x");
	if (settings.out) writeFileSync(settings.out, data);
	await new Promise((done) => setTimeout(done, settings.sleepMs));
	return { records: [{ id: "r1", note: "ran" }] };
};`,
});

function pack(name: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		[`${name}/module.json`]: JSON.stringify({ schema: 1, name, version: "0.1.0", title: name, description: "module files" }),
		...Object.fromEntries(Object.entries(WHERE_TOOL).map(([file, text]) => [`${name}/tools/where/${file}`, text])),
		...Object.fromEntries(Object.entries(extra).map(([file, text]) => [`${name}/${file}`, text])),
	};
}

const feedFiles = (out: string, limit?: string): Record<string, string> => ({
	"data/runs/collection.json": JSON.stringify({ title: "运行", kind: "record", class: "shareable", fields: { note: { type: "text", title: "说明" } } }),
	...Object.fromEntries(Object.entries(WRITING_FEED(limit)).map(([file, text]) => [`feeds/write/${file}`, text])),
	"feeds/write/fixtures/once.json": JSON.stringify({ input: { settings: { out } }, responses: {} }),
});

const PY = { "py/pyproject.toml": `[project]\nname = "sample"\nversion = "0"\n`, "py/uv.lock": "version = 1\n" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function gatewayOver(t: TestContext, tree: Record<string, string>) {
	const root = scratch(t);
	files(join(root, "modules"), tree);
	const store = new ModuleStore(join(root, "store"));
	const serving = new Map<string, Digest>();
	const keep = (name: string) => {
		const scan = scanPackage(join(root, "modules", name), { runCases: false });
		assert.ok(scan.ok, scan.ok ? "" : scan.problems.map(problemLine).join("\n"));
		assert.ok(store.keep(name as ModuleName, scan.scan.digest, join(root, "modules", name)));
		serving.set(name, scan.scan.digest);
		return scan.scan.digest;
	};
	const data = instanceData(join(root, "state"));
	const gateway = createGateway({ copyDir: (m, d) => store.dirOf(m, d), serving: (m) => serving.get(m), dataDir: (m) => moduleDataDir(join(root, "state"), m), rows: data, secret: () => undefined, log: () => {} });
	const where = async (name: string, digest: Digest) => {
		const caller: WorkerCaller = { who: "worker", ticket: "tkt_1", pin: { module: name as ModuleName, digest }, basis: "request", member: null, heardOthers: false };
		const reply = await gateway.call(caller, { kind: "tool", name: "where" as ComponentName, input: { x: 1 } });
		assert.ok(reply.ok, JSON.stringify(reply));
		return reply.output as { data: string; venv: string | null };
	};
	return { root, keep, where, data, dataOf: (name: string) => moduleDataDir(join(root, "state"), name) };
}

test("工具拿到自己模块的数据目录，拿不到别的模块的，files/ 已经建好", async (t) => {
	const { keep, where, dataOf } = gatewayOver(t, { ...pack("alpha"), ...pack("beta") });
	const [alpha, beta] = [await where("alpha", keep("alpha")), await where("beta", keep("beta"))];
	assert.equal(alpha.data, dataOf("alpha"));
	assert.equal(beta.data, dataOf("beta"));
	assert.ok(existsSync(join(dataOf("alpha"), "files")) && existsSync(join(dataOf("beta"), "files")));
});

test("包里有 py/uv.lock：工具拿到和自己这份包副本的锁文件对得上的 venv 路径，锁文件换了以后钉在旧版本的照旧", async (t) => {
	const { root, keep, where, dataOf } = gatewayOver(t, pack("alpha", PY));
	const old = keep("alpha");
	writeFileSync(join(root, "modules/alpha/py/uv.lock"), "version = 2\n");
	const next = keep("alpha");
	assert.equal((await where("alpha", old)).venv, join(dataOf("alpha"), "files", `venv-${sha("version = 1\n").slice(0, 12)}`));
	assert.equal((await where("alpha", next)).venv, join(dataOf("alpha"), "files", `venv-${sha("version = 2\n").slice(0, 12)}`));
});

test("包里没有 py/：工具没有 venv 路径", async (t) => {
	const { keep, where } = gatewayOver(t, pack("alpha"));
	assert.equal((await where("alpha", keep("alpha"))).venv, null);
});

function feedOf(t: TestContext, limit?: string) {
	const root = scratch(t);
	const out = join(root, "out");
	files(join(root, "modules"), pack("alpha", feedFiles(out, limit)));
	const entry = servedAsHost(Modules.load([join(root, "modules")])).feeds().find((e) => e.source === "alpha/write");
	assert.ok(entry);
	const data = instanceData(join(root, "state"));
	const run = (settings: object, limitMs?: number) =>
		runFeed({ ...entry, feed: { ...entry.feed, settings: { ...entry.feed.settings, ...settings } } }, [], { data, submit: () => {}, alert: () => {}, secret: () => undefined, now: () => 0, ...(limitMs !== undefined && { limitMs }) });
	return { root, out, run, real: moduleDataDir(join(root, "state"), "alpha") };
}

test("feed 的 handler 拿到自己模块的数据目录，能往 files/ 写", async (t) => {
	const { out, run, real } = feedOf(t);
	assert.deepEqual(await run({ out }), { ok: true, records: 1, notices: 0 });
	assert.equal(readFileSync(out, "utf8"), real);
	assert.ok(existsSync(join(real, "files", "written-by-feed")));
});

test("feed.json 的 limit 代替默认时限：比默认久的调用成功，到 limit 还没完的被停掉", async (t) => {
	const { run } = feedOf(t, "2s");
	assert.deepEqual(await run({ sleepMs: 700 }, 200), { ok: true, records: 1, notices: 0 });
	const late = await run({ sleepMs: 60_000 }, 200);
	assert.match(late.ok ? "" : late.note, /limit of 2 s/);
});

test("不写 limit：还是宿主默认的时限", async (t) => {
	const { run } = feedOf(t);
	const late = await run({ sleepMs: 60_000 }, 200);
	assert.match(late.ok ? "" : late.note, /limit of 0\.2 s/);
});

test("limit 最多 10m，写法不对或超过都被检查拒绝", (t) => {
	const problems = (limit: string) => {
		const root = scratch(t);
		files(root, pack("alpha", feedFiles("", limit)));
		const scan = scanPackage(join(root, "alpha"));
		return scan.ok ? "" : scan.problems.map(problemLine).join("\n");
	};
	assert.equal(problems("10m"), "");
	assert.equal(problems("90s"), "");
	for (const bad of ["11m", "601s", "1h", "0s", "soon"]) assert.match(problems(bad), /feeds\/write\/feed\.json: "limit"/, bad);
});

test("just module check 跑 fixtures：handler 拿到的是临时数据目录，跑完删掉", (t) => {
	const root = scratch(t);
	const out = join(root, "out");
	files(root, pack("alpha", feedFiles(out)));
	const scan = scanPackage(join(root, "alpha"));
	assert.ok(scan.ok, scan.ok ? "" : scan.problems.map(problemLine).join("\n"));
	const given = readFileSync(out, "utf8");
	assert.ok(!given.includes("modules-data"), given);
	assert.ok(!existsSync(given), "临时数据目录删掉了");
});

const label = (dir: string, name: string) => {
	const db = openStore(join(dir, "state.db"));
	try {
		const row = moduleRows(db).find((r) => r.name === name);
		return row?.record ? describe(row.record) : undefined;
	} finally {
		db.close();
	}
};

function host(t: TestContext, tree: Record<string, string>) {
	const dir = scratch(t);
	files(join(dir, "modules"), tree);
	const db = openStore(join(dir, "state.db"));
	const roots = [join(dir, "modules")];
	const modules = startLiveModules({ db, stateDir: dir, roots, discovered: Modules.load(roots, { switches: { values: {}, file: "config.json" } }), configSwitches: {}, secret: () => undefined, log: () => {} });
	t.after(() => {
		modules.stop();
		if (db.isOpen) db.close();
	});
	return { dir, db };
}

test("宿主装新版本前跑 fixtures：handler 拿到的是临时数据目录，真实数据目录里没有它写的文件，带 py/ 的包照样运行", async (t) => {
	const out = join(scratch(t), "out");
	const { dir, db } = host(t, pack("alpha", { ...feedFiles(out), ...PY }));
	setModuleSwitch(db, "alpha", true);
	await until(() => ["运行中", "无效"].includes(label(dir, "alpha")?.label ?? ""), "alpha 检查完", 15_000);
	assert.equal(label(dir, "alpha")?.label, "运行中", label(dir, "alpha")?.reason);
	const given = readFileSync(out, "utf8");
	assert.notEqual(given, moduleDataDir(dir, "alpha"));
	assert.ok(!existsSync(given), "临时数据目录删掉了");
	assert.ok(!existsSync(join(moduleDataDir(dir, "alpha"), "files", "written-by-feed")));
});

test("just module check 接受 py/：有 pyproject.toml 和 uv.lock 的包通过，没有 py 的报错", (t) => {
	const root = scratch(t);
	files(root, pack("alpha", PY));
	const scan = scanPackage(join(root, "alpha"));
	assert.ok(scan.ok, scan.ok ? "" : scan.problems.map(problemLine).join("\n"));
});

test("py/ 里的 __pycache__ 不改变版本 digest，别的文件改了照样变", (t) => {
	const root = scratch(t);
	files(root, pack("alpha", PY));
	const before = digestOf(join(root, "alpha"));
	files(root, { "alpha/py/__pycache__/x.pyc": "bytecode", "alpha/tools/where/__pycache__/y.pyc": "bytecode" });
	assert.equal(digestOf(join(root, "alpha")), before);
	const scan = scanPackage(join(root, "alpha"));
	assert.ok(scan.ok, scan.ok ? "" : scan.problems.map(problemLine).join("\n"));
	writeFileSync(join(root, "alpha/py/uv.lock"), "version = 2\n");
	assert.notEqual(digestOf(join(root, "alpha")), before);
});

test("预演用的 files/：普通文件是副本，venv-* 是指向真实 venv 的符号链接，写副本不碰真实文件", (t) => {
	const root = scratch(t);
	const [real, temp] = [join(root, "real"), join(root, "temp")];
	files(real, { "files/ta/ta.sqlite": "rows", "files/venv-aaaaaaaaaaaa/bin/ta": "#!/bin/sh\n", "files/venv-aaaaaaaaaaaa/.psa-lock": "a", "data.db": "host" });
	cloneFiles(real, temp);
	assert.equal(readFileSync(join(temp, "files/ta/ta.sqlite"), "utf8"), "rows");
	assert.ok(lstatSync(join(temp, "files/venv-aaaaaaaaaaaa")).isSymbolicLink());
	assert.equal(realpathSync(join(temp, "files/venv-aaaaaaaaaaaa")), join(real, "files/venv-aaaaaaaaaaaa"));
	assert.deepEqual(readdirSync(temp), ["files"]);
	writeFileSync(join(temp, "files/ta/ta.sqlite"), "changed");
	assert.equal(readFileSync(join(real, "files/ta/ta.sqlite"), "utf8"), "rows");
});

test("预演用的 files/：真实数据目录还没有 files/ 时什么都不建", (t) => {
	const root = scratch(t);
	cloneFiles(join(root, "real"), join(root, "temp"));
	assert.ok(!existsSync(join(root, "temp")));
});

test("purge 删掉整个数据目录，files/ 和里面的 venv 跟着删", async (t) => {
	const { keep, where, data, dataOf } = gatewayOver(t, pack("alpha"));
	await where("alpha", keep("alpha"));
	files(dataOf("alpha"), { "files/venv-aaaaaaaaaaaa/.psa-lock": "a" });
	data.purge("alpha" as ModuleName);
	assert.ok(!existsSync(dataOf("alpha")));
});
