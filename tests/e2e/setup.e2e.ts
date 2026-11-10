import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeModel, on, parseSabotage, worker } from "./fake-model.ts";
import { fakeModels, groupAlive, stopGroup, story, teardown, writeConfig } from "./harness.ts";

test("writeConfig 拒绝按量计费的提供方", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-e2e-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.throws(() => writeConfig(dir, { ...fakeModels, fallback: "deepseek/deepseek-flash" }), /按量计费/);
	assert.throws(() => writeConfig(dir, { ...fakeModels, router: "anthropic/x" }), /anthropic/);
	assert.doesNotThrow(() => writeConfig(dir, fakeModels));
});

test("两个 Worker 脚本用同一个 brief 时假模型拒绝启动", async () => {
	const step = on("汇报", /^\[任务说明\]/, () => "好。");
	await assert.rejects(FakeModel.start({ router: [], workers: [worker("同一个", step), worker("同一个", step)] }, ""), /同一个 brief/);
});

test("PSA_E2E_SABOTAGE 只把最后的 :crash 当模式", () => {
	assert.deepEqual(parseSabotage("Worker 汇报:crash"), { label: "Worker 汇报", crash: true });
	assert.deepEqual(parseSabotage("步骤: 带冒号:crash"), { label: "步骤: 带冒号", crash: true });
	assert.deepEqual(parseSabotage("步骤: 带冒号"), { label: "步骤: 带冒号", crash: false });
	assert.equal(parseSabotage(""), undefined);
});

test("收尾的某一步卡住时按时限放弃，后面的步骤照常执行，并报告卡住的那一步", async () => {
	const ran: string[] = [];
	const started = Date.now();
	const problems = await teardown([
		["关闭页面", () => new Promise(() => {})],
		["停宿主", () => { ran.push("停宿主"); }],
		["关假模型", async () => { ran.push("关假模型"); throw new Error("端口已关"); }],
	], 200);
	assert.deepEqual(ran, ["停宿主", "关假模型"]);
	assert.ok(Date.now() - started < 2_000);
	assert.deepEqual(problems, ["关闭页面：200 ms 内没有完成", "关假模型：端口已关"]);
});

test("故事在准备阶段出错（假模型拒绝启动）时，不留下临时目录", async (t) => {
	const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("psa-e2e-")));
	const step = on("汇报", /^\[任务说明\]/, () => "好。");
	await assert.rejects(story(t, { router: [], workers: [worker("同一个", step), worker("同一个", step)] }, async () => {}), /同一个 brief/);
	const leaked = readdirSync(tmpdir()).filter((n) => n.startsWith("psa-e2e-") && !before.has(n));
	assert.deepEqual(leaked, []);
});

test("对进程组发信号得到 EPERM（macOS 上只剩僵尸进程，或组号已被别的用户复用）时，按已不在处理，不抛错也不再发信号", async (t) => {
	const calls: [number, string | number][] = [];
	t.mock.method(process, "kill", (pid: number, signal: string | number) => {
		calls.push([pid, signal]);
		throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
	});
	assert.equal(groupAlive(424242), false);
	assert.equal(await stopGroup(424242), true);
	assert.ok(!calls.some(([, s]) => s === "SIGKILL"), "EPERM 的组不再升级成 SIGKILL");
});
