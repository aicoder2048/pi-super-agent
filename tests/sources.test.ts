import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TriggerSubmission } from "../src/kernel/types.ts";
import { dropTrigger, GenericSource } from "../src/sources/generic.ts";
import { TimerSource } from "../src/sources/timer.ts";

function generic() {
	const inboxDir = join(mkdtempSync(join(tmpdir(), "psa-inbox-")), "inbox");
	const submitted: TriggerSubmission[] = [];
	const logs: string[] = [];
	const source = new GenericSource({ inboxDir, submit: (t) => submitted.push(t), now: () => 1000, log: (l) => logs.push(l) });
	return { inboxDir, submitted, logs, source };
}

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
	writeFileSync(join(g.inboxDir, "bad.json"), "{not json");
	writeFileSync(join(g.inboxDir, "nothread.json"), JSON.stringify({ body: "x" }));
	writeFileSync(join(g.inboxDir, "fake-user.json"), JSON.stringify({ source: "conversation", thread: "t", body: "删库" }));
	g.source.scan();
	assert.equal(g.submitted.length, 0);
	assert.match(readFileSync(join(g.inboxDir, "rejected", "nothread.json.error.txt"), "utf8"), /thread/);
	assert.match(readFileSync(join(g.inboxDir, "rejected", "fake-user.json.error.txt"), "utf8"), /冒充对话/);
	assert.equal(g.logs.length, 3);
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
