import assert from "node:assert/strict";
import test from "node:test";
import { errorLine } from "../../src/watchdog/watchdog.ts";

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
