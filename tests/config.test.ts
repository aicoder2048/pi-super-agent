import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
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
	mkdirSync(join(dir, "secrets"));
	writeFileSync(join(dir, "secrets/market.env"), "");
	const config = loadConfig(dir);
	assert.equal(config.secretsFile, join(dir, "secrets/market.env"));
	assert.deepEqual(config.sources, { "us-market": { watchlist: ["AMD"] } });
	assert.deepEqual([loadConfig(stateWith({})).secretsFile, loadConfig(stateWith({})).sources], [undefined, {}]);
});

test("secretsFile 指向不存在的文件、不是字符串，或 sources 不是对象时拒绝启动，报错指出字段", () => {
	const bad: [object, RegExp][] = [
		[{ secretsFile: "missing.env" }, /secretsFile.*missing\.env/],
		[{ secretsFile: 42 }, /secretsFile/],
		[{ sources: ["us-market"] }, /sources/],
		[{ sources: "us-market" }, /sources/],
	];
	for (const [raw, field] of bad) {
		assert.throws(() => loadConfig(stateWith(raw)), (e: Error) => e.name === "ConfigError" && field.test(e.message), JSON.stringify(raw));
	}
});

test("久无进展的阈值只有 watchdog.stuckMinutes 一个设置，内核的 stuckMs 由它换算", () => {
	assert.equal(loadConfig(stateWith({})).kernel.stuckMs, 30 * 60_000);
	assert.equal(loadConfig(stateWith({ watchdog: { stuckMinutes: 5 }, kernel: { maxWorkers: 2 } })).kernel.stuckMs, 5 * 60_000);
	assert.equal(loadConfig(stateWith({ watchdog: { stuckMinutes: 0.5 } })).kernel.stuckMs, 30_000);
	assert.equal(loadConfig(stateWith({ kernel: { maxWorkers: 2 } })).kernel.maxWorkers, 2);
});

test("watchdog.stuckMinutes 不是 0 到 1440 之间的正数时拒绝启动，报错指出字段", () => {
	for (const stuckMinutes of [0, -5, null, "abc", "30", 50_000, Number.NaN, 1441]) {
		assert.throws(() => loadConfig(stateWith({ watchdog: { stuckMinutes } })), (e: Error) => e.name === "ConfigError" && /watchdog\.stuckMinutes/.test(e.message), JSON.stringify(stuckMinutes));
	}
});

test("config 里手写 kernel.stuckMs 时拒绝启动，指向 watchdog.stuckMinutes，免得两处设置一处被悄悄覆盖", () => {
	assert.throws(() => loadConfig(stateWith({ kernel: { stuckMs: 1 } })), (e: Error) => e.name === "ConfigError" && /kernel\.stuckMs/.test(e.message) && /watchdog\.stuckMinutes/.test(e.message));
});

test("状态目录不存在时建成 0700，只有自己能进；已有的目录权限不动", () => {
	const fresh = join(mkdtempSync(join(tmpdir(), "psa-config-")), "state");
	loadConfig(fresh);
	assert.equal(statSync(fresh).mode & 0o777, 0o700);
	const chosen = join(mkdtempSync(join(tmpdir(), "psa-config-")), "chosen");
	mkdirSync(chosen, { mode: 0o755 });
	loadConfig(chosen);
	assert.equal(statSync(chosen).mode & 0o777, 0o755);
});

test("派活的设置有默认值：同时运行的成员最多 4 位，不写代码的成员限时 15 分钟，能写代码的 60 分钟；config.json 可以改", () => {
	const defaults = loadConfig(stateWith({}));
	assert.equal(defaults.maxConcurrentExperts, 4);
	assert.equal(defaults.dispatchTimeoutSeconds, 900);
	assert.equal(defaults.dispatchCodingTimeoutSeconds, 3600);
	const set = loadConfig(stateWith({ maxConcurrentExperts: 2, dispatchTimeoutSeconds: 60, dispatchCodingTimeoutSeconds: 600 }));
	assert.deepEqual([set.maxConcurrentExperts, set.dispatchTimeoutSeconds, set.dispatchCodingTimeoutSeconds], [2, 60, 600]);
	assert.equal(loadConfig(stateWith({ dispatchTimeoutSeconds: 3600 })).dispatchTimeoutSeconds, 3600, "两个时限最长都是 60 分钟");
});

test("maxConcurrentExperts 不是 1 到 16 的整数、两个派活时限不是 0 到 3600 之间的正数时拒绝启动，报错指出字段", () => {
	for (const value of [0, 17, 1.5, "4", null]) {
		assert.throws(() => loadConfig(stateWith({ maxConcurrentExperts: value })), (e: Error) => e.name === "ConfigError" && /maxConcurrentExperts/.test(e.message), JSON.stringify(value));
	}
	for (const key of ["dispatchTimeoutSeconds", "dispatchCodingTimeoutSeconds"]) {
		for (const value of [0, -1, 3601, "60", null]) {
			assert.throws(() => loadConfig(stateWith({ [key]: value })), (e: Error) => e.name === "ConfigError" && e.message.includes(`${key}（`) && /不超过 3600/.test(e.message), `${key} ${JSON.stringify(value)}`);
		}
	}
});
