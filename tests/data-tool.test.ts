import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createGateway } from "../src/modules/gateway.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { moduleDataDir } from "../src/modules/knowledge.ts";
import { ModuleStore } from "../src/modules/live.ts";
import type { Digest, ModuleName } from "../src/modules/manifest.ts";
import type { Json, Query, Reply, Request, WorkerCaller } from "../src/modules/protocol.ts";
import { scanPackage } from "../src/modules/validate.ts";
import { BotApi, BotToken } from "../src/host/telegram/bot-api.ts";
import type { DomainKit, Domains } from "../src/modules.ts";
import { FAKE_BOT_TOKEN, FakeTelegram } from "./helpers/fake-telegram.ts";
import { ids, openOnConversation, startHost, until, type FakeWorker } from "./helpers/fakes.ts";

const SAMPLE = join(import.meta.dirname, "../docs/modules/architecture/sample");
const UPDATE = join(SAMPLE, "update");
const HEALTH = "personal-health" as ModuleName;
const LITE = "health-lite" as ModuleName;

function files(root: string, tree: Record<string, string>): void {
	for (const [path, content] of Object.entries(tree)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

function world(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "psa-data-tool-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const state = join(root, "state");
	const store = new ModuleStore(join(state, "module-store"));
	const serving = new Map<ModuleName, Digest>();
	const keep = (module: ModuleName, dir: string, serve = true): Digest => {
		const scan = scanPackage(dir, { runCases: false, folder: module });
		assert.ok(scan.ok, JSON.stringify(scan));
		assert.ok(store.keep(module, scan.scan.digest, dir));
		if (serve) serving.set(module, scan.scan.digest);
		return scan.scan.digest;
	};
	const logs: string[] = [];
	const data = instanceData(state);
	const gateway = createGateway({
		copyDir: (module, digest) => store.dirOf(module, digest),
		serving: (module) => serving.get(module),
		dataDir: (module) => moduleDataDir(state, module),
		rows: data,
		secret: () => undefined,
		log: (line) => logs.push(line),
	});
	const caller = (module: ModuleName, digest: Digest, over: Partial<WorkerCaller> = {}): WorkerCaller => ({
		who: "worker", ticket: "tkt_1", pin: { module, digest }, basis: "request", member: null, heardOthers: false, ...over,
	});
	const sql = <T>(module: string, query: string): T[] => {
		const db = new DatabaseSync(join(moduleDataDir(state, module), "data.db"), { readOnly: true });
		try {
			return db.prepare(query).all().map((row) => ({ ...row })) as T[];
		} finally {
			db.close();
		}
	};
	return { root, state, keep, serving, gateway, caller, logs, data, sql };
}

const health = (t: TestContext) => {
	const w = world(t);
	const digest = w.keep(HEALTH, join(SAMPLE, "personal-health"));
	return { ...w, digest, me: (over: Partial<WorkerCaller> = {}) => w.caller(HEALTH, digest, over) };
};

const query = (collection: string, q: Query = {}): Request => ({ kind: "data", collection: collection as never, op: "query", query: q });
const write = (collection: string, rows: Json[], from = "blobs/report-2026-10.pdf"): Request => ({ kind: "data", collection: collection as never, op: "write", rows, from });
const ok = (reply: Reply) => {
	assert.ok(reply.ok, JSON.stringify(reply));
	return reply;
};
const rowsOf = (reply: Reply) => (ok(reply).output as { rows: { id: string; from: string; sources?: Record<string, string>; fields: Record<string, Json> }[] }).rows;
const refusal = (reply: Reply) => {
	assert.ok(!reply.ok, `没被拒：${JSON.stringify(reply)}`);
	return reply.refusal;
};

const cea = (value: number, takenAt: string, lab = "协和") => ({ item: "CEA", value, unit: "ng/mL", reference: "<5", takenAt, lab });

test("写一条检验指标再按项目和日期查：读回同一行，带出处 from，回复标着私密", async (t) => {
	const { gateway, me } = health(t);
	const written = await gateway.call(me(), write("lab-results", [cea(3.1, "2026-09-01"), cea(4.2, "2026-10-01")]));
	assert.equal(ok(written).private, true);
	const read = await gateway.call(me(), query("lab-results", { where: { item: "CEA" }, since: "2026-09-15", until: "2026-12-31" }));
	assert.equal(ok(read).private, true);
	assert.deepEqual(rowsOf(read).map((r) => ({ from: r.from, fields: r.fields })), [{ from: "blobs/report-2026-10.pdf", fields: cea(4.2, "2026-10-01") }]);
	assert.deepEqual(rowsOf(read).map((r) => r.id), [rowsOf(written)[1]!.id], "读回的是写进去的那一行");
});

test("查询按时间从新到旧，limit 限条数；只写了一部分字段的行，其余字段为空", async (t) => {
	const { gateway, me } = health(t);
	await gateway.call(me(), write("lab-results", [cea(1, "2026-01-01"), cea(2, "2026-03-01"), cea(3, "2026-02-01"), { item: "AFP", value: 7 }]));
	const read = await gateway.call(me(), query("lab-results", { where: { item: "CEA" }, limit: 2 }));
	assert.deepEqual(rowsOf(read).map((r) => r.fields.value), [2, 3]);
	const afp = rowsOf(await gateway.call(me(), query("lab-results", { where: { item: "AFP" } })));
	assert.deepEqual(afp[0]!.fields, { item: "AFP", value: 7, unit: null, reference: null, takenAt: null, lab: null });
});

test("record 按主键写：不带 id 新增一行，带 id 只改给出的字段；series 带 id 被拒，只能追加", async (t) => {
	const { gateway, me } = health(t);
	const [row] = rowsOf(await gateway.call(me(), write("profile", [{ birthYear: 1970, sex: "男", allergies: "青霉素" }], "使用者口述")));
	await gateway.call(me(), write("profile", [{ id: row!.id, allergies: "青霉素、头孢" }], "使用者口述"));
	const all = rowsOf(await gateway.call(me(), query("profile")));
	assert.equal(all.length, 1);
	assert.deepEqual(all[0]!.fields, { birthYear: 1970, sex: "男", conditions: null, allergies: "青霉素、头孢", medications: null });
	assert.equal(refusal(await gateway.call(me(), write("lab-results", [{ id: "1", value: 2 }]))).code, "bad-input");
});

test("record 按 id 改几项、来源不同：这一行的 from 不变，改过的字段在 sources 里写明各自的来源；同一来源再改就收回", async (t) => {
	const { gateway, me } = health(t);
	const [row] = rowsOf(await gateway.call(me(), write("profile", [{ birthYear: 1970, allergies: "青霉素" }], "blobs/discharge-2025.pdf")));
	const [updated] = rowsOf(await gateway.call(me(), write("profile", [{ id: row!.id, medications: "二甲双胍" }], "使用者口述")));
	assert.equal(updated!.from, "blobs/discharge-2025.pdf");
	assert.deepEqual(updated!.sources, { medications: "使用者口述" });
	const [back] = rowsOf(await gateway.call(me(), write("profile", [{ id: row!.id, medications: "二甲双胍缓释片" }], "blobs/discharge-2025.pdf")));
	assert.equal(back!.sources, undefined);
	assert.deepEqual(rowsOf(await gateway.call(me(), query("profile")))[0]!.sources, undefined);
});

test("字段名不认识、类型不对、没写 from：拒绝，说明原因，一行都不写", async (t) => {
	const { gateway, me } = health(t);
	const bad = [
		write("lab-results", [cea(1, "2026-01-01"), { item: "CEA", colour: "red" }]),
		write("lab-results", [{ item: "CEA", value: "高" }]),
		write("lab-results", [cea(1, "2026-01-01")], ""),
		query("lab-results", { where: { colour: "red" } }),
	];
	for (const request of bad) assert.equal(refusal(await gateway.call(me(), request)).code, "bad-input", JSON.stringify(request));
	assert.deepEqual(rowsOf(await gateway.call(me(), query("lab-results"))), []);
});

test("推断开的任务能读不能写；使用者开的任务能写", async (t) => {
	const { gateway, me } = health(t);
	const inference = me({ basis: "inference" });
	assert.equal(refusal(await gateway.call(inference, write("lab-results", [cea(1, "2026-01-01")]))).code, "not-allowed");
	ok(await gateway.call(me(), write("lab-results", [cea(1, "2026-01-01")])));
	assert.equal(rowsOf(await gateway.call(inference, query("lab-results"))).length, 1);
});

test("成员只够得到 uses 里列的 data/<名字>：临床药师读得到检验指标，读不到病历原件", async (t) => {
	const { gateway, me } = health(t);
	const pharmacist = me({ member: "clinical-pharmacist" });
	ok(await gateway.call(pharmacist, query("lab-results")));
	assert.deepEqual(refusal(await gateway.call(pharmacist, query("documents"))), { code: "not-in-uses", member: "clinical-pharmacist" });
});

test("别的模块的任务查不到这个模块的数据", async (t) => {
	const w = health(t);
	await w.gateway.call(w.me(), write("lab-results", [cea(1, "2026-01-01")]));
	const tax = w.keep("personal-tax" as ModuleName, join(SAMPLE, "personal-tax"));
	const reply = await w.gateway.call(w.caller("personal-tax" as ModuleName, tax), query("lab-results"));
	assert.equal(refusal(reply).code, "no-such-capability");
});

test("每次读写在 data.db 的访问记录里记一笔：谁、哪类数据、读还是写、几行、结果；被拒的也记", async (t) => {
	const { gateway, me, sql } = health(t);
	await gateway.call(me(), write("lab-results", [cea(1, "2026-01-01"), cea(2, "2026-02-01")]));
	await gateway.call(me({ member: "oncologist" }), query("lab-results", { limit: 1 }));
	await gateway.call(me({ ticket: "tkt_2" }), query("research-updates"));
	await gateway.call(me(), write("lab-results", [{ item: "CEA", value: "高" }]));
	await gateway.call(me(), query("lab-results", { where: { colour: "red" } }));
	const log = sql<Record<string, unknown>>("personal-health", "SELECT who, collection, op, rows, outcome FROM _access ORDER BY rowid");
	assert.deepEqual(log, [
		{ who: "tkt_1 helper", collection: "lab-results", op: "write", rows: 2, outcome: "ok" },
		{ who: "tkt_1 oncologist", collection: "lab-results", op: "read", rows: 1, outcome: "ok" },
		{ who: "tkt_2 helper", collection: "research-updates", op: "read", rows: 0, outcome: "ok" },
		{ who: "tkt_1 helper", collection: "lab-results", op: "write", rows: 0, outcome: "refused：字段「value」要数字，收到 \"高\"" },
		{ who: "tkt_1 helper", collection: "lab-results", op: "read", rows: 0, outcome: "refused：「lab-results」没有字段「colour」，有：item、value、unit、reference、takenAt、lab" },
	]);
});

test("只碰 shareable 数据的回复不标私密", async (t) => {
	const { gateway, me } = health(t);
	const reply = await gateway.call(me(), write("research-updates", [{ title: "新指南", source: "pubmed", published: "2026-11-01", url: "https://example.org/x" }], "feed pubmed"));
	assert.equal(ok(reply).private, false);
	assert.equal(ok(await gateway.call(me(), query("research-updates"))).private, false);
});

test("模块早就开着、从没迁移过，或者有人手动删了 modules-data：第一次读写时建好表", async (t) => {
	const { gateway, me, state } = health(t);
	assert.deepEqual(rowsOf(await gateway.call(me(), query("lab-results"))), []);
	rmSync(join(state, "modules-data"), { recursive: true, force: true });
	ok(await gateway.call(me(), write("lab-results", [cea(1, "2026-01-01")])));
	assert.equal(rowsOf(await gateway.call(me(), query("lab-results"))).length, 1);
});

test("钉在改名前版本的任务按旧字段名写：值落到新名字下，查的时候旧名字也认", async (t) => {
	const w = world(t);
	const v1 = w.keep(LITE, join(UPDATE, "0.1.0", "health-lite"));
	const v2 = w.keep(LITE, join(UPDATE, "0.2.0-renames-field", "health-lite"));
	const pinned = w.caller(LITE, v1);
	ok(await w.gateway.call(pinned, write("lab-results", [{ item: "CEA", value: 3.1, takenAt: "2026-10-01", lab: "协和" }])));
	const now = rowsOf(await w.gateway.call(w.caller(LITE, v2), query("lab-results")));
	assert.deepEqual(now[0]!.fields, { item: "CEA", value: 3.1, takenAt: "2026-10-01", laboratory: "协和" });
	assert.equal(rowsOf(await w.gateway.call(pinned, query("lab-results", { where: { lab: "协和" } }))).length, 1);
});

test("字段改名以后，这个字段另记的来源跟着到新名字下", async (t) => {
	const w = world(t);
	const asRecord = (version: string) => {
		const dir = join(w.root, version, "health-lite");
		cpSync(join(UPDATE, version, "health-lite"), dir, { recursive: true });
		const path = join(dir, "data", "lab-results", "collection.json");
		writeFileSync(path, readFileSync(path, "utf8").replace('"series"', '"record"'));
		return dir;
	};
	const v1 = w.caller(LITE, w.keep(LITE, asRecord("0.1.0")));
	const [row] = rowsOf(await w.gateway.call(v1, write("lab-results", [{ item: "CEA", value: 3.1, takenAt: "2026-10-01", lab: "协和" }])));
	ok(await w.gateway.call(v1, write("lab-results", [{ id: row!.id, lab: "协和东院" }], "使用者口述")));
	const v2 = w.caller(LITE, w.keep(LITE, asRecord("0.2.0-renames-field")));
	assert.deepEqual(rowsOf(await w.gateway.call(v2, query("lab-results")))[0]!.sources, { laboratory: "使用者口述" });
});

test("拿掉的字段读不出来也写不进去，值留着；加回来以后又看得见", async (t) => {
	const w = world(t);
	const v1 = w.keep(LITE, join(UPDATE, "0.1.0", "health-lite"));
	ok(await w.gateway.call(w.caller(LITE, v1), write("lab-results", [{ item: "CEA", value: 3.1, lab: "协和" }])));
	const v2 = w.keep(LITE, join(UPDATE, "0.2.0-removes-field", "health-lite"));
	assert.deepEqual(rowsOf(await w.gateway.call(w.caller(LITE, v2), query("lab-results")))[0]!.fields, { item: "CEA", value: 3.1, takenAt: null });
	assert.equal(refusal(await w.gateway.call(w.caller(LITE, v2), write("lab-results", [{ item: "AFP", lab: "协和" }]))).code, "bad-input");
	w.keep(LITE, join(UPDATE, "0.1.0", "health-lite"));
	assert.equal(rowsOf(await w.gateway.call(w.caller(LITE, v1), query("lab-results")))[0]!.fields.lab, "协和");
});

test("旧名字后来又给了一类新数据：按现在声明的名字走，不走旧别名", async (t) => {
	const w = world(t);
	const pkg = (version: string, data: Record<string, object>) => {
		const dir = join(w.root, "pkg", version);
		files(dir, {
			"module.json": JSON.stringify({ schema: 1, name: "notes-mod", version }),
			...Object.fromEntries(Object.entries(data).map(([name, c]) => [`data/${name}/collection.json`, JSON.stringify({ kind: "record", class: "shareable", fields: { text: { type: "text", title: "内容" } }, ...c })])),
		});
		return w.keep("notes-mod" as ModuleName, dir);
	};
	const v1 = pkg("0.1.0", { notes: { title: "笔记" } });
	await w.gateway.call(w.caller("notes-mod" as ModuleName, v1), write("notes", [{ text: "旧笔记" }], "使用者口述"));
	const v2 = pkg("0.2.0", { memos: { title: "备忘", was: "notes" } });
	ok(await w.gateway.call(w.caller("notes-mod" as ModuleName, v2), query("memos")));
	const v3 = pkg("0.3.0", { memos: { title: "备忘" }, notes: { title: "新笔记" } });
	const me = w.caller("notes-mod" as ModuleName, v3);
	await w.gateway.call(me, write("notes", [{ text: "新笔记" }], "使用者口述"));
	assert.deepEqual(rowsOf(await w.gateway.call(me, query("notes"))).map((r) => r.fields.text), ["新笔记"]);
	assert.deepEqual(rowsOf(await w.gateway.call(me, query("memos"))).map((r) => r.fields.text), ["旧笔记"]);
});

test("写进去的行在之后的加字段迁移里原样留着，新字段为空", async (t) => {
	const w = world(t);
	const v1 = w.keep(LITE, join(UPDATE, "0.1.0", "health-lite"));
	ok(await w.gateway.call(w.caller(LITE, v1), write("lab-results", [{ item: "CEA", value: 3.1, takenAt: "2026-10-01", lab: "协和" }])));
	const v2 = w.keep(LITE, join(UPDATE, "0.2.0-adds-field", "health-lite"));
	const scan = scanPackage(join(UPDATE, "0.2.0-adds-field", "health-lite"), { runCases: false });
	assert.ok(scan.ok);
	assert.deepEqual(w.data.migrate(LITE, scan.scan.components), { ok: true });
	ok(await w.gateway.call(w.caller(LITE, v2), write("lab-results", [{ item: "AFP", value: 2 }])));
	const rows = rowsOf(await w.gateway.call(w.caller(LITE, v2), query("lab-results", { where: { item: "CEA" } })));
	assert.equal(rows[0]!.fields.lab, "协和");
	assert.equal(Object.values(rows[0]!.fields).filter((v) => v === null).length, 1, "只有新加的字段为空");
});

test("工具目录：每类数据一行，带字段说明；成员只见 uses 里的，没写 data 的成员没有这一项", async (t) => {
	const { gateway, me } = health(t);
	const names = (caller: WorkerCaller) => gateway.catalogue(caller).filter((e) => e.request === "data").map((e) => e.name);
	assert.deepEqual(names(me()).sort(), ["device-readings", "documents", "lab-results", "profile", "research-updates"]);
	assert.deepEqual(names(me({ member: "clinical-pharmacist" })), ["lab-results"]);
	assert.match(gateway.catalogue(me()).find((e) => e.name === "lab-results")!.help, /item（text，项目/);
});

const USER = 42;
const NOTICE = "个人医疗健康 有新内容，请在网页上查看";

async function hostWithHealth(t: TestContext, script: (worker: FakeWorker) => Promise<unknown>, basis: "request" | "inference" = "request") {
	const w = health(t);
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const kit: DomainKit = { skillsDir: undefined, prepare: undefined, crew: [], granted: [] };
	const domains: Domains = { book: () => new Map([["personal-health", { team: "健康顾问团", onRoster: true, digest: w.digest, title: "个人医疗健康" }]]), kitFor: (d) => (d === "personal-health" ? kit : undefined) };
	const results: unknown[] = [];
	const { host, spawner } = await startHost(
		(cards) => cards.flatMap((card) => {
			if (card.startsWith("[Worker 汇报]")) return [{ name: "reply", args: { text: `转述：${card.split("\n")[1]}`, cause: ids(card, "tkt") } }];
			if (!card.startsWith("[对话]")) return [];
			const [route, reply] = openOnConversation(card, "记指标", "personal-health");
			(route!.args.decisions as Record<string, unknown>[])[0]!.basis = basis;
			return [route!, reply!];
		}),
		async (worker) => {
			results.push(await Promise.resolve().then(() => script(worker)).catch((e: Error) => e.message));
			worker.report({ status: "ready", summary: "CEA 4.2 ng/mL，比上次高" });
			worker.settle();
		},
		{ domains, gateway: w.gateway, telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 2, minGapMs: 20 } } },
	);
	t.after(() => host.stop());
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length > 0, "聊天打开");
	await host.say("帮我记一下这次的 CEA");
	await until(() => host.kernel.conversation().some((l) => l.text.startsWith("转述：")), "幕僚长转述了汇报", 10_000);
	const phone = () => tg.sent.filter((m) => m.chatId === USER).map((m) => m.text);
	await until(() => phone().some((m) => m.startsWith("转述：") || m === NOTICE), "汇报到了手机");
	return { ...w, result: results[0], host, spawner, phone };
}

const writeCea = { op: "write", collection: "lab-results", rows: [cea(4.2, "2026-10-01")], from: "blobs/report-2026-10.pdf" };

test("宿主：助手用 data 写一条检验指标再读出来；访问记录两笔；Telegram 只收到一行提示，网页和终端是完整转述", async (t) => {
	const { result, host, phone, sql, spawner } = await hostWithHealth(t, async (worker) => {
		await worker.request("worker.data", writeCea);
		return worker.request("worker.data", { op: "query", collection: "lab-results", where: { item: "CEA" } });
	});
	assert.deepEqual((result as { rows: { fields: Record<string, Json> }[] }).rows.map((r) => r.fields), [cea(4.2, "2026-10-01")]);
	assert.deepEqual(sql<{ op: string }>("personal-health", "SELECT op FROM _access").map((r) => r.op), ["write", "read"]);
	assert.ok(phone().includes(NOTICE), phone().join("\n"));
	assert.ok(!phone().some((m) => m.includes("4.2")), `手机上没有指标的数值：${phone().join(" / ")}`);
	assert.ok(host.kernel.conversation().some((l) => l.text === "转述：CEA 4.2 ng/mL，比上次高"), "对话里是完整转述");
	assert.match([...spawner.workers.values()][0]!.spec.data ?? "", /lab-results · 检验指标/);
});

test("宿主：只读过 shareable 数据的任务，Telegram 收到完整转述", async (t) => {
	const { phone } = await hostWithHealth(t, (worker) => Promise.resolve(worker.request("worker.data", { op: "list", collection: "research-updates" })));
	assert.ok(phone().includes("转述：CEA 4.2 ng/mL，比上次高"), phone().join("\n"));
	assert.ok(!phone().includes(NOTICE));
});

test("宿主：推断开的任务用 data 写被拒，说明推断任务只读", async (t) => {
	const { result } = await hostWithHealth(t, (worker) => Promise.resolve(worker.request("worker.data", writeCea)), "inference");
	assert.match(String(result), /\[模块数据\].*只读/);
});

test("宿主：write 没给 rows 或 rows 不是数组、op 不认识：拒绝，不当成写了 0 行或 list", async (t) => {
	const { result, state } = await hostWithHealth(t, async (worker) => {
		const outcomes: string[] = [];
		for (const params of [{ op: "write", collection: "lab-results", from: "使用者口述" }, { op: "write", collection: "lab-results", rows: "CEA 4.2", from: "使用者口述" }, { op: "delete", collection: "lab-results" }]) {
			outcomes.push(await Promise.resolve().then(() => worker.request("worker.data", params)).then((r) => `ok ${JSON.stringify(r)}`, (e: Error) => e.message));
		}
		return outcomes;
	});
	const [noRows, notArray, unknownOp] = result as string[];
	assert.match(noRows!, /\[模块数据\].*rows/);
	assert.match(notArray!, /\[模块数据\].*rows/);
	assert.match(unknownOp!, /\[模块数据\].*delete/);
	assert.ok(!existsSync(join(moduleDataDir(state, HEALTH), "data.db")), "没有碰到数据库");
});

test("宿主：在网页上回答私密任务的问题，Telegram 上这句回答只是一行提示，看不到选项原文", async (t) => {
	const w = health(t);
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const kit: DomainKit = { skillsDir: undefined, prepare: undefined, crew: [], granted: [] };
	const domains: Domains = { book: () => new Map([["personal-health", { team: "健康顾问团", onRoster: true, digest: w.digest, title: "个人医疗健康" }]]), kitFor: (d) => (d === "personal-health" ? kit : undefined) };
	let opened = false;
	const { host } = await startHost(
		(cards) => cards.flatMap((card) => {
			if (!card.startsWith("[对话]") || opened) return [];
			opened = true;
			return openOnConversation(card, "记指标", "personal-health");
		}),
		async (worker) => {
			await worker.request("worker.data", { op: "list", collection: "lab-results" });
			worker.report({ status: "blocked", summary: "要你定", question: "CEA 从 3.1 升到 4.2，要不要约复查？", options: ["CEA 4.2 偏高，约下周复查", "先不复查"] });
			worker.settle();
		},
		{ domains, gateway: w.gateway, telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 2, minGapMs: 20 } } },
	);
	t.after(() => host.stop());
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length > 0, "聊天打开");
	await host.say("看看 CEA");
	await until(() => host.kernel.listTickets()[0]?.question != null, "问题来了", 10_000);
	const phone = () => tg.sent.filter((m) => m.chatId === USER).map((m) => m.text);
	await until(() => phone().includes(NOTICE), "问题卡片换成一行提示");
	const before = phone().length;
	assert.equal(host.answer(host.kernel.listTickets()[0]!.question!.reportId, 0).ok, true);
	await until(() => phone().length > before, "回答发到了手机");
	await new Promise((r) => setTimeout(r, 300));
	assert.deepEqual(phone().slice(before), [NOTICE]);
	assert.ok(host.kernel.conversation().some((l) => l.text.includes("CEA 4.2 偏高，约下周复查")), "对话里是完整回答");
});
