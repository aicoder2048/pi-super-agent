import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { ConfigError } from "../src/config-error.ts";
import { BotApi, BotToken, TELEGRAM_API, TelegramError, type Http } from "../src/host/telegram/bot-api.ts";

const RAW = "123456789:AAH-fake_token_for_tests_only_000000";
const token = () => new BotToken(RAW, "测试");
const never = new AbortController().signal;

type Call = { url: string; body: Record<string, unknown> };

function fakeHttp(respond: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const http: Http = async (url, init) => {
		const call = { url, body: JSON.parse(init.body) };
		calls.push(call);
		return respond(call);
	};
	return { http, calls };
}

const ok = (result: unknown) => () => Response.json({ ok: true, result });
const failed = (status: number, description: string, parameters?: object) => () => Response.json({ ok: false, error_code: status, description, ...(parameters && { parameters }) }, { status });

function assertNoToken(error: unknown) {
	const e = error as Error;
	for (const text of [e.message, String(e), e.stack ?? "", inspect(e), JSON.stringify(e)]) assert.ok(!text.includes(RAW) && !text.includes(RAW.split(":")[1]), text);
	assert.equal(e.cause, undefined);
}

test("bot token 格式不对时报 ConfigError，报错里没有 token", () => {
	for (const raw of ["123:short", "abc:AAH-fake_token_for_tests_only_000000", `${RAW} `, ""]) {
		assert.throws(() => new BotToken(raw, "secretsFile /x/secrets.env"), (e: Error) => {
			assert.ok(e instanceof ConfigError);
			assert.match(e.message, /TELEGRAM_BOT_TOKEN/);
			assert.match(e.message, /secretsFile \/x\/secrets\.env/);
			if (raw) assert.ok(!e.message.includes(raw), e.message);
			return true;
		});
	}
});

test("BotToken 打印、转 JSON、inspect 都只显示 [BotToken]；冒号前的数字是 bot id", () => {
	const t = token();
	assert.equal(t.botId, 123456789);
	for (const text of [String(t), `${t}`, JSON.stringify({ t }), inspect(t), inspect({ nested: { t } }, { depth: 5 })]) {
		assert.ok(!text.includes(RAW.split(":")[1]), text);
		assert.match(text, /\[BotToken\]/);
	}
});

test("baseUrl 只能是官方地址或 http://127.0.0.1:<端口>", () => {
	for (const baseUrl of ["https://evil.example", "http://localhost:1", "http://127.0.0.1", "https://127.0.0.1:8081", "http://127.0.0.1:8081/x", "http://127.0.0.1.evil.example:80"]) {
		assert.throws(() => new BotApi({ token: token(), baseUrl }), /baseUrl/, baseUrl);
	}
	new BotApi({ token: token() });
	new BotApi({ token: token(), baseUrl: TELEGRAM_API });
	new BotApi({ token: token(), baseUrl: "http://127.0.0.1:8081" });
});

test("发消息：POST JSON 到 <base>/bot<token>/sendMessage，纯文本不带 parse_mode；静默就带 disable_notification；返回 message_id", async () => {
	const f = fakeHttp(ok({ message_id: 77 }));
	const api = new BotApi({ token: token(), baseUrl: "http://127.0.0.1:8081", http: f.http });
	assert.equal(await api.send(42, "你好", false, never), 77);
	assert.equal(await api.send(42, "静默", true, never), 77);
	assert.equal(f.calls[0].url, `http://127.0.0.1:8081/bot${RAW}/sendMessage`);
	assert.deepEqual(f.calls[0].body, { chat_id: 42, text: "你好" });
	assert.deepEqual(f.calls[1].body, { chat_id: 42, text: "静默", disable_notification: true });
});

test("fetch 抛出的错误带着网址和 token：变成 network，报错里没有网址和 token", async () => {
	const api = new BotApi({
		token: token(),
		http: async (url) => {
			throw new TypeError(`fetch failed: ${url}`);
		},
	});
	await assert.rejects(api.send(42, "x", false, never), (e: TelegramError) => {
		assert.equal(e.kind, "network");
		assert.equal(e.method, "sendMessage");
		assert.ok(!e.message.includes("api.telegram.org"), e.message);
		assertNoToken(e);
		return true;
	});
});

test("401 的 description 里带着 token：变成 unauthorized，报错里没有 token", async () => {
	const api = new BotApi({ token: token(), http: fakeHttp(failed(401, `Unauthorized: ${RAW}`)).http });
	await assert.rejects(api.getMe(never), (e: TelegramError) => {
		assert.equal(e.kind, "unauthorized");
		assertNoToken(e);
		return true;
	});
});

test("429 带 retry_after：变成 rate_limited，retryAfterMs 是毫秒", async () => {
	const api = new BotApi({ token: token(), http: fakeHttp(failed(429, "Too Many Requests: retry after 7", { retry_after: 7 })).http });
	await assert.rejects(api.send(42, "x", false, never), (e: TelegramError) => e.kind === "rate_limited" && e.retryAfterMs === 7000);
});

test("其余失败按状态分类：400、403、409、5xx、不是 Bot API 的 JSON", async () => {
	const cases: [() => Response, string][] = [
		[failed(400, "Bad Request: chat not found"), "bad_request"],
		[failed(403, "Forbidden: bot was blocked by the user"), "forbidden"],
		[failed(409, "Conflict: terminated by other getUpdates request"), "conflict"],
		[() => new Response("<html>bad gateway</html>", { status: 502 }), "server"],
		[failed(500, "Internal Server Error"), "server"],
		[() => new Response("not json", { status: 200 }), "bad_response"],
		[() => Response.json({ ok: true }), "bad_response"],
	];
	for (const [respond, kind] of cases) {
		const api = new BotApi({ token: token(), http: fakeHttp(respond).http });
		await assert.rejects(api.send(42, "x", false, never), (e: TelegramError) => {
			assert.equal(e.kind, kind);
			assertNoToken(e);
			return true;
		}, kind);
	}
});

test("报错里 Telegram 的说明截到 120 字", async () => {
	const api = new BotApi({ token: token(), http: fakeHttp(failed(400, `Bad Request: ${"x".repeat(500)}`)).http });
	await assert.rejects(api.send(42, "x", false, never), (e: TelegramError) => e.message.length < 200 && e.message.startsWith("Telegram sendMessage：bad_request：Bad Request"));
});

test("getMe 返回机器人的用户名", async () => {
	const api = new BotApi({ token: token(), http: fakeHttp(ok({ id: 123456789, is_bot: true, first_name: "白宫", username: "psa_test_bot" })).http });
	assert.deepEqual(await api.getMe(never), { username: "psa_test_bot" });
});

test("取更新：带 offset、timeout 和只要 message 的 allowed_updates；解析成领域事件，看不懂的更新只留 updateId", async () => {
	const updates = [
		{ update_id: 10, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "查一下 NVDA", reply_to_message: { message_id: 9 } } },
		{ update_id: 11, message: { message_id: 2, from: { id: 42 }, chat: { id: -100, type: "group" }, text: "群里" } },
		{ update_id: 12, message: { message_id: 3, from: { id: 42 }, chat: { id: 42, type: "private" }, photo: [{ file_id: "p" }] } },
		{ update_id: 13, message: { message_id: 4, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "转发", forward_origin: { type: "user" } } },
		{ update_id: 14, edited_message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "改了" } },
		{ update_id: 15, message: { message_id: 5, chat: { id: 42, type: "private" }, text: "没有 from" } },
		{ update_id: 16, callback_query: { id: "c", from: { id: 42 }, data: "a:x:0" } },
		{ update_id: 17, message: "garbage" },
		{ update_id: 18, message: { message_id: 6, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "gif 机器人的结果", via_bot: { id: 777, is_bot: true } } },
	];
	const f = fakeHttp(ok(updates));
	const api = new BotApi({ token: token(), http: f.http });
	const got = await api.getUpdates(10, 50, never);
	assert.deepEqual(f.calls[0].body, { offset: 10, timeout: 50, allowed_updates: ["message"] });
	assert.deepEqual(got, [
		{ updateId: 10, event: { kind: "message", chat: { id: 42, private: true }, from: 42, messageId: 1, content: { kind: "text", text: "查一下 NVDA" }, replyTo: 9 } },
		{ updateId: 11, event: { kind: "message", chat: { id: -100, private: false }, from: 42, messageId: 2, content: { kind: "text", text: "群里" }, replyTo: null } },
		{ updateId: 12, event: { kind: "message", chat: { id: 42, private: true }, from: 42, messageId: 3, content: { kind: "other" }, replyTo: null } },
		{ updateId: 13, event: { kind: "message", chat: { id: 42, private: true }, from: 42, messageId: 4, content: { kind: "forwarded" }, replyTo: null } },
		{ updateId: 14, event: null },
		{ updateId: 15, event: null },
		{ updateId: 16, event: null },
		{ updateId: 17, event: null },
		{ updateId: 18, event: { kind: "message", chat: { id: 42, private: true }, from: 42, messageId: 6, content: { kind: "via-bot" }, replyTo: null } },
	]);
	await api.getUpdates(undefined, 50, never);
	assert.deepEqual(f.calls[1].body, { timeout: 50, allowed_updates: ["message"] });
});

test("取更新的结果不是数组、更新没有 update_id：bad_response", async () => {
	for (const result of [{}, [{ message: {} }]]) {
		const api = new BotApi({ token: token(), http: fakeHttp(ok(result)).http });
		await assert.rejects(api.getUpdates(undefined, 50, never), (e: TelegramError) => e.kind === "bad_response");
	}
});

test("调用方中止：变成 stopped", async () => {
	const stop = new AbortController();
	const api = new BotApi({
		token: token(),
		http: (_url, init) =>
			new Promise((_, reject) => {
				init.signal.addEventListener("abort", () => reject(new DOMException(`aborted ${RAW}`, "AbortError")));
			}),
	});
	const pending = api.getUpdates(undefined, 50, stop.signal);
	stop.abort();
	await assert.rejects(pending, (e: TelegramError) => {
		assert.equal(e.kind, "stopped");
		assertNoToken(e);
		return true;
	});
});
