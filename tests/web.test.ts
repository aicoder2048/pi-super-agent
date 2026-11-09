import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { connect, createServer, type AddressInfo } from "node:net";
import test, { mock, type TestContext } from "node:test";
import type { HostToClient, TodayCounts } from "../src/client/protocol.ts";
import type { DashboardRow } from "../src/kernel/types.ts";
import { formatInputs } from "../src/host/workers.ts";
import { INPUT_KINDS } from "../src/kernel/types.ts";
import { ConfigError } from "../src/config-error.ts";
import { WebGateway } from "../src/host/web.ts";
import * as page from "../src/web/view.mjs";
import { WATCHDOG_SOURCE } from "../src/watchdog/watchdog.ts";
import { busyPort, ofType, openOnConversation, startHost, tempStateDir, until, within } from "./helpers/fakes.ts";

function row(over: Partial<DashboardRow> = {}): DashboardRow {
	return {
		id: "tkt_abcd1234", title: "查天气", stage: "running", basis: "request", latestSummary: null, model: "openai-codex/gpt-6.1-sol",
		fellBack: false, toolCalls: 2, tokensIn: 1200, tokensOut: 300, elapsedMs: 5000, lastProgressAt: null, latestQuestion: null, ...over,
	};
}

const zeroToday = (): TodayCounts => ({ byDisposition: { ignored: 0, delivered: 0, to_router: 0, opened_ticket: 0, handed_over: 0, router_ignored: 0 }, bySource: {} });
const duty = { since: 0, resumed: 0 };
const snapshot = (over: Partial<Extract<HostToClient, { type: "snapshot" }>> = {}): HostToClient => ({ type: "snapshot", conversation: [], board: [], today: zeroToday(), duty, watching: [], ...over });
const board = (rows: DashboardRow[], today = zeroToday()): HostToClient => ({ type: "board", rows, today, duty });
const texts = (view: ReturnType<typeof page.emptyView>) => [...view.lines.values()].map((l) => `${l.who}:${l.text}`);
const withRows = (rows: DashboardRow[], now = 0) => {
	const view = page.emptyView();
	page.applyMessage(view, board(rows), now);
	return view;
};

test("页面：快照之后再收到同一句 user 或同一条 reply，不重复显示", () => {
	const view = page.emptyView();
	page.applyMessage(view, snapshot({ conversation: [{ id: "trg_1", who: "user", text: "你好", at: 1 }, { id: "rpl_1", who: "router", text: "在", at: 2 }] }), 0);
	page.applyMessage(view, { type: "user", id: "trg_1", text: "你好", at: 1 }, 0);
	page.applyMessage(view, { type: "reply", replyId: "rpl_1", text: "在", at: 2 }, 0);
	assert.deepEqual(texts(view), ["user:你好", "router:在"]);
});

test("页面：重连后的快照只补没见过的行，已显示的顺序不变", () => {
	const view = page.emptyView();
	page.applyMessage(view, { type: "user", id: "trg_2", text: "第二句", at: 2 }, 0);
	page.applyMessage(view, snapshot({ conversation: [{ id: "trg_1", who: "user", text: "第一句", at: 1 }, { id: "trg_2", who: "user", text: "第二句", at: 2 }, { id: "rpl_3", who: "router", text: "回复", at: 3 }] }), 0);
	assert.deepEqual(texts(view), ["user:第二句", "user:第一句", "router:回复"]);
});

test("页面：未知消息类型被忽略，不改对话也不改左栏", () => {
	const view = withRows([row()]);
	assert.deepEqual(page.applyMessage(view, { type: "ack", requestId: "r", triggerId: "trg_1" }, 0), []);
	assert.deepEqual(page.applyMessage(view, { type: "transcript", ticketId: "tkt_abcd1234", message: { role: "assistant", content: "x" } }, 0), []);
	assert.equal(view.lines.size, 0);
	assert.equal(page.leftColumn(view).doing.length, 1);
});

test("页面：每种消息只报告它改动的区域", () => {
	const view = page.emptyView();
	assert.deepEqual(page.applyMessage(view, snapshot(), 0), ["conversation", "left", "header"]);
	assert.deepEqual(page.applyMessage(view, { type: "user", id: "trg_1", text: "你好", at: 1 }, 0), ["conversation"]);
	assert.deepEqual(page.applyMessage(view, { type: "reply", replyId: "rpl_1", text: "在", at: 2 }, 0), ["conversation"]);
	assert.deepEqual(page.applyMessage(view, board([]), 0), ["left", "header"]);
});

test("页面：每个任务恰好进一个分组：待回复、待确认、受阻进待你处理，排队中、进行中、等待中进进行中，已完成和已停止进已完成", () => {
	const stages: DashboardRow["stage"][] = ["awaiting_answer", "awaiting_review", "blocked_or_failed", "queued", "running", "idle", "closed", "stopped"];
	const left = page.leftColumn(withRows(stages.map((stage) => row({ id: `tkt_${stage}`, stage }))), 0);
	const ids = (cards: { id: string }[]) => cards.map((c) => c.id.slice(4));
	assert.deepEqual(ids(left.needsYou), ["awaiting_answer", "awaiting_review", "blocked_or_failed"]);
	assert.deepEqual(ids(left.doing), ["queued", "running", "idle"]);
	assert.deepEqual(ids(left.done), ["stopped", "closed"], "后开的在前");
	assert.equal(left.doneLine, "已完成 · 2");
});

test("页面：待你处理的卡片先显示问题，受阻的显示最近汇报；进行中的显示最近汇报，没有时说已开始", () => {
	const left = page.leftColumn(withRows([
		row({ id: "tkt_ask", stage: "awaiting_answer", basis: "rule", latestSummary: "需要确认", latestQuestion: "用 A 还是 B？" }),
		row({ id: "tkt_stk", stage: "blocked_or_failed", basis: "inference", latestSummary: "缺少权限" }),
		row({ id: "tkt_run", stage: "running", latestSummary: null }),
		row({ id: "tkt_idl", stage: "idle", latestSummary: "读完 3 份" }),
	]), 0);
	assert.deepEqual(left.needsYou.map((c) => [c.latest, c.stage, c.why]), [["用 A 还是 B？", "待回复", "规则触发"], ["缺少权限", "受阻", "主动发现"]]);
	assert.deepEqual(left.doing.map((c) => [c.latest, c.stage, c.why]), [["已开始，暂无进展", "进行中", "你的请求"], ["读完 3 份", "等待中", "你的请求"]]);
	assert.deepEqual([...left.needsYou, ...left.doing].map((c) => c.canStop), [false, false, true, true], "只有进行中的能停止");
});

test("页面：停止只在输入框里填一句话，含任务标题", () => {
	assert.equal(page.stopSentence("读取 example.com 的网页标题"), "停止任务「读取 example.com 的网页标题」");
});

test("页面：关注的来源每一行用来源原名，显示第一条规则的第一行，或定时器的频率，以及今日消息数", () => {
	const view = page.emptyView();
	const today = zeroToday();
	today.bySource = { inbox: 2 };
	page.applyMessage(view, snapshot({
		today,
		watching: [
			{ source: "inbox", timers: [], rules: [{ id: "user/mail", text: "\n有人找我先看一遍\n细节", by: "user" }] },
			{ source: "digest", timers: [{ everyMinutes: 1440, body: "早报" }], rules: [] },
			{ source: "pager", timers: [{ everyMinutes: 30, body: "看看" }], rules: [] },
			{ source: "quotes", timers: [], rules: [] },
		],
	}), 0);
	assert.deepEqual(page.leftColumn(view).watching, [
		{ name: "inbox", rule: "有人找我先看一遍", hits: "今日 2 条" },
		{ name: "digest", rule: "每 1 天：早报", hits: "" },
		{ name: "pager", rule: "每 30 分钟：看看", hits: "" },
		{ name: "quotes", rule: "收到新消息时处理", hits: "" },
	]);
});

test("页面：今日来源消息 · N，明细只列不为 0 的去向", () => {
	const counts = (over: Partial<TodayCounts["byDisposition"]>) => ({ ...zeroToday(), byDisposition: { ...zeroToday().byDisposition, ...over } });
	assert.deepEqual(page.todayCopy(counts({})), { headline: "今日暂无来源消息", detail: "" });
	assert.deepEqual(page.todayCopy(counts({ opened_ticket: 2, delivered: 1, handed_over: 1, to_router: 1, ignored: 5, router_ignored: 4 })), {
		headline: "今日来源消息 · 14",
		detail: "新建任务 2 · 转入进行中任务 2 · 处理中 1 · 无需处理 9",
	});
	assert.deepEqual(page.todayCopy(counts({ opened_ticket: 1 })), { headline: "今日来源消息 · 1", detail: "新建任务 1" });
	assert.deepEqual(page.todayCopy(undefined), { headline: "", detail: "" });
});

test("页面：运行时长粗略到天、小时、分钟；只有这次启动恢复了任务，半小时内才提示已重启", () => {
	const H = 3_600_000;
	assert.equal(page.dutyLine({ since: 0, resumed: 0 }, (3 * 24 + 6) * H + 59_000), "在线 · 已运行 3 天 6 小时");
	assert.equal(page.dutyLine({ since: 0, resumed: 0 }, 2 * H + 5 * 60_000), "在线 · 已运行 2 小时 5 分钟");
	assert.equal(page.dutyLine({ since: 0, resumed: 0 }, 30_000), "在线 · 刚启动");
	assert.equal(page.dutyLine(undefined, 0), "");
	assert.equal(page.restartNotice({ since: 0, resumed: 2 }, 29 * 60_000), "已重启，进行中的任务已恢复");
	assert.equal(page.restartNotice({ since: 0, resumed: 2 }, 31 * 60_000), "");
	assert.equal(page.restartNotice({ since: 0, resumed: 0 }, 60_000), "");
	assert.equal(page.restartNotice(undefined, 0), "");
});

const tool = (name: string, args: unknown) => ({ role: "assistant", content: [{ type: "toolCall", name, arguments: args }] });
const result = (toolName: string, text: string, isError = false) => ({ role: "toolResult", toolName, isError, content: [{ type: "text", text }] });
const history = (ticketId: string, messages: unknown[]): HostToClient => ({ type: "transcript_history", ticketId, messages: messages as never });
const live = (ticketId: string, message: unknown): HostToClient => ({ type: "transcript", ticketId, message: message as never });
const watched = (messages: unknown[]) => {
	const w = page.emptyWatch("tkt_1");
	page.applyTranscript(w, history("tkt_1", messages));
	return w.steps;
};

test("页面：工具调用写成步骤名称，未知工具写「调用工具 名字」，原始参数留在 raw 里", () => {
	const steps = watched([tool("web_get", { url: "https://example.com/a?b=1" }), tool("read", { path: "/w/notes/a.md" }), tool("mystery", { x: 1 })]);
	assert.deepEqual(steps.map((s) => [s.title, s.detail, s.state]), [["读取网页", "example.com", "pending"], ["读取文件", "a.md", "pending"], ["调用工具 mystery", "", "pending"]]);
	assert.match(steps[0].raw, /web_get/);
	assert.match(steps[0].raw, /https:\/\/example\.com\/a\?b=1/);
});

test("页面：report 带问题是提出问题，ready 是提交结果，blocked 和 failed 是报告受阻", () => {
	const steps = watched([
		tool("report", { status: "progress", summary: "需要确认", question: "用 A 还是 B？" }),
		tool("report", { status: "ready", summary: "标题是 Example Domain" }),
		tool("report", { status: "blocked", summary: "缺少权限" }),
		tool("report", { status: "failed", summary: "网站打不开" }),
		tool("report", { status: "progress", summary: "读完一半" }),
		tool("report", { status: "no_action", summary: "不用做" }),
	]);
	assert.deepEqual(steps.map((s) => [s.title, s.detail]), [
		["提出问题", "用 A 还是 B？"], ["提交结果", "标题是 Example Domain"], ["报告受阻", "缺少权限"], ["报告受阻", "网站打不开"], ["汇报进度", "读完一半"], ["无需处理", "不用做"],
	]);
});

test("页面：工具结果并进最近一个同名的待完成步骤，出错的标成 error；思考步骤里不出现 thinking", () => {
	const steps = watched([
		{ role: "assistant", content: [{ type: "thinking", thinking: "内心独白" }, { type: "text", text: "我先打开网页" }, { type: "toolCall", name: "web_get", arguments: { url: "https://a.example" } }] },
		result("web_get", "<title>A</title>"),
		tool("web_get", { url: "https://b.example" }),
		result("web_get", "404", true),
	]);
	assert.deepEqual(steps.map((s) => [s.title, s.state]), [["思考", "ok"], ["读取网页", "ok"], ["读取网页", "error"]]);
	assert.equal(steps[0].detail, "我先打开网页");
	assert.match(steps[1].raw, /<title>A<\/title>/);
	assert.doesNotMatch(JSON.stringify(steps), /内心独白/);
});

test("页面：每种任务输入（formatInputs 生成的方括号标签）都有专门的步骤标题", () => {
	const titles = INPUT_KINDS.map((kind) => {
		const content = formatInputs({} as never, [{ id: "inp", ticketId: "tkt_1", kind, triggerId: null, body: "读取网页标题\n第二行", createdAt: 0, deliveredAt: null }]);
		const [step] = watched([{ role: "user", content }]);
		assert.equal(step.detail, "读取网页标题", kind);
		return step.title;
	});
	assert.equal(new Set(titles).size, INPUT_KINDS.length, "每种输入各有标题；若有一种落到兜底，会和 trigger 的「收到新消息」重复");
	assert.equal(watched([{ role: "user", content: "[没见过的标签]\n正文" }])[0].title, "收到新消息");
	assert.deepEqual(watched([{ role: "user", content: "[任务说明]\n读网页\n\n[使用者的话（经 Router 转交）]\n快一点" }]).map((s) => s.title), ["接收任务", "收到你的补充说明"]);
	assert.deepEqual(watched([{ role: "custom", customType: "psa-bg-result", content: "[后台命令结束] bg_1 退出码 0" }]).map((s) => s.title), ["后台命令完成"]);
});

test("页面：历史替换步骤，重连再来一次结果不变；别的任务的帧被忽略", () => {
	const w = page.emptyWatch("tkt_1");
	const first = tool("web_get", { url: "https://a.example" });
	assert.equal(page.applyTranscript(w, history("tkt_1", [first])), true);
	assert.equal(page.applyTranscript(w, live("tkt_1", result("web_get", "ok"))), true);
	page.applyTranscript(w, history("tkt_1", [first, result("web_get", "ok")]));
	assert.deepEqual(w.steps.map((s) => [s.title, s.state]), [["读取网页", "ok"]]);
	assert.equal(page.applyTranscript(w, live("tkt_2", tool("read", { path: "x" }))), false);
	assert.equal(page.applyTranscript(w, history("tkt_2", [])), false);
	assert.equal(w.steps.length, 1);
});

test("页面：右栏小字是唯一出现模型、用量、工具次数、用时和编号的地方，执行中的用时在本地累加", () => {
	assert.equal(page.smallPrint(row({ fellBack: true }), 65_000, 0), "模型 gpt-6.1-sol（已回退） · 1.5k tokens · 工具调用 2 次 · 用时 1分10秒 · 编号 abcd");
	assert.equal(page.smallPrint(row({ stage: "idle", model: null }), 65_000, 0), "模型 未启动 · 1.5k tokens · 工具调用 2 次 · 用时 5秒 · 编号 abcd");
	assert.equal(page.smallPrint(undefined, 0, 0), "");
	const left = page.leftColumn(withRows([row({ stage: "running", latestSummary: "x" })]), 0);
	const shown = left.doing.map(({ id, ...visible }) => visible);
	assert.doesNotMatch(JSON.stringify(shown), /gpt|tok|abcd/, "左栏卡片上看不到编号、模型和用量");
});

test("页面：200 是已发送，401 是链接失效，其他状态是发送失败，超时和网络错误是未收到确认", () => {
	assert.equal(page.sayOutcome({ status: 200 }), "delivered");
	assert.equal(page.sayOutcome({ status: 401 }), "expired");
	for (const status of [400, 403, 413, 415, 500]) assert.equal(page.sayOutcome({ status }), "rejected", String(status));
	assert.equal(page.sayOutcome("timeout"), "maybe_lost");
	assert.equal(page.sayOutcome("network"), "maybe_lost");
	assert.match(page.SAY_COPY.maybe_lost, /未收到确认.*对话.*重新发送/);
});

test("页面：未收到确认的话随后出现在对话里时，改为已发送，输入框里还是这句话就清空", () => {
	const text = "读取 example.com 的网页标题";
	const lost = { state: "maybe_lost" as const, text };
	const mine = { id: "trg_1", who: "user" as const, text, at: 1 };
	assert.deepEqual(page.settleSay(lost, text, [mine]), { state: "delivered", composer: "" });
	assert.deepEqual(page.settleSay(lost, "我又改了", [mine]), { state: "delivered", composer: "我又改了" }, "用户已经改了输入框就不动");
	assert.deepEqual(page.settleSay(lost, text, []), { state: "maybe_lost", composer: text });
	assert.deepEqual(page.settleSay(lost, text, [{ ...mine, text: "另一句" }]), { state: "maybe_lost", composer: text });
	assert.deepEqual(page.settleSay(lost, text, [{ ...mine, who: "router" }]), { state: "maybe_lost", composer: text }, "幕僚长说了同样的话不算");
	assert.deepEqual(page.settleSay({ state: "rejected", text }, text, [mine]), { state: "rejected", composer: text }, "服务器明确拒绝的不改");
});

test("页面：发送失败时按状态码显示固定文案，不显示服务器正文", () => {
	const shown = (status: number) => page.sayCopy(page.sayOutcome({ status }), status);
	assert.equal(shown(400), "发送失败：内容为空或格式不正确。");
	assert.equal(shown(401), page.SAY_COPY.expired);
	assert.equal(shown(403), "发送失败：请求来源不被允许。");
	assert.equal(shown(413), "发送失败：内容过长，请分几次发送。");
	assert.equal(shown(415), "发送失败：请求格式不正确。");
	for (const status of [404, 405, 500, 502]) assert.equal(shown(status), "发送失败，请稍后重试。", String(status));
	assert.equal(shown(200), page.SAY_COPY.delivered);
	assert.equal(page.sayCopy("maybe_lost"), page.SAY_COPY.maybe_lost);
});

test("页面：只含空白的话不能发", () => {
	assert.equal(page.canSend(" \n\t "), false);
	assert.equal(page.canSend(" 好 "), true);
});

test("页面：主题优先用保存的选择，保存的值不认识时跟随系统", () => {
	assert.equal(page.resolveTheme("dark", false), "dark");
	assert.equal(page.resolveTheme("light", true), "light");
	assert.equal(page.resolveTheme(null, true), "dark");
	assert.equal(page.resolveTheme("purple", false), "light");
	assert.equal(page.toggleTheme("dark"), "light");
});

test("页面：超过两个保活间隔（35 秒）没收到任何帧才算断线", () => {
	assert.equal(page.isStale(100_000, 130_000), false, "错过一次 ping 还不算");
	assert.equal(page.isStale(100_000, 135_000), false);
	assert.equal(page.isStale(100_000, 135_001), true);
});

type Got = { status: number; headers: http.IncomingHttpHeaders; body: string };

// node:http rather than fetch, because fetch refuses to send a custom Host header.
function request(url: string, options: { host?: string; method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Got> {
	return new Promise((resolve, reject) => {
		const headers = { ...(options.host ? { host: options.host } : {}), ...options.headers };
		const req = http.request(url, { method: options.method ?? "GET", headers }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => (body += chunk));
			res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.setTimeout(3000, () => req.destroy(new Error(`请求 3 秒没有响应：${url}`)));
		req.end(options.body);
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
async function webHost(t: TestContext, brain: Parameters<typeof startHost>[0] = () => [], options: Parameters<typeof startHost>[2] = {}) {
	const started = await startHost(brain, () => {}, { webPort: 0, ...options });
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

test("宿主：快照和 board 帧带今天的计数、值班时间和在盯着；等你回答的任务带上问题", async (t) => {
	const brain = (cards: string[]) => (cards[0]?.startsWith("[对话]") ? openOnConversation(cards[0]) : []);
	const watching = [{ source: "inbox", timers: [], rules: [{ id: "user/mail", text: "有人找我先看一遍", by: "user" as const }] }];
	const before = Date.now();
	const started = await startHost(brain, (w) => {
		w.report({ status: "progress", summary: "需要确认", question: "用 A 还是 B？" });
		w.settle();
	}, { webPort: 0, watching });
	t.after(() => started.host.stop());
	const { host } = started;
	const url = new URL(host.webUrl!);
	const at = (path: string) => `${url.origin}${path}?token=${url.searchParams.get("token")}`;
	const submit = (source: string, n: number) => host.kernel.submitTrigger({ source, externalId: `${source}${n}`, threads: [{ id: `thr_${source}${n}` }], sender: "s", body: "b", occurredAt: Date.now() });
	submit("inbox", 1);
	submit("inbox", 2);
	submit(WATCHDOG_SOURCE, 1);
	const live = sse(at("/events"));
	t.after(() => live.close());
	await until(() => live.got.length > 0, "快照");
	host.say("查天气");
	await until(() => ofType(live.got, "board").some((m) => m.rows.some((r) => r.latestQuestion === "用 A 还是 B？")), "board 帧带问题");
	const frame = ofType(live.got, "board").at(-1)!;
	assert.deepEqual(frame.today.byDisposition, { ignored: 0, delivered: 0, to_router: 2, opened_ticket: 0, handed_over: 0, router_ignored: 0 });
	assert.deepEqual(frame.today.bySource, { inbox: 2 });
	assert.ok(frame.duty.since >= before && frame.duty.since <= Date.now(), "值班从这次启动算起");
	assert.equal(frame.duty.resumed, 0);
	const fresh = sse(at("/events"));
	t.after(() => fresh.close());
	await until(() => fresh.got.length > 0, "第二个快照");
	const [snap] = ofType(fresh.got, "snapshot");
	assert.deepEqual(snap.watching, watching);
	const settled = (rows: typeof snap.board) => rows.map(({ elapsedMs, ...rest }) => rest);
	assert.deepEqual({ rows: settled(snap.board), today: snap.today, duty: snap.duty }, { rows: settled(frame.rows), today: frame.today, duty: frame.duty });
});

test("宿主：过了本地午夜即使没有任何动静，也推一帧看板，今日计数归零", async (t) => {
	let now = new Date(2026, 10, 9, 23, 59, 59, 800).getTime();
	const { host, events } = await webHost(t, () => [], { clock: { now: () => now } });
	host.kernel.submitTrigger({ source: "inbox", externalId: "e1", threads: [{ id: "thr_1" }], sender: "s", body: "b", occurredAt: now });
	assert.deepEqual(host.snapshot().today.bySource, { inbox: 1 });
	const stream = events();
	now = new Date(2026, 10, 10, 0, 0, 0, 0).getTime();
	await until(() => ofType(stream.got, "board").length > 0, "午夜的看板帧");
	assert.deepEqual(ofType(stream.got, "board")[0].today.bySource, {});
});

test("宿主：午夜推完看板后排好下一次", async (t) => {
	const { events } = await webHost(t, () => [], { clock: { now: () => new Date(2026, 10, 9, 23, 59, 59, 950).getTime() } });
	const stream = events();
	await until(() => ofType(stream.got, "board").length >= 2, "连续两个午夜的看板帧");
});

test("宿主：其他阶段的任务行 latestQuestion 为空；不传在盯着时快照里是空列表", async (t) => {
	const brain = (cards: string[]) => (cards[0]?.startsWith("[对话]") ? openOnConversation(cards[0]) : []);
	const { host } = await startHost(brain, (w) => {
		w.report({ status: "progress", summary: "做了一半" });
		w.settle();
	});
	t.after(() => host.stop());
	host.say("查天气");
	await until(() => host.snapshot().board.some((r) => r.latestSummary === "做了一半"), "汇报");
	assert.deepEqual(host.snapshot().board.map((r) => [r.stage, r.latestQuestion]), [["idle", null]]);
	assert.deepEqual(host.snapshot().watching, []);
});

test("宿主：这次启动恢复了执行中的任务，快照里的 duty.resumed 等于恢复数", async (t) => {
	const stateDir = tempStateDir();
	const brain = (cards: string[]) => (cards[0]?.startsWith("[对话]") ? openOnConversation(cards[0]) : []);
	const first = await startHost(brain, () => {}, { stateDir });
	first.host.say("一直做");
	await until(() => first.host.snapshot().board.some((r) => r.stage === "running"), "执行中");
	await first.host.stop();
	const second = await startHost(() => [], () => {}, { stateDir });
	t.after(() => second.host.stop());
	assert.equal(second.host.snapshot().duty.resumed, 1);
	const third = await startHost(() => [], () => {}, { stateDir: tempStateDir() });
	t.after(() => third.host.stop());
	assert.equal(third.host.snapshot().duty.resumed, 0);
});

async function sayHost(t: TestContext) {
	const web = await webHost(t);
	const origin = web.url.origin;
	const post = (body: string, over: { token?: string; origin?: string | null; type?: string; host?: string } = {}) =>
		request(web.at("/say", over.token ?? web.token), {
			method: "POST",
			host: over.host,
			body,
			headers: { "content-type": over.type ?? "application/json", ...(over.origin === null ? {} : { origin: over.origin ?? origin }) },
		});
	const userLines = () => web.host.kernel.conversation().filter((l) => l.who === "user").map((l) => l.text);
	return { ...web, post, userLines };
}

test("网关：正确的 POST /say 返回 triggerId，事件流收到同一句 user", async (t) => {
	const { post, events, userLines } = await sayHost(t);
	const stream = events();
	await until(() => stream.got.length > 0, "快照");
	const res = await post(JSON.stringify({ text: "帮我读一下 example.com 的网页标题" }));
	assert.equal(res.status, 200);
	assert.equal(res.headers["cache-control"], "no-store");
	const { triggerId } = JSON.parse(res.body);
	assert.match(triggerId, /^trg_/);
	await until(() => ofType(stream.got, "user").some((m) => m.id === triggerId && m.text === "帮我读一下 example.com 的网页标题"), "user");
	assert.deepEqual(userLines(), ["帮我读一下 example.com 的网页标题"]);
});

test("网关：POST /say 没有 token 401，Host 头不对 403，对话没有新增", async (t) => {
	const { post, url, userLines } = await sayHost(t);
	const body = JSON.stringify({ text: "偷偷说" });
	assert.equal((await post(body, { token: "" })).status, 401);
	assert.equal((await post(body, { token: "0".repeat(64) })).status, 401);
	assert.equal((await post(body, { host: `evil.example:${url.port}` })).status, 403);
	assert.deepEqual(userLines(), []);
});

test("网关：POST /say 的 Origin 是别的端口、别的域名或缺失，都 403，对话没有新增", async (t) => {
	const { post, url, userLines } = await sayHost(t);
	const body = JSON.stringify({ text: "跨站说" });
	for (const origin of [`http://127.0.0.1:${Number(url.port) + 1}`, "http://evil.example", `https://127.0.0.1:${url.port}`, "null", null]) {
		assert.equal((await post(body, { origin })).status, 403, String(origin));
	}
	assert.equal((await post(body, { origin: `http://localhost:${url.port}` })).status, 200, "localhost 也是本机这个页面");
	assert.deepEqual(userLines(), ["跨站说"]);
});

test("网关：POST /say 不是 JSON 时 415，跨站页面不经预检发不出这种请求", async (t) => {
	const { post, userLines } = await sayHost(t);
	for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
		assert.equal((await post(JSON.stringify({ text: "表单说" }), { type })).status, 415, type);
	}
	assert.equal((await post(JSON.stringify({ text: "带字符集" }), { type: "application/json; charset=utf-8" })).status, 200);
	assert.deepEqual(userLines(), ["带字符集"]);
});

test("网关：POST /say 超过 32 KB 413；正文不是 {text} 或只有空白 400；都不进对话", async (t) => {
	const { post, userLines } = await sayHost(t);
	assert.equal((await post(JSON.stringify({ text: "字".repeat(11_000) }))).status, 413);
	for (const body of ["", "不是 JSON", "[]", "null", JSON.stringify({ text: 3 }), JSON.stringify({ say: "x" }), JSON.stringify({ text: " \n\t " })]) {
		assert.equal((await post(body)).status, 400, body);
	}
	assert.equal((await post(JSON.stringify({ text: "字".repeat(2000) }))).status, 200, "2000 字照常送达");
	assert.equal(userLines().length, 1);
});

test("网关：POST /say 只有零宽或格式字符（夹着空白也算）时 400，不进对话", async (t) => {
	const { post, userLines } = await sayHost(t);
	for (const text of ["\u200b\u200b", "\u200c\u200d", "\u2060", "\ufeff", " \u200b\n\u00ad ", "\u202e\u2066"]) {
		assert.equal((await post(JSON.stringify({ text }))).status, 400, JSON.stringify(text));
	}
	assert.equal((await post(JSON.stringify({ text: "好\u200d的" }))).status, 200, "夹在字中间的零宽字符不影响送达");
	assert.deepEqual(userLines(), ["好\u200d的"]);
});

test("网关：GET /say 405；/say 以外的 POST 也是 405", async (t) => {
	const { at } = await webHost(t);
	assert.equal((await request(at("/say"))).status, 405);
	assert.equal((await request(at("/"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 405);
});

async function watchHost(t: TestContext) {
	const brain = (cards: string[]) => (cards[0]?.startsWith("[对话]") ? openOnConversation(cards[0]) : []);
	const stateDir = tempStateDir();
	const web = await webHost(t, brain, { stateDir });
	const open = async (title: string) => {
		web.host.say(title);
		let id = "";
		await until(() => {
			id = web.host.kernel.listTickets().find((r) => r.title === title)?.id ?? "";
			return web.spawner.workers.has(id);
		}, `任务 ${title}`);
		return { id, worker: web.spawner.workers.get(id)! };
	};
	const sessionFile = (ticketId: string) => join(stateDir, "sessions", "workers", `2026-11-08T00-00-00_${web.host.kernel.getTicket(ticketId)!.workerSessionId}.jsonl`);
	const history = (ticketId: string, messages: unknown[]) => {
		mkdirSync(join(stateDir, "sessions", "workers"), { recursive: true });
		const lines = [{ type: "session", id: web.host.kernel.getTicket(ticketId)!.workerSessionId }, ...messages.map((message) => ({ type: "message", message }))];
		writeFileSync(sessionFile(ticketId), lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
	};
	const watch = (ticketId: string, token = web.token) => {
		const stream = sse(`${web.url.origin}/transcript?token=${token}&ticket=${encodeURIComponent(ticketId)}`);
		t.after(() => stream.close());
		return stream;
	};
	return { ...web, open, history, sessionFile, watch };
}

const said = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

test("网关：查看任务先收到 transcript_history，再收到实时 transcript；系统消息不出现", async (t) => {
	const { open, history, watch } = await watchHost(t);
	const { id, worker } = await open("读网页");
	history(id, [{ role: "system", content: "你是 Worker" }, said("先看看")]);
	const stream = watch(id);
	await until(() => stream.got.length === 1, "历史");
	assert.equal(stream.status, 200);
	assert.deepEqual(stream.got[0], { type: "transcript_history", ticketId: id, messages: [said("先看看")] });
	worker.transcript(said("找到标题了"));
	await until(() => stream.got.length === 2, "实时");
	assert.deepEqual(stream.got[1], { type: "transcript", ticketId: id, message: said("找到标题了") });
});

test("网关：开始查看时，紧跟历史的第一条实时消息若和历史最后一条相同只收到一次", async (t) => {
	const { open, history, watch } = await watchHost(t);
	const { id, worker } = await open("读网页");
	history(id, [said("先看看")]);
	const stream = watch(id);
	await until(() => stream.got.length === 1, "历史");
	worker.transcript(said("先看看"));
	worker.transcript(said("找到了"));
	worker.transcript(said("先看看"));
	await until(() => stream.got.length >= 3, "实时");
	assert.deepEqual(ofType(stream.got, "transcript").map((m) => m.message), [said("找到了"), said("先看看")]);
});

test("网关：两个连接看不同任务，各自只收到自己的；关掉旧连接改看新任务后，旧任务的消息不再到达", async (t) => {
	const { open, watch } = await watchHost(t);
	const one = await open("任务一");
	const two = await open("任务二");
	const a = watch(one.id);
	const b = watch(two.id);
	await until(() => a.got.length === 1 && b.got.length === 1, "两份历史");
	one.worker.transcript(said("一的进展"));
	two.worker.transcript(said("二的进展"));
	await until(() => a.got.length === 2 && b.got.length === 2, "各自的实时消息");
	assert.deepEqual(ofType(a.got, "transcript").map((m) => m.ticketId), [one.id]);
	assert.deepEqual(ofType(b.got, "transcript").map((m) => m.ticketId), [two.id]);
	a.close();
	const switched = watch(two.id);
	await until(() => switched.got.length === 1, "新任务的历史");
	one.worker.transcript(said("一的后续"));
	two.worker.transcript(said("二的后续"));
	await until(() => switched.got.length === 2 && b.got.length === 3, "新任务的实时消息");
	assert.deepEqual(ofType(switched.got, "transcript").map((m) => m.ticketId), [two.id]);
	assert.equal(a.got.length, 2, "关掉的连接不再收到");
});

test("网关：Worker 写到一半被杀、会话文件最后一行不完整时，历史只含完整的行，宿主照常服务", async (t) => {
	const { open, history, sessionFile, watch, at } = await watchHost(t);
	const { id } = await open("读网页");
	history(id, [said("先看看"), said("找到了")]);
	appendFileSync(sessionFile(id), '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"写到一');
	const stream = watch(id);
	await until(() => stream.got.length === 1, "历史");
	assert.deepEqual(stream.got[0], { type: "transcript_history", ticketId: id, messages: [said("先看看"), said("找到了")] });
	assert.equal((await request(at("/"))).status, 200, "宿主还活着");
});

test("网关：处理请求时意外出错答 500，不带内部细节，记一行日志，进程不退出", async (t) => {
	const logs: string[] = [];
	const boom = () => {
		throw new Error("内部秘密 /Users/x/state.db");
	};
	const gateway = new WebGateway({ snapshot: boom, transcript: boom, say: boom }, (line) => logs.push(line));
	await gateway.listen(0);
	t.after(() => gateway.close());
	const url = new URL(gateway.url);
	const token = url.searchParams.get("token")!;
	const got = await request(`${url.origin}/transcript?token=${token}&ticket=tkt_abcd1234`);
	assert.equal(got.status, 500);
	assert.equal(got.headers["cache-control"], "no-store");
	assert.doesNotMatch(got.body, /秘密|Users|Error/);
	const said = await request(`${url.origin}/say?token=${token}`, { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ text: "你好" }) });
	assert.equal(said.status, 500);
	assert.doesNotMatch(said.body, /秘密/);
	assert.equal(logs.length, 2);
	assert.match(logs[0], /内部秘密/, "日志里有原因，便于排查");
	assert.equal((await request(`${url.origin}/?token=${token}`)).status, 200, "之后照常服务");
});

test("网关：/transcript 没有 token 401；ticket 不像任务编号 400；没有这个任务时历史为空", async (t) => {
	const { watch, token } = await watchHost(t);
	const noToken = watch("tkt_abc", "");
	const bad = watch("../etc", token);
	const empty = watch("tkt_nothere", token);
	await until(() => noToken.status === 401 && bad.status === 400, "拒绝");
	await until(() => empty.got.length === 1, "空历史");
	assert.deepEqual(empty.got[0], { type: "transcript_history", ticketId: "tkt_nothere", messages: [] });
});
