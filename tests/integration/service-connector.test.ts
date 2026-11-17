import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createGateway, refusalText } from "../../src/modules/gateway.ts";
import { ModuleStore } from "../../src/modules/live.ts";
import type { ComponentName, Digest, ModuleName } from "../../src/modules/manifest.ts";
import type { Json, Request, WorkerCaller } from "../../src/modules/protocol.ts";
import { scanPackage } from "../../src/modules/validate.ts";
import { venvDir, VENV_MARK, lockOf } from "../../src/modules/files.ts";

function files(root: string, tree: Record<string, string>): void {
	for (const [path, content] of Object.entries(tree)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

const readTool = (title: string, secrets: string[] = []) =>
	JSON.stringify({ title, description: `${title}的说明`, effect: "read", input: { code: { type: "text", title: "代码" } }, output: { level: { type: "number", title: "价位" } }, ...(secrets.length && { secrets }) });

const ALPHA = {
	"module.json": JSON.stringify({ schema: 1, name: "alpha", version: "0.1.0", exports: ["tools/level", "tools/boom", "tools/slow"] }),
	"tools/level/tool.json": readTool("价位", ["ALPHA_KEY"]),
	"tools/level/index.ts":
		'import { readFileSync } from "node:fs"; import { join } from "node:path";\nexport default (input) => ({ level: Number(readFileSync(join(process.env.PSA_MODULE_DATA, "files", "level.txt"), "utf8")), code: input.code ?? null, key: process.env.ALPHA_KEY ?? null });',
	"tools/boom/tool.json": readTool("出错"),
	"tools/boom/index.ts": 'export default () => { throw new Error("行情接口超时"); };',
	"tools/hidden/tool.json": readTool("不开放"),
	"tools/hidden/index.ts": "export default () => ({ level: 0 });",
	"tools/slow/tool.json": readTool("慢"),
	"tools/slow/index.ts":
		'import { existsSync } from "node:fs"; import { join } from "node:path";\nexport default async () => { const go = join(process.env.PSA_MODULE_DATA, "files", "go"); while (!existsSync(go)) await new Promise((r) => setTimeout(r, 10)); return { level: 1 }; };',
};

const BETA = {
	"module.json": JSON.stringify({ schema: 1, name: "beta", version: "0.1.0", team: "乙队" }),
	"tools/own/tool.json": readTool("本模块"),
	"tools/own/index.ts": "export default () => ({ level: 7 });",
	"agents/analyst.md": "---\nname: analyst\ntitle: 分析员\ndescription: 看价位\ntools: read\nuses: tools/own, alpha/tools/level, alpha/tools/boom, alpha/tools/hidden, alpha/tools/slow, alpha/tools/missing\n---\n你是分析员。",
	"agents/writer.md": "---\nname: writer\ntitle: 写手\ndescription: 写汇报\ntools: read\nuses: tools/own\n---\n你是写手。",
};

const GAMMA = {
	"module.json": JSON.stringify({ schema: 1, name: "gamma", version: "0.1.0", uses: ["alpha/tools/level"] }),
};

type Fixture = { root: string; store: ModuleStore; digests: Map<string, Digest>; keep(name: string, tree: Record<string, string>): Digest };

function fixture(t: TestContext): Fixture {
	const root = mkdtempSync(join(tmpdir(), "psa-connector-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = new ModuleStore(join(root, "store"));
	const digests = new Map<string, Digest>();
	const keep = (name: string, tree: Record<string, string>): Digest => {
		const pkg = join(root, "src", `${name}-${digests.size}`, name);
		files(pkg, tree);
		const scan = scanPackage(pkg, { runCases: false });
		assert.ok(scan.ok, JSON.stringify(scan));
		assert.ok(store.keep(name as ModuleName, scan.scan.digest, pkg));
		digests.set(name, scan.scan.digest);
		return scan.scan.digest;
	};
	return { root, store, digests, keep };
}

function setup(t: TestContext, { alpha = ALPHA as Record<string, string> | null } = {}) {
	const fx = fixture(t);
	const serving = new Map<string, Digest>();
	if (alpha) serving.set("alpha", fx.keep("alpha", alpha));
	serving.set("beta", fx.keep("beta", BETA));
	serving.set("gamma", fx.keep("gamma", GAMMA));
	const dataDir = (module: string) => join(fx.root, "data", module);
	files(dataDir("alpha"), { "files/level.txt": "42" });
	const envs: Record<string, Record<string, string>> = { alpha: { ALPHA_KEY: "alpha-own-key" }, beta: { ALPHA_KEY: "beta-planted-key" } };
	const logs: string[] = [];
	const held: string[] = [];
	const gateway = createGateway({
		copyDir: (module, digest) => fx.store.dirOf(module, digest),
		serving: (module) => serving.get(module),
		dataDir,
		rows: undefined as never,
		secret: (module, name) => envs[module]?.[name],
		log: (line) => logs.push(line),
		hold: (module, digest) => {
			const key = `${module}/${digest}`;
			held.push(key);
			return () => held.splice(held.indexOf(key), 1);
		},
	});
	const caller = (over: Partial<WorkerCaller> = {}): WorkerCaller => ({
		who: "worker",
		ticket: "tkt_1",
		pin: { module: "beta" as ModuleName, digest: serving.get("beta")! },
		basis: "request",
		member: "analyst",
		heardOthers: false,
		...over,
	});
	const gammaCaller = (over: Partial<WorkerCaller> = {}) => caller({ pin: { module: "gamma" as ModuleName, digest: serving.get("gamma")! }, member: null, ...over });
	return { fx, serving, dataDir, gateway, caller, gammaCaller, logs, held };
}

const call = (name: string, input: Json = { code: "NVDA" }): Request => ({ kind: "tool", name: name as ComponentName, input });

test("B 的专家调 A 开放的只读工具：在 A 的副本里跑，数据来自 A 的数据目录", async (t) => {
	const { gateway, caller } = setup(t);
	assert.deepEqual(await gateway.call(caller(), call("alpha/tools/level")), { ok: true, output: { level: 42, code: "NVDA", key: "alpha-own-key" } });
});

test("A 的工具拿到的是 A 自己 .env 里的 key，不是调用方 B 的", async (t) => {
	const { gateway, caller } = setup(t);
	const reply = await gateway.call(caller(), call("alpha/tools/level"));
	assert.equal(reply.ok && (reply.output as { key: string }).key, "alpha-own-key");
});

test("推断任务、模块 feed 开的规则和推断任务（读过别人的话）也调得成开放的只读工具", async (t) => {
	const { gateway, caller } = setup(t);
	for (const over of [{ basis: "inference" as const, heardOthers: true }, { basis: "rule" as const, heardOthers: true }, { basis: "inference" as const, heardOthers: true, member: null }]) {
		assert.equal((await gateway.call(caller(over), call("alpha/tools/level"))).ok, true, JSON.stringify(over));
	}
});

test("A 关掉或没装：B 拿到「alpha 没装或没开」，拒绝码是 provider-absent", async (t) => {
	const { gateway, caller, serving } = setup(t);
	serving.delete("alpha");
	assert.deepEqual(await gateway.call(caller(), call("alpha/tools/level")), { ok: false, refusal: { code: "provider-absent", note: "alpha 没装或没开" } });
	const never = setup(t, { alpha: null });
	assert.deepEqual(await never.gateway.call(never.caller(), call("alpha/tools/level")), { ok: false, refusal: { code: "provider-absent", note: "alpha 没装或没开" } });
});

test("A 在服务但它的副本目录被删了：B 拿到「alpha 没装或没开」", async (t) => {
	const { gateway, caller, fx, serving } = setup(t);
	assert.equal((await gateway.call(caller(), call("alpha/tools/level"))).ok, true);
	rmSync(fx.store.dirOf("alpha" as ModuleName, serving.get("alpha")!), { recursive: true, force: true });
	assert.deepEqual(await gateway.call(caller(), call("alpha/tools/level")), { ok: false, refusal: { code: "provider-absent", note: "alpha 没装或没开" } });
});

test("A 没开放这个工具、或没有这个工具：B 拿到「alpha 现在没有开放 <工具>」", async (t) => {
	const { gateway, caller } = setup(t);
	assert.deepEqual(await gateway.call(caller(), call("alpha/tools/hidden")), { ok: false, refusal: { code: "provider-absent", note: "alpha 现在没有开放 hidden" } });
	assert.deepEqual(await gateway.call(caller({ member: null }), call("alpha/tools/missing")), { ok: false, refusal: { code: "provider-absent", note: "alpha 现在没有开放 missing" } });
});

test("A 带 py/uv.lock 而环境没装：工具失败时换成「alpha 的运行环境还没装好」；不用环境的工具照常成", async (t) => {
	const { fx, gateway, caller, serving, dataDir } = setup(t);
	const withLock = { ...ALPHA, "py/pyproject.toml": '[project]\nname = "alpha"\nversion = "0.1.0"\n', "py/uv.lock": "version = 1\n" };
	serving.set("alpha", fx.keep("alpha", withLock));
	assert.deepEqual(await gateway.call(caller(), call("alpha/tools/boom")), { ok: false, refusal: { code: "provider-absent", note: "alpha 的运行环境还没装好" } });
	assert.equal((await gateway.call(caller(), call("alpha/tools/level"))).ok, true);
	const lock = lockOf(fx.store.dirOf("alpha" as ModuleName, serving.get("alpha")!))!;
	files(venvDir(dataDir("alpha"), lock), { [VENV_MARK]: lock });
	const failed = await gateway.call(caller(), call("alpha/tools/boom"));
	assert.equal(!failed.ok && failed.refusal.code, "provider-failed", "环境装好以后照常回工具自己的错误");
});

test("A 的工具抛错：提示写着「alpha 的工具这一次出错：……」，note 本身不加前缀", async (t) => {
	const { gateway, caller } = setup(t);
	const reply = await gateway.call(caller(), call("alpha/tools/boom"));
	assert.ok(!reply.ok && reply.refusal.code === "provider-failed", JSON.stringify(reply));
	assert.match(reply.refusal.note, /行情接口超时/);
	assert.doesNotMatch(reply.refusal.note, /alpha|工具这一次出错/);
	assert.match(refusalText(reply.refusal), /^alpha 的工具这一次出错：.*行情接口超时/);
});

test("provider-absent 的提示：这部分没做，汇报里写明，其余照常做完；不叫任务收尾", () => {
	const text = refusalText({ code: "provider-absent", note: "alpha 没装或没开" });
	assert.equal(text, "alpha 没装或没开，这部分没做。在汇报里写明哪部分没做、为什么，其余照常做完");
	assert.doesNotMatch(text, /收尾|停用/);
});

test("本模块工具出错的提示不变：没有提供方名", async () => {
	assert.equal(refusalText({ code: "provider-failed", note: "坏了" }), "工具这一次出错：坏了");
});

test("专家只能调自己 uses 里写了的外部工具；领队和单个助手取全部专家 uses 的并集", async (t) => {
	const { gateway, caller } = setup(t);
	assert.deepEqual(await gateway.call(caller({ member: "writer" }), call("alpha/tools/level")), { ok: false, refusal: { code: "not-in-uses", member: "writer" } });
	assert.equal((await gateway.call(caller({ member: null }), call("alpha/tools/level"))).ok, true, "领队取并集，analyst 写了");
	assert.deepEqual(await gateway.call(caller({ member: null }), call("alpha/tools/other")), { ok: false, refusal: { code: "not-in-uses", member: null } });
	assert.equal(refusalText({ code: "not-in-uses", member: null }), "本模块没有在 uses 里列这个外部工具，用不了");
	assert.equal(refusalText({ code: "not-in-uses", member: "writer" }), "成员 writer 的 uses 没有列这一项，用不了");
});

test("没有专家的模块 C 在 module.json 写了 uses：它的助手调得成；没写的外部工具回 not-in-uses", async (t) => {
	const { gateway, gammaCaller } = setup(t);
	assert.deepEqual(await gateway.call(gammaCaller(), call("alpha/tools/level")), { ok: true, output: { level: 42, code: "NVDA", key: "alpha-own-key" } });
	assert.deepEqual(await gateway.call(gammaCaller(), call("alpha/tools/boom")), { ok: false, refusal: { code: "not-in-uses", member: null } });
});

test("调用方自己的模块停了：外部调用回 module-disabled，和本模块调用一样", async (t) => {
	const { gateway, caller, serving } = setup(t);
	serving.delete("beta");
	assert.deepEqual(await gateway.call(caller(), call("alpha/tools/level")), { ok: false, refusal: { code: "module-disabled" } });
});

test("日志行：外部调用第一段写提供方、第二段写提供方的能力名，末尾追加 from=<调用方>；本模块调用一字不变", async (t) => {
	const { gateway, caller, logs } = setup(t);
	await gateway.call(caller({ basis: "inference" }), call("alpha/tools/level"));
	await gateway.call(caller(), call("own"));
	assert.match(logs[0]!, /^\[gateway\] alpha tools\/level tkt_1 analyst inference ok \d+ ms from=beta$/);
	assert.match(logs[1]!, /^\[gateway\] beta tools\/own tkt_1 analyst request ok \d+ ms$/);
});

test("目录：专家的 domain_tool 照列 uses 里的外部工具；A 在时说明取自 A 的 tool.json，A 不在时写「现在用不了」；都带「以调用结果为准」", async (t) => {
	const { gateway, caller, serving } = setup(t);
	const line = (name: string) => gateway.catalogue(caller()).find((e) => e.name === name);
	assert.deepEqual(line("alpha/tools/level"), { request: "tool", name: "alpha/tools/level", title: "价位", help: "价位的说明 输入：code（text，代码）。输出：level（number，价位）。说明取自启动时，以调用结果为准。" });
	assert.equal(line("own")?.title, "本模块");
	serving.delete("alpha");
	assert.deepEqual(line("alpha/tools/level"), { request: "tool", name: "alpha/tools/level", title: "alpha/tools/level", help: "alpha 现在用不了，调用会回原因。说明取自启动时，以调用结果为准。" });
	assert.equal(gateway.catalogue(caller({ member: "writer" })).some((e) => e.name.startsWith("alpha/")), false, "writer 的 uses 没写外部工具");
});

test("目录：领队按并集列外部工具；没有专家的模块按 module.json 的 uses 列", async (t) => {
	const { gateway, caller, gammaCaller } = setup(t);
	const names = (entries: ReturnType<typeof gateway.catalogue>) => entries.map((e) => e.name).filter((n) => n.includes("/")).sort();
	assert.deepEqual(names(gateway.catalogue(caller({ member: null }))), ["alpha/tools/boom", "alpha/tools/hidden", "alpha/tools/level", "alpha/tools/missing", "alpha/tools/slow"]);
	assert.deepEqual(names(gateway.catalogue(gammaCaller())), ["alpha/tools/level"]);
});

test("外部调用进行中，提供方的副本放进「进行中」集合；调用结束（成功或失败）就拿掉", async (t) => {
	const { gateway, caller, dataDir, held, serving } = setup(t);
	const running = gateway.call(caller(), call("alpha/tools/slow"));
	assert.deepEqual(held, [`alpha/${serving.get("alpha")}`]);
	writeFileSync(join(dataDir("alpha"), "files", "go"), "");
	assert.equal((await running).ok, true);
	assert.deepEqual(held, []);
	await gateway.call(caller(), call("alpha/tools/boom"));
	assert.deepEqual(held, []);
	await gateway.call(caller(), call("own"));
	assert.deepEqual(held, [], "本模块调用不占");
});

test("外部调用进行中 A 换了版本并跑 collect：旧副本在调用结束前不被删，结束后下一次 collect 删掉", async (t) => {
	const { startLiveModules } = await import("../../src/host/live-modules.ts");
	const { openStore, setModuleSwitch, moduleRows } = await import("../../src/kernel/store.ts");
	const { Modules } = await import("../../src/modules.ts");
	const { moduleDataDir } = await import("../../src/modules/knowledge.ts");
	const { until } = await import("../helpers/fakes.ts");
	const dir = mkdtempSync(join(tmpdir(), "psa-connector-live-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	files(join(dir, "modules/alpha"), ALPHA);
	files(join(dir, "modules/beta"), BETA);
	const db = openStore(join(dir, "state.db"));
	setModuleSwitch(db, "alpha", true);
	setModuleSwitch(db, "beta", true);
	const roots = [join(dir, "modules")];
	const modules = startLiveModules({ db, stateDir: dir, roots, discovered: Modules.load(roots), configSwitches: {}, log: () => {} });
	t.after(() => {
		modules.stop();
		if (db.isOpen) db.close();
	});
	const servingOf = (name: string) => {
		const state = moduleRows(db).find((r) => r.name === name)?.record?.state;
		return state?.at === "active" ? (state.serving.digest as Digest) : undefined;
	};
	await until(() => servingOf("alpha") !== undefined && servingOf("beta") !== undefined, "alpha 和 beta 在服务");
	await new Promise((r) => setTimeout(r, 300));
	const store = new ModuleStore(join(dir, "module-store"));
	const gateway = createGateway({
		copyDir: (module, digest) => store.dirOf(module, digest),
		serving: (module) => modules.live.current().book.get(module)?.digest as Digest | undefined,
		dataDir: (module) => moduleDataDir(dir, module),
		rows: undefined as never,
		secret: () => undefined,
		log: () => {},
		hold: modules.copiesInUse.hold,
	});
	const old = servingOf("alpha")!;
	const caller: WorkerCaller = { who: "worker", ticket: "tkt_1", pin: { module: "beta" as ModuleName, digest: servingOf("beta")! }, basis: "inference", member: "analyst", heardOthers: true };
	const running = gateway.call(caller, call("alpha/tools/slow"));
	writeFileSync(join(dir, "modules/alpha/module.json"), JSON.stringify({ schema: 1, name: "alpha", version: "0.2.0", exports: ["tools/level", "tools/boom", "tools/slow"] }));
	await until(() => servingOf("alpha") !== old, "alpha 换上新版", 5000);
	modules.tick();
	assert.equal(existsSync(store.dirOf("alpha" as ModuleName, old)), true, "调用还没结束，旧副本留着");
	mkdirSync(join(moduleDataDir(dir, "alpha"), "files"), { recursive: true });
	writeFileSync(join(moduleDataDir(dir, "alpha"), "files", "go"), "");
	assert.equal((await running).ok, true);
	modules.tick();
	assert.equal(existsSync(store.dirOf("alpha" as ModuleName, old)), false, "调用结束后下一次 collect 删掉旧副本");
	assert.equal(existsSync(store.dirOf("alpha" as ModuleName, servingOf("alpha")!)), true);
});
