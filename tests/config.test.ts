import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/host/config.ts";

function stateWith(config: object) {
	const dir = mkdtempSync(join(tmpdir(), "psa-config-"));
	writeFileSync(join(dir, "config.json"), JSON.stringify(config));
	return dir;
}

test("心跳间隔和过期阈值有默认值：30 秒心跳，120 秒过期", () => {
	const config = loadConfig(stateWith({}));
	assert.equal(config.heartbeatSeconds, 30);
	assert.equal(config.watchdog.staleSeconds, 120);
});

test("过期阈值不大于心跳间隔的两倍时拒绝启动，免得 Watchdog 反复重启健康的宿主", () => {
	assert.throws(() => loadConfig(stateWith({ heartbeatSeconds: 30, watchdog: { staleSeconds: 10 } })), /staleSeconds/);
	assert.throws(() => loadConfig(stateWith({ heartbeatSeconds: 30, watchdog: { staleSeconds: 60 } })), /staleSeconds/);
	assert.equal(loadConfig(stateWith({ heartbeatSeconds: 30, watchdog: { staleSeconds: 61 } })).watchdog.staleSeconds, 61);
});
