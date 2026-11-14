import assert from "node:assert/strict";
import test from "node:test";
import { causeOf, clearedText, Health, scrub, type Alarm } from "../../src/host/health.ts";

function board(start = 1_000) {
	let now = start;
	const raised: Alarm[] = [];
	const cleared: Alarm[] = [];
	const health = new Health({ now: () => now, onRaised: (a) => raised.push(a), onCleared: (a) => cleared.push(a), recentMax: 2 });
	return { health, raised, cleared, tick: (ms: number) => (now += ms) };
}

const failure = (error: string, after = 3) => ({ area: "data" as const, subject: "stock-ta 报价", error, after });

test("连续失败到阈值才拉响，之前的失败不出现在横幅上", () => {
	const { health, raised } = board();
	health.failed("data:quotes", failure("HTTP 503"));
	health.failed("data:quotes", failure("HTTP 503"));
	assert.deepEqual(health.board().active, []);
	assert.equal(raised.length, 0);
	health.failed("data:quotes", failure("HTTP 502 bad gateway"));
	const [alarm] = health.board().active;
	assert.equal(alarm.id, "data:quotes");
	assert.equal(alarm.count, 3);
	assert.equal(alarm.since, 1_000);
	assert.equal(alarm.lastError, "HTTP 502 bad gateway");
	assert.equal(raised.length, 1);
});

test("拉响后再失败只更新次数和最近的错误，不再通知", () => {
	const { health, raised, tick } = board();
	health.failed("model:router", { ...failure("HTTP 401 unauthorized", 1), area: "model", subject: "幕僚长模型" });
	tick(5_000);
	health.failed("model:router", { ...failure("HTTP 403 forbidden", 1), area: "model", subject: "幕僚长模型" });
	assert.equal(raised.length, 1);
	const [alarm] = health.board().active;
	assert.equal(alarm.count, 2);
	assert.equal(alarm.lastAt, 6_000);
	assert.equal(alarm.lastError, "HTTP 403 forbidden");
});

test("一次成功就解除：通知一次，进最近恢复；没拉响过的失败被成功清零，不通知", () => {
	const { health, cleared, tick } = board();
	health.failed("a", failure("x"));
	health.ok("a");
	health.failed("a", failure("x"));
	health.failed("a", failure("x"));
	assert.deepEqual(health.board().active, [], "清零后重新计数");
	health.failed("a", failure("x"));
	tick(60_000);
	health.ok("a");
	health.ok("a");
	assert.equal(cleared.length, 1);
	assert.deepEqual(health.board().active, []);
	const [recent] = health.board().recent;
	assert.equal(recent.id, "a");
	assert.equal(recent.clearedAt, 61_000);
});

test("最近恢复只留 recentMax 条，新的在前", () => {
	const { health } = board();
	for (const id of ["a", "b", "c"]) {
		health.failed(id, failure("x", 1));
		health.ok(id);
	}
	assert.deepEqual(health.board().recent.map((a) => a.id), ["c", "b"]);
});

test("模型和数据都因联网错误断了：提示本机可能断网；只有一边断不提示", () => {
	const { health } = board();
	health.failed("data:quotes", failure("fetch failed: getaddrinfo ENOTFOUND api.example.com", 1));
	assert.equal(health.board().offline, false);
	health.failed("model:router", { area: "model", subject: "幕僚长模型", error: "Connection error: ECONNREFUSED", after: 1 });
	assert.equal(health.board().offline, true);
	health.ok("data:quotes");
	assert.equal(health.board().offline, false);
});

test("错误分类：鉴权、额度限流、联网、服务方", () => {
	assert.equal(causeOf("401 Unauthorized"), "auth");
	assert.equal(causeOf("HTTP 403 forbidden"), "auth");
	assert.equal(causeOf("invalid_grant: Token has been expired or revoked"), "auth");
	assert.equal(causeOf("429 Too Many Requests"), "quota");
	assert.equal(causeOf("You exceeded your current quota"), "quota");
	assert.equal(causeOf("fetch failed"), "network");
	assert.equal(causeOf("connect ETIMEDOUT 1.2.3.4:443"), "network");
	assert.equal(causeOf("500 Internal Server Error"), "provider");
	assert.equal(causeOf("529 overloaded_error"), "provider");
});

test("错误文字去掉密钥、换成一行、截短", () => {
	const text = scrub("GET https://api.example.com/v2/x?apiKey=abc123secret&symbols=NVDA failed\nBearer sk-live-0123456789abcdef");
	assert.ok(!text.includes("abc123secret"));
	assert.ok(!text.includes("0123456789abcdef"));
	assert.ok(!text.includes("\n"));
	assert.ok(scrub("x".repeat(500)).length <= 200);
});

test("forget：撤下匹配的警报，不通知、不进最近恢复，之后再失败重新计数", () => {
	const { health, cleared } = board();
	health.failed("data:a", failure("x", 1));
	health.failed("model:router", { ...failure("x", 1), area: "model", subject: "幕僚长模型" });
	health.forget((id) => id.startsWith("data:"));
	assert.deepEqual(health.board().active.map((a) => a.id), ["model:router"]);
	assert.equal(cleared.length, 0);
	assert.deepEqual(health.board().recent, []);
	health.failed("data:a", failure("x", 2));
	assert.equal(health.board().active.length, 1, "重新从 1 数起");
});

test("同一处断了又好、好了又断：最近恢复里只留最后一次", () => {
	const { health, tick } = board();
	for (const _ of [1, 2]) {
		health.failed("data:a", failure("x", 1));
		tick(1_000);
		health.ok("data:a");
	}
	assert.deepEqual(health.board().recent.map((a) => [a.id, a.clearedAt]), [["data:a", 3_000]]);
});

test("没登录、没密钥、会话过期都算鉴权：不会自己好", () => {
	assert.equal(causeOf("No API key for provider: openai-codex"), "auth");
	assert.equal(causeOf("Your session has expired. Please log in again."), "auth");
	assert.equal(causeOf("session expired"), "auth");
	assert.equal(causeOf("please log in to continue"), "auth");
});

test("错误文字里的各种密钥写法都去掉", () => {
	const secrets: [string, string][] = [
		["POST https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getUpdates failed", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"],
		["POST /token body refresh_token=1-abcdefSECRET&grant_type=refresh_token", "1-abcdefSECRET"],
		['400 {"api_key":"live-key-SECRET-9","error":"bad"}', "live-key-SECRET-9"],
		['401 {"token": "tok-SECRET-42"}', "tok-SECRET-42"],
		["request headers x-api-key: hdr-SECRET-77 rejected", "hdr-SECRET-77"],
		["fetch https://alice:pa55-SECRET@imap.example.com/inbox failed", "pa55-SECRET"],
		["provider says apiKey=bare-SECRET-11 is invalid", "bare-SECRET-11"],
	];
	for (const [error, secret] of secrets) assert.ok(!scrub(error).includes(secret), `${secret} 还在：${scrub(error)}`);
});

test("环境变量名、裸 bot token、私钥、冒号写法、Cookie、带转义引号的 JSON 也都去掉", () => {
	const secrets: [string, string][] = [
		["launchd env TELEGRAM_BOT_TOKEN=7312345678:AAH3kd9fJ2lQwXyZ0aBcDeFgHiJkLmNoPqR rejected", "AAH3kd9fJ2lQwXyZ0aBcDeFgHiJkLmNoPqR"],
		["MASSIVE_API_KEY=mv-SECRET-1234 rejected", "mv-SECRET-1234"],
		["telegram 401 for 7312345678:AAH3kd9fJ2lQwXyZ0aBcDeFgHiJkLmNoPqR", "AAH3kd9fJ2lQwXyZ0aBcDeFgHiJkLmNoPqR"],
		["gmail service account private_key=pk-SECRET-5566 invalid", "pk-SECRET-5566"],
		["config token: tok-SECRET-8899 is invalid", "tok-SECRET-8899"],
		["request headers Cookie: session=sess-SECRET-3141; theme=dark rejected", "sess-SECRET-3141"],
		['400 {"token":"ab\\"SECRET-in-quotes\\"cd"}', "SECRET-in-quotes"],
	];
	for (const [error, secret] of secrets) assert.ok(!scrub(error).includes(secret), `${secret} 还在：${scrub(error)}`);
	assert.match(scrub("TELEGRAM_BOT_TOKEN=7312345678:AAH3kd9fJ2lQwXyZ0aBcDeFgHiJkLmNoPqR"), /^TELEGRAM_BOT_TOKEN=…$/, "保留变量名，看得出是哪个密钥");
});

test("恢复的话：不到一分钟说不到 1 分钟，否则说约几分钟", () => {
	const alarm = { id: "model:router", area: "model" as const, subject: "幕僚长模型", since: 0 };
	assert.match(clearedText({ ...alarm, clearedAt: 20_000 }), /不到 1 分钟/);
	assert.match(clearedText({ ...alarm, clearedAt: 5 * 60_000 }), /约 5 分钟/);
});
