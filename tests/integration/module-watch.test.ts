import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";
import { startLiveModules } from "../../src/host/live-modules.ts";
import { moduleRows, openStore, setModuleSwitch } from "../../src/kernel/store.ts";
import { Modules } from "../../src/modules.ts";
import { describe } from "../../src/modules/lifecycle.ts";
import { digestOf } from "../../src/modules/validate.ts";
import { watchModules } from "../../src/modules/watch.ts";
import { until } from "../helpers/fakes.ts";
import { FakeModel, fakeAgentEnv, on } from "../e2e/fake-model.ts";
import { fakeModels, REPO, startHost } from "../e2e/harness.ts";

const skill = (description: string) => `---\nname: estimate\ndescription: ${description}\n---\n\n# estimate\n`;
const manifest = (name: string, extra: object = {}) => JSON.stringify({ schema: 1, name, version: "0.1.0", title: "报税", description: "估算税额", ...extra });

function write(root: string, tree: Record<string, string>): void {
	for (const [path, content] of Object.entries(tree)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

function stateDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-watch-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	write(join(dir, "modules"), { "tax/module.json": manifest("tax"), "tax/skills/estimate/SKILL.md": skill("旧版") });
	return dir;
}

async function boot(t: TestContext, dir: string) {
	const db = openStore(join(dir, "state.db"));
	setModuleSwitch(db, "tax", true);
	const logs: string[] = [];
	const roots = [join(dir, "modules")];
	const modules = startLiveModules({ db, stateDir: dir, roots, discovered: Modules.load(roots), configSwitches: {}, log: (line) => logs.push(line) });
	t.after(() => {
		modules.stop();
		if (db.isOpen) db.close();
	});
	const record = (name: string) => moduleRows(db).find((r) => r.name === name)?.record ?? undefined;
	const serving = (name: string) => {
		const state = record(name)?.state;
		return state?.at === "active" ? state.serving.digest : undefined;
	};
	const receipts = () => logs.filter((l) => l.includes("换上"));
	await until(() => serving("tax") !== undefined, "tax 在服务");
	// macOS starts delivering fs.watch events a few milliseconds after watch() returns; a save before that is not seen.
	await new Promise((r) => setTimeout(r, 300));
	return { modules, logs, record, serving, receipts };
}

const save = (dir: string, path: string, content: string) => writeFileSync(join(dir, "modules", path), content);

test("运行中的包改了技能文件存盘：换上新摘要，新任务拿到新技能，日志有一行收据列出这个文件", async (t) => {
	const dir = stateDir(t);
	const { modules, serving, receipts } = await boot(t, dir);
	const before = serving("tax");
	save(dir, "tax/skills/estimate/SKILL.md", skill("新版"));
	const now = digestOf(join(dir, "modules/tax"));
	await until(() => serving("tax") === now, "换上新摘要", 5000);
	assert.notEqual(now, before);
	assert.match(readFileSync(join(modules.kitFor("tax", null)!.skillsDir!, "estimate/SKILL.md"), "utf8"), /新版/);
	assert.equal(receipts().length, 1, receipts().join("\n"));
	assert.match(receipts()[0]!, /tax.*skills\/estimate\/SKILL\.md/);
});

test("带工具用例的包改了规则存盘：用例在后台跑完才换上，换上时留一行收据列出这个文件", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-watch-cases-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	cpSync(join(REPO, "docs/modules/architecture/sample/personal-tax"), join(dir, "modules/personal-tax"), { recursive: true });
	const db = openStore(join(dir, "state.db"));
	setModuleSwitch(db, "personal-tax", true);
	const logs: string[] = [];
	const roots = [join(dir, "modules")];
	const modules = startLiveModules({ db, stateDir: dir, roots, discovered: Modules.load(roots), configSwitches: {}, log: (line) => logs.push(line) });
	t.after(() => {
		modules.stop();
		db.close();
	});
	const serving = () => {
		const state = moduleRows(db).find((r) => r.name === "personal-tax")?.record?.state;
		return state?.at === "active" ? state.serving.digest : undefined;
	};
	await until(() => serving() !== undefined, "personal-tax 在服务", 15_000);
	await new Promise((r) => setTimeout(r, 300));
	appendFileSync(join(dir, "modules/personal-tax/rules.md"), "\n");
	const now = digestOf(join(dir, "modules/personal-tax"));
	await until(() => serving() === now, "用例跑完后换上", 15_000);
	const receipts = logs.filter((l) => l.includes("换上"));
	assert.equal(receipts.length, 1, logs.join("\n"));
	assert.match(receipts[0]!, /personal-tax 换上 0\.1\.0.*改了 rules\.md/);
});

test("打开带工具用例的模块、正在复制副本时存盘：复制作废，换上存下的版本，仍留一行收据列出这个文件", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-watch-race-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	cpSync(join(REPO, "docs/modules/architecture/sample/personal-tax"), join(dir, "modules/personal-tax"), { recursive: true });
	const real = openStore(join(dir, "state.db"));
	t.after(() => real.close());
	let saved = false;
	const saveWhileCopying = (json: string) => {
		const record = JSON.parse(json) as { state?: { at: string }; pending?: { do: string }[] };
		if (saved || record.state?.at !== "active" || record.pending?.[0]?.do !== "publish") return;
		saved = true;
		appendFileSync(join(dir, "modules/personal-tax/rules.md"), "\n");
	};
	const db = new Proxy(real, {
		get: (target, key) =>
			key === "prepare"
				? (sql: string) => {
						const statement = target.prepare(sql);
						return new Proxy(statement, { get: (s, k) => (k === "run" ? (...args: unknown[]) => (sql.startsWith("INSERT INTO module_records") && saveWhileCopying(args[1] as string), (s.run as (...a: unknown[]) => unknown)(...args)) : Reflect.get(s, k).bind?.(s) ?? Reflect.get(s, k)) });
					}
				: (Reflect.get(target, key) as { bind?: (o: unknown) => unknown }).bind?.(target) ?? Reflect.get(target, key),
	});
	const logs: string[] = [];
	const roots = [join(dir, "modules")];
	const modules = startLiveModules({ db, stateDir: dir, roots, discovered: Modules.load(roots), configSwitches: {}, log: (line) => logs.push(line) });
	t.after(() => modules.stop());
	await new Promise((r) => setTimeout(r, 300));
	setModuleSwitch(real, "personal-tax", true);
	modules.tick();
	await until(() => saved, "存盘发生在复制副本时", 15_000);
	const now = digestOf(join(dir, "modules/personal-tax"));
	await until(() => modules.live.current().book.get("personal-tax")?.digest === now && logs.some((l) => l.includes("收据")), `换上存下的版本并留收据：${logs.join("\n")}`, 15_000);
	assert.match(logs.find((l) => l.includes("收据"))!, /personal-tax 换上 0\.1\.0.*改了 rules\.md/);
});

test("存一个坏的 module.json：旧版本继续服务，状态写出原因；再改好就换上新版本", async (t) => {
	const dir = stateDir(t);
	const { modules, record, serving, receipts } = await boot(t, dir);
	const before = serving("tax");
	save(dir, "tax/module.json", '{"schema":1,');
	await until(() => describe(record("tax")!).reason.includes("module.json"), "状态写出原因", 5000);
	assert.equal(serving("tax"), before);
	assert.ok(modules.live.current().book.has("tax"), "tax 还在领域表里");
	assert.match(describe(record("tax")!).reason, /not valid JSON/);
	assert.equal(receipts().length, 0);

	save(dir, "tax/module.json", manifest("tax", { version: "0.1.1" }));
	const fixed = digestOf(join(dir, "modules/tax"));
	await until(() => serving("tax") === fixed, "改好后换上", 5000);
	assert.equal(describe(record("tax")!).label, "运行中");
	assert.equal(receipts().length, 1);
});

test("放进一个新模块文件夹：它出现为已停用，不进领域表", async (t) => {
	const dir = stateDir(t);
	const { modules, record } = await boot(t, dir);
	write(join(dir, "modules"), { "mail/module.json": manifest("mail", { title: "邮件", description: "收发邮件" }) });
	await until(() => record("mail") !== undefined && describe(record("mail")!).label === "已停用", "mail 是已停用", 5000);
	assert.ok(!modules.live.current().book.has("mail"));
});

test("删掉模块文件夹：状态变成包不在了，它离开领域表，实例数据目录还在", async (t) => {
	const dir = stateDir(t);
	const { modules, record } = await boot(t, dir);
	const data = join(dir, "modules-data/tax");
	mkdirSync(data, { recursive: true });
	rmSync(join(dir, "modules/tax"), { recursive: true });
	await until(() => describe(record("tax")!).label === "包不在了", "tax 包不在了", 5000);
	assert.ok(!modules.live.current().book.has("tax"));
	assert.ok(existsSync(data));
});

test("一秒内连存五次：只换一次，换上的是最后一次存下的版本", async (t) => {
	const dir = stateDir(t);
	const { serving, receipts } = await boot(t, dir);
	for (let i = 1; i <= 5; i++) {
		save(dir, "tax/skills/estimate/SKILL.md", skill(`第 ${i} 次`));
		await new Promise((r) => setTimeout(r, 200));
	}
	const last = digestOf(join(dir, "modules/tax"));
	await until(() => serving("tax") === last, "换上最后一次", 5000);
	await new Promise((r) => setTimeout(r, 500));
	assert.equal(receipts().length, 1, receipts().join("\n"));
	assert.equal(serving("tax"), last);
});

test("宿主运行时打开一个模块：幕僚长下一次收到的输入前带一段名单，里面有这个模块；再说一句时不带", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-watch-host-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	write(join(dir, "modules"), { "tax/module.json": manifest("tax") });
	const fake = await FakeModel.start({ router: [on("第一句", /^\[对话\][\s\S]*第一句/, () => "好。"), on("第二句", /^\[对话\][\s\S]*第二句/, () => "好。")] });
	t.after(() => fake.close());
	const host = await startHost({ models: fakeModels, stateDir: dir, logFile: join(dir, "host.log"), config: { webPort: 0 }, env: fakeAgentEnv(fake, join(dir, "pi")) });
	t.after(() => host.stop());
	const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", ...args], { cwd: REPO, env: { ...process.env, PSA_STATE_DIR: dir, PSA_SAY_WAIT_MS: "300" }, encoding: "utf8", timeout: 20_000 });
	cli("src/cli/module.ts", "on", "tax");
	const db = openStore(join(dir, "state.db"));
	t.after(() => db.close());
	await until(() => moduleRows(db).find((r) => r.name === "tax")?.record?.state.at === "active", "tax 打开", 3000);
	const routerCards = () => fake.exchanges.filter((e) => e.conversation === "router").flatMap((e) => e.cards);
	const said = cli("src/cli/say.ts", "say", "第一句");
	await until(() => routerCards().some((c) => c.includes("第一句")), `幕僚长收到第一句：${said.stdout}${said.stderr}\n${host.log().slice(-2000)}`, 10_000);
	const block = routerCards().find((c) => c.startsWith("[名单和规则]"));
	assert.ok(block?.includes("- tax（报税）：估算税额"), routerCards().join("\n---\n"));
	const seen = routerCards().length;
	cli("src/cli/say.ts", "say", "第二句");
	await until(() => routerCards().some((c) => c.includes("第二句")), "幕僚长收到第二句", 10_000);
	assert.ok(!routerCards().slice(seen).some((c) => c.startsWith("[名单和规则]")), routerCards().slice(seen).join("\n---\n"));
});

test("旧布局模块的 module.json 存了一半或写错：照旧服务，改好后照旧；关掉再打开也正常", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-watch-legacy-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const good = JSON.stringify({ name: "notes", title: "笔记", description: "记笔记" });
	write(join(dir, "modules"), { "notes/module.json": good, "notes/rules.md": "" });
	const db = openStore(join(dir, "state.db"));
	const roots = [join(dir, "modules")];
	const modules = startLiveModules({ db, stateDir: dir, roots, discovered: Modules.load(roots), configSwitches: {}, log: () => {} });
	t.after(() => {
		modules.stop();
		db.close();
	});
	const served = () => modules.live.current().book.has("notes");
	const label = () => describe(moduleRows(db).find((r) => r.name === "notes")!.record!).label;
	assert.ok(served(), "启动时在服务");
	await new Promise((r) => setTimeout(r, 300));
	save(dir, "notes/module.json", good.slice(0, -1) + ",");
	await new Promise((r) => setTimeout(r, 800));
	assert.ok(served(), "写错后照旧服务");
	assert.equal(label(), "运行中");
	save(dir, "notes/module.json", good);
	await new Promise((r) => setTimeout(r, 800));
	setModuleSwitch(db, "notes", false);
	modules.tick();
	assert.ok(!served(), "关掉后不服务");
	setModuleSwitch(db, "notes", true);
	modules.tick();
	assert.ok(served(), "再打开照旧服务");
	assert.equal(label(), "运行中");
});

test("模块目录建不出来：宿主照常启动，日志写一行原因", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-watch-root-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "a-file"), "");
	const roots = [join(dir, "a-file/modules")];
	const db = openStore(join(dir, "state.db"));
	t.after(() => db.close());
	const logs: string[] = [];
	const modules = startLiveModules({ db, stateDir: dir, roots, discovered: Modules.load(roots), configSwitches: {}, log: (line) => logs.push(line) });
	modules.stop();
	assert.ok(logs.some((l) => l.includes("a-file/modules")), logs.join("\n"));
});

test("文件监视器报错：写一行日志，不抛出", (t) => {
	const fake = new EventEmitter() as FSWatcher;
	fake.close = () => {};
	t.after(() => {
		mock.restoreAll();
		syncBuiltinESMExports();
	});
	mock.method(fs, "watch", () => fake);
	syncBuiltinESMExports();
	const logs: string[] = [];
	const watcher = watchModules(["/somewhere"], () => {}, (line) => logs.push(line));
	t.after(() => watcher.close());
	fake.emit("error", new Error("EMFILE"));
	assert.ok(logs.some((l) => l.includes("EMFILE")), logs.join("\n"));
});

test("内容没变的存盘不进收据：之后改规则，收据只列出规则文件", async (t) => {
	const dir = stateDir(t);
	const { serving, receipts } = await boot(t, dir);
	save(dir, "tax/skills/estimate/SKILL.md", skill("旧版"));
	await new Promise((r) => setTimeout(r, 800));
	save(dir, "tax/rules.md", "新规则");
	const now = digestOf(join(dir, "modules/tax"));
	await until(() => serving("tax") === now && receipts().length === 1, `换上并留收据：${receipts().join("\n")}`, 5000);
	assert.match(receipts()[0]!, /改了 rules\.md$/);
});

test("停用期间的存盘不进再打开以后的收据", async (t) => {
	const dir = stateDir(t);
	const { modules, serving, receipts } = await boot(t, dir);
	const db = openStore(join(dir, "state.db"));
	t.after(() => db.close());
	setModuleSwitch(db, "tax", false);
	modules.tick();
	save(dir, "tax/notes.md", "停用时改的");
	await new Promise((r) => setTimeout(r, 800));
	setModuleSwitch(db, "tax", true);
	modules.tick();
	await until(() => serving("tax") === digestOf(join(dir, "modules/tax")), "再打开后在服务", 5000);
	save(dir, "tax/rules.md", "新规则");
	const now = digestOf(join(dir, "modules/tax"));
	await until(() => serving("tax") === now && receipts().length === 1, `换上并留收据：${receipts().join("\n")}`, 5000);
	assert.match(receipts()[0]!, /改了 rules\.md$/);
});
