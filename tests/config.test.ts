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

test("modules 是以模块名为键、值为 true 或 false 的对象，默认为空", () => {
	assert.deepEqual(loadConfig(stateWith({})).moduleSwitches, {});
	assert.deepEqual(loadConfig(stateWith({ modules: { "toy-market": true, "us-market": false } })).moduleSwitches, { "toy-market": true, "us-market": false });
	for (const modules of [[], "toy-market", { "toy-market": "yes" }, null]) {
		assert.throws(() => loadConfig(stateWith({ modules })), (e: Error) => e.name === "ConfigError" && /config\.json.*modules/.test(e.message), JSON.stringify(modules));
	}
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

test("成员多久没有动静算无进展：默认 180 秒，可以改；必须在 30 秒和最长的派活时限之间", () => {
	assert.equal(loadConfig(stateWith({})).dispatchStallSeconds, 180);
	assert.equal(loadConfig(stateWith({ dispatchStallSeconds: 30 })).dispatchStallSeconds, 30);
	assert.equal(loadConfig(stateWith({ dispatchStallSeconds: 3600 })).dispatchStallSeconds, 3600);
	assert.equal(loadConfig(stateWith({ dispatchTimeoutSeconds: 60, dispatchCodingTimeoutSeconds: 600, dispatchStallSeconds: 600 })).dispatchStallSeconds, 600);
	for (const config of [{ dispatchStallSeconds: 29 }, { dispatchStallSeconds: 3601 }, { dispatchStallSeconds: "180" }, { dispatchStallSeconds: null }, { dispatchTimeoutSeconds: 60, dispatchCodingTimeoutSeconds: 600, dispatchStallSeconds: 601 }]) {
		assert.throws(() => loadConfig(stateWith(config)), (e: Error) => e.name === "ConfigError" && /dispatchStallSeconds（.*必须是 30 到 \d+ 之间的秒数/.test(e.message), JSON.stringify(config));
	}
	assert.equal(loadConfig(stateWith({ dispatchTimeoutSeconds: 60, dispatchCodingTimeoutSeconds: 90 })).dispatchStallSeconds, 90, "没写时不超过最长的时限");
});

test("两个派活时限都短于 30 秒时写了 dispatchStallSeconds：报错说清这时没有可写的值和怎么改，不说「30 到 20 之间」", () => {
	assert.throws(
		() => loadConfig(stateWith({ dispatchTimeoutSeconds: 20, dispatchCodingTimeoutSeconds: 20, dispatchStallSeconds: 30 })),
		(e: Error) => e.name === "ConfigError" && !/30 到 20/.test(e.message) && /dispatchStallSeconds（30）.*最长的派活时限现在是 20 秒.*不短于 30 秒.*去掉 dispatchStallSeconds/.test(e.message),
	);
	assert.equal(loadConfig(stateWith({ dispatchTimeoutSeconds: 20, dispatchCodingTimeoutSeconds: 20 })).dispatchStallSeconds, 20, "不写时照常启动");
});

test("两个派活时限不到 1 秒时拒绝启动", () => {
	for (const key of ["dispatchTimeoutSeconds", "dispatchCodingTimeoutSeconds"]) {
		assert.throws(() => loadConfig(stateWith({ [key]: 0.5 })), (e: Error) => e.name === "ConfigError" && e.message.includes(`${key}（0.5）`) && /不小于 1、不超过 3600/.test(e.message), key);
		assert.equal(loadConfig(stateWith({ [key]: 1 }))[key as "dispatchTimeoutSeconds"], 1);
	}
});

test("maxConcurrentExperts 不是 1 到 10 的整数、两个派活时限不是 1 到 3600 之间的数时拒绝启动，报错指出字段", () => {
	for (const value of [0, 11, 16, 1.5, "4", null]) {
		assert.throws(() => loadConfig(stateWith({ maxConcurrentExperts: value })), (e: Error) => e.name === "ConfigError" && /maxConcurrentExperts.*1 到 10 的整数/.test(e.message), JSON.stringify(value));
	}
	assert.equal(loadConfig(stateWith({ maxConcurrentExperts: 10 })).maxConcurrentExperts, 10);
	for (const key of ["dispatchTimeoutSeconds", "dispatchCodingTimeoutSeconds"]) {
		for (const value of [0, -1, 3601, "60", null]) {
			assert.throws(() => loadConfig(stateWith({ [key]: value })), (e: Error) => e.name === "ConfigError" && e.message.includes(`${key}（`) && /不超过 3600/.test(e.message), `${key} ${JSON.stringify(value)}`);
		}
	}
});

test("webHosts 缺省时是空的，网页只开在本机，webPort 默认值不变", () => {
	const config = loadConfig(stateWith({}));
	assert.deepEqual(config.webHosts, []);
	assert.equal(config.webPort, 4517);
});

test("webHosts 的名字读成小写，重复的只留一个，顺序不变", () => {
	const config = loadConfig(stateWith({ webHosts: ["PSA-Home.Example.TS.net", "laptop.example.ts.net", "psa-home.example.ts.net"] }));
	assert.deepEqual(config.webHosts, ["psa-home.example.ts.net", "laptop.example.ts.net"]);
});

test("webHosts 里不是 tailnet 机器名的项拒绝启动，报错只有一行，指出是第几项和原值", () => {
	const bad = ["psa-home.example.ts.net:443", "https://psa-home.example.ts.net", "psa-home.example.ts.net/x", "example.com", "100.101.102.103", "", "psa-home.example.ts.net.", "*.example.ts.net", 42];
	for (const item of bad) {
		assert.throws(
			() => loadConfig(stateWith({ webHosts: ["ok.example.ts.net", item] })),
			(e: Error) => e.name === "ConfigError" && e.message.includes("webHosts[1]") && e.message.includes(JSON.stringify(item)) && !e.message.includes("\n"),
			JSON.stringify(item),
		);
	}
	assert.throws(() => loadConfig(stateWith({ webHosts: "psa-home.example.ts.net" })), (e: Error) => e.name === "ConfigError" && /webHosts/.test(e.message));
});

test("webHosts 不为空时 webPort 不能是 0：tailscale serve 转发到固定端口", () => {
	assert.throws(() => loadConfig(stateWith({ webHosts: ["psa-home.example.ts.net"], webPort: 0 })), (e: Error) => e.name === "ConfigError" && /webHosts/.test(e.message) && /webPort/.test(e.message));
	assert.equal(loadConfig(stateWith({ webHosts: [], webPort: 0 })).webPort, 0);
});

test("成品目录默认是状态目录下的 output；相对路径按状态目录解析，绝对路径原样保留", () => {
	const dir = stateWith({});
	assert.equal(loadConfig(dir).outputDir, join(dir, "output"));
	const relative = stateWith({ outputDir: "made/by-workers" });
	assert.equal(loadConfig(relative).outputDir, join(relative, "made/by-workers"));
	const elsewhere = mkdtempSync(join(tmpdir(), "psa-made-"));
	assert.equal(loadConfig(stateWith({ outputDir: elsewhere })).outputDir, elsewhere);
});

test("outputDir 不是字符串、等于状态目录、是状态目录的上级、或在 workers/、sessions/ 下面时拒绝启动，报错以 config.json 开头", () => {
	const dir = mkdtempSync(join(tmpdir(), "psa-config-"));
	for (const outputDir of [42, ".", dir, "..", "workers/x", "sessions", "sessions/workers/out"]) {
		writeFileSync(join(dir, "config.json"), JSON.stringify({ outputDir }));
		assert.throws(() => loadConfig(dir), (e: Error) => e.name === "ConfigError" && e.message.startsWith(join(dir, "config.json")) && /outputDir/.test(e.message), JSON.stringify(outputDir));
	}
});

test("outputDir 以 ~ 开头时拒绝启动，报错说写绝对路径：配置里的 ~ 不展开", () => {
	for (const outputDir of ["~/out", "~"]) {
		assert.throws(() => loadConfig(stateWith({ outputDir })), (e: Error) => e.name === "ConfigError" && /outputDir/.test(e.message) && /绝对路径/.test(e.message) && e.message.includes(JSON.stringify(outputDir)), outputDir);
	}
	assert.equal(loadConfig(stateWith({ outputDir: "made~1" })).outputDir.endsWith("made~1"), true);
});

test("没写 telegram 段时 Telegram 客户端不运行；名单可以是空的（设置模式）", () => {
	assert.equal(loadConfig(stateWith({})).telegram, undefined);
	assert.deepEqual(loadConfig(stateWith({ telegram: { allowedUserIds: [] } })).telegram, { allowedUserIds: [] });
	assert.deepEqual(loadConfig(stateWith({ telegram: { allowedUserIds: [987654321, 42] } })).telegram, { allowedUserIds: [987654321, 42] });
});

test("telegram 段写错时拒绝启动，报错指出字段；群和频道的负数 id 不收", () => {
	const bad = [null, [], "x", {}, { allowedUserIds: "42" }, { allowedUserIds: [42], extra: 1 }, { allowedUserIds: [-100123] }, { allowedUserIds: [0] }, { allowedUserIds: [1.5] }, { allowedUserIds: ["42"] }, { allowedUserIds: [42, 42] }, { allowedUserIds: [2 ** 53] }];
	for (const telegram of bad) {
		assert.throws(() => loadConfig(stateWith({ telegram })), (e: Error) => e.name === "ConfigError" && /telegram/.test(e.message), JSON.stringify(telegram));
	}
	assert.throws(() => loadConfig(stateWith({ telegram: { allowedUserIds: [42, 42] } })), /telegram\.allowedUserIds/);
});

test("telegram 段写错时报错只点出字段名，不回显段里的值：误写进去的 token 不会出现在报错里", () => {
	const token = "987654321:AAH-real_looking_secret_token_abcdefg";
	const secret = token.split(":")[1];
	const cases: [unknown, RegExp][] = [
		[{ allowedUserIds: [42], botToken: token }, /botToken/],
		[{ allowedUserIds: [42], [token]: true }, /telegram/],
		[{ allowedUserIds: [token] }, /telegram\.allowedUserIds/],
		[{ allowedUserIds: token }, /telegram\.allowedUserIds/],
		[token, /telegram/],
	];
	for (const [telegram, names] of cases) {
		assert.throws(() => loadConfig(stateWith({ telegram })), (e: Error) => {
			assert.equal(e.name, "ConfigError");
			assert.match(e.message, names);
			assert.ok(!e.message.includes(secret), e.message);
			return true;
		});
	}
});

test("feedFixtures 默认关；just module try 写 true 时预演用 fixtures 代替连接器", () => {
	assert.equal(loadConfig(stateWith({})).feedFixtures, false);
	assert.equal(loadConfig(stateWith({ feedFixtures: true })).feedFixtures, true);
});

test("OCR 默认用 macOS 的 Vision，最多读 20 页、60 秒；engine 可以写 off 关掉", () => {
	assert.deepEqual(loadConfig(stateWith({})).ocr, { engine: "vision", maxPages: 20, timeoutSeconds: 60 });
	assert.deepEqual(loadConfig(stateWith({ ocr: { engine: "off" } })).ocr, { engine: "off" });
	assert.deepEqual(loadConfig(stateWith({ ocr: { maxPages: 5, timeoutSeconds: 30 } })).ocr, { engine: "vision", maxPages: 5, timeoutSeconds: 30 });
});

test("OCR 用 unlimited 要写 unlimitedHome，那里要有模型和 .venv，宿主要是 Apple Silicon；默认时限 900 秒", () => {
	const home = mkdtempSync(join(tmpdir(), "psa-unlimited-home-"));
	const ocrOf = (ocr: object) => () => loadConfig(stateWith({ ocr })).ocr;
	assert.throws(ocrOf({ engine: "unlimited" }), (e: Error) => e.name === "ConfigError" && /ocr\.unlimitedHome/.test(e.message));
	assert.throws(ocrOf({ engine: "unlimited", unlimitedHome: home }), (e: Error) => e.name === "ConfigError" && /models\/unlimited_ocr_official/.test(e.message));
	mkdirSync(join(home, "models/unlimited_ocr_official"), { recursive: true });
	mkdirSync(join(home, ".venv/bin"), { recursive: true });
	writeFileSync(join(home, ".venv/bin/python"), "");
	if (process.arch === "arm64") assert.deepEqual(ocrOf({ engine: "unlimited", unlimitedHome: home })(), { engine: "unlimited", home, maxPages: 20, timeoutSeconds: 900 });
	else assert.throws(ocrOf({ engine: "unlimited", unlimitedHome: home }), /Apple Silicon/);
});

test("OCR 的 engine、页数和秒数不对时拒绝启动，报错指出是哪一项", () => {
	for (const [ocr, key] of [[{ engine: "tesseract" }, "ocr.engine"], [{ maxPages: 0 }, "ocr.maxPages"], [{ maxPages: 1.5 }, "ocr.maxPages"], [{ timeoutSeconds: 0 }, "ocr.timeoutSeconds"], ["vision", "ocr"]] as const) {
		assert.throws(() => loadConfig(stateWith({ ocr })), (e: Error) => e.name === "ConfigError" && e.message.includes(key), JSON.stringify(ocr));
	}
});
