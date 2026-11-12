import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createGateway } from "../src/modules/gateway.ts";
import { importKnowledge } from "../src/modules/knowledge.ts";
import { ModuleStore } from "../src/modules/live.ts";
import type { Digest, ModuleName } from "../src/modules/manifest.ts";
import type { Passage, Reply, WorkerCaller } from "../src/modules/protocol.ts";
import { scanPackage } from "../src/modules/validate.ts";
import type { DomainKit, Domains } from "../src/modules.ts";
import type { Member } from "../src/teams.ts";
import { openOnConversation, startHost, until, type FakeSpawner, type FakeWorker } from "./helpers/fakes.ts";

const SAMPLE = join(import.meta.dirname, "../docs/modules/architecture/sample/personal-health");
const HEALTH = "personal-health" as ModuleName;
const GUIDE = "2022-aha-acc-hfsa-hf";

function setup(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "psa-knowledge-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "src", HEALTH);
	cpSync(SAMPLE, pkg, { recursive: true });
	const store = new ModuleStore(join(root, "store"));
	const dataDir = join(root, "modules-data", HEALTH);
	const state = { digest: "" as Digest };
	const publish = () => {
		const scan = scanPackage(pkg, { runCases: false });
		assert.ok(scan.ok, JSON.stringify(scan));
		assert.ok(store.keep(HEALTH, scan.scan.digest, pkg));
		state.digest = scan.scan.digest;
		return scan.scan;
	};
	publish();
	const gateway = createGateway({
		copyDir: (module, digest) => store.dirOf(module, digest),
		serving: (module) => (module === HEALTH ? state.digest : undefined),
		dataDir: (module) => join(root, "modules-data", module),
		secret: () => undefined,
		log: () => {},
	});
	const caller = (over: Partial<WorkerCaller> = {}): WorkerCaller => ({
		who: "worker", ticket: "tkt_1", pin: { module: HEALTH, digest: state.digest }, basis: "request", member: null, heardOthers: false, ...over,
	});
	const search = (query: string, who = caller()) => gateway.call(who, { kind: "knowledge", op: "search", query });
	return { pkg, dataDir, gateway, caller, search, publish, root };
}

const passages = (reply: Reply): readonly Passage[] => (reply.ok ? reply.passages ?? [] : assert.fail(JSON.stringify(reply)));
const text = (reply: Reply): string => (reply.ok ? String(reply.output) : assert.fail(JSON.stringify(reply)));

test("按 Markdown 标题切段：查三个字以上的词，返回的段落带文档名、标题、版本、权威程度和章节路径", async (t) => {
	const { search } = setup(t);
	const reply = await search("同一家实验室");
	assert.deepEqual(passages(reply).map((p) => [p.doc, p.title, p.version, p.authority, p.section]), [
		["tumor-marker-basics", "肿瘤标志物跟踪要点（模块自编）", "0.1", "reference", "肿瘤标志物跟踪要点 > 看趋势，不看单次"],
	]);
	assert.match(text(reply), /《肿瘤标志物跟踪要点（模块自编）》.*0\.1.*看趋势，不看单次/);
});

test("两个字的中文词也能查到", async (t) => {
	const { search } = setup(t);
	assert.deepEqual(passages(await search("复查")).map((p) => p.section), ["肿瘤标志物跟踪要点 > 什么算需要提醒"]);
	assert.deepEqual(passages(await search("趋势")).map((p) => p.section), ["肿瘤标志物跟踪要点 > 看趋势，不看单次"]);
});

test("user-import 的知识还没导入：回复说明还没导入，并给出导入命令", async (t) => {
	const { search } = setup(t);
	assert.match(text(await search("射血分数")), new RegExp(`2022 AHA/ACC/HFSA 心力衰竭管理指南.*还没导入[\\s\\S]*just module import personal-health ${GUIDE} <文件或目录>`));
});

test("导入以后能查到导入文件里的段落，提示不再说还没导入；包里一个文件都没多", async (t) => {
	const { search, dataDir, pkg, root } = setup(t);
	const file = join(root, "guide.md");
	writeFileSync(file, "# 心衰指南\n\n## 7.3 射血分数降低的心衰\n\n推荐四联药物治疗。\n");
	importKnowledge(dataDir, GUIDE, file);
	const reply = await search("射血分数");
	assert.deepEqual(passages(reply).map((p) => [p.doc, p.version, p.authority, p.section]), [[GUIDE, "2022", "authoritative", "心衰指南 > 7.3 射血分数降低的心衰"]]);
	assert.doesNotMatch(text(reply), /还没导入/);
	assert.deepEqual(readdirSync(join(pkg, "knowledge", GUIDE)), ["source.json"]);
});

test("改了导入的文件，下一次查询用的是新内容", async (t) => {
	const { search, dataDir, root } = setup(t);
	const file = join(root, "guide.md");
	writeFileSync(file, "# 指南\n\n## 旧章节\n\n旧的推荐内容。\n");
	importKnowledge(dataDir, GUIDE, file);
	assert.equal(passages(await search("旧的推荐")).length, 1);
	writeFileSync(file, "# 指南\n\n## 新章节\n\n新的推荐内容。\n");
	importKnowledge(dataDir, GUIDE, file);
	assert.equal(passages(await search("旧的推荐")).length, 0);
	assert.deepEqual(passages(await search("新的推荐")).map((p) => p.section), ["指南 > 新章节"]);
});

test("包更新以后索引重建：新版本钉住的任务查到新内容，查不到删掉的内容", async (t) => {
	const { search, pkg, publish } = setup(t);
	assert.equal(passages(await search("连续三次上升")).length, 1);
	writeFileSync(join(pkg, "knowledge/tumor-marker-basics/overview.md"), "# 肿瘤标志物跟踪要点\n\n## 新的提醒条件\n\n连续两次上升就提醒。\n");
	publish();
	assert.equal(passages(await search("连续三次上升")).length, 0);
	assert.deepEqual(passages(await search("连续两次上升")).map((p) => p.section), ["肿瘤标志物跟踪要点 > 新的提醒条件"]);
});

test("别的模块的任务查不到这个模块的知识", async (t) => {
	const { search, caller } = setup(t);
	const other = caller({ pin: { module: "personal-tax" as ModuleName, digest: "0".repeat(64) as Digest } });
	assert.deepEqual(await search("同一家实验室", other), { ok: false, refusal: { code: "no-such-capability" } });
});

test("成员 uses 没写 knowledge：拒绝；写了的照常查。工具目录也只给写了的成员列 knowledge", async (t) => {
	const { search, caller, gateway } = setup(t);
	assert.deepEqual(await search("同一家实验室", caller({ member: "radiologist" })), { ok: false, refusal: { code: "not-in-uses", member: "radiologist" } });
	assert.equal(passages(await search("同一家实验室", caller({ member: "oncologist" }))).length, 1);
	const knowledge = (c: WorkerCaller) => gateway.catalogue(c).filter((e) => e.request === "knowledge");
	assert.deepEqual(knowledge(caller({ member: "radiologist" })), []);
	const help = knowledge(caller({ member: "oncologist" }))[0]!.help;
	assert.match(help, /tumor-marker-basics · 《肿瘤标志物跟踪要点（模块自编）》/);
	assert.match(help, /2022-aha-acc-hfsa-hf · .*还没导入/);
	assert.equal(knowledge(caller()).length, 1);
});

test("查不到：返回空列表和一句说明", async (t) => {
	const { search } = setup(t);
	const reply = await search("量子纠缠");
	assert.deepEqual(passages(reply), []);
	assert.match(text(reply), /没有找到和「量子纠缠」相关的段落/);
});

test("命中很多段时只返回前 8 段的摘录，不把全文倒出来", async (t) => {
	const { search, dataDir, root } = setup(t);
	const long = "血压控制的要点很多。".repeat(200);
	const file = join(root, "big.md");
	writeFileSync(file, Array.from({ length: 30 }, (_, i) => `## 第 ${i + 1} 节\n\n${long}\n`).join("\n"));
	importKnowledge(dataDir, GUIDE, file);
	const reply = await search("血压控制");
	assert.equal(passages(reply).length, 8);
	assert.ok(text(reply).length < 5000, `回复 ${text(reply).length} 个字`);
});

test("导入目录：只收 Markdown 文件，再导入一次结果一样", async (t) => {
	const { search, dataDir, root } = setup(t);
	const dir = join(root, "guide");
	mkdirSync(dir);
	writeFileSync(join(dir, "a.md"), "## 第一章\n\n利尿剂用法。\n");
	writeFileSync(join(dir, "b.md"), "## 第二章\n\n利尿剂剂量。\n");
	writeFileSync(join(dir, "notes.pdf"), "not markdown");
	importKnowledge(dataDir, GUIDE, dir);
	importKnowledge(dataDir, GUIDE, dir);
	assert.deepEqual(passages(await search("利尿剂")).map((p) => p.section).sort(), ["第一章", "第二章"]);
});

const member = (name: string): Member => ({ name, title: name, description: name, tools: ["read"], skills: [], model: undefined, prompt: name, file: `/agents/${name}.md` });

async function hostWithHealth(t: TestContext, script: (scene: { worker: FakeWorker; spawner: FakeSpawner }) => Promise<unknown>) {
	const { gateway, caller } = setup(t);
	const { digest } = caller().pin;
	const kit: DomainKit = { skillsDir: undefined, prepare: undefined, crew: [member("oncologist"), member("radiologist")], granted: [] };
	const domains: Domains = { book: () => new Map([[HEALTH, { team: "健康顾问团", onRoster: true, digest }]]), kitFor: (domain) => (domain === HEALTH ? kit : undefined) };
	const results: unknown[] = [];
	let spawner!: FakeSpawner;
	const started = await startHost(
		(cards) => cards.flatMap((card) => (card.startsWith("[对话]") ? openOnConversation(card, "肿瘤标志物", HEALTH) : [])),
		async (worker) => {
			results.push(await Promise.resolve().then(() => script({ worker, spawner })).catch((e: Error) => e.message));
			worker.report({ status: "progress", summary: "查好了" });
			worker.settle();
		},
		{ domains, gateway, dispatch: { timeoutMs: 5000, codingTimeoutMs: 5000, stallMs: 5000, maxConcurrent: 4 } },
	);
	spawner = started.spawner;
	t.after(() => started.host.stop());
	await started.host.say("CEA 连续涨了三次要紧吗");
	await until(() => results.length === 1, "助手查完一次", 10_000);
	return { result: results[0], spawner };
}

test("宿主：personal-health 任务的助手带着知识目录，调 knowledge 拿到带文档名和章节的段落", async (t) => {
	const { result, spawner } = await hostWithHealth(t, async ({ worker }) => worker.request("worker.knowledge", { query: "同一家实验室" }));
	assert.match(String(result), /^\[模块知识\][\s\S]*《肿瘤标志物跟踪要点（模块自编）》（tumor-marker-basics，版本 0\.1，参考）章节：肿瘤标志物跟踪要点 > 看趋势，不看单次/);
	assert.match([...spawner.workers.values()][0]!.spec.knowledge ?? "", /tumor-marker-basics/);
});

test("宿主：派出的成员 uses 写了 knowledge 的带知识目录、查得到；没写的没有目录、被拒", async (t) => {
	const { result } = await hostWithHealth(t, async ({ worker, spawner }) => {
		const seen: Record<string, { catalogue: string | null; reply: string }> = {};
		spawner.runner = async (run) => {
			const reply = await Promise.resolve()
				.then(() => spawner.request(run.ticketId, run.token, "worker.knowledge", { query: "复查" }))
				.then((r) => String(r), (e: Error) => e.message);
			seen[run.member.name] = { catalogue: run.knowledge ?? null, reply };
			return "好了";
		};
		for (const agent of ["oncologist", "radiologist"]) await worker.request("worker.dispatch", { agent, task: "看标志物", callId: `call_${agent}` });
		return seen;
	});
	const seen = result as Record<string, { catalogue: string | null; reply: string }>;
	assert.match(seen["oncologist"]!.catalogue ?? "", /tumor-marker-basics/);
	assert.match(seen["oncologist"]!.reply, /什么算需要提醒/);
	assert.equal(seen["radiologist"]!.catalogue, null);
	assert.match(seen["radiologist"]!.reply, /uses/);
});

test("导入一个没有 Markdown 的目录：什么都不改，之前导入的还在", async (t) => {
	const { search, dataDir, root } = setup(t);
	const file = join(root, "guide.md");
	writeFileSync(file, "## 第一章\n\n利尿剂用法。\n");
	importKnowledge(dataDir, GUIDE, file);
	const empty = join(root, "empty");
	mkdirSync(empty);
	assert.equal(importKnowledge(dataDir, GUIDE, empty), 0);
	assert.equal(passages(await search("利尿剂")).length, 1);
});
