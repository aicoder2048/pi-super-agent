import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { startLiveModules, type LiveModules } from "../src/host/live-modules.ts";
import { Kernel } from "../src/kernel/kernel.ts";
import { moduleRows, openStore, saveModuleRecord, setModuleSwitch } from "../src/kernel/store.ts";
import { CONVERSATION_THREAD_ID } from "../src/kernel/types.ts";
import { Modules } from "../src/modules.ts";
import { describe } from "../src/modules/lifecycle.ts";
import type { Digest, ModuleName } from "../src/modules/manifest.ts";
import { liveRegistry } from "../src/modules/live.ts";
import { until } from "./helpers/fakes.ts";

const OLD_SKILL = "估算年底税额（旧版技能）";
const NEW_SKILL = "估算年底税额（新版技能）";
const skill = (description: string) => `---\nname: estimate\ndescription: ${description}\n---\n\n# estimate\n`;

function files(root: string, tree: Record<string, string>): void {
	for (const [path, content] of Object.entries(tree)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

function stateDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-live-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	files(join(dir, "modules"), {
		"tax/module.json": JSON.stringify({ schema: 1, name: "tax", version: "0.1.0", title: "报税", description: "估算税额" }),
		"tax/skills/estimate/SKILL.md": skill(OLD_SKILL),
		"old/module.json": JSON.stringify({ name: "old", title: "旧模块", description: "旧布局" }),
		"quiet/module.json": JSON.stringify({ name: "quiet", defaultEnabled: false }),
	});
	return dir;
}

function boot(t: TestContext, dir: string, configSwitches: Record<string, boolean> = {}) {
	const db = openStore(join(dir, "state.db"));
	const logs: string[] = [];
	const discovered = Modules.load([join(dir, "modules")], { switches: { values: configSwitches, file: "config.json" } });
	const modules = startLiveModules({ db, stateDir: dir, discovered, configSwitches, log: (line) => logs.push(line) });
	const stop = () => {
		modules.stop();
		if (db.isOpen) db.close();
	};
	t.after(stop);
	const clock = { now: () => Date.now() };
	const kernel = new Kernel({ db, clock, sourcePolicy: () => "candidate", domains: () => modules.live.current().book });
	const open = (domain: string) => {
		const { triggerId } = kernel.submitTrigger({ source: "conversation", externalId: randomUUID(), threads: [{ id: CONVERSATION_THREAD_ID }], sender: "user", body: "算一下税", occurredAt: clock.now() });
		return kernel.route([{ kind: "open_ticket", title: "算税", basis: "request", domain, triggerId, threads: [], brief: "算税" }])[0]!;
	};
	return { db, logs, modules, kernel, open, stop };
}

const label = (dir: string, name: string) => {
	const db = openStore(join(dir, "state.db"));
	try {
		const row = moduleRows(db).find((r) => r.name === name);
		return row?.record ? describe(row.record).label : undefined;
	} finally {
		db.close();
	}
};
const serving = (modules: LiveModules) => [...modules.live.current().book.keys()].sort();
const copies = (dir: string) => (existsSync(join(dir, "module-store/tax")) ? readdirSync(join(dir, "module-store/tax")).sort() : []);
const skillText = (skillsDir: string | undefined) => readFileSync(join(skillsDir!, "estimate/SKILL.md"), "utf8");

test("换表是一次赋值：拿着旧快照的人看到整张旧表，current() 看到整张新表", () => {
	const before = { book: new Map([["a", 1]]) };
	const after = { book: new Map([["b", 2]]) };
	const live = liveRegistry(before);
	const held = live.current();
	live.publish(after);
	assert.equal(held, before);
	assert.equal(live.current(), after);
});

test("首次启动从 config.json 导入开关：旧布局默认开的导入成开，config 关掉的导入成关，新布局包默认关", (t) => {
	const dir = stateDir(t);
	const { modules } = boot(t, dir, { old: false });
	assert.deepEqual(serving(modules), []);
	assert.deepEqual([label(dir, "old"), label(dir, "quiet"), label(dir, "tax")], ["已停用", "已停用", "已停用"]);

	const fresh = stateDir(t);
	assert.deepEqual(serving(boot(t, fresh).modules), ["old"]);
});

test("导入只做一次：之后改 config.json 再启动，开关不变，日志说开关改由 just module 管", (t) => {
	const dir = stateDir(t);
	boot(t, dir, { old: false }).stop();
	const again = boot(t, dir, { old: true, tax: true });
	assert.deepEqual(serving(again.modules), []);
	assert.equal(again.logs.filter((l) => l.includes("just module on")).length, 1, again.logs.join("\n"));
});

test("运行中打开新布局包：两秒内它进了领域表、记录是运行中，内核能把任务分给它", async (t) => {
	const dir = stateDir(t);
	const { db, modules, open } = boot(t, dir);
	assert.equal(open("tax").ok, false);
	setModuleSwitch(db, "tax", true);
	await until(() => serving(modules).includes("tax"), "tax 进领域表", 2000);
	assert.equal(label(dir, "tax"), "运行中");
	assert.equal(open("tax").ok, true);
});

test("运行中关掉：两秒内它离开领域表、记录是已停用，新任务不再分给它", async (t) => {
	const dir = stateDir(t);
	const { db, modules, open } = boot(t, dir);
	setModuleSwitch(db, "old", false);
	await until(() => !serving(modules).includes("old"), "old 离开领域表", 2000);
	assert.equal(label(dir, "old"), "已停用");
	assert.deepEqual(open("old"), { ok: false, reason: "unknown domain old; there are no domains (omit domain)" });
});

test("任务开出时钉住摘要：改了技能再启动，钉着的任务拿旧副本里的技能，新任务拿新的，副本目录有两个摘要", (t) => {
	const dir = stateDir(t);
	const first = boot(t, dir);
	setModuleSwitch(first.db, "tax", true);
	first.modules.tick();
	const pinned = first.open("tax").ticketId!;
	const pin = first.kernel.getTicket(pinned)!.moduleDigest;
	assert.ok(pin);
	first.stop();

	writeFileSync(join(dir, "modules/tax/skills/estimate/SKILL.md"), skill(NEW_SKILL));
	const second = boot(t, dir);
	const fresh = second.kernel.getTicket(second.open("tax").ticketId!)!;
	assert.notEqual(fresh.moduleDigest, pin);
	assert.match(skillText(second.modules.kitFor("tax", pin)!.skillsDir), new RegExp(OLD_SKILL));
	assert.match(skillText(second.modules.kitFor("tax", fresh.moduleDigest)!.skillsDir), new RegExp(NEW_SKILL));
	assert.deepEqual(copies(dir), [pin, fresh.moduleDigest].sort());
});

test("没有任务钉着的旧副本回收：钉着它的任务结束后，下一次轮询删掉它，正在服务的副本留着", (t) => {
	const dir = stateDir(t);
	const first = boot(t, dir);
	setModuleSwitch(first.db, "tax", true);
	first.modules.tick();
	const pinned = first.open("tax").ticketId!;
	const old = first.kernel.getTicket(pinned)!.moduleDigest!;
	first.stop();

	writeFileSync(join(dir, "modules/tax/skills/estimate/SKILL.md"), skill(NEW_SKILL));
	const second = boot(t, dir);
	second.modules.tick();
	assert.equal(copies(dir).length, 2);
	second.kernel.workerReport(pinned, { status: "no_action", summary: "不用做" });
	second.modules.tick();
	const now = second.modules.live.current().book.get("tax")!.digest;
	assert.deepEqual(copies(dir), [now]);
	assert.notEqual(now, old);
});

test("崩溃后接着做 pending：记录停在检查中、outbox 里还有检查，再启动时做完，状态是运行中", (t) => {
	const dir = stateDir(t);
	boot(t, dir).stop();
	const db = openStore(join(dir, "state.db"));
	const record = moduleRows(db).find((r) => r.name === "tax")!.record!;
	assert.equal(record.state.at, "disabled");
	const version = record.state.at === "disabled" ? record.state.onDisk : assert.fail();
	saveModuleRecord(db, { ...record, state: { at: "staging", stage: { at: "checking", version } }, pending: [{ do: "check", version }] });
	setModuleSwitch(db, "tax", true);
	db.close();

	const again = boot(t, dir);
	assert.deepEqual(serving(again.modules), ["old", "tax"]);
	const after = moduleRows(again.db).find((r) => r.name === "tax")!.record!;
	assert.deepEqual([after.state.at, after.pending], ["active", []]);
});

test("包不在时关掉开关，包放回来以后仍是关", (t) => {
	const dir = stateDir(t);
	const first = boot(t, dir);
	setModuleSwitch(first.db, "tax", true);
	first.modules.tick();
	first.stop();
	const away = join(dir, "tax-away");
	renameSync(join(dir, "modules/tax"), away);

	const gone = boot(t, dir);
	assert.equal(label(dir, "tax"), "包不在了");
	setModuleSwitch(gone.db, "tax", false);
	gone.modules.tick();
	gone.stop();
	renameSync(away, join(dir, "modules/tax"));

	const back = boot(t, dir);
	assert.deepEqual(serving(back.modules), ["old"]);
	assert.equal(label(dir, "tax"), "已停用");
});

function moduleCli(dir: string, args: string[]) {
	return spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/cli/module.ts", ...args], { env: { ...process.env, PSA_STATE_DIR: dir }, encoding: "utf8", timeout: 20_000 });
}

test("宿主没运行时 just module on：开关写进状态库，下次启动生效", (t) => {
	const dir = stateDir(t);
	writeFileSync(join(dir, "config.json"), JSON.stringify({ modulesDirs: [join(dir, "modules")] }));
	const run = moduleCli(dir, ["on", "tax"]);
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /tax/);
	assert.deepEqual(serving(boot(t, dir).modules), ["old", "tax"]);
});

test("just module on 一个没发现的模块：一行说明有哪些模块，以 1 退出，什么都不写", (t) => {
	const dir = stateDir(t);
	writeFileSync(join(dir, "config.json"), JSON.stringify({ modulesDirs: [join(dir, "modules")] }));
	const run = moduleCli(dir, ["off", "taks"]);
	assert.equal(run.status, 1);
	assert.equal(run.stdout.trim().split("\n").length, 1, run.stdout);
	assert.match(run.stdout, /taks.*old、quiet、tax/);
	const db = openStore(join(dir, "state.db"));
	t.after(() => db.close());
	assert.deepEqual(moduleRows(db), []);
});

test("钉着的摘要不在副本目录里了：kitFor 给 undefined，任务按没有领域继续", (t) => {
	const dir = stateDir(t);
	const { modules } = boot(t, dir);
	assert.equal(modules.kitFor("tax", "0".repeat(64) as Digest), undefined);
	assert.equal(modules.kitFor("nope" as ModuleName, null), undefined);
});

test("包不在时 just module off 它：状态库里有它的记录就照样写开关", (t) => {
	const dir = stateDir(t);
	writeFileSync(join(dir, "config.json"), JSON.stringify({ modulesDirs: [join(dir, "modules")] }));
	boot(t, dir).stop();
	rmSync(join(dir, "modules/tax"), { recursive: true });
	const run = moduleCli(dir, ["off", "tax"]);
	assert.equal(run.status, 0, run.stdout + run.stderr);
	const db = openStore(join(dir, "state.db"));
	t.after(() => db.close());
	assert.equal(moduleRows(db).find((r) => r.name === "tax")!.switch, false);
});
