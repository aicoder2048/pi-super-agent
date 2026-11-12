import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createGateway } from "../src/modules/gateway.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { moduleDataDir } from "../src/modules/knowledge.ts";
import { ModuleStore } from "../src/modules/live.ts";
import type { Digest, ModuleName } from "../src/modules/manifest.ts";
import type { Alert, Condition, Json, Reply, Request, WorkerCaller } from "../src/modules/protocol.ts";
import { scanPackage } from "../src/modules/validate.ts";
import { BotApi, BotToken } from "../src/host/telegram/bot-api.ts";
import { hostLineLabel } from "../src/client/board-format.mjs";
import type { DomainKit, Domains } from "../src/modules.ts";
import { FAKE_BOT_TOKEN, FakeTelegram } from "./helpers/fake-telegram.ts";
import { ids, openOnConversation, startHost, until, type FakeWorker } from "./helpers/fakes.ts";

const SAMPLE = join(import.meta.dirname, "../docs/modules/architecture/sample");
const HEALTH = "personal-health" as ModuleName;

function world(t: TestContext, log: (line: string) => void = () => {}) {
	const root = mkdtempSync(join(tmpdir(), "psa-conditions-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const state = join(root, "state");
	const store = new ModuleStore(join(state, "module-store"));
	const serving = new Map<ModuleName, Digest>();
	const keep = (module: ModuleName, dir: string): Digest => {
		const scan = scanPackage(dir, { runCases: false, folder: module });
		assert.ok(scan.ok, JSON.stringify(scan));
		assert.ok(store.keep(module, scan.scan.digest, dir));
		serving.set(module, scan.scan.digest);
		return scan.scan.digest;
	};
	const gateway = createGateway({
		copyDir: (module, digest) => store.dirOf(module, digest),
		serving: (module) => serving.get(module),
		dataDir: (module) => moduleDataDir(state, module),
		rows: instanceData(state),
		secret: () => undefined,
		log,
	});
	const caller = (module: ModuleName, digest: Digest, over: Partial<WorkerCaller> = {}): WorkerCaller => ({
		who: "worker", ticket: "tkt_1", pin: { module, digest }, basis: "request", member: null, heardOthers: false, ...over,
	});
	return { root, keep, gateway, caller };
}

const health = (t: TestContext, log?: (line: string) => void, pkg = join(SAMPLE, "personal-health")) => {
	const w = world(t, log);
	const digest = w.keep(HEALTH, pkg);
	return { ...w, me: (over: Partial<WorkerCaller> = {}) => w.caller(HEALTH, digest, over) };
};

const ok = (reply: Reply) => {
	assert.ok(reply.ok, JSON.stringify(reply));
	return reply;
};
const refusal = (reply: Reply) => {
	assert.ok(!reply.ok, `没被拒：${JSON.stringify(reply)}`);
	return reply.refusal;
};

const set = (key: string, condition: Condition, extra: { note?: string; id?: string } = {}): Request => ({ kind: "watch", collection: "lab-results" as never, op: "set", watch: { key, condition, ...extra } });
const list: Request = { kind: "watch", collection: "lab-results" as never, op: "list" };
const remove = (id: string): Request => ({ kind: "watch", collection: "lab-results" as never, op: "remove", id });
const write = (rows: Json[], from = "使用者口述"): Request => ({ kind: "data", collection: "lab-results" as never, op: "write", rows, from });
const glucose = (value: number, takenAt: string) => ({ item: "空腹血糖", value, unit: "mmol/L", takenAt });
const conditionsOf = (reply: Reply) => (ok(reply).output as { conditions: { id: string; key: string; condition: Condition }[] }).conditions;
const alertsOf = (reply: Reply): readonly Alert[] => {
	const r = ok(reply);
	return r.alerts ?? [];
};

/** Writes one reading per value, a day apart from 2026-11-01, and returns how many alerts each write raised. */
async function series(gateway: ReturnType<typeof world>["gateway"], me: WorkerCaller, values: number[], item = "空腹血糖"): Promise<number[]> {
	const counts: number[] = [];
	for (const [i, value] of values.entries()) {
		const reply = await gateway.call(me, write([{ item, value, takenAt: `2026-11-${String(i + 1).padStart(2, "0")}` }]));
		counts.push(alertsOf(reply).length);
	}
	return counts;
}

test("above：严格高于才提醒；从不满足变成满足时提醒一次，一直高于不重复，降回去再升上来再提醒", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "above", value: 7 })));
	assert.deepEqual(await series(gateway, me(), [6.8, 7, 7.4, 7.6, 6.5, 7.2]), [0, 0, 1, 0, 0, 1]);
});

test("below：等于界限不提醒，低于才提醒", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "below", value: 3.9 })));
	assert.deepEqual(await series(gateway, me(), [4.2, 3.9, 3.8]), [0, 0, 1]);
});

test("条件只看自己的 key：别的项目的读数不触发", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "above", value: 7 })));
	assert.deepEqual(await series(gateway, me(), [9, 9.5], "CEA"), [0, 0]);
});

test("rising-streak：连续上涨到第 times 次的那一行提醒一次，继续涨不再提醒；中途回落重新数", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "rising-streak", times: 3 })));
	assert.deepEqual(await series(gateway, me(), [5, 5.5, 5.2, 5.4, 5.6, 5.8, 6.0]), [0, 0, 0, 0, 0, 1, 0]);
});

test("falling-streak：持平不算下跌", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "falling-streak", times: 2 })));
	assert.deepEqual(await series(gateway, me(), [7, 6.5, 6.5, 6.2, 6.0]), [0, 0, 0, 0, 1]);
});

test("change-pct 带 basis：相对 basis 的涨跌幅到界限时提醒，界限本身算到；方向不对不提醒", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "change-pct", atLeast: 10, direction: "up", basis: 5 })));
	assert.deepEqual(await series(gateway, me(), [5.4, 4, 5.5, 5.8]), [0, 0, 1, 0]);
});

test("change-pct 不带 basis：和上一行比，每一次够大的变动都提醒", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "change-pct", atLeast: 20, direction: "either" })));
	assert.deepEqual(await series(gateway, me(), [5, 5.5, 4.2, 4.4, 5.4]), [0, 0, 1, 0, 1]);
});

test("crosses-average：上一行在均线上或下面、这一行穿到另一边时提醒；均线是最近 points 行的平均", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "crosses-average", points: 3, direction: "up" })));
	ok(await gateway.call(me(), set("空腹血糖", { when: "crosses-average", points: 3, direction: "down" })));
	assert.deepEqual(await series(gateway, me(), [10, 11, 12, 13, 9, 12, 13, 10]), [0, 0, 0, 0, 1, 1, 0, 1]);
});

test("提醒文字由程序拼出：带模块的数据名、key、这一行的数值、时间和来源，只有一行", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "above", value: 7 }, { note: "复查后告诉内分泌科" })));
	const [alert] = alertsOf(await gateway.call(me(), write([glucose(7.4, "2026-11-12")], "blobs/checkup-2026-11.pdf")));
	assert.ok(alert);
	for (const part of ["检验指标", "空腹血糖", "7.4", "高于 7", "2026-11-12", "blobs/checkup-2026-11.pdf", "复查后告诉内分泌科"]) assert.ok(alert.text.includes(part), `${alert.text} 缺 ${part}`);
	assert.ok(!/[\n\r]/.test(alert.text));
	assert.equal(alert.private, true);
	assert.equal(alert.at, "2026-11-12");
});

test("改了条件之后同一天再写一行：提醒编号和改之前的不同，宿主不会把它当重复吞掉", async (t) => {
	const { gateway, me } = health(t);
	const kept = ok(await gateway.call(me(), set("CEA", { when: "above", value: 5 })));
	const id = (kept.output as { condition: { id: string } }).condition.id;
	const [before] = alertsOf(await gateway.call(me(), write([{ item: "CEA", value: 9, takenAt: "2026-11-12" }])));
	ok(await gateway.call(me(), set("CEA", { when: "above", value: 8 }, { id })));
	alertsOf(await gateway.call(me(), write([{ item: "CEA", value: 7, takenAt: "2026-11-12" }])));
	const [after] = alertsOf(await gateway.call(me(), write([{ item: "CEA", value: 9, takenAt: "2026-11-12" }])));
	assert.ok(before && after);
	assert.notEqual(after.externalId, before.externalId);
});

test("日期只到天：同一天里先涨后跌两次够大的变动，各提醒一次，编号不同", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "change-pct", atLeast: 20, direction: "either" })));
	const alerts = [];
	for (const value of [5, 7, 5]) alerts.push(alertsOf(await gateway.call(me(), write([glucose(value, "2026-11-12")]))));
	assert.deepEqual(alerts.map((a) => a.length), [0, 1, 1]);
	assert.notEqual(alerts[1]![0]!.externalId, alerts[2]![0]!.externalId);
});

test("change-pct 带 basis、方向 either：从涨够一侧直接跳到跌够一侧，也提醒", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "change-pct", atLeast: 10, direction: "either", basis: 5 })));
	assert.deepEqual(await series(gateway, me(), [5.6, 4.4, 4.3, 5.7]), [1, 1, 0, 1]);
});

test("一次导入多行过去的读数：只看最新的那一行，不为中间每次越线各提醒一次", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "above", value: 7 })));
	const rows = [6, 8, 6, 8, 6, 8, 6, 8].map((value, i) => glucose(value, `2026-10-0${i + 1}`));
	assert.equal(alertsOf(await gateway.call(me(), write(rows))).length, 1);
});

test("补录比已存最新一行更早的读数：存下，不提醒", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "above", value: 7 })));
	assert.deepEqual(await series(gateway, me(), [6, 6.5]), [0, 0]);
	const backfilled = await gateway.call(me(), write([glucose(8, "2026-10-20"), glucose(6, "2026-10-21"), glucose(8, "2026-10-22")]));
	assert.equal(alertsOf(backfilled).length, 0);
	assert.equal((ok(backfilled).output as { rows: unknown[] }).rows.length, 3);
});

test("一次写进几行比已存最新一行更新的读数：每行和它前一行比，越线那行提醒", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "above", value: 7 })));
	assert.deepEqual(await series(gateway, me(), [6]), [0]);
	const alerts = alertsOf(await gateway.call(me(), write([glucose(7.2, "2026-11-02"), glucose(7.4, "2026-11-03")])));
	assert.deepEqual(alerts.map((a) => a.at), ["2026-11-02"]);
});

test("一次写进的新读数先越线又降回：越线那行照样提醒", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "above", value: 7 })));
	assert.deepEqual(await series(gateway, me(), [6]), [0]);
	const alerts = alertsOf(await gateway.call(me(), write([glucose(8, "2026-11-02"), glucose(6.5, "2026-11-03")])));
	assert.deepEqual(alerts.map((a) => a.at), ["2026-11-02"]);
});

test("一次写进的行里，比写入前已存最新一行更早的只存不提醒，更新的照样提醒", async (t) => {
	const { gateway, me } = health(t);
	ok(await gateway.call(me(), set("空腹血糖", { when: "above", value: 7 })));
	assert.deepEqual(await series(gateway, me(), [6, 6.5]), [0, 0]);
	const alerts = alertsOf(await gateway.call(me(), write([glucose(8, "2026-10-20"), glucose(6, "2026-10-21"), glucose(7.5, "2026-11-03")])));
	assert.deepEqual(alerts.map((a) => a.at), ["2026-11-03"]);
});

test("检查提醒条件出错时，写进去的行照样算写成功，出错记一行日志", async (t) => {
	const logs: string[] = [];
	const { root, gateway, me } = health(t, (line) => logs.push(line));
	ok(await gateway.call(me(), set("空腹血糖", { when: "above", value: 7 })));
	const db = new DatabaseSync(join(moduleDataDir(join(root, "state"), HEALTH), "data.db"));
	db.exec("UPDATE _conditions SET params = 'not json'");
	db.close();
	const reply = await gateway.call(me(), write([glucose(7.4, "2026-11-12")]));
	assert.deepEqual(alertsOf(reply), []);
	const read = ok(await gateway.call(me(), { kind: "data", collection: "lab-results" as never, op: "query", query: {} }));
	assert.equal((read.output as { rows: unknown[] }).rows.length, 1);
	assert.ok(logs.some((l) => l.includes("lab-results") && l.includes("提醒")), logs.join("\n"));
});

test("watch.key 要指向文字字段，watch.at 要指向日期或文字字段，否则包检查不过", (t) => {
	const root = mkdtempSync(join(tmpdir(), "psa-watch-scan-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const scan = (watch: object) => {
		const dir = mkdtempSync(join(root, "pkg-"));
		const fields = { who: { type: "text", title: "谁" }, code: { type: "number", title: "编号" }, kg: { type: "number", title: "公斤" }, on: { type: "date", title: "日期" }, epoch: { type: "number", title: "时间戳" } };
		mkdirSync(join(dir, "data", "weights"), { recursive: true });
		writeFileSync(join(dir, "module.json"), JSON.stringify({ schema: 1, name: "body", version: "0.1.0" }));
		writeFileSync(join(dir, "data", "weights", "collection.json"), JSON.stringify({ title: "体重", kind: "series", class: "shareable", fields, watch }));
		const result = scanPackage(dir, { runCases: false, folder: "body" });
		return result.ok ? [] : result.problems.map((p) => p.reason);
	};
	assert.deepEqual(scan({ key: "who", value: "kg", at: "on" }), []);
	assert.ok(scan({ key: "code", value: "kg", at: "on" }).some((r) => r.includes("watch.key")));
	assert.ok(scan({ key: "who", value: "kg", at: "epoch" }).some((r) => r.includes("watch.at")));
});

test("set 回一行回执；list 列出；带 id 的 set 改那一条；remove 去掉", async (t) => {
	const { gateway, me } = health(t);
	const reply = ok(await gateway.call(me(), set("空腹血糖", { when: "above", value: 7 })));
	const { receipt, condition } = reply.output as { receipt: string; condition: { id: string } };
	assert.match(receipt, /空腹血糖.*高于 7/);
	assert.ok(!receipt.includes("\n"));
	ok(await gateway.call(me(), set("空腹血糖", { when: "above", value: 7.5 }, { id: condition.id })));
	assert.deepEqual(conditionsOf(await gateway.call(me(), list)).map((c) => [c.id, c.condition]), [[condition.id, { when: "above", value: 7.5 }]]);
	ok(await gateway.call(me(), remove(condition.id)));
	assert.deepEqual(conditionsOf(await gateway.call(me(), list)), []);
	assert.equal(refusal(await gateway.call(me(), remove(condition.id))).code, "bad-input");
});

test("推断任务、读过别人内容的 request 任务、规则任务设或删条件被拒，条件表不变；list 谁都能用", async (t) => {
	const { gateway, me } = health(t);
	const kept = ok(await gateway.call(me(), set("空腹血糖", { when: "above", value: 7 })));
	const id = (kept.output as { condition: { id: string } }).condition.id;
	for (const other of [me({ basis: "inference" }), me({ heardOthers: true }), me({ basis: "rule" })]) {
		assert.equal(refusal(await gateway.call(other, set("空腹血糖", { when: "below", value: 3 }))).code, "not-allowed");
		assert.equal(refusal(await gateway.call(other, remove(id))).code, "not-allowed");
		assert.equal(conditionsOf(await gateway.call(other, list)).length, 1);
	}
	assert.deepEqual(conditionsOf(await gateway.call(me(), list)).map((c) => c.condition), [{ when: "above", value: 7 }]);
});

test("不合法的条件和没写 watch 的数据都被拒", async (t) => {
	const { gateway, me } = health(t);
	const bad = [
		set("空腹血糖", { when: "sideways" } as never),
		set("空腹血糖", { when: "above", value: "7" } as never),
		set("空腹血糖", { when: "rising-streak", times: 0 }),
		set("空腹血糖", { when: "change-pct", atLeast: -5, direction: "up" }),
		set("空腹血糖", { when: "crosses-average", points: 1, direction: "up" }),
		set("", { when: "above", value: 7 }),
	];
	for (const request of bad) assert.equal(refusal(await gateway.call(me(), request)).code, "bad-input", JSON.stringify(request));
	const profile: Request = { kind: "watch", collection: "profile" as never, op: "list" };
	assert.equal(refusal(await gateway.call(me(), profile)).code, "no-such-capability");
	assert.deepEqual(conditionsOf(await gateway.call(me(), list)), []);
});

test("这类数据改名后，原来设的条件跟着走，照常提醒", async (t) => {
	const w = world(t);
	const pkg = (version: string, name: string, was?: string) => {
		const dir = join(w.root, "pkg", version);
		const collection = { title: "体重", kind: "series", class: "shareable", fields: { who: { type: "text", title: "谁" }, kg: { type: "number", title: "公斤" }, on: { type: "date", title: "日期" } }, watch: { key: "who", value: "kg", at: "on" }, ...(was && { was }) };
		mkdirSync(join(dir, "data", name), { recursive: true });
		writeFileSync(join(dir, "module.json"), JSON.stringify({ schema: 1, name: "body", version }));
		writeFileSync(join(dir, "data", name, "collection.json"), JSON.stringify(collection));
		return w.keep("body" as ModuleName, dir);
	};
	const v1 = w.caller("body" as ModuleName, pkg("0.1.0", "weights"));
	ok(await w.gateway.call(v1, { kind: "watch", collection: "weights" as never, op: "set", watch: { key: "我", condition: { when: "above", value: 80 } } }));
	const v2 = w.caller("body" as ModuleName, pkg("0.2.0", "body-weights", "weights"));
	assert.equal(conditionsOf(await w.gateway.call(v2, { kind: "watch", collection: "body-weights" as never, op: "list" })).length, 1);
	const written = await w.gateway.call(v2, { kind: "data", collection: "body-weights" as never, op: "write", rows: [{ who: "我", kg: 81, on: "2026-11-12" }], from: "体重秤" });
	assert.equal(alertsOf(written).length, 1);
	assert.equal(alertsOf(written)[0]!.private, false);
});

const USER = 42;
const NOTICE = "个人医疗健康 有新内容，请在网页上查看";

async function hostWithHealth(t: TestContext, script: (worker: FakeWorker) => Promise<unknown>, basis: "request" | "inference" = "request", pkg?: string) {
	const w = health(t, undefined, pkg);
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const digest = w.me().pin.digest;
	const kit: DomainKit = { skillsDir: undefined, prepare: undefined, crew: [], granted: [] };
	const domains: Domains = { book: () => new Map([["personal-health", { team: "健康顾问团", onRoster: true, digest, title: "个人医疗健康" }]]), kitFor: (d) => (d === "personal-health" ? kit : undefined) };
	const results: unknown[] = [];
	const { host, spawner } = await startHost(
		(cards) => cards.flatMap((card) => {
			if (card.startsWith("[Worker 汇报]")) return [{ name: "reply", args: { text: "好的", cause: ids(card, "tkt") } }];
			if (!card.startsWith("[对话]")) return [];
			const [route, reply] = openOnConversation(card, "设提醒", "personal-health");
			(route!.args.decisions as Record<string, unknown>[])[0]!.basis = basis;
			return [route!, reply!];
		}),
		async (worker) => {
			results.push(await Promise.resolve().then(() => script(worker)).catch((e: Error) => e.message));
			worker.report({ status: "ready", summary: "记好了" });
			worker.settle();
		},
		{ domains, gateway: w.gateway, telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 2, minGapMs: 20 } } },
	);
	t.after(() => host.stop());
	tg.userSays(USER, "/start");
	await until(() => tg.sent.length > 0, "聊天打开");
	await host.say("空腹血糖高于 7 提醒我");
	await until(() => host.kernel.conversation().some((l) => l.text === "好的"), "幕僚长转述了汇报", 10_000);
	const phone = () => tg.sent.filter((m) => m.chatId === USER).map((m) => m.text);
	const alerts = () => host.kernel.conversation().filter((l) => l.who === "alert").map((l) => l.text);
	return { result: results[0], host, spawner, phone, alerts };
}

const setAbove7 = { op: "set", collection: "lab-results", key: "空腹血糖", condition: { when: "above", value: 7 } };
const write74 = { op: "write", collection: "lab-results", rows: [glucose(7.4, "2026-11-12")], from: "使用者口述" };

test("宿主：助手设条件后写进 7.4，网页对话里有一条完整提醒；Telegram 上是一行提示，不带数值", async (t) => {
	const { result, phone, alerts, spawner } = await hostWithHealth(t, async (worker) => {
		const receipt = await worker.request("worker.watch", setAbove7);
		await worker.request("worker.data", write74);
		return receipt;
	});
	assert.match((result as { receipt: string }).receipt, /空腹血糖.*高于 7/);
	assert.equal(alerts().length, 1);
	assert.match(alerts()[0]!, /空腹血糖 7\.4.*2026-11-12/);
	await until(() => phone().filter((m) => m === NOTICE).length >= 2, "提醒的一行提示和汇报的一行提示都到了手机");
	assert.ok(!phone().some((m) => m.includes("7.4")), phone().join(" / "));
	assert.match([...spawner.workers.values()][0]!.spec.watch ?? "", /lab-results · 检验指标/);
});

test("宿主：同一天里两次越线，网页上两条提醒都在，都标着是哪个模块的提醒", async (t) => {
	const { host } = await hostWithHealth(t, async (worker) => {
		await worker.request("worker.watch", setAbove7);
		for (const value of [6, 7.4, 6, 7.4]) await worker.request("worker.data", { ...write74, rows: [glucose(value, "2026-11-12")] });
	});
	const lines = host.kernel.conversation().filter((l) => l.who === "alert");
	assert.equal(lines.length, 2);
	for (const line of lines) assert.equal(hostLineLabel(line), "提醒 · 个人医疗健康");
});

test("宿主：可分享数据上的提醒，Telegram 上带全文，前面写「提醒 · 模块名」", async (t) => {
	const pkg = mkdtempSync(join(tmpdir(), "psa-shareable-health-"));
	t.after(() => rmSync(pkg, { recursive: true, force: true }));
	cpSync(join(SAMPLE, "personal-health"), pkg, { recursive: true });
	const collection = join(pkg, "data", "lab-results", "collection.json");
	writeFileSync(collection, JSON.stringify({ ...JSON.parse(readFileSync(collection, "utf8")), class: "shareable" }));
	const { phone } = await hostWithHealth(t, async (worker) => {
		await worker.request("worker.watch", setAbove7);
		await worker.request("worker.data", write74);
	}, "request", pkg);
	await until(() => phone().some((m) => m.startsWith("提醒 · 个人医疗健康：")), "提醒带模块名到了手机");
	assert.ok(phone().some((m) => m.startsWith("提醒 · 个人医疗健康：") && m.includes("空腹血糖 7.4")), phone().join(" / "));
});

test("宿主：推断开的任务设条件被拒，说明推断任务只读、不能改提醒条件；list 可以", async (t) => {
	const { result } = await hostWithHealth(t, async (worker) => {
		const listed = await worker.request("worker.watch", { op: "list", collection: "lab-results" });
		assert.deepEqual((listed as { conditions: unknown[] }).conditions, []);
		return worker.request("worker.watch", setAbove7);
	}, "inference");
	assert.match(String(result), /\[提醒条件\].*只读.*提醒条件/);
});
