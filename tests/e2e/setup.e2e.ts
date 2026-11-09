import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeModel, on, parseSabotage, worker } from "./fake-model.ts";
import { fakeModels, teardown, writeConfig } from "./harness.ts";

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
