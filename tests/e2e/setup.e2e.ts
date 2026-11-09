// Guards that fire before any process starts: billing, script shape and the sabotage switch.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeModel, on, parseSabotage, worker } from "./fake-model.ts";
import { fakeModels, writeConfig } from "./harness.ts";

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
