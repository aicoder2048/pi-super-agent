import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Modules } from "../src/modules.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import type { ModuleName } from "../src/modules/manifest.ts";
import type { Alert } from "../src/modules/protocol.ts";
import { runFeed, type FeedEntry, type FeedNotice } from "../src/modules/feed-runner.ts";
import { createScheduler } from "../src/modules/scheduler.ts";
import { problemLine, scanPackage } from "../src/modules/validate.ts";
import { inPollWindow } from "../src/sources/market/session.ts";
import { ids, servedAsHost, startHost, until } from "./helpers/fakes.ts";

type Feed = { json: Record<string, unknown>; handler?: string };

const READINGS = {
	title: "读数",
	kind: "series",
	class: "shareable",
	fields: { item: { type: "text", title: "项目" }, value: { type: "number", title: "数值" }, at: { type: "date", title: "时间" } },
	watch: { key: "item", value: "value", at: "at" },
};

function writePackage(root: string, name: string, feeds: Record<string, Feed>, { privateData = false } = {}): string {
	const dir = join(root, name);
	mkdirSync(join(dir, "data", "readings"), { recursive: true });
	writeFileSync(join(dir, "module.json"), JSON.stringify({ schema: 1, name, version: "0.1.0", title: `${name} 模块`, description: "测试模块" }));
	writeFileSync(join(dir, "data", "readings", "collection.json"), JSON.stringify({ ...READINGS, class: privateData ? "private" : "shareable" }));
	for (const [feed, { json, handler }] of Object.entries(feeds)) {
		mkdirSync(join(dir, "feeds", feed), { recursive: true });
		writeFileSync(join(dir, "feeds", feed, "feed.json"), JSON.stringify(json));
		if (handler !== undefined) writeFileSync(join(dir, "feeds", feed, "index.ts"), handler);
	}
	return dir;
}

const counting = (body: string) => `import { appendFileSync } from "node:fs";\nexport default async function (input) {\n\tappendFileSync("calls.txt", JSON.stringify(input) + "\\n");\n${body}\n}\n`;
const callsOf = (root: string, module: string, feed: string) => {
	const file = join(root, "modules", module, "feeds", feed, "calls.txt");
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
};

const TUESDAY_10AM_NY = Date.parse("2026-11-10T15:00:00Z");

function world(t: TestContext, feeds: Record<string, Record<string, Feed>>, options: { limitMs?: number; fixtures?: boolean; privateData?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "psa-scheduler-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const state = join(root, "state");
	for (const [name, list] of Object.entries(feeds)) writePackage(join(root, "modules"), name, list, options);
	const modules = servedAsHost(Modules.load([join(root, "modules")]));
	let serving = modules.feeds();
	const clock = { now: TUESDAY_10AM_NY };
	const submitted: FeedNotice[] = [];
	const alerts: { module: ModuleName; alert: Alert }[] = [];
	const logged: string[] = [];
	const make = () => {
		const data = instanceData(state);
		const ports = { data, submit: (n: FeedNotice) => void submitted.push(n), alert: (module: ModuleName, alert: Alert) => void alerts.push({ module, alert }), problem: () => {}, secret: () => undefined, now: () => clock.now, ...(options.limitMs !== undefined && { limitMs: options.limitMs }) };
		return {
			data,
			scheduler: createScheduler({
				feeds: () => serving,
				run: (entry: FeedEntry, items, fixture, signal) => runFeed(entry, items, ports, fixture, signal),
				state: data,
				inboxDir: join(state, "inbox"),
				now: () => clock.now,
				when: { "us-market-hours": inPollWindow },
				fixtures: options.fixtures ?? false,
				log: (line) => void logged.push(line),
			}),
		};
	};
	return { root, state, clock, submitted, alerts, logged, make, switchOff: () => (serving = []), entries: modules.feeds() };
}

const MINUTE = 60_000;
const timerNotice = { title: "整点提醒", connector: "timer", every: "1m", notice: "到点了 {{at}}" };

test("timer 加 notice：到点发一条触发，来源是 <模块>/<feed>；同一个点不再发；下一个点再发", async (t) => {
	const w = world(t, { clock: { tick: { json: timerNotice } } });
	const { scheduler } = w.make();
	await scheduler.tick();
	assert.equal(w.submitted.length, 1);
	assert.equal(w.submitted[0]!.source, "clock/tick");
	assert.match(w.submitted[0]!.body, /^到点了 2026-11-10T15:00:00/);
	w.clock.now += 20_000;
	await scheduler.tick();
	assert.equal(w.submitted.length, 1, "同一个点只调用一次");
	w.clock.now += MINUTE;
	await scheduler.tick();
	assert.equal(w.submitted.length, 2);
	assert.notEqual(w.submitted[0]!.id, w.submitted[1]!.id);
});

test("调度器跟着模块表：模块关掉以后下一个点不再调用", async (t) => {
	const w = world(t, { clock: { tick: { json: timerNotice } } });
	const { scheduler } = w.make();
	await scheduler.tick();
	w.switchOff();
	w.clock.now += 5 * MINUTE;
	await scheduler.tick();
	assert.equal(w.submitted.length, 1);
});

test("us-market-hours：盘前、周末、收盘 20 分钟以后不调用；盘中和收盘后 20 分钟内调用", async (t) => {
	const w = world(t, { quotes: { pull: { json: { ...timerNotice, when: "us-market-hours" } } } });
	const { scheduler } = w.make();
	const at = async (iso: string) => {
		w.clock.now = Date.parse(iso);
		const before = w.submitted.length;
		await scheduler.tick();
		return w.submitted.length > before;
	};
	assert.equal(await at("2026-11-10T14:00:00Z"), false, "盘前 9:00");
	assert.equal(await at("2026-11-14T16:00:00Z"), false, "周六 11:00");
	assert.equal(await at("2026-11-10T15:00:00Z"), true, "盘中 10:00");
	assert.equal(await at("2026-11-10T21:15:00Z"), true, "收盘后 15 分钟");
	assert.equal(await at("2026-11-10T21:25:00Z"), false, "收盘后 25 分钟");
});

const storeTwo = counting(`\treturn { records: [{ id: "a", item: "CEA", value: 4, at: "2026-11-01" }, { id: "b", item: "CEA", value: 6, at: "2026-11-02" }], notices: [{ id: "batch-1", fields: { n: "2" } }], cursor: "2026-11-02" };`);
const handlerFeed = { json: { title: "取读数", handler: "index.ts", every: "1m", into: "readings", notice: "新读数 {{n}} 条" }, handler: storeTwo };

test("handler 存的行进 into，带 from <模块>/<feed>；同一批跑两次行不重复，进度存下", async (t) => {
	const w = world(t, { lab: { pull: handlerFeed } });
	const { scheduler, data } = w.make();
	await scheduler.tick();
	w.clock.now += MINUTE;
	await scheduler.tick();
	assert.equal(callsOf(w.root, "lab", "pull").length, 2);
	const entry = w.entries[0]!;
	const rows = data.query(entry.module, entry.components, "readings", {}, "test").rows;
	assert.equal(rows.length, 2, JSON.stringify(rows));
	assert.deepEqual(new Set(rows.map((r) => r.from)), new Set(["lab/pull"]));
	assert.equal(w.submitted.filter((n) => n.id === "batch-1").length, 2, "两次都交给内核，内核按 id 去重");
	assert.equal(data.feedState(entry.module, "lab/pull").cursor, "2026-11-02");
});

test("进度在崩溃后接上：新的调度器把上次的进度交给 handler；同一个点不重跑", async (t) => {
	const w = world(t, { lab: { pull: handlerFeed } });
	await w.make().scheduler.tick();
	const restarted = w.make().scheduler;
	await restarted.tick();
	assert.equal(callsOf(w.root, "lab", "pull").length, 1, "重启后同一个点不再调用");
	w.clock.now += MINUTE;
	await restarted.tick();
	const calls = callsOf(w.root, "lab", "pull");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].cursor, null);
	assert.equal(calls[1].cursor, "2026-11-02");
});

test("handler 超时只算这一次失败：有日志，进度不动，下一个点照常调用", async (t) => {
	const w = world(t, { lab: { slow: { json: handlerFeed.json, handler: counting(`\tif (input.cursor === null) await new Promise(() => setInterval(() => {}, 1000));\n\treturn { cursor: "next" };`) } } }, { limitMs: 500 });
	const { scheduler, data } = w.make();
	await scheduler.tick();
	assert.ok(w.logged.some((line) => line.includes("lab/slow") && line.includes("limit")), w.logged.join("\n"));
	assert.equal(data.feedState("lab" as ModuleName, "lab/slow").cursor, null);
	w.clock.now += MINUTE;
	await scheduler.tick();
	assert.equal(callsOf(w.root, "lab", "slow").length, 2);
});

test("存下的行满足条件时交给宿主提醒", async (t) => {
	const w = world(t, { lab: { pull: handlerFeed } });
	const { scheduler, data } = w.make();
	const entry = w.entries[0]!;
	data.watch(entry.module, entry.components, { kind: "watch", collection: "readings" as never, op: "set", watch: { key: "CEA", condition: { when: "above", value: 5 } } }, "test");
	await scheduler.tick();
	assert.equal(w.alerts.length, 1, JSON.stringify(w.alerts));
	assert.equal(w.alerts[0]!.module, "lab");
	assert.match(w.alerts[0]!.alert.text, /6/);
	const calls = callsOf(w.root, "lab", "pull");
	assert.deepEqual(calls[0].watchedKeys, ["CEA"], "handler 拿到要盯的 key");
});

test("inbox：丢进来的 JSON 进了数据，文件挪走；坏文件挪进 rejected", async (t) => {
	const w = world(t, { lab: { drop: { json: { title: "投递读数", connector: "inbox", into: "readings" } } } });
	const { scheduler, data } = w.make();
	const dir = join(w.state, "inbox", "lab", "drop");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "one.json"), JSON.stringify({ id: "r1", item: "CEA", value: 3, at: "2026-11-03" }));
	writeFileSync(join(dir, "bad.json"), "{ not json");
	utimesSync(join(dir, "bad.json"), new Date(Date.now() - 5_000), new Date(Date.now() - 5_000));
	await scheduler.tick();
	const entry = w.entries[0]!;
	assert.equal(data.query(entry.module, entry.components, "readings", {}, "test").rows.length, 1);
	assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".json")), []);
	assert.ok(existsSync(join(dir, "processed", "one.json")));
	assert.ok(existsSync(join(dir, "rejected", "bad.json")));
	writeFileSync(join(dir, "again.json"), JSON.stringify({ id: "r1", item: "CEA", value: 3, at: "2026-11-03" }));
	await scheduler.tick();
	assert.equal(data.query(entry.module, entry.components, "readings", {}, "test").rows.length, 1, "同一个 id 不重复存");
});

test("预演：连接器换成 fixtures，每个样例跑一次，网络请求由 responses 代替", async (t) => {
	const handler = `export default async function (input) {\n\tconst reply = await fetch(input.settings.url);\n\tconst body = await reply.json();\n\treturn { records: body.rows };\n}\n`;
	const w = world(t, { lab: { pull: { json: { title: "取读数", handler: "index.ts", every: "1d", into: "readings", settings: { url: "https://example.test/rows" } }, handler } } }, { fixtures: true });
	const fixtures = join(w.root, "modules", "lab", "feeds", "pull", "fixtures");
	mkdirSync(fixtures, { recursive: true });
	writeFileSync(join(fixtures, "one.json"), JSON.stringify({ responses: { "https://example.test/rows": { rows: [{ id: "x", item: "CEA", value: 1, at: "2026-11-01" }] } } }));
	const modules = servedAsHost(Modules.load([join(w.root, "modules")]));
	const entries = modules.feeds();
	const data = instanceData(w.state);
	const ports = { data, submit: () => {}, alert: () => {}, problem: () => {}, secret: () => undefined, now: () => w.clock.now };
	const scheduler = createScheduler({ feeds: () => entries, run: (e, items, f) => runFeed(e, items, ports, f), state: data, inboxDir: join(w.state, "inbox"), now: () => w.clock.now, when: { "us-market-hours": inPollWindow }, fixtures: true, log: (line) => void w.logged.push(line) });
	await scheduler.tick();
	await scheduler.tick();
	assert.equal(data.query(entries[0]!.module, entries[0]!.components, "readings", {}, "test").rows.length, 1, w.logged.join("\n"));
});

const hostFeeds = (t: TestContext, feeds: Record<string, Feed>, privateData = false) => {
	const root = mkdtempSync(join(tmpdir(), "psa-scheduler-host-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writePackage(join(root, "modules"), "lab", feeds, { privateData });
	return servedAsHost(Modules.load([join(root, "modules")]));
};

async function hostWith(t: TestContext, modules: Modules) {
	let now = TUESDAY_10AM_NY;
	const { host } = await startHost(
		(cards) => cards.flatMap((card) => {
			if (!card.startsWith("[候选触发]")) return [];
			const triggerId = ids(card, "trg")!;
			return [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "inference", triggerId, title: "看新读数", brief: "看新读数", domain: "lab" }] } }];
		}),
		(worker) => {
			worker.report({ status: "ready", summary: "看过了" });
			worker.settle();
		},
		{
			sourcePolicy: (trigger) => modules.sourcePolicy(trigger),
			domains: { book: () => modules.book, kitFor: modules.kitFor },
			clock: { now: () => now },
			moduleFeeds: { feeds: () => modules.feeds(), fixtures: false, tickMs: 3_600_000 },
		},
	);
	t.after(() => host.stop());
	return { host, advance: (ms: number) => (now += ms) };
}

test("宿主：timer 的触发到了幕僚长那里开出任务；同一批 notice 跑两次只有一条触发", async (t) => {
	const modules = hostFeeds(t, { pull: handlerFeed });
	const { host, advance } = await hostWith(t, modules);
	await host.feedScheduler.tick();
	advance(MINUTE);
	await host.feedScheduler.tick();
	await until(() => host.kernel.listTickets().length === 1, "开了任务");
	const triggers = host.kernel.triggerLog().filter((r) => r.source === "lab/pull");
	assert.equal(triggers.length, 1, JSON.stringify(triggers));
	assert.equal(triggers[0]!.body, "新读数 2 条");
	assert.equal(host.kernel.touchedPrivate(host.kernel.listTickets()[0]!.id), false);
});

test("宿主：feed 的 ignore 匹配上的触发被丢掉，不到幕僚长", async (t) => {
	const modules = hostFeeds(t, { pull: { ...handlerFeed, json: { ...handlerFeed.json, ignore: ["^新读数 2"] } } });
	const { host } = await hostWith(t, modules);
	await host.feedScheduler.tick();
	await host.settled();
	const triggers = host.kernel.triggerLog().filter((r) => r.source === "lab/pull");
	assert.equal(triggers.length, 1);
	assert.equal(triggers[0]!.disposition, "ignored");
	assert.equal(host.kernel.listTickets().length, 0);
});

test("宿主：写进 private 数据的 feed 触发的任务标成读过私密数据", async (t) => {
	const modules = hostFeeds(t, { pull: handlerFeed }, true);
	const { host } = await hostWith(t, modules);
	await host.feedScheduler.tick();
	await until(() => host.kernel.listTickets().length === 1, "开了任务");
	assert.equal(host.kernel.touchedPrivate(host.kernel.listTickets()[0]!.id), true);
});

const countReadings = { title: "数读数", handler: "index.ts", every: "1m", reads: ["readings"], notice: "n={{n}}" };
const countHandler = `export default async function (input) {\n\treturn { notices: [{ id: "x", fields: { n: String(input.rows.readings.length) } }] };\n}\n`;
const writeFixture = (root: string, module: string, feed: string, name: string, body: object) => {
	const dir = join(root, "modules", module, "feeds", feed, "fixtures");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.json`), JSON.stringify(body));
};

test("检查和运行给 handler 的输入一样：reads 里的每个集合都有一列行，样例没给就是空列", async (t) => {
	const w = world(t, { lab: { count: { json: countReadings, handler: countHandler } } });
	writeFixture(w.root, "lab", "count", "plain", { responses: {} });
	const scan = scanPackage(join(w.root, "modules", "lab"));
	assert.ok(scan.ok, scan.ok ? "" : scan.problems.map(problemLine).join("\n"));
});

test("预演时样例给的 rows 交给 handler", async (t) => {
	const w = world(t, { lab: { count: { json: countReadings, handler: countHandler } } }, { fixtures: true });
	writeFixture(w.root, "lab", "count", "two", { input: { rows: { readings: [{ item: "CEA" }, { item: "CEA" }] } }, responses: {} });
	const entries = servedAsHost(Modules.load([join(w.root, "modules")])).feeds();
	const data = instanceData(w.state);
	const ports = { data, submit: (n: FeedNotice) => void w.submitted.push(n), alert: () => {}, problem: () => {}, secret: () => undefined, now: () => w.clock.now };
	await runFeed(entries[0]!, [], ports, entries[0]!.fixtures[0]);
	assert.deepEqual(w.submitted.map((n) => n.body), ["n=2"]);
});

test("inbox：一个坏文件只拒收它自己，好文件照常存下；rejected 里有一个 .error.txt 写着问题", async (t) => {
	const w = world(t, { lab: { drop: { json: { title: "投递读数", connector: "inbox", into: "readings" } } } });
	const { scheduler, data } = w.make();
	const dir = join(w.state, "inbox", "lab", "drop");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "a-good.json"), JSON.stringify({ id: "g1", item: "CEA", value: 3, at: "2026-11-03" }));
	writeFileSync(join(dir, "b-typo.json"), JSON.stringify({ id: "t1", item: "CEA", valeu: 4 }));
	await scheduler.tick();
	const entry = w.entries[0]!;
	assert.equal(data.query(entry.module, entry.components, "readings", {}, "test").rows.length, 1);
	assert.deepEqual(readdirSync(join(dir, "processed")), ["a-good.json"]);
	assert.deepEqual(readdirSync(join(dir, "rejected")).sort(), ["b-typo.json", "b-typo.json.error.txt"]);
	assert.match(readFileSync(join(dir, "rejected", "b-typo.json.error.txt"), "utf8"), /valeu/);
});

test("inbox：handler 这一次失败（比如断网）时文件留在 inbox，下一个点再试", async (t) => {
	const handler = counting(`\tif (input.items[0].fail) throw new Error("network down");\n\treturn { records: input.items };`);
	const w = world(t, { lab: { drop: { json: { title: "投递读数", connector: "inbox", handler: "index.ts", into: "readings" }, handler } } });
	const { scheduler } = w.make();
	const dir = join(w.state, "inbox", "lab", "drop");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "one.json"), JSON.stringify({ id: "r1", item: "CEA", fail: true }));
	await scheduler.tick();
	assert.deepEqual(readdirSync(dir), ["one.json"]);
	assert.ok(w.logged.some((line) => line.includes("network down")), w.logged.join("\n"));
});

test("inbox：一个 handler 一直失败的文件不挡住同一批后面的文件", async (t) => {
	const handler = `export default async (input) => { if (input.items[0].fail) throw new Error("network down"); return { records: input.items }; };\n`;
	const w = world(t, { lab: { drop: { json: { title: "投递读数", connector: "inbox", handler: "index.ts", into: "readings" }, handler } } });
	const { scheduler } = w.make();
	const dir = join(w.state, "inbox", "lab", "drop");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "a-stuck.json"), JSON.stringify({ id: "s1", item: "CEA", fail: true }));
	writeFileSync(join(dir, "b-good.json"), JSON.stringify({ id: "g1", item: "CEA", value: 3, at: "2026-11-03" }));
	await scheduler.tick();
	assert.deepEqual(readdirSync(join(dir, "processed")), ["b-good.json"]);
	assert.ok(existsSync(join(dir, "a-stuck.json")));
});

test("inbox：handler 对同一个文件连着失败 3 次，文件挪进 rejected，.error.txt 写着最后一次的原因", async (t) => {
	const handler = `export default async (input) => { throw new Error("network down " + input.items[0].id); };\n`;
	const w = world(t, { lab: { drop: { json: { title: "投递读数", connector: "inbox", handler: "index.ts", into: "readings" }, handler } } });
	const { scheduler } = w.make();
	const dir = join(w.state, "inbox", "lab", "drop");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "one.json"), JSON.stringify({ id: "r1", item: "CEA" }));
	await scheduler.tick();
	await scheduler.tick();
	assert.ok(existsSync(join(dir, "one.json")), "两次失败后还在 inbox");
	await scheduler.tick();
	assert.deepEqual(readdirSync(join(dir, "rejected")).sort(), ["one.json", "one.json.error.txt"]);
	assert.match(readFileSync(join(dir, "rejected", "one.json.error.txt"), "utf8"), /network down r1/);
});

test("inbox：handler 失败 2 次后成功，文件进 processed，不进 rejected", async (t) => {
	const handler = counting(`\tif (readFileSync("calls.txt", "utf8").trim().split("\\n").length < 3) throw new Error("network down");\n\treturn { records: input.items };`).replace("{ appendFileSync }", "{ appendFileSync, readFileSync }");
	const w = world(t, { lab: { drop: { json: { title: "投递读数", connector: "inbox", handler: "index.ts", into: "readings" }, handler } } });
	const { scheduler } = w.make();
	const dir = join(w.state, "inbox", "lab", "drop");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "one.json"), JSON.stringify({ id: "r1", item: "CEA", value: 3, at: "2026-11-03" }));
	for (let i = 0; i < 3; i++) await scheduler.tick();
	assert.equal(callsOf(w.root, "lab", "drop").length, 3);
	assert.deepEqual(readdirSync(join(dir, "processed")), ["one.json"]);
	assert.equal(existsSync(join(dir, "rejected")), false);
});

test("检查：timer 或不带连接器的 handler 没写 every 时拒收，一行说清楚", (t) => {
	const root = mkdtempSync(join(tmpdir(), "psa-scheduler-every-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const timer = writePackage(root, "timer", { tick: { json: { title: "到点", connector: "timer", notice: "到点了" } } });
	const pull = writePackage(root, "pull", { fetch: { json: { title: "取", handler: "index.ts", into: "readings" }, handler: "export default async () => ({});\n" } });
	for (const [dir, feed] of [[timer, "tick"], [pull, "fetch"]] as const) {
		const scan = scanPackage(dir);
		assert.equal(scan.ok, false, feed);
		assert.match(scan.ok ? "" : scan.problems.map(problemLine).join("\n"), new RegExp(`^feeds/${feed}/feed\\.json: .*"every"`, "m"));
	}
});

test("进度最后才存：存了行、交触发时崩了，下一次从原来的进度重跑，行和触发都不重复", async (t) => {
	const once = counting(`\tif (input.cursor === "c1") return {};\n\treturn { records: [{ id: "a", item: "CEA", value: 4, at: "2026-11-01" }], notices: [{ id: "n1", fields: {} }], cursor: "c1" };`);
	const w = world(t, { lab: { pull: { json: { title: "取读数", handler: "index.ts", every: "1m", into: "readings", notice: "新读数" }, handler: once } } });
	const entry = w.entries[0]!;
	const data = instanceData(w.state);
	let crash = true;
	const submit = (n: FeedNotice) => {
		if (crash) throw new Error("host went down");
		w.submitted.push(n);
	};
	const ports = { data, submit, alert: () => {}, problem: () => {}, secret: () => undefined, now: () => w.clock.now };
	assert.equal((await runFeed(entry, [], ports)).ok, false);
	crash = false;
	await runFeed(entry, [], ports);
	assert.equal(data.query(entry.module, entry.components, "readings", {}, "test").rows.length, 1);
	assert.deepEqual(w.submitted.map((n) => n.id), ["n1"]);
});

test("日志里的行数只算真存下的：同一批重跑一次写 0 行", async (t) => {
	const w = world(t, { lab: { pull: handlerFeed } });
	const { scheduler } = w.make();
	await scheduler.tick();
	w.clock.now += MINUTE;
	await scheduler.tick();
	assert.deepEqual(w.logged, ["[feeds] lab/pull：2 行，1 条触发", "[feeds] lab/pull：0 行，1 条触发"]);
});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const pidsIn = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
const SLOW_WRITER = `import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
export default async function () {
	const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
	appendFileSync("pids.txt", process.pid + "\\n" + sleeper.pid + "\\n");
	await new Promise((r) => setTimeout(r, 3000));
	mkdirSync(process.env.PSA_MODULE_DATA + "/files/ta", { recursive: true });
	writeFileSync(process.env.PSA_MODULE_DATA + "/files/ta/written-after", "x");
	return {};
}
`;
const slowFeed = { json: { title: "慢慢取", handler: "index.ts", every: "1m", into: "readings" }, handler: SLOW_WRITER };

test("模块关掉时正在跑的 feed 进程组被杀掉：跑到一半删掉的数据不会被它写回来", async (t) => {
	const w = world(t, { lab: { slow: slowFeed } });
	const { scheduler, data } = w.make();
	const pids = join(w.root, "modules", "lab", "feeds", "slow", "pids.txt");
	const first = scheduler.tick();
	await until(() => pidsIn(pids).length === 2, "feed 进程起来了");
	data.purge("lab" as ModuleName);
	w.switchOff();
	await scheduler.tick();
	await first;
	assert.deepEqual(pidsIn(pids).filter(alive), [], "feed 进程和它起的子进程都没了");
	assert.equal(existsSync(join(w.state, "modules-data", "lab")), false, "删掉的数据目录没有被写回");
});

test("宿主停下时正在跑的 feed 进程组被杀掉，不留孤儿", async (t) => {
	const modules = hostFeeds(t, { slow: slowFeed });
	const { host } = await hostWith(t, modules);
	const pids = join(modules.feeds()[0]!.dir, "feeds", "slow", "pids.txt");
	const ticked = host.feedScheduler.tick();
	await until(() => pidsIn(pids).length === 2, "feed 进程起来了");
	await host.stop();
	await until(() => pidsIn(pids).filter(alive).length === 0, "feed 进程和它起的子进程在宿主停下时就没了", 1500);
	await ticked;
});
