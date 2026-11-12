import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { startLiveModules } from "../src/host/live-modules.ts";
import { moduleRows, openStore, setModuleSwitch } from "../src/kernel/store.ts";
import { Modules } from "../src/modules.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { describe, initialRecord, transition, type ModuleRecord } from "../src/modules/lifecycle.ts";
import type { Component, ComponentName, Digest, ModuleName } from "../src/modules/manifest.ts";
import { scanPackage } from "../src/modules/validate.ts";

const SAMPLE = join(import.meta.dirname, "..", "docs", "modules", "architecture", "sample");
const UPDATE = join(SAMPLE, "update");
const LITE = "health-lite" as ModuleName;

function stateDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-data-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function components(dir: string): Component[] {
	const scan = scanPackage(dir, { runCases: false });
	assert.ok(scan.ok, JSON.stringify(scan));
	return [...scan.scan.components];
}
const lite = (version: string) => components(join(UPDATE, version, "health-lite"));

const dbOf = (state: string, module: string) => join(state, "modules-data", module, "data.db");
function sql<T>(state: string, module: string, query: string, ...args: (string | number | null)[]): T[] {
	const db = new DatabaseSync(dbOf(state, module), { readOnly: true });
	try {
		return db.prepare(query).all(...args).map((row) => ({ ...row })) as T[];
	} finally {
		db.close();
	}
}
function write(state: string, module: string, query: string, ...args: (string | number | null)[]): void {
	const db = new DatabaseSync(dbOf(state, module));
	try {
		db.prepare(query).run(...args);
	} finally {
		db.close();
	}
}
const columns = (state: string, module: string, table: string) => sql<{ name: string }>(state, module, `SELECT name FROM pragma_table_info(?)`, table).map((c) => c.name);
const tables = (state: string, module: string) => sql<{ name: string }>(state, module, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name").map((t) => t.name);
const labRow = (state: string) => write(state, LITE, `INSERT INTO "lab-results" ("_from", item, value, takenAt, lab) VALUES ('blobs/report-1.pdf', 'CEA', 3.1, '2026-10-01', '协和')`);

test("第一次迁移：personal-health 的五类数据各一张表，列是 collection.json 的字段，每行另有出处 _from", (t) => {
	const state = stateDir(t);
	const result = instanceData(state).migrate("personal-health" as ModuleName, components(join(SAMPLE, "personal-health")));
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(tables(state, "personal-health"), ["device-readings", "documents", "lab-results", "profile", "research-updates"]);
	assert.deepEqual(columns(state, "personal-health", "lab-results"), ["_id", "_from", "item", "value", "unit", "reference", "takenAt", "lab"]);
	assert.ok(existsSync(join(state, "modules-data", "personal-health", "blobs")), "blobs/ holds the originals rows point to");
});

test("加字段：表多一列，旧行这一列为空", (t) => {
	const state = stateDir(t);
	const data = instanceData(state);
	data.migrate(LITE, lite("0.1.0"));
	labRow(state);
	assert.deepEqual(data.migrate(LITE, lite("0.2.0-adds-field")), { ok: true });
	assert.deepEqual(sql(state, LITE, `SELECT item, lab, method FROM "lab-results"`), [{ item: "CEA", lab: "协和", method: null }]);
});

test("改名（was）：旧值出现在新名字下，再迁移一次什么都不变", (t) => {
	const state = stateDir(t);
	const data = instanceData(state);
	data.migrate(LITE, lite("0.1.0"));
	labRow(state);
	assert.deepEqual(data.migrate(LITE, lite("0.2.0-renames-field")), { ok: true });
	assert.deepEqual(data.migrate(LITE, lite("0.2.0-renames-field")), { ok: true });
	assert.deepEqual(sql(state, LITE, `SELECT item, laboratory FROM "lab-results"`), [{ item: "CEA", laboratory: "协和" }]);
	assert.ok(!columns(state, LITE, "lab-results").includes("lab"));
});

test("拿掉字段再加回来：值一直留着", (t) => {
	const state = stateDir(t);
	const data = instanceData(state);
	data.migrate(LITE, lite("0.1.0"));
	labRow(state);
	assert.deepEqual(data.migrate(LITE, lite("0.2.0-removes-field")), { ok: true });
	assert.deepEqual(data.check(LITE, lite("0.1.0")), []);
	assert.deepEqual(data.migrate(LITE, lite("0.1.0")), { ok: true });
	assert.deepEqual(sql(state, LITE, `SELECT lab FROM "lab-results"`), [{ lab: "协和" }]);
});

test("拿掉的字段换了单位再加回来：检查拒绝，因为存下的值是旧单位", (t) => {
	const state = stateDir(t);
	const data = instanceData(state);
	data.migrate(LITE, lite("0.1.0"));
	data.migrate(LITE, lite("0.2.0-removes-field"));
	const back = lite("0.1.0").map((c) => (c.kind === "data" ? { ...c, collection: { ...c.collection, fields: { ...c.collection.fields, lab: { type: "number" as const, title: "实验室编号" } } } } : c));
	assert.match(data.check(LITE, back).map((p) => p.reason).join("\n"), /field "lab" changed type from text to number/);
});

test("改单位：检查给出原因，迁移也拒绝，数据和结构不变", (t) => {
	const state = stateDir(t);
	const data = instanceData(state);
	data.migrate(LITE, lite("0.1.0"));
	labRow(state);
	const problems = data.check(LITE, lite("0.2.0-changes-unit"));
	assert.deepEqual(problems.map((p) => p.where), ["data/lab-results/collection.json"]);
	assert.match(problems[0]!.reason, /changed unit from mmol\/L to mg\/dL/);
	const before = readFileSync(dbOf(state, LITE));
	const result = data.migrate(LITE, lite("0.2.0-changes-unit"));
	assert.equal(result.ok, false);
	assert.deepEqual(readFileSync(dbOf(state, LITE)), before);
});

test("什么都没存过：检查没有问题，也不建目录", (t) => {
	const state = stateDir(t);
	assert.deepEqual(instanceData(state).check(LITE, lite("0.2.0-changes-unit")), []);
	assert.ok(!existsSync(join(state, "modules-data", LITE)));
});

test("迁移中途失败：恢复快照，前面做过的调整也撤回，原因带出来，不留快照文件", (t) => {
	const state = stateDir(t);
	const data = instanceData(state);
	data.migrate(LITE, lite("0.1.0"));
	labRow(state);
	write(state, LITE, `CREATE TABLE "notes" (x)`);
	const notes: Component = { kind: "data", name: "notes" as ComponentName, seeded: false, collection: { title: "笔记", kind: "record", class: "private", fields: { text: { type: "text", title: "内容" } } } };
	const result = data.migrate(LITE, [...lite("0.2.0-adds-field"), notes]);
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.reason, /notes/);
	assert.deepEqual(columns(state, LITE, "lab-results"), ["_id", "_from", "item", "value", "takenAt", "lab"]);
	assert.deepEqual(sql(state, LITE, `SELECT item FROM "lab-results"`), [{ item: "CEA" }]);
	assert.deepEqual(data.check(LITE, lite("0.2.0-adds-field")), []);
	assert.deepEqual(data.migrate(LITE, lite("0.2.0-adds-field")), { ok: true });
});

test("崩溃后重跑：上次留下的快照先恢复，再迁移一遍，结果和没崩过一样", (t) => {
	const state = stateDir(t);
	const data = instanceData(state);
	data.migrate(LITE, lite("0.1.0"));
	labRow(state);
	cpSync(dbOf(state, LITE), `${dbOf(state, LITE)}.snapshot`);
	write(state, LITE, `ALTER TABLE "lab-results" ADD COLUMN half`);
	assert.deepEqual(data.migrate(LITE, lite("0.2.0-adds-field")), { ok: true });
	assert.deepEqual(columns(state, LITE, "lab-results"), ["_id", "_from", "item", "value", "takenAt", "lab", "method"]);
	assert.ok(!existsSync(`${dbOf(state, LITE)}.snapshot`));
});

test("迁移带编号：第一次的结果在第二次开始后才到，被忽略，模块按第二次的结果上线", () => {
	const v1 = { digest: "a" as Digest, label: "0.2.0" };
	const v2 = { digest: "b" as Digest, label: "0.2.1" };
	const play = (record: ModuleRecord, ...events: Parameters<typeof transition>[1][]) => events.reduce((r, e) => transition({ ...r, pending: [] }, e).record, record);
	const first = play(initialRecord(LITE), { type: "enable" }, { type: "package-found", version: v1 }, { type: "checked", digest: v1.digest, problems: [] });
	const second = play(first, { type: "package-found", version: v2 }, { type: "checked", digest: v2.digest, problems: [] });
	assert.equal(play(second, { type: "migrated", attempt: first.attempts }).state.at, "staging");
	assert.deepEqual(play(second, { type: "migrated", attempt: second.attempts }).state, { at: "active", serving: v2, update: null });
});

function boot(t: TestContext, state: string) {
	const db = openStore(join(state, "state.db"));
	const roots = [join(state, "modules")];
	const modules = startLiveModules({ db, stateDir: state, roots, discovered: Modules.load(roots, { switches: { values: {}, file: "config.json" } }), configSwitches: {}, log: () => {} });
	const stop = () => {
		modules.stop();
		if (db.isOpen) db.close();
	};
	t.after(stop);
	const label = () => describe(moduleRows(db).find((r) => r.name === LITE)!.record!);
	return { db, modules, stop, label };
}
const place = (state: string, version: string) => {
	rmSync(join(state, "modules", LITE), { recursive: true, force: true });
	cpSync(join(UPDATE, version, "health-lite"), join(state, "modules", LITE), { recursive: true });
};

test("宿主打开模块就建表；改单位的版本停在无效、旧版本继续服务；拿掉包再放回来，数据原样接上", (t) => {
	const state = stateDir(t);
	place(state, "0.1.0");
	const first = boot(t, state);
	setModuleSwitch(first.db, LITE, true);
	first.modules.tick();
	assert.equal(first.label().label, "运行中");
	labRow(state);
	first.stop();

	place(state, "0.2.0-changes-unit");
	const second = boot(t, state);
	assert.match(second.label().reason, /0\.1\.0 在运行.*无效.*changed unit/);
	second.stop();

	rmSync(join(state, "modules", LITE), { recursive: true });
	boot(t, state).stop();
	place(state, "0.2.0-adds-field");
	const back = boot(t, state);
	assert.deepEqual(back.label(), { label: "运行中", reason: "0.2.0" });
	assert.deepEqual(sql(state, LITE, `SELECT item, lab, method FROM "lab-results"`), [{ item: "CEA", lab: "协和", method: null }]);
});

function purgeCli(state: string, args: string[], input?: string) {
	return spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/cli/module.ts", "purge", ...args], { env: { ...process.env, PSA_STATE_DIR: state }, input: input ?? "", encoding: "utf8", timeout: 20_000 });
}

test("just module purge：模块开着拒绝；名字输错拒绝、数据还在；输对删掉全部实例数据，模块包不动", (t) => {
	const state = stateDir(t);
	place(state, "0.1.0");
	const host = boot(t, state);
	setModuleSwitch(host.db, LITE, true);
	host.modules.tick();
	host.stop();
	const dataDir = join(state, "modules-data", LITE);

	const on = purgeCli(state, [LITE, "--confirm", LITE]);
	assert.equal(on.status, 1, on.stderr);
	assert.match(on.stdout, /just module off health-lite/);

	const db = openStore(join(state, "state.db"));
	setModuleSwitch(db, LITE, false);
	db.close();
	boot(t, state).stop();

	const wrong = purgeCli(state, [LITE, "--confirm", "health"]);
	assert.equal(wrong.status, 1, wrong.stderr);
	assert.ok(existsSync(dbOf(state, LITE)));
	const typedWrong = purgeCli(state, [LITE], "health\n");
	assert.equal(typedWrong.status, 1, typedWrong.stderr);
	assert.ok(existsSync(dbOf(state, LITE)));

	const typed = purgeCli(state, [LITE], `${LITE}\n`);
	assert.equal(typed.status, 0, typed.stderr);
	assert.ok(!existsSync(dataDir));
	assert.ok(existsSync(join(state, "modules", LITE, "module.json")));
});
