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

test("网页端口默认 4517，config.json 可以改，0 表示任意空闲端口", () => {
	assert.equal(loadConfig(stateWith({})).webPort, 4517);
	assert.equal(loadConfig(stateWith({ webPort: 4600 })).webPort, 4600);
	assert.equal(loadConfig(stateWith({ webPort: 0 })).webPort, 0);
});

test("网页端口不是 0 到 65535 的整数时拒绝启动，报错指出 webPort", () => {
	for (const webPort of [-1, 65536, 1.5, "4517"]) {
		assert.throws(() => loadConfig(stateWith({ webPort })), (e: Error) => e.name === "ConfigError" && /webPort/.test(e.message), JSON.stringify(webPort));
	}
});

test("secretsFile 按状态目录解析成绝对路径；sources 原样交给各自的来源", () => {
	const dir = stateWith({ secretsFile: "secrets/market.env", sources: { "us-market": { watchlist: ["AMD"] } } });
	const config = loadConfig(dir);
	assert.equal(config.secretsFile, join(dir, "secrets/market.env"));
	assert.deepEqual(config.sources, { "us-market": { watchlist: ["AMD"] } });
	assert.deepEqual([loadConfig(stateWith({})).secretsFile, loadConfig(stateWith({})).sources], [undefined, {}]);
});
