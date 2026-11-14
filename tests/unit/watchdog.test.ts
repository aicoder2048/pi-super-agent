import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { errorLine, Watchdog } from "../../src/watchdog/watchdog.ts";

const at = "2026-11-14T03:00:00.000Z";

test("host.log 里宿主崩溃的输出排在 Telegram 取消息失败之前：报崩溃那行", () => {
	const log = [
		`${at} [host] 已启动，状态目录 /state`,
		"file:///repo/src/host/host.ts:40",
		"Error: SQLITE_CANTOPEN: unable to open database file",
		"    at Host.start (file:///repo/src/host/host.ts:40:9)",
		`${at} [telegram] 取消息失败（connect EHOSTUNREACH api.telegram.org unreachable），30 秒后重试`,
		"Node.js v24.11.0",
	].join("\n");
	assert.equal(errorLine(log), "Error: SQLITE_CANTOPEN: unable to open database file");
});

test("带属性的错误（node:sqlite 打不开库）：报 Error 那行，不报 code 或收尾的大括号", () => {
	const log = [
		`${at} [host] 已启动，状态目录 /state`,
		"file:///repo/src/host/host.ts:3",
		'new DatabaseSync("/state/psa.db");',
		"^",
		"",
		"Error: unable to open database file",
		"    at file:///repo/src/host/host.ts:3:1",
		"    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5) {",
		"  code: 'ERR_SQLITE_ERROR',",
		"  errcode: 14,",
		"  errstr: 'unable to open database file'",
		"}",
		"",
		"Node.js v24.11.0",
	].join("\n");
	assert.equal(errorLine(log), "Error: unable to open database file");
});

test("没捕获的错误带着自己的属性：报 Error 那行", () => {
	const log = [
		`${at} [router] Error: boom`,
		"    at file:///repo/src/router.ts:1:11 {",
		"  code: 'ERR_BOOM',",
		"  detail: { a: 1 }",
		"}",
		"node:internal/modules/run_main:107",
		"    triggerUncaughtException(",
		"    ^",
		"",
		"Error: boom",
		"    at file:///repo/src/router.ts:1:11 {",
		"  code: 'ERR_BOOM',",
		"  detail: { a: 1 }",
		"}",
		"",
		"Node.js v24.11.0",
	].join("\n");
	assert.equal(errorLine(log), "Error: boom");
});

test("没有崩溃输出时报宿主自己的错误行（去掉时间戳），不报别的部件的失败", () => {
	const log = [
		`${at} [host] OCR（vision）没准备好，扫描件和图片会读不出：swift 失败`,
		`${at} [telegram] 取消息失败（fetch failed unreachable），30 秒后重试`,
	].join("\n");
	assert.equal(errorLine(log), `[host] OCR（vision）没准备好，扫描件和图片会读不出：swift 失败`);
});

test("只有别的部件的失败行时不猜原因", () => {
	const log = [`${at} [host] 已启动，状态目录 /state`, `${at} [telegram] 取消息失败（fetch failed unreachable），30 秒后重试`].join("\n");
	assert.equal(errorLine(log), undefined);
});

test("配置错误没有时间戳也没有 error 字样：照样报出来", () => {
	assert.equal(errorLine("/state/config.json：modules.toy-market 不是已发现的模块\n"), "/state/config.json：modules.toy-market 不是已发现的模块");
});

test("outage.json 写不进去：照样拉起宿主、照样发 ⚠️，写失败记进日志", () => {
	const MIN = 60_000;
	const stateDir = mkdtempSync(join(tmpdir(), "psa-wd-"));
	mkdirSync(join(stateDir, "outage.json"));
	writeFileSync(join(stateDir, "outage.json", "x"), "");
	const now = { t: 100 * MIN };
	const told: string[] = [];
	const logs: string[] = [];
	let starts = 0;
	const wd = new Watchdog({
		stateDir,
		clock: { now: () => now.t },
		config: { heartbeatStaleMs: 2 * MIN, restartGraceMs: 3 * MIN },
		startHost: () => starts++,
		tell: (text) => told.push(text),
		log: (line) => logs.push(line),
	});
	for (let i = 0; i < 4; i++) {
		wd.checkOnce();
		now.t += 3 * MIN;
	}
	assert.equal(starts, 4, "每次都拉起");
	assert.match(told.join("\n"), /宿主连续 3 次启动失败/);
	assert.ok(logs.some((l) => l.includes("outage.json")), logs.join("\n"));
});
