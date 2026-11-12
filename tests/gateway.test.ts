import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { DomainKit, Domains } from "../src/modules.ts";
import { createGateway } from "../src/modules/gateway.ts";
import type { Member } from "../src/teams.ts";
import { openOnConversation, startHost, until, type FakeSpawner, type FakeWorker } from "./helpers/fakes.ts";
import { ModuleStore } from "../src/modules/live.ts";
import type { ComponentName, Digest, ModuleName } from "../src/modules/manifest.ts";
import type { Json, Request, WorkerCaller } from "../src/modules/protocol.ts";
import { scanPackage } from "../src/modules/validate.ts";

const SAMPLE = join(import.meta.dirname, "../docs/modules/architecture/sample/personal-tax");
const CASES = JSON.parse(readFileSync(join(SAMPLE, "tools/tax-bracket/cases.json"), "utf8")) as { input: { taxableIncome: number }; expect: object }[];

function files(root: string, tree: Record<string, string>): void {
	for (const [path, content] of Object.entries(tree)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

const tool = (effect: string, secrets: string[] = []) =>
	JSON.stringify({ title: effect, description: `${effect} tool`, input: { note: { type: "text", title: "备注" } }, output: { done: { type: "text", title: "结果" } }, effect, ...(secrets.length && { secrets }) });

function storeWithTax(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "psa-gateway-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "src/personal-tax");
	cpSync(SAMPLE, pkg, { recursive: true });
	files(pkg, {
		"tools/file-return/tool.json": tool("write"),
		"tools/file-return/index.ts": "export default () => ({ filed: true });",
		"tools/env-probe/tool.json": tool("read", ["TAX_KEY"]),
		"tools/env-probe/index.ts": "export default () => ({ named: process.env.TAX_KEY ?? null, unnamed: process.env.OTHER_KEY ?? null });",
		"tools/spin/tool.json": tool("read"),
		"tools/spin/index.ts": "export default () => { for (;;) {} };",
		"agents/clerk.md": "---\nname: clerk\ntitle: 记账员\ndescription: 只整理交易记录\ntools: read\nuses: data/transactions\n---\n你是记账员。",
	});
	const scan = scanPackage(pkg, { runCases: false });
	assert.ok(scan.ok, JSON.stringify(scan));
	const store = new ModuleStore(join(root, "store"));
	const digest = scan.scan.digest;
	assert.ok(store.keep("personal-tax" as ModuleName, digest, pkg));
	return { store, digest };
}

const hostSecrets = (name: string): string | undefined => ({ TAX_KEY: "named-value", OTHER_KEY: "unnamed-value" })[name];

function setup(t: TestContext, { serving = true, limitMs = 20_000, secret = hostSecrets } = {}) {
	const { store, digest } = storeWithTax(t);
	const logs: string[] = [];
	const state = { serving };
	const gateway = createGateway({
		copyDir: (module, pin) => store.dirOf(module, pin),
		serving: () => (state.serving ? digest : undefined),
		dataDir: (module) => join(store.dirOf(module, digest), "..", "data"),
		secret,
		log: (line) => logs.push(line),
		limitMs,
	});
	const caller = (over: Partial<WorkerCaller> = {}): WorkerCaller => ({
		who: "worker",
		ticket: "tkt_1",
		pin: { module: "personal-tax" as ModuleName, digest },
		basis: "request",
		member: null,
		heardOthers: false,
		...over,
	});
	return { gateway, caller, logs, state };
}

const call = (name: string, input: Json = {}): Request => ({ kind: "tool", name: name as ComponentName, input });

test("任务所属模块钉住的版本里的工具：按 cases.json 的输入算出 cases.json 的结果", async (t) => {
	const { gateway, caller } = setup(t);
	for (const item of CASES) {
		assert.deepEqual(await gateway.call(caller(), call("tax-bracket", item.input)), { ok: true, output: item.expect, private: false });
	}
});

test("别的模块的任务查不到这个工具：拒绝，原因是不在本模块", async (t) => {
	const { gateway, caller } = setup(t);
	const other = caller({ pin: { module: "pi-pi" as ModuleName, digest: "0".repeat(64) as Digest } });
	assert.deepEqual(await gateway.call(other, call("tax-bracket", CASES[0]!.input)), { ok: false, refusal: { code: "no-such-capability" } });
});

test("模块停用以后，它的任务再调工具一律拒绝", async (t) => {
	const { gateway, caller, state } = setup(t);
	assert.equal((await gateway.call(caller(), call("tax-bracket", CASES[0]!.input))).ok, true);
	state.serving = false;
	assert.deepEqual(await gateway.call(caller(), call("tax-bracket", CASES[0]!.input)), { ok: false, refusal: { code: "module-disabled" } });
});

test("成员只能调 uses 里写了的工具：写了的照常算，没写的拒绝", async (t) => {
	const { gateway, caller } = setup(t);
	assert.equal((await gateway.call(caller({ member: "tax-preparer" }), call("tax-bracket", CASES[0]!.input))).ok, true);
	assert.deepEqual(await gateway.call(caller({ member: "clerk" }), call("tax-bracket", CASES[0]!.input)), { ok: false, refusal: { code: "not-in-uses", member: "clerk" } });
});

test("推断开的任务调 effect 是 write 的工具被拒绝；使用者开的任务能调", async (t) => {
	const { gateway, caller } = setup(t);
	const refused = await gateway.call(caller({ basis: "inference" }), call("file-return"));
	assert.equal(refused.ok, false);
	assert.equal(!refused.ok && refused.refusal.code, "not-allowed");
	assert.deepEqual(await gateway.call(caller(), call("file-return")), { ok: true, output: { filed: true }, private: false });
});

test("工具的进程只拿到 tool.json 写了名字的密钥，宿主别的密钥拿不到", async (t) => {
	const { gateway, caller } = setup(t);
	assert.deepEqual(await gateway.call(caller(), call("env-probe")), { ok: true, output: { named: "named-value", unnamed: null }, private: false });
});

test("读密钥出错（值不合法、密钥文件读不到）：这次调用失败并说明原因，宿主日志照样记一笔", async (t) => {
	const { gateway, caller, logs } = setup(t, { secret: () => { throw new Error("TAX_KEY 含有空白或非 ASCII 字符，请检查"); } });
	const reply = await gateway.call(caller(), call("env-probe"));
	assert.deepEqual(reply, { ok: false, refusal: { code: "provider-failed", note: "TAX_KEY 含有空白或非 ASCII 字符，请检查" } });
	assert.match(logs.at(-1)!, /\[gateway\] personal-tax tools\/env-probe .* provider-failed \d+ ms/);
});

test("工具死循环：到时限只这一次失败，宿主同时和之后的调用照常", async (t) => {
	const { gateway, caller } = setup(t, { limitMs: 500 });
	const spinning = gateway.call(caller(), call("spin"));
	assert.equal((await gateway.call(caller(), call("tax-bracket", CASES[0]!.input))).ok, true, "死循环的工具跑着时别的调用照常回");
	const failed = await spinning;
	assert.equal(!failed.ok && failed.refusal.code, "provider-failed");
	assert.equal((await gateway.call(caller(), call("tax-bracket", CASES[0]!.input))).ok, true);
});

test("每次调用在宿主日志里记一笔：模块、能力、调用者、结果和耗时", async (t) => {
	const { gateway, caller, logs } = setup(t);
	await gateway.call(caller({ member: "clerk" }), call("tax-bracket", CASES[0]!.input));
	await gateway.call(caller(), call("tax-bracket", CASES[0]!.input));
	assert.equal(logs.length, 2);
	assert.match(logs[0]!, /personal-tax .*tools\/tax-bracket .*tkt_1.*clerk.*not-in-uses.* \d+ ms/);
	assert.match(logs[1]!, /personal-tax .*tools\/tax-bracket .*tkt_1.*ok.* \d+ ms/);
});

test("宿主日志记的是能力的 uses 写法：知识写 knowledge，数据写 data/<集合>，和考题的 uses 对得上", async (t) => {
	const { gateway, caller, logs } = setup(t);
	await gateway.call(caller(), { kind: "knowledge", op: "search", query: "税率" });
	await gateway.call(caller(), { kind: "data", collection: "transactions" as ComponentName, op: "query", query: {} });
	assert.match(logs[0]!, /\[gateway\] personal-tax knowledge tkt_1 /);
	assert.match(logs[1]!, /\[gateway\] personal-tax data\/transactions tkt_1 /);
});

test("工具目录只列调用者能用的：成员只见 uses 里的工具，推断任务不见 write 工具", (t) => {
	const { gateway, caller } = setup(t);
	const names = (c: WorkerCaller) => gateway.catalogue(c).filter((e) => e.request === "tool").map((entry) => entry.name).sort();
	assert.deepEqual(names(caller()), ["env-probe", "file-return", "spin", "tax-bracket"]);
	assert.deepEqual(names(caller({ basis: "inference" })), ["env-probe", "spin", "tax-bracket"]);
	assert.deepEqual(names(caller({ member: "tax-preparer" })), ["tax-bracket"]);
	assert.deepEqual(names(caller({ member: "clerk" })), []);
	assert.deepEqual(names(caller({ pin: { module: "pi-pi" as ModuleName, digest: "0".repeat(64) as Digest } })), []);
	assert.match(gateway.catalogue(caller()).find((e) => e.name === "tax-bracket")!.help, /taxableIncome/);
});

const member = (name: string): Member => ({ name, title: name, description: name, tools: ["read"], skills: [], model: undefined, prompt: name, file: `/agents/${name}.md` });

type Scene = { worker: FakeWorker; state: { serving: boolean }; spawner: FakeSpawner };

async function hostWithTax(t: TestContext, script: (scene: Scene) => Promise<unknown>, basis: "request" | "inference" = "request") {
	const { store, digest } = storeWithTax(t);
	const logs: string[] = [];
	const state = { serving: true };
	const kit: DomainKit = { skillsDir: undefined, prepare: undefined, crew: [member("tax-preparer"), member("clerk")], granted: [] };
	const domains: Domains = { book: () => new Map(state.serving ? [["personal-tax", { team: "报税顾问团", onRoster: true, digest }]] : []), kitFor: (domain) => (domain === "personal-tax" ? kit : undefined) };
	const gateway = createGateway({ copyDir: (m, d) => store.dirOf(m, d), serving: () => (state.serving ? digest : undefined), dataDir: (m) => join(store.dirOf(m, digest), "..", "data"), secret: () => undefined, log: (line) => logs.push(line) });
	const results: unknown[] = [];
	let spawner!: FakeSpawner;
	const started = await startHost(
		(cards) => cards.flatMap((card) => {
			if (!card.startsWith("[对话]")) return [];
			const [route, reply] = openOnConversation(card, "算税", "personal-tax");
			(route!.args.decisions as Record<string, unknown>[])[0]!.basis = basis;
			return [route!, reply!];
		}),
		async (worker) => {
			results.push(await Promise.resolve().then(() => script({ worker, state, spawner })).catch((e: Error) => e.message));
			worker.report({ status: "progress", summary: "算好了" });
			worker.settle();
		},
		{ domains, gateway, log: (line) => logs.push(line), dispatch: { timeoutMs: 5000, codingTimeoutMs: 5000, stallMs: 5000, maxConcurrent: 4 } },
	);
	spawner = started.spawner;
	t.after(() => started.host.stop());
	await started.host.say("帮我算一下 25000 的税");
	await until(() => results.length === 1, "助手调完一次", 10_000);
	return { result: results[0], logs, spawner, host: started.host };
}

const taxCall = { name: "tax-bracket", input: { taxableIncome: 25000 } };
const refusalOf = (work: () => unknown) => Promise.resolve().then(work).then(() => "没被拒", (e: Error) => e.message);

test("宿主：personal-tax 任务的助手调 domain_tool，拿到 cases.json 的结果，宿主日志记一笔；助手的工具目录列出这个工具", async (t) => {
	const { result, logs, spawner, host } = await hostWithTax(t, ({ worker }) => Promise.resolve(worker.request("worker.domain_tool", taxCall)));
	assert.deepEqual(result, { bracket: 2, marginalRate: 0.2, tax: 4000 });
	assert.ok(logs.some((l) => /\[gateway\] personal-tax tools\/tax-bracket tkt_\S+ helper request ok/.test(l)), logs.join("\n"));
	assert.match([...spawner.workers.values()][0]!.spec.domainTools ?? "", /tax-bracket · 税率档位/);
	assert.deepEqual(host.kernel.listTickets().map((r) => r.moduleOff), [false]);
});

test("宿主：模块停用以后，它开着的任务调 domain_tool 被拒，拒绝说明请助手汇报并收尾；看板上这个任务标着所属模块已停用", async (t) => {
	const { result, host } = await hostWithTax(t, ({ worker, state }) => {
		state.serving = false;
		return refusalOf(() => worker.request("worker.domain_tool", taxCall));
	});
	assert.match(String(result), /所属模块已停用/);
	assert.deepEqual(host.kernel.listTickets().map((r) => r.moduleOff), [true]);
});

test("宿主：推断开的任务调 effect 是 write 的工具被拒，说明推断任务只读", async (t) => {
	const { result } = await hostWithTax(t, ({ worker }) => refusalOf(() => worker.request("worker.domain_tool", { name: "file-return", input: {} })), "inference");
	assert.match(String(result), /只读/);
});

test("宿主：派出的成员带着它能用的工具目录；uses 写了工具的成员调得到，没写的被拒", async (t) => {
	const { result } = await hostWithTax(t, async ({ worker, spawner }) => {
		const seen: Record<string, unknown> = {};
		spawner.runner = async (run) => {
			seen[run.member.name] = { catalogue: run.domainTools ?? null, reply: await refusalOf(() => spawner.request(run.ticketId, run.token, "worker.domain_tool", taxCall)).then((r) => (r === "没被拒" ? "ok" : r)) };
			return "好了";
		};
		for (const agent of ["tax-preparer", "clerk"]) await worker.request("worker.dispatch", { agent, task: "算税", callId: `call_${agent}` });
		return seen;
	});
	const seen = result as Record<string, { catalogue: string | null; reply: string }>;
	assert.match(seen["tax-preparer"]!.catalogue ?? "", /tax-bracket/);
	assert.equal(seen["tax-preparer"]!.reply, "ok");
	assert.equal(seen["clerk"]!.catalogue, null);
	assert.match(seen["clerk"]!.reply, /uses/);
});
