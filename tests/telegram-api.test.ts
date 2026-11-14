import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { inspect } from "node:util";
import { ConfigError } from "../src/config-error.ts";
import { BotApi, BotToken, TELEGRAM_API, TelegramError, type Http, type Keyboard } from "../src/host/telegram/bot-api.ts";

const RAW = "123456789:AAH-fake_token_for_tests_only_000000";
const token = () => new BotToken(RAW, "测试");
const never = new AbortController().signal;
const text = (t: string, silent = false, keyboard: Keyboard | null = null) => ({ text: t, plain: t, keyboard, silent });

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

test("发消息：POST JSON 到 <base>/bot<token>/sendMessage，带 HTML parse_mode；静默就带 disable_notification；返回 message_id", async () => {
	const f = fakeHttp(ok({ message_id: 77 }));
	const api = new BotApi({ token: token(), baseUrl: "http://127.0.0.1:8081", http: f.http });
	assert.equal(await api.send(42, text("你好"), never), 77);
	assert.equal(await api.send(42, text("静默", true), never), 77);
	assert.equal(f.calls[0].url, `http://127.0.0.1:8081/bot${RAW}/sendMessage`);
	assert.deepEqual(f.calls[0].body, { chat_id: 42, text: "你好", parse_mode: "HTML" });
	assert.deepEqual(f.calls[1].body, { chat_id: 42, text: "静默", parse_mode: "HTML", disable_notification: true });
});

test("fetch 抛出的错误带着网址和 token：变成 network，报错里没有网址和 token", async () => {
	const api = new BotApi({
		token: token(),
		http: async (url) => {
			throw new TypeError(`fetch failed: ${url}`);
		},
	});
	await assert.rejects(api.send(42, text("x"), never), (e: TelegramError) => {
		assert.equal(e.kind, "network");
		assert.equal(e.method, "sendMessage");
		assert.ok(!e.message.includes("api.telegram.org"), e.message);
		assertNoToken(e);
		return true;
	});
});

test("请求没发出去（拒绝连接、域名查不到、连接超时）是 unreachable；发出去后断开、超时是 network，说不准 Telegram 收没收到", async () => {
	const cases: [string | undefined, string][] = [
		["ECONNREFUSED", "unreachable"],
		["ENOTFOUND", "unreachable"],
		["EAI_AGAIN", "unreachable"],
		["UND_ERR_CONNECT_TIMEOUT", "unreachable"],
		["ECONNRESET", "network"],
		["UND_ERR_SOCKET", "network"],
		["UND_ERR_HEADERS_TIMEOUT", "network"],
		[undefined, "network"],
	];
	for (const [code, kind] of cases) {
		const api = new BotApi({
			token: token(),
			http: async (url) => {
				throw new TypeError(`fetch failed ${url}`, { cause: Object.assign(new Error(`${code} ${url}`), code ? { code } : {}) });
			},
		});
		await assert.rejects(api.send(42, text("x"), never), (e: TelegramError) => {
			assert.equal(e.kind, kind, String(code));
			assertNoToken(e);
			return true;
		});
	}
	const timedOut = new BotApi({ token: token(), http: async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); } });
	await assert.rejects(timedOut.send(42, text("x"), never), (e: TelegramError) => e.kind === "network");
});

test("本机一个没人监听的端口：真实的 fetch 报拒绝连接，归为 unreachable", async () => {
	const server = createServer();
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	const { port } = server.address() as { port: number };
	await new Promise((closed) => server.close(closed));
	const api = new BotApi({ token: token(), baseUrl: `http://127.0.0.1:${port}` });
	await assert.rejects(api.send(42, text("x"), never), (e: TelegramError) => e.kind === "unreachable");
});

test("retry_after 夹在 1 秒到 1 小时之间；别的状态带 retry_after 也按限流处理", async () => {
	const cases: [number, unknown, number][] = [
		[429, 0, 1000],
		[429, -5, 1000],
		[429, 2 ** 31, 3_600_000],
		[429, 1e400, 3_600_000],
		[500, 3, 3000],
	];
	for (const [status, retryAfter, ms] of cases) {
		const respond = () => new Response(`{"ok":false,"error_code":${status},"description":"wait","parameters":{"retry_after":${retryAfter === 1e400 ? "1e400" : retryAfter}}}`, { status });
		const api = new BotApi({ token: token(), http: fakeHttp(respond).http });
		await assert.rejects(api.send(42, text("x"), never), (e: TelegramError) => {
			assert.equal(e.kind, "rate_limited", `${status} ${retryAfter}`);
			assert.equal(e.retryAfterMs, ms, `${status} ${retryAfter}`);
			return true;
		});
	}
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
	await assert.rejects(api.send(42, text("x"), never), (e: TelegramError) => e.kind === "rate_limited" && e.retryAfterMs === 7000);
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
		await assert.rejects(api.send(42, text("x"), never), (e: TelegramError) => {
			assert.equal(e.kind, kind);
			assertNoToken(e);
			return true;
		}, kind);
	}
});

test("报错里 Telegram 的说明截到 120 字", async () => {
	const api = new BotApi({ token: token(), http: fakeHttp(failed(400, `Bad Request: ${"x".repeat(500)}`)).http });
	await assert.rejects(api.send(42, text("x"), never), (e: TelegramError) => e.message.length < 200 && e.message.startsWith("Telegram sendMessage：bad_request：Bad Request"));
});

test("getMe 返回机器人的用户名", async () => {
	const api = new BotApi({ token: token(), http: fakeHttp(ok({ id: 123456789, is_bot: true, first_name: "白宫", username: "psa_test_bot" })).http });
	assert.deepEqual(await api.getMe(never), { username: "psa_test_bot" });
});

test("取更新：带 offset、timeout 和只要 message、callback_query 的 allowed_updates；按钮点击也解析成事件；解析成领域事件，看不懂的更新只留 updateId", async () => {
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
		{ update_id: 19, callback_query: { id: "cb7", from: { id: 42 }, message: { message_id: 30, chat: { id: 42, type: "private" } }, data: "a:rpt_1:1" } },
		{ update_id: 20, callback_query: { id: "cb8", from: { id: 42 }, message: { message_id: 30, chat: { id: 42, type: "private" } }, game_short_name: "g" } },
	];
	const f = fakeHttp(ok(updates));
	const api = new BotApi({ token: token(), http: f.http });
	const got = await api.getUpdates(10, 50, never);
	assert.deepEqual(f.calls[0].body, { offset: 10, timeout: 50, allowed_updates: ["message", "callback_query"] });
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
		{ updateId: 19, event: { kind: "tap", chat: { id: 42, private: true }, from: 42, messageId: 30, callbackId: "cb7", data: "a:rpt_1:1" } },
		{ updateId: 20, event: { kind: "tap", chat: { id: 42, private: true }, from: 42, messageId: 30, callbackId: "cb8", data: "" } },
	]);
	await api.getUpdates(undefined, 50, never);
	assert.deepEqual(f.calls[1].body, { timeout: 50, allowed_updates: ["message", "callback_query"] });
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

const KEYS: Keyboard = [[{ label: "北京", data: "a:rpt_1:0" }], [{ label: "上海", data: "a:rpt_1:1" }]];

test("带按钮的消息：reply_markup 是 inline_keyboard，每个按钮的 text 和 callback_data", async () => {
	const f = fakeHttp(ok({ message_id: 78 }));
	const api = new BotApi({ token: token(), http: f.http });
	assert.equal(await api.send(42, text("查哪个城市？", false, KEYS), never), 78);
	assert.deepEqual(f.calls[0].body, {
		chat_id: 42,
		text: "查哪个城市？",
		parse_mode: "HTML",
		reply_markup: { inline_keyboard: [[{ text: "北京", callback_data: "a:rpt_1:0" }], [{ text: "上海", callback_data: "a:rpt_1:1" }]] },
	});
});

test("编辑消息：editMessageText 带新文字；没有按钮时发空的 inline_keyboard，让旧按钮真的消失", async () => {
	const f = fakeHttp(ok(true));
	const api = new BotApi({ token: token(), http: f.http });
	await api.edit(42, 78, text("已选「上海」"), never);
	await api.edit(42, 78, text("重选", false, KEYS), never);
	assert.equal(f.calls[0].url, `${TELEGRAM_API}/bot${RAW}/editMessageText`);
	assert.deepEqual(f.calls[0].body, { chat_id: 42, message_id: 78, text: "已选「上海」", parse_mode: "HTML", reply_markup: { inline_keyboard: [] } });
	assert.deepEqual(f.calls[1].body.reply_markup, { inline_keyboard: [[{ text: "北京", callback_data: "a:rpt_1:0" }], [{ text: "上海", callback_data: "a:rpt_1:1" }]] });
});

test("编辑时 Telegram 说内容没变：算编辑成功；消息找不到、改不了：bad_request，不带 token", async () => {
	const same = new BotApi({ token: token(), http: fakeHttp(failed(400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same")).http });
	await same.edit(42, 78, text("x"), never);
	for (const description of ["Bad Request: message to edit not found", "Bad Request: message can't be edited"]) {
		const api = new BotApi({ token: token(), http: fakeHttp(failed(400, description)).http });
		await assert.rejects(api.edit(42, 78, text("x"), never), (e: TelegramError) => {
			assert.equal(e.kind, "bad_request");
			assert.equal(e.method, "editMessageText");
			assertNoToken(e);
			return true;
		}, description);
	}
	const send = new BotApi({ token: token(), http: fakeHttp(failed(400, "Bad Request: message is not modified")).http });
	await assert.rejects(send.send(42, text("x"), never), (e: TelegramError) => e.kind === "bad_request", "只有编辑把「没变」当成功");
});

test("回应按钮点击：answerCallbackQuery 带 callback_query_id 和提示文字", async () => {
	const f = fakeHttp(ok(true));
	const api = new BotApi({ token: token(), http: f.http });
	await api.answerTap("cb7", "已发送", never);
	assert.equal(f.calls[0].url, `${TELEGRAM_API}/bot${RAW}/answerCallbackQuery`);
	assert.deepEqual(f.calls[0].body, { callback_query_id: "cb7", text: "已发送" });
});

const html = (t: string, plain: string, replyTo?: number) => ({ text: t, plain, keyboard: null, silent: false, ...(replyTo !== undefined && { replyTo }) });

test("发消息用 HTML parse_mode；挂在一条消息下时带 reply_parameters，原消息删了也照发", async () => {
	const f = fakeHttp(ok({ message_id: 80 }));
	const api = new BotApi({ token: token(), http: f.http });
	await api.send(42, html("<b>幕僚长</b>：好", "幕僚长：好", 7), never);
	assert.deepEqual(f.calls[0].body, { chat_id: 42, text: "<b>幕僚长</b>：好", parse_mode: "HTML", reply_parameters: { message_id: 7, allow_sending_without_reply: true } });
	await api.edit(42, 80, html("<b>改</b>", "改"), never);
	assert.deepEqual(f.calls[1].body, { chat_id: 42, message_id: 80, text: "<b>改</b>", parse_mode: "HTML", reply_markup: { inline_keyboard: [] } });
});

test("Telegram 说 HTML 解析不了：同一条改发纯文本，不带 parse_mode；编辑也一样；别的 400 不重发", async () => {
	for (const method of ["send", "edit"] as const) {
		const f = fakeHttp((call) => (call.body.parse_mode ? failed(400, "Bad Request: can't parse entities: Can't find end tag corresponding to start tag \"b\"")() : ok({ message_id: 81 })()));
		const api = new BotApi({ token: token(), http: f.http });
		if (method === "send") assert.equal(await api.send(42, html("<b>坏", "坏", 7), never), 81);
		else await api.edit(42, 81, html("<b>坏", "坏"), never);
		assert.equal(f.calls.length, 2, method);
		assert.equal(f.calls[1].body.text, "坏");
		assert.equal(f.calls[1].body.parse_mode, undefined);
		if (method === "send") assert.deepEqual(f.calls[1].body.reply_parameters, { message_id: 7, allow_sending_without_reply: true });
	}
	const f = fakeHttp(failed(400, "Bad Request: chat not found"));
	const api = new BotApi({ token: token(), http: f.http });
	await assert.rejects(api.send(42, html("<b>x</b>", "x"), never), (e: TelegramError) => e.kind === "bad_request");
	assert.equal(f.calls.length, 1);
});
