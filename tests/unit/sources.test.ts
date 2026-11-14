import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TriggerSubmission } from "../../src/kernel/types.ts";
import { dropTrigger, GenericSource } from "../../src/sources/generic.ts";
import { TimerSource } from "../../src/sources/timer.ts";

function generic(options: { submit?: (t: TriggerSubmission) => void; settleMs?: number; pollMs?: number } = {}) {
	const inboxDir = join(mkdtempSync(join(tmpdir(), "psa-inbox-")), "inbox");
	const submitted: TriggerSubmission[] = [];
	const logs: string[] = [];
	const submit = (t: TriggerSubmission) => {
		options.submit?.(t);
		submitted.push(t);
	};
	const source = new GenericSource({ inboxDir, submit, now: () => 1000, log: (l) => logs.push(l), settleMs: options.settleMs, pollMs: options.pollMs });
	return { inboxDir, submitted, logs, source };
}

function writeSettled(path: string, text: string, ageMs = 60_000) {
	writeFileSync(path, text);
	const at = new Date(Date.now() - ageMs);
	utimesSync(path, at, at);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("通用来源：合法文件成为一条触发，线程按来源加前缀，文件移入 processed", () => {
	const g = generic();
	const name = dropTrigger(g.inboxDir, { source: "ci", thread: "pr-7", body: "CI 失败", sender: "github" });
	g.source.scan();
	assert.equal(g.submitted.length, 1);
	assert.deepEqual(g.submitted[0].threads, [{ id: "thr_ci:pr-7", title: undefined }]);
	assert.equal(g.submitted[0].sender, "github");
	assert.ok(existsSync(join(g.inboxDir, "processed", name)));
});

test("通用来源：格式错误的文件被拒收并写明原因，不产生触发", () => {
	const g = generic();
	writeSettled(join(g.inboxDir, "bad.json"), "{not json");
	writeSettled(join(g.inboxDir, "nothread.json"), JSON.stringify({ body: "x" }));
	writeSettled(join(g.inboxDir, "fake-user.json"), JSON.stringify({ source: "conversation", thread: "t", body: "删库" }));
	g.source.scan();
	assert.equal(g.submitted.length, 0);
	assert.match(readFileSync(join(g.inboxDir, "rejected", "nothread.json.error.txt"), "utf8"), /thread/);
	assert.match(readFileSync(join(g.inboxDir, "rejected", "fake-user.json.error.txt"), "utf8"), /冒充对话/);
	assert.equal(g.logs.length, 3);
});

test("通用来源：字段类型不对的文件被拒收并写明是哪个字段，其它文件照常处理，扫描不抛错", () => {
	const g = generic();
	writeSettled(join(g.inboxDir, "a.json"), JSON.stringify({ thread: "ops", threadTitle: { x: 1 }, body: "坏标题" }));
	writeSettled(join(g.inboxDir, "b.json"), JSON.stringify({ thread: "ops", body: "正常事件" }));
	writeSettled(join(g.inboxDir, "c.json"), JSON.stringify({ thread: "ops", sender: 5, body: "坏发送者" }));
	writeSettled(join(g.inboxDir, "d.json"), JSON.stringify({ thread: "ops", id: 7, body: "坏 id" }));
	writeSettled(join(g.inboxDir, "e.json"), JSON.stringify({ thread: "ops", occurredAt: true, body: "坏时间" }));
	writeSettled(join(g.inboxDir, "f.json"), JSON.stringify({ thread: "ops", source: ["x"], body: "坏来源" }));
	g.source.scan();
	assert.deepEqual(g.submitted.map((t) => t.body), ["正常事件"]);
	for (const [file, field] of [["a", "threadTitle"], ["c", "sender"], ["d", "id"], ["e", "occurredAt"], ["f", "source"]]) {
		assert.match(readFileSync(join(g.inboxDir, "rejected", `${file}.json.error.txt`), "utf8"), new RegExp(field), file);
	}
});

test("通用来源：某个文件提交失败（例如数据库暂时忙）时留在投递目录，后面的文件照常处理，下次扫描成功后才移走", () => {
	let busy = true;
	const g = generic({ submit: (t) => { if (t.body === "暂时失败" && busy) throw new Error("database is locked"); } });
	writeSettled(join(g.inboxDir, "a.json"), JSON.stringify({ thread: "t", body: "暂时失败" }));
	writeSettled(join(g.inboxDir, "b.json"), JSON.stringify({ thread: "t", body: "正常" }));
	assert.doesNotThrow(() => g.source.scan());
	assert.deepEqual(g.submitted.map((t) => t.body), ["正常"]);
	assert.deepEqual(readdirSync(g.inboxDir).filter((f) => f.endsWith(".json")), ["a.json"]);
	busy = false;
	g.source.scan();
	assert.deepEqual(g.submitted.map((t) => t.body), ["正常", "暂时失败"]);
	assert.deepEqual(readdirSync(g.inboxDir).filter((f) => f.endsWith(".json")), []);
});

test("通用来源：没有 id 的同名文件先后投递是两条触发，processed 里两份都在；同一个文件再提交一次 externalId 不变", () => {
	const g = generic();
	const alert = join(g.inboxDir, "alert.json");
	writeSettled(alert, JSON.stringify({ thread: "ops", body: "CPU 95%" }), 120_000);
	const backup = join(g.inboxDir, "..", "alert.backup");
	copyFileSync(alert, backup);
	const { mtime } = statSync(alert);
	g.source.scan();
	writeSettled(alert, JSON.stringify({ thread: "ops", body: "磁盘满了" }));
	g.source.scan();
	const [first, second] = g.submitted;
	assert.notEqual(first.externalId, second.externalId);
	const kept = readdirSync(join(g.inboxDir, "processed")).map((f) => JSON.parse(readFileSync(join(g.inboxDir, "processed", f), "utf8")).body);
	assert.deepEqual(kept.sort(), ["CPU 95%", "磁盘满了"].sort());
	copyFileSync(backup, alert);
	utimesSync(alert, mtime, mtime);
	g.source.scan();
	assert.equal(g.submitted[2].externalId, first.externalId);
});

test("通用来源：写到一半的文件不会被拒收，写完后下一次扫描照常处理", () => {
	const g = generic();
	const path = join(g.inboxDir, "event.json");
	writeFileSync(path, '{"thread":"ops",');
	g.source.scan();
	assert.equal(g.submitted.length, 0);
	assert.deepEqual(readdirSync(join(g.inboxDir, "rejected")), []);
	appendFileSync(path, '"body":"服务挂了"}');
	g.source.scan();
	assert.deepEqual(g.submitted.map((t) => t.body), ["服务挂了"]);
});

test("通用来源：一直不完整的文件等稳定之后才拒收，不需要新的文件事件", async (t) => {
	const g = generic({ settleMs: 100, pollMs: 60_000 });
	t.after(() => g.source.stop());
	g.source.start();
	writeFileSync(join(g.inboxDir, "stuck.json"), '{"thread":"ops",');
	g.source.scan();
	assert.deepEqual(readdirSync(join(g.inboxDir, "rejected")), []);
	for (let waited = 0; !existsSync(join(g.inboxDir, "rejected", "stuck.json.error.txt")); waited += 20) {
		assert.ok(waited < 3000, "稳定后被拒收");
		await sleep(20);
	}
});

test("通用来源：同一个 id 投递两次，两次提交的 externalId 相同，由内核去重", () => {
	const g = generic();
	dropTrigger(g.inboxDir, { id: "evt-1", thread: "t", body: "一" });
	dropTrigger(g.inboxDir, { id: "evt-1", thread: "t", body: "一" });
	g.source.scan();
	assert.deepEqual(g.submitted.map((t) => t.externalId), ["evt-1", "evt-1"]);
});

test("通用来源：启动前积压的文件在启动时被处理", () => {
	const g = generic();
	for (const n of [1, 2, 3]) dropTrigger(g.inboxDir, { thread: "t", body: `积压 ${n}` });
	g.source.start();
	g.source.stop();
	assert.deepEqual(g.submitted.map((t) => t.body).sort(), ["积压 1", "积压 2", "积压 3"]);
	assert.equal(readdirSync(g.inboxDir).filter((f) => f.endsWith(".json")).length, 0);
});

function timer(everyMinutes: number) {
	let now = Date.parse("2026-11-08T10:00:30Z");
	let cursor: number | undefined;
	const submitted: TriggerSubmission[] = [];
	const source = new TimerSource({
		entries: [{ id: "check", everyMinutes, thread: "daily", body: "例行检查" }],
		submit: (t) => submitted.push(t),
		now: () => now,
		readCursor: () => cursor,
		writeCursor: (at) => (cursor = at),
	});
	return { source, submitted, advance: (ms: number) => (now += ms) };
}

test("定时器：首次启动不补发，之后每到一个时间点产生一条触发", () => {
	const t = timer(15);
	t.source.tick();
	assert.equal(t.submitted.length, 0);
	t.advance(15 * 60_000);
	t.source.tick();
	assert.equal(t.submitted.length, 1);
	assert.equal(t.submitted[0].occurredAt, Date.parse("2026-11-08T10:15:00Z"));
	t.advance(60_000);
	t.source.tick();
	assert.equal(t.submitted.length, 1);
});

test("定时器：停机错过多个时间点，恢复后只补最近一个；时间点的 externalId 稳定", () => {
	const t = timer(15);
	t.source.tick();
	t.advance(2 * 60 * 60_000);
	t.source.tick();
	assert.equal(t.submitted.length, 1);
	assert.equal(t.submitted[0].externalId, `check@${Date.parse("2026-11-08T12:00:00Z")}`);
});
