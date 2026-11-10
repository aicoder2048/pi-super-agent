import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { HostConnection } from "../src/client/connection.ts";
import type { HostToClient } from "../src/client/protocol.ts";
import type { MemberRun } from "../src/host/dispatch.ts";
import type { HostOptions } from "../src/host/host.ts";
import { onJsonLines, writeJsonLine } from "../src/jsonl.ts";
import type { Member } from "../src/teams.ts";
import { domainsOf, ids, ofType, startHost, tempStateDir, until, type Brain, type FakeWorker, type ToolCallSpec } from "./helpers/fakes.ts";

const NOON = Date.UTC(2026, 10, 9, 17, 0);
const MIDNIGHT = Date.UTC(2026, 10, 10, 5, 0);
const NEXT_DAY = Date.UTC(2026, 10, 10, 5, 30);
const DAY_MS = 86_400_000;
const ASK = "ask_cap_2026-11-09";
const SAID = "回答成员上限：今天放宽到 10";

const member = (name: string, title: string): Member => ({ name, title, description: `${title}的说明`, tools: undefined, skills: [], model: undefined, prompt: `你是${title}。`, file: `/agents/${name}.md` });
const CREW = [member("market-analyst", "行情分析师"), member("news-researcher", "新闻研究员"), member("chart-reader", "技术分析师")];
const DOMAINS = domainsOf({ watch: { team: "看盘队", crew: CREW } });

interface Options { configured?: number; stateDir?: string; clock?: { at: number; now(): number }; webPort?: number; onCard?: (card: string) => ToolCallSpec[]; crew?: Member[]; after?: HostOptions["after"] }

async function wholeCrewDispatched(t: TestContext, options: Options = {}) {
	const crew = options.crew ?? CREW;
	const clock = options.clock ?? { at: NOON, now: () => clock.at };
	const logs: string[] = [];
	const finish = new Map<string, () => void>();
	const runs = new Map<string, MemberRun>();
	let helper: FakeWorker | undefined;
	let opened = false;
	const brain: Brain = (cards) => cards.flatMap((card) => {
		if (!card.startsWith("[对话]")) return [];
		if (opened) return options.onCard?.(card) ?? [];
		opened = true;
		return [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId: ids(card, "trg"), title: "看盘", brief: "b", domain: "watch" }] } }];
	});
	const started = await startHost(brain, (w) => {
		if (helper) return;
		helper = w;
		crew.forEach((m, i) => void Promise.resolve(w.request("worker.dispatch", { callId: `call_${i}`, agent: m.name, task: "看一下" })).catch(() => {}));
	}, {
		domains: options.crew ? domainsOf({ watch: { team: "看盘队", crew } }) : DOMAINS,
		clock,
		log: (line) => logs.push(line),
		dispatch: { timeoutMs: 5000, codingTimeoutMs: 5000, stallMs: 5000, maxConcurrent: options.configured ?? 1 },
		...(options.stateDir && { stateDir: options.stateDir }),
		...(options.webPort !== undefined && { webPort: options.webPort }),
		...(options.after && { after: options.after }),
	} satisfies Partial<HostOptions>);
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await started.host.stop();
	};
	t.after(stop);
	started.spawner.runner = (run) => new Promise((done, fail) => {
		if (run.signal.aborted) return fail(run.signal.reason);
		runs.set(run.member.name, run);
		finish.set(run.member.name, () => done("答"));
		run.signal.addEventListener("abort", () => fail(run.signal.reason));
	});
	started.host.say("NVDA 今天为什么跌");
	await until(() => helper !== undefined, "助手开始工作");
	const states = () => Object.values(started.host.snapshot().dispatching).flat().map((d) => d.state);
	const count = (state: string) => states().filter((s) => s === state).length;
	const cap = () => started.host.snapshot().memberCap;
	const capLogs = () => logs.filter((line) => line.startsWith("[host] 成员上限"));
	return { ...started, helper: () => helper!, finish, runs, clock, logs, capLogs, count, cap, stop };
}

/** A connected client, after the frames already on their way have arrived. */
async function watching(t: TestContext, host: { socketPath: string }) {
	const got: HostToClient[] = [];
	const conn = new HostConnection({ socketPath: host.socketPath, onMessage: (m) => got.push(m), retryMs: 30 });
	conn.open();
	t.after(() => conn.close());
	await until(() => conn.connected, "连接");
	await new Promise((r) => setTimeout(r, 250));
	return { got, boards: () => ofType(got, "board") };
}

function handTimers() {
	const timers: { ms: number; run(): void }[] = [];
	const after: NonNullable<HostOptions["after"]> = (ms, run) => {
		timers.push({ ms, run });
		return () => {};
	};
	return { timers, after };
}

test("名额用完、有成员排队：看板带上宿主的问题和现在的上限，排队的照常等；这个问题不经过幕僚长", async (t) => {
	const { host, count, cap, capLogs, router } = await wholeCrewDispatched(t);
	await until(() => count("queued") === 2, "一位在做两位排队");
	assert.deepEqual(cap(), { limit: 1, question: { reportId: ASK, text: "现在有 2 位成员在排队，同时运行的成员上限是 1。今天放宽到 10 吗？", options: ["今天放宽到 10", "保持 1"], askedAt: NOON } });
	assert.equal(count("running"), 1);
	assert.equal(capLogs().length, 1, capLogs().join("\n"));
	await host.settled();
	assert.equal(router.batches.flat().some((card) => card.includes("成员上限") || card.includes(ASK)), false, "幕僚长没有收到关于这个问题的任何通知");
});

test("使用者点「今天放宽到 10」：上限马上是 10，排队的成员立刻开始；这句话记进对话，再点一次不重复", async (t) => {
	const { host, count, cap, capLogs } = await wholeCrewDispatched(t);
	await until(() => count("queued") === 2, "一位在做两位排队");
	const got: HostToClient[] = [];
	const conn = new HostConnection({ socketPath: host.socketPath, onMessage: (m) => got.push(m), retryMs: 30 });
	conn.open();
	t.after(() => conn.close());
	await until(() => conn.connected, "连接");
	assert.deepEqual(host.answer(ASK, 0), { ok: true, triggerId: ASK });
	await until(() => count("running") === 3, "三位都在做", 500);
	assert.deepEqual(cap(), { limit: 10, question: null });
	assert.deepEqual(host.answer(ASK, 0), { ok: true, triggerId: ASK });
	assert.deepEqual(host.answer(ASK, 1), { ok: false, refusal: { kind: "chosen", option: 0, label: "今天放宽到 10" } });
	assert.deepEqual(host.snapshot().conversation.filter((l) => l.id === ASK).map((l) => [l.who, l.text]), [["user", SAID]]);
	host.say("后面一句");
	await until(() => ofType(got, "user").some((m) => m.text === "后面一句"), "客户端收到后面那句话");
	assert.deepEqual(ofType(got, "user").map((m) => m.text), [SAID, "后面一句"], "再点一次和换项被拒都不再播这句话");
	assert.equal(capLogs().length, 2, capLogs().join("\n"));
});

test("使用者点「保持」：上限不变，排队的按原来的上限一位一位轮；这个纽约日里不再问", async (t) => {
	const { host, count, cap, finish, capLogs } = await wholeCrewDispatched(t);
	await until(() => count("queued") === 2, "一位在做两位排队");
	const { boards } = await watching(t, host);
	assert.deepEqual(host.answer(ASK, 1), { ok: true, triggerId: ASK });
	assert.deepEqual(cap(), { limit: 1, question: null });
	assert.equal(count("running"), 1);
	await until(() => boards().at(-1)?.memberCap?.question === null, "回答之后客户端收到一帧问题已经收起的看板");
	finish.get("market-analyst")!();
	await until(() => finish.has("news-researcher"), "第二位轮到");
	assert.equal(count("running"), 1);
	assert.equal(cap()?.question, null);
	assert.equal(capLogs().length, 2, capLogs().join("\n"));
});

test("宿主在同一个纽约日里重启，放宽还在；过了这一天上限回到配置值，记一行到期", async (t) => {
	const stateDir = tempStateDir();
	const first = await wholeCrewDispatched(t, { stateDir });
	await until(() => first.count("queued") === 2, "一位在做两位排队");
	first.host.answer(ASK, 0);
	await first.stop();
	const second = await wholeCrewDispatched(t, { stateDir });
	await until(() => second.count("running") === 3, "重启后三位直接都在做");
	assert.deepEqual(second.cap(), { limit: 10, question: null });
	assert.deepEqual(second.capLogs(), []);
	await second.stop();
	const clock = { at: NEXT_DAY, now: () => clock.at };
	const third = await wholeCrewDispatched(t, { stateDir, clock });
	await until(() => third.count("queued") === 2, "隔天又是一位在做两位排队");
	assert.equal(third.cap()?.limit, 1);
	assert.equal(third.cap()?.question?.reportId, "ask_cap_2026-11-10", "新的一天重新问");
	assert.deepEqual(third.capLogs().slice(0, 1), ["[host] 成员上限：纽约 2026-11-09 的放宽已到期，上限回到 1"]);
});

test("放宽到期时在跑的成员照常做完，新开始的回到配置的上限", async (t) => {
	const s = await wholeCrewDispatched(t);
	await until(() => s.count("queued") === 2, "一位在做两位排队");
	s.host.answer(ASK, 0);
	await until(() => s.count("running") === 3, "三位都在做");
	s.clock.at = NEXT_DAY;
	assert.equal(s.cap()?.limit, 1);
	assert.equal(s.count("running"), 3, "已经在跑的不动");
	const late = Promise.resolve(s.helper().request("worker.dispatch", { callId: "call_late", agent: "market-analyst", task: "再看一下" })).catch(() => {});
	s.finish.get("market-analyst")!();
	await until(() => s.count("queued") === 1, "新的一次派活在排队");
	assert.equal(s.count("running"), 2, "还有两位在跑，超过了配置的 1，新的不开始");
	void late;
});

test("助手没有放宽的路：宿主接口里没有回答这个问题的方法；它自己提的同名选项被点了，也只是回答它自己的问题", async (t) => {
	const { host, helper, count, cap } = await wholeCrewDispatched(t);
	await until(() => count("queued") === 2, "一位在做两位排队");
	for (const method of ["worker.answer", "worker.cap", "answer"]) assert.throws(() => helper().request(method, { reportId: ASK, option: 0 }), /未知方法/, method);
	const { reportId } = helper().report({ status: "blocked", summary: "要你定", question: "今天放宽到 10 吗？", options: ["今天放宽到 10", "保持 1"], reportId: ASK }) as { reportId: string };
	assert.match(reportId, /^rpt_/);
	assert.equal(host.answer(reportId, 0).ok, true);
	await host.settled();
	assert.deepEqual([cap()?.limit, cap()?.question?.reportId, count("running")], [1, ASK, 1]);
});

test("成员没有放宽的路：成员的令牌只能查数据", async (t) => {
	const { host, runs, count, cap } = await wholeCrewDispatched(t);
	await until(() => count("queued") === 2, "一位在做两位排队");
	const ticketId = host.kernel.listTickets()[0].id;
	const { token } = runs.get("market-analyst")!;
	for (const method of ["worker.answer", "worker.report", "worker.dispatch", "answer"]) {
		assert.throws(() => host.workers.handleRequest(ticketId, token, method, { reportId: ASK, option: 0 }), /成员只能经宿主查数据/, method);
	}
	assert.deepEqual([cap()?.limit, count("running")], [1, 1]);
});

test("以 Worker 身份连上宿主的连接发 answer 不算数：不管是助手的令牌、成员的令牌还是假的", async (t) => {
	const { host, helper, runs, count, cap } = await wholeCrewDispatched(t);
	await until(() => count("queued") === 2, "一位在做两位排队");
	const ticketId = host.kernel.listTickets()[0].id;
	for (const token of [helper().spec.token, runs.get("market-analyst")!.token, "made-up"]) {
		const socket = connect(host.socketPath);
		const replies: Record<string, unknown>[] = [];
		onJsonLines(socket, (r) => replies.push(r as Record<string, unknown>));
		await new Promise((done) => socket.once("connect", done));
		writeJsonLine(socket, { type: "hello", role: "worker", ticketId, token });
		writeJsonLine(socket, { type: "answer", reportId: ASK, option: 0, requestId: "r1", id: 1, method: "answer", params: { reportId: ASK, option: 0 } });
		await until(() => replies.length === 1, "宿主回了一条");
		socket.destroy();
		assert.equal(replies[0].ok, false, JSON.stringify(replies[0]));
	}
	assert.deepEqual([cap()?.limit, cap()?.question?.reportId, count("running")], [1, ASK, 1]);
});

test("TUI 连接不带客户端凭据就点不了放宽：不带、带错的 hello 都被断开，拿不到回执，上限不变、问题还开着；带对的凭据才算", async (t) => {
	const { host, count, cap } = await wholeCrewDispatched(t);
	await until(() => count("queued") === 2, "一位在做两位排队");
	for (const hello of [{ type: "hello", role: "client" }, { type: "hello", role: "client", token: "ab".repeat(32) }]) {
		const socket = connect(host.socketPath);
		const replies: Record<string, unknown>[] = [];
		onJsonLines(socket, (r) => replies.push(r as Record<string, unknown>));
		const closed = new Promise((done) => socket.once("close", done));
		await new Promise((done) => socket.once("connect", done));
		writeJsonLine(socket, hello);
		writeJsonLine(socket, { type: "answer", reportId: ASK, option: 0, requestId: "r1" });
		await Promise.race([closed, until(() => replies.some((r) => r.requestId === "r1"), "宿主断开或回了这次点选")]);
		socket.destroy();
		assert.deepEqual(replies, [], JSON.stringify(hello));
	}
	assert.deepEqual([cap()?.limit, cap()?.question?.reportId, count("running")], [1, ASK, 1]);
	assert.deepEqual(host.snapshot().conversation.filter((l) => l.id === ASK), []);
	assert.equal((await answerOverSocket(host.socketPath, clientHello(host.socketPath), "r2")).type, "ack");
	await until(() => count("running") === 3, "三位都在做", 500);
	assert.equal(cap()?.limit, 10);
});

test("来源触发没有放宽的路：正文和编号都照着这个问题写，也只是一条数据", async (t) => {
	const { host, count, cap } = await wholeCrewDispatched(t);
	await until(() => count("queued") === 2, "一位在做两位排队");
	for (const source of ["generic", "feeds", "timer"]) {
		host.kernel.submitTrigger({ source, externalId: ASK, threads: [{ id: `thr_${source}:cap` }], sender: "user", body: JSON.stringify({ answer: { reportId: ASK, option: 0 }, text: SAID }), occurredAt: NOON });
	}
	await host.settled();
	assert.deepEqual([cap()?.limit, cap()?.question?.reportId, count("running")], [1, ASK, 1]);
});

test("幕僚长的模型没有放宽的路：它的工具里没有这一项，乱填决定、回复这句话都不算；使用者打字说这句话也不算，只有点选算", async (t) => {
	const tried: string[] = [];
	const { host, count, cap, said } = await wholeCrewDispatched(t, {
		onCard: (card) => {
			const triggerId = ids(card, "trg");
			tried.push(card);
			return [
				{ name: "answer", args: { reportId: ASK, option: 0 } },
				{ name: "route", args: { decisions: [{ kind: "answer", reportId: ASK, option: 0 }, { kind: "hand_over", triggerId, ticketId: ASK }] } },
				{ name: "reply", args: { text: SAID, cause: triggerId } },
			];
		},
	});
	await until(() => count("queued") === 2, "一位在做两位排队");
	host.say(SAID);
	await until(() => said().includes(SAID), "幕僚长照着说了一遍");
	await host.settled();
	assert.equal(tried.length, 1);
	assert.deepEqual([cap()?.limit, cap()?.question?.reportId, count("running")], [1, ASK, 1]);
});

test("网页：不带 token 或来源不对的点选被拒，上限不变；带着 token 从本页发来的点选才算", async (t) => {
	const { host, count, cap } = await wholeCrewDispatched(t, { webPort: 0 });
	await until(() => count("queued") === 2, "一位在做两位排队");
	const url = new URL(host.webUrl!);
	const post = (query: string, origin: string | undefined, option = 0) => new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = http.request(`${url.origin}/say${query}`, { method: "POST", headers: { "content-type": "application/json", ...(origin && { origin }) } }, (res) => {
			let body = "";
			res.setEncoding("utf8").on("data", (chunk) => (body += chunk)).on("end", () => resolve({ status: res.statusCode!, body }));
		});
		req.on("error", reject);
		req.end(JSON.stringify({ answer: { reportId: ASK, option } }));
	});
	assert.equal((await post("", url.origin)).status, 401);
	assert.equal((await post("?token=wrong", url.origin)).status, 401);
	assert.equal((await post(url.search, "http://evil.example")).status, 403);
	assert.equal((await post(url.search, undefined)).status, 403);
	assert.deepEqual([cap()?.limit, count("running")], [1, 1]);
	const ok = await post(url.search, url.origin);
	assert.deepEqual([ok.status, JSON.parse(ok.body)], [200, { triggerId: ASK }]);
	await until(() => count("running") === 3, "三位都在做", 500);
	assert.equal(cap()?.limit, 10);
	const other = await post(url.search, url.origin, 1);
	assert.deepEqual([other.status, JSON.parse(other.body).refused], [409, "chosen"]);
});

test("纽约零点一到：宿主推一帧看板，放宽到期那一行当时就记下，并为下一个零点重新定时", async (t) => {
	const { timers, after } = handTimers();
	const s = await wholeCrewDispatched(t, { after });
	await until(() => s.count("queued") === 2, "一位在做两位排队");
	assert.deepEqual(timers.map((x) => x.ms), [MIDNIGHT - NOON], "启动时定到纽约零点");
	s.host.answer(ASK, 0);
	await until(() => s.count("running") === 3, "三位都在做");
	const { boards } = await watching(t, s.host);
	const frames = boards().length;
	s.clock.at = MIDNIGHT;
	assert.equal(s.capLogs().length, 2, "零点到了、定时器还没响，没有人读上限，到期还没记");
	timers[0].run();
	assert.deepEqual(s.capLogs().slice(2), ["[host] 成员上限：纽约 2026-11-09 的放宽已到期，上限回到 1"]);
	await until(() => boards().length > frames, "零点推了一帧看板");
	assert.deepEqual(boards().at(-1)!.memberCap, { limit: 1, question: null });
	assert.deepEqual(timers.map((x) => x.ms), [MIDNIGHT - NOON, DAY_MS], "再定到下一个纽约零点");
	s.clock.at = MIDNIGHT + DAY_MS;
	timers[1].run();
	assert.equal(timers.length, 3, "每过一个零点都再定一次");
});

test("过了纽约零点还有成员在等名额：宿主为新的一天再问一次，不用等下一次派活", async (t) => {
	const { timers, after } = handTimers();
	const s = await wholeCrewDispatched(t, { after });
	await until(() => s.count("queued") === 2, "一位在做两位排队");
	s.host.answer(ASK, 1);
	const { boards } = await watching(t, s.host);
	s.clock.at = MIDNIGHT;
	timers[0].run();
	const asked = { reportId: "ask_cap_2026-11-10", text: "现在有 2 位成员在排队，同时运行的成员上限是 1。今天放宽到 10 吗？", options: ["今天放宽到 10", "保持 1"], askedAt: MIDNIGHT };
	assert.deepEqual(s.cap(), { limit: 1, question: asked });
	await until(() => boards().at(-1)?.memberCap?.question?.reportId === asked.reportId, "这一帧看板带着新一天的问题");
	assert.deepEqual(s.capLogs().slice(2), ["[host] 成员上限：2 位成员在排队，上限 1，已问使用者今天是否放宽到 10"]);
	assert.deepEqual(s.host.answer(asked.reportId, 0), { ok: true, triggerId: asked.reportId });
	await until(() => s.count("running") === 3, "点了新一天的放宽，排队的马上开始", 500);
});

test("零点时没有成员在等名额：不问", async (t) => {
	const { timers, after } = handTimers();
	const s = await wholeCrewDispatched(t, { after, configured: 3 });
	await until(() => s.count("running") === 3, "三位都在做");
	s.clock.at = MIDNIGHT;
	timers[0].run();
	assert.deepEqual(s.cap(), { limit: 3, question: null });
	assert.deepEqual(s.capLogs(), []);
});

test("问题记不进状态库：这次派活不受影响，照常排队、轮到、做完；日志里记一行", async (t) => {
	const s = await wholeCrewDispatched(t);
	await until(() => s.count("queued") === 2, "一位在做两位排队");
	s.clock.at = NEXT_DAY;
	storeBroken(s.host, new Error("SQLITE_BUSY: database is locked"));
	const late = Promise.resolve(s.helper().request("worker.dispatch", { callId: "call_late", agent: "market-analyst", task: "再看一下" })) as Promise<{ details: { state: string } }>;
	const outcome = late.then((r) => r.details.state, (error) => `派活出错：${String(error)}`);
	await until(() => s.count("queued") === 3, "新的一次派活也在排队");
	assert.deepEqual(s.capLogs().slice(1), ["[host] 成员上限：没能记下要问使用者的问题：SQLITE_BUSY: database is locked"]);
	assert.equal(s.cap()?.question, null);
	for (const name of ["market-analyst", "news-researcher", "chart-reader", "market-analyst"]) {
		await until(() => s.finish.has(name), `${name} 轮到`);
		const done = s.finish.get(name)!;
		s.finish.delete(name);
		done();
	}
	assert.equal(await outcome, "done");
});

function storeBroken(host: { kernel: { capAsks: { save: unknown } } }, error: Error) {
	const { capAsks } = host.kernel;
	const save = capAsks.save;
	capAsks.save = () => {
		throw error;
	};
	return () => void (capAsks.save = save);
}

const clientHello = (socketPath: string) => ({ type: "hello", role: "client", token: readFileSync(join(dirname(socketPath), "client-token"), "utf8").trim() });

async function answerOverSocket(socketPath: string, hello: object, requestId: string, option = 0) {
	const socket = connect(socketPath);
	const replies: Record<string, unknown>[] = [];
	onJsonLines(socket, (r) => replies.push(r as Record<string, unknown>));
	await new Promise((done) => socket.once("connect", done));
	writeJsonLine(socket, hello);
	writeJsonLine(socket, { type: "answer", reportId: ASK, option, requestId });
	await until(() => replies.some((r) => r.requestId === requestId), "宿主回了这次点选");
	socket.destroy();
	return replies.find((r) => r.requestId === requestId)!;
}

test("点了放宽而状态库写不进去：宿主照常运行，TUI 和网页都收到失败，上限不变、问题还开着、对话里没有这句话；状态库好了再点才放宽", async (t) => {
	const { host, count, cap, capLogs, logs } = await wholeCrewDispatched(t, { webPort: 0 });
	await until(() => count("queued") === 2, "一位在做两位排队");
	const mend = storeBroken(host, new Error("SQLITE_FULL: database or disk is full"));
	assert.deepEqual(await answerOverSocket(host.socketPath, clientHello(host.socketPath), "r1"), { type: "refused", requestId: "r1", reason: "宿主内部出错，这次点选没有生效，请再点一次；详情见宿主日志。" });
	const url = new URL(host.webUrl!);
	const post = () => fetch(`${url.origin}/say${url.search}`, { method: "POST", headers: { "content-type": "application/json", origin: url.origin }, body: JSON.stringify({ answer: { reportId: ASK, option: 0 } }) });
	assert.equal((await post()).status, 500);
	assert.deepEqual([cap()?.limit, cap()?.question?.reportId, count("running")], [1, ASK, 1]);
	assert.deepEqual(host.snapshot().conversation.filter((l) => l.id === ASK), []);
	assert.equal(capLogs().length, 1, capLogs().join("\n"));
	assert.equal(logs.filter((l) => l.startsWith("[socket] 客户端 answer 出错：") && l.includes("SQLITE_FULL")).length, 1, logs.join("\n"));
	mend();
	assert.equal((await answerOverSocket(host.socketPath, clientHello(host.socketPath), "r2")).type, "ack");
	await until(() => count("running") === 3, "三位都在做", 500);
	assert.deepEqual(host.snapshot().conversation.filter((l) => l.id === ASK).map((l) => l.text), [SAID]);
});

test("配置的上限已经是 10：成员排队也不问", async (t) => {
	const crew = Array.from({ length: 11 }, (_, i) => member(`m${i}`, `成员${i}`));
	const { count, cap, capLogs } = await wholeCrewDispatched(t, { configured: 10, crew });
	await until(() => count("queued") === 1, "十位在做一位排队");
	assert.deepEqual(cap(), { limit: 10, question: null });
	assert.deepEqual(capLogs(), []);
});

test("不能派活的宿主：看板上没有成员上限，拿这个问题的编号来回答被拒", async (t) => {
	const { host } = await startHost(() => [], () => {});
	t.after(() => host.stop());
	assert.equal(host.snapshot().memberCap, null);
	assert.deepEqual(host.answer(ASK, 0), { ok: false, refusal: { kind: "closed" } });
});
