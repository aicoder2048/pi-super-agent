import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import http from "node:http";
import { connect, createServer, type AddressInfo } from "node:net";
import test, { mock, type TestContext } from "node:test";
import type { HostToClient } from "../src/client/protocol.ts";
import { ConfigError } from "../src/config-error.ts";
import type { DashboardRow } from "../src/kernel/types.ts";
import * as page from "../src/web/view.mjs";
import { busyPort, ofType, openOnConversation, startHost, tempStateDir, until, within } from "./helpers/fakes.ts";

function row(over: Partial<DashboardRow> = {}): DashboardRow {
	return {
		id: "tkt_abcd1234", title: "查天气", stage: "running", basis: "request", latestSummary: null, model: "openai-codex/gpt-6.1-sol",
		fellBack: false, toolCalls: 2, tokensIn: 1200, tokensOut: 300, elapsedMs: 5000, lastProgressAt: null, ...over,
	};
}

const texts = (view: ReturnType<typeof page.emptyView>) => [...view.lines.values()].map((l) => `${l.who}:${l.text}`);

test("页面：快照之后再收到同一句 user 或同一条 reply，不重复显示", () => {
	const view = page.emptyView();
	page.applyMessage(view, { type: "snapshot", conversation: [{ id: "trg_1", who: "user", text: "你好", at: 1 }, { id: "rpl_1", who: "router", text: "在", at: 2 }], board: [] }, 0);
	page.applyMessage(view, { type: "user", id: "trg_1", text: "你好", at: 1 }, 0);
	page.applyMessage(view, { type: "reply", replyId: "rpl_1", text: "在", at: 2 }, 0);
	assert.deepEqual(texts(view), ["user:你好", "router:在"]);
});

test("页面：重连后的快照只补没见过的行，已显示的顺序不变", () => {
	const view = page.emptyView();
	page.applyMessage(view, { type: "user", id: "trg_2", text: "第二句", at: 2 }, 0);
	page.applyMessage(view, { type: "snapshot", conversation: [{ id: "trg_1", who: "user", text: "第一句", at: 1 }, { id: "trg_2", who: "user", text: "第二句", at: 2 }, { id: "rpl_3", who: "router", text: "回复", at: 3 }], board: [] }, 0);
	assert.deepEqual(texts(view), ["user:第二句", "user:第一句", "router:回复"]);
});

test("页面：未知消息类型被忽略，不改对话也不改看板", () => {
	const view = page.emptyView();
	page.applyMessage(view, { type: "board", rows: [row()] }, 0);
	assert.deepEqual(page.applyMessage(view, { type: "ack", requestId: "r", triggerId: "trg_1" }, 0), []);
	assert.deepEqual(page.applyMessage(view, { type: "transcript", ticketId: "tkt_abcd1234", message: { role: "assistant", content: "x" } }, 0), []);
	assert.equal(view.lines.size, 0);
	assert.equal(page.boardModel(view, 0).cards.length, 1);
});

test("页面：每种消息只报告它改动的区域", () => {
	const view = page.emptyView();
	assert.deepEqual(page.applyMessage(view, { type: "snapshot", conversation: [], board: [] }, 0), ["conversation", "board"]);
	assert.deepEqual(page.applyMessage(view, { type: "user", id: "trg_1", text: "你好", at: 1 }, 0), ["conversation"]);
	assert.deepEqual(page.applyMessage(view, { type: "reply", replyId: "rpl_1", text: "在", at: 2 }, 0), ["conversation"]);
	assert.deepEqual(page.applyMessage(view, { type: "board", rows: [] }, 0), ["board"]);
});

test("页面：执行中和排队的任务耗时在本地累加，其他阶段不变", () => {
	const view = page.emptyView();
	page.applyMessage(view, { type: "board", rows: [row({ id: "tkt_run1", stage: "running" }), row({ id: "tkt_que1", stage: "queued" }), row({ id: "tkt_idl1", stage: "idle" })] }, 10_000);
	const cards = page.boardModel(view, 75_000).cards;
	assert.deepEqual(cards.map((c) => c.elapsed), ["1分10秒", "1分10秒", "5秒"]);
});

test("页面：看板卡片显示阶段、依据、最近汇报、模型、用量和耗时", () => {
	const view = page.emptyView();
	page.applyMessage(view, { type: "board", rows: [row({ stage: "awaiting_review", basis: "rule", latestSummary: "查完了", fellBack: true })] }, 0);
	assert.deepEqual(page.boardModel(view, 0).cards[0], {
		id: "tkt_abcd1234", shortId: "abcd", title: "查天气", stage: "awaiting_review", stageLabel: "等你验收", basisLabel: "规则",
		summary: "查完了", model: "gpt-6.1-sol（已回退）", tokens: "1.5k tok", toolCalls: 2, elapsed: "5秒",
	});
	page.applyMessage(view, { type: "board", rows: [row({ model: null, latestSummary: null })] }, 0);
	const card = page.boardModel(view, 0).cards[0];
	assert.equal(card.model, "未启动");
	assert.equal(card.summary, "（暂无汇报）");
});

test("页面：已结束的任务只显示最近 2 个，其余计数", () => {
	const view = page.emptyView();
	const closed = ["c1", "c2", "c3"].map((id) => row({ id: `tkt_${id}`, stage: "closed" }));
	page.applyMessage(view, { type: "board", rows: [closed[0], row({ id: "tkt_act1" }), closed[1], row({ id: "tkt_stp1", stage: "stopped" }), closed[2]] }, 0);
	const model = page.boardModel(view, 0);
	assert.deepEqual(model.cards.map((c) => c.id), ["tkt_act1", "tkt_stp1", "tkt_c3"]);
	assert.equal(model.hiddenClosed, 2);
	assert.equal(model.active, 1);
});

test("页面：超过两个保活间隔（35 秒）没收到任何帧才算断线", () => {
	assert.equal(page.isStale(100_000, 130_000), false, "错过一次 ping 还不算");
	assert.equal(page.isStale(100_000, 135_000), false);
	assert.equal(page.isStale(100_000, 135_001), true);
});

type Got = { status: number; headers: http.IncomingHttpHeaders; body: string };

// node:http rather than fetch, because fetch refuses to send a custom Host header.
function request(url: string, options: { host?: string; method?: string } = {}): Promise<Got> {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method: options.method ?? "GET", headers: options.host ? { host: options.host } : {} }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.setTimeout(3000, () => req.destroy(new Error(`请求 3 秒没有响应：${url}`)));
		req.end();
	});
}

function sse(url: string) {
	const stream = { raw: "", got: [] as HostToClient[], status: 0, ended: false, close: () => req.destroy() };
	const req = http.get(url, (res) => {
		stream.status = res.statusCode!;
		res.setEncoding("utf8");
		res.on("data", (chunk: string) => {
			stream.raw += chunk;
			stream.got = stream.raw
				.split("\n\n")
				.slice(0, -1)
				.flatMap((frame) => (frame.startsWith("data: ") ? [JSON.parse(frame.slice(6)) as HostToClient] : []));
		});
		res.on("close", () => (stream.ended = true));
	});
	req.on("error", () => (stream.ended = true));
	return stream;
}

// Streams close before the host stops: server.close() waits on open connections, so a broken stop() fails here instead of hanging the run.
async function webHost(t: TestContext, brain: Parameters<typeof startHost>[0] = () => []) {
	const started = await startHost(brain, () => {}, { webPort: 0 });
	const streams: ReturnType<typeof sse>[] = [];
	let stopping: Promise<void> | undefined;
	const stop = () => (stopping ??= started.host.stop());
	t.after(async () => {
		for (const s of streams) s.close();
		await within(stop(), 5000, "清理时 host.stop()");
	});
	const url = new URL(started.host.webUrl!);
	const token = url.searchParams.get("token")!;
	const at = (path: string, t = token) => `${url.origin}${path}${t === "" ? "" : `?token=${t}`}`;
	const events = () => {
		const stream = sse(at("/events"));
		streams.push(stream);
		return stream;
	};
	return { ...started, url, token, at, events, stop };
}

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
	const { port } = probe.address() as AddressInfo;
	await new Promise((r) => probe.close(r));
	return port;
}

test("网关：网址是 127.0.0.1 加 64 位十六进制 token，每次启动换新 token", async (t) => {
	const a = await webHost(t);
	const b = await webHost(t);
	assert.match(a.host.webUrl!, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
	assert.notEqual(a.token, b.token);
});

test("网关：没有 token 或 token 错误时，首页和事件流返回 401，正文不含对话内容", async (t) => {
	const { host, at } = await webHost(t);
	host.say("机密的一句话");
	for (const path of ["/", "/events"]) {
		for (const token of ["", "0".repeat(64), "short"]) {
			const res = await request(at(path, token));
			assert.equal(res.status, 401, `${path} token=${token}`);
			assert.doesNotMatch(res.body, /机密/);
		}
	}
});

test("网关：静态脚本不含数据，不带 token 也能取到，但 Host 头不对仍然 403", async (t) => {
	const { host, at, url } = await webHost(t);
	for (const path of ["/app.mjs", "/view.mjs", "/client/board-format.mjs"]) {
		const res = await request(at(path, ""));
		assert.equal(res.status, 200, path);
		assert.match(res.headers["content-type"]!, /^text\/javascript/, path);
		assert.equal((await request(at(path, ""), { host: `evil.example:${url.port}` })).status, 403, path);
	}
	assert.match((await request(at("/client/board-format.mjs", ""))).body, /export const STAGE_LABEL/);
});

test("网关：页面加载的每个模块，它 import 的路径网关都不带 token 就能给出", async (t) => {
	const { host, at, url } = await webHost(t);
	const seen = new Set<string>();
	const pending = ["/app.mjs"];
	while (pending.length) {
		const path = pending.pop()!;
		if (seen.has(path)) continue;
		seen.add(path);
		const res = await request(at(path, ""));
		assert.equal(res.status, 200, path);
		for (const [, a, b] of res.body.matchAll(/^\s*(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)) {
			const target = new URL(a ?? b, `${url.origin}${path}`);
			assert.equal(target.origin, url.origin, `${path} 引用了 ${a ?? b}`);
			pending.push(target.pathname);
		}
	}
	assert.deepEqual([...seen].sort(), ["/app.mjs", "/client/board-format.mjs", "/view.mjs"]);
});

test("网关：Host 头不是本机这个端口时返回 403，即使 token 正确", async (t) => {
	const { host, at, url } = await webHost(t);
	for (const forged of ["evil.example:" + url.port, "127.0.0.1:1", "evil.example"]) {
		assert.equal((await request(at("/events"), { host: forged })).status, 403, forged);
	}
	assert.equal((await request(at("/events", ""), { host: "evil.example:" + url.port })).status, 403, "Host 先于 token 检查");
	assert.equal((await request(at("/"), { host: `localhost:${url.port}` })).status, 200);
});

test("网关：首页带 token 的脚本地址，CSP 不允许内联脚本，响应不缓存、不带 referrer", async (t) => {
	const { host, at, token } = await webHost(t);
	const res = await request(at("/"));
	assert.equal(res.status, 200);
	assert.match(res.headers["content-type"]!, /^text\/html/);
	assert.ok(res.body.includes(`<script type="module" src="/app.mjs?token=${token}"></script>`), res.body);
	assert.doesNotMatch(res.body, /\{\{token\}\}/);
	const scriptSrc = /script-src ([^;]*)/.exec(String(res.headers["content-security-policy"]))?.[1];
	assert.equal(scriptSrc, "'self'");
	assert.equal(res.headers["cache-control"], "no-store");
	assert.equal(res.headers["referrer-policy"], "no-referrer");
	assert.equal(res.headers["x-content-type-options"], "nosniff");
	const app = await request(at("/app.mjs"));
	assert.equal(app.status, 200);
	assert.match(app.headers["content-type"]!, /^text\/javascript/);
});

function rawRequest(port: number, head: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let got = "";
		const socket = connect(port, "127.0.0.1", () => socket.end(head));
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => (got += chunk));
		socket.on("end", () => resolve(got));
		socket.on("error", reject);
		socket.setTimeout(3000, () => socket.destroy(new Error("原始请求 3 秒没有响应")));
	});
}

test("网关：请求目标解析不了时返回 400，宿主照常服务", async (t) => {
	const { host, at, url } = await webHost(t);
	const res = await rawRequest(Number(url.port), "GET //[ HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n");
	assert.match(res, /^HTTP\/1\.1 400 /);
	assert.match(res, /\r\ncache-control: no-store\r\n/i);
	assert.equal((await request(at("/"))).status, 200);
});

test("网关：只读，非 GET 返回 405；未知路径返回 404", async (t) => {
	const { host, at } = await webHost(t);
	assert.equal((await request(at("/events"), { method: "POST" })).status, 405);
	assert.equal((await request(at("/nope"))).status, 404);
});

test("网关：SSE 第一条是快照，之后转发 user、reply、board，和 socket 客户端收到的相同", async (t) => {
	const brain = (cards: string[]) => (cards[0]?.startsWith("[对话]") ? openOnConversation(cards[0]) : []);
	const { host, events } = await webHost(t, brain);
	host.say("早");
	await host.settled();
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	assert.equal(stream.status, 200);
	const [first] = ofType(stream.got.slice(0, 1), "snapshot");
	const expected = host.snapshot();
	assert.deepEqual(first.conversation, expected.conversation);
	assert.deepEqual(first.board.map((r) => [r.id, r.title, r.stage]), expected.board.map((r) => [r.id, r.title, r.stage]));
	const id = host.say("查天气");
	await until(() => ofType(stream.got, "user").some((m) => m.id === id && m.text === "查天气"), "user");
	await until(() => ofType(stream.got, "reply").some((m) => m.text === "收到：查天气"), "reply");
	await until(() => ofType(stream.got, "board").some((m) => m.rows.some((r) => r.title === "查天气")), "board");
});

test("网关：两个 SSE 连接收到相同的消息", async (t) => {
	const { host, events } = await webHost(t);
	const a = events();
	const b = events();
	await until(() => a.got.length > 0 && b.got.length > 0, "两个快照");
	host.say("一");
	host.say("二");
	await until(() => ofType(a.got, "user").length === 2 && ofType(b.got, "user").length === 2, "两条 user");
	assert.deepEqual(ofType(a.got, "user"), ofType(b.got, "user"));
});

test("网关：正文含 <script> 和换行时，原样作为一行 data 传输", async (t) => {
	const { host, events } = await webHost(t);
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	const text = "<script>alert(1)</script>\n第二行\r\n第三行";
	host.say(text);
	await until(() => ofType(stream.got, "user").length === 1, "user");
	assert.equal(ofType(stream.got, "user")[0].text, text);
	const frame = stream.raw.split("\n\n").find((f) => f.includes("alert(1)"))!;
	assert.equal(frame.split("\n").length, 1, frame);
});

test("网关：每个 SSE 连接每 15 秒收到一条页面看得见的 ping 事件", async (t) => {
	const { host, events } = await webHost(t);
	mock.timers.enable({ apis: ["setInterval"] });
	t.after(() => mock.timers.reset());
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	mock.timers.tick(14_999);
	await new Promise((r) => setTimeout(r, 50));
	assert.doesNotMatch(stream.raw, /^event: ping$/m);
	mock.timers.tick(1);
	await until(() => /^event: ping\ndata: \n\n/m.test(stream.raw), "ping 事件");
});

test("网关：SSE 连着时 host.stop() 仍然结束，流被关掉，之后连不上", async (t) => {
	const { at, events, stop } = await webHost(t);
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	await within(stop(), 2000, "SSE 连着时 host.stop()");
	await until(() => stream.ended, "流被关掉");
	await assert.rejects(request(at("/")), /ECONNREFUSED/);
});

test("网关：端口被占用时 Host.start 报一行 ConfigError，指出端口和 webPort，也不碰 host.sock", async (t) => {
	const port = await busyPort(t);
	const stateDir = tempStateDir();
	let routerCreated = false;
	await assert.rejects(
		startHost(() => [], () => {}, {
			stateDir,
			webPort: port,
			createRouter: async () => {
				routerCreated = true;
				throw new Error("不该走到这里");
			},
		}),
		(e: Error) => e instanceof ConfigError && e.message.includes(String(port)) && e.message.includes("webPort") && !e.message.includes("\n"),
	);
	assert.equal(routerCreated, false);
	assert.equal(existsSync(`${stateDir}/host.sock`), false);
});

test("网关：网关开好之后启动失败，端口被释放", async () => {
	const port = await freePort();
	await assert.rejects(
		startHost(() => [], () => {}, {
			webPort: port,
			createRouter: async () => {
				throw new Error("Router 起不来");
			},
		}),
		/Router 起不来/,
	);
	const again = createServer();
	await new Promise<void>((resolve, reject) => again.once("error", reject).listen(port, "127.0.0.1", resolve));
	await new Promise((r) => again.close(r));
});
