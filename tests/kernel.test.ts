import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Kernel, nextStallAt } from "../src/kernel/kernel.ts";
import { SOLO_NAMES, TEAM_NAMES } from "../src/kernel/helper-names.ts";
import { refusalText } from "../src/kernel/question.ts";
import { openStore } from "../src/kernel/store.ts";
import { CONVERSATION_THREAD_ID, DISPOSITIONS } from "../src/kernel/types.ts";
import type { Basis, DomainBook, KernelConfig, TriggerSubmission } from "../src/kernel/types.ts";

const HOUR = 3_600_000;

function setup({ config, path = ":memory:", at = "2026-11-08T10:00:00", domains }: { config?: Partial<KernelConfig>; path?: string; at?: string; domains?: DomainBook } = {}) {
	const clock = { t: new Date(at).getTime(), now() { return this.t; } };
	const db = openStore(path);
	const logs: string[] = [];
	const kernel = new Kernel({
		domains,
		log: (line) => logs.push(line),
		db,
		clock,
		sourcePolicy: (t) => (t.source === "noise" ? "ignore" : "candidate"),
		isMarketSource: (source) => source === "toy-market",
		config,
	});
	let n = 0;
	const trigger = (over: Partial<TriggerSubmission> = {}) =>
		kernel.submitTrigger({
			source: "generic",
			externalId: `e${++n}-${clock.t}`,
			threads: [{ id: "thr_misc" }],
			sender: "script",
			body: "外部事件",
			occurredAt: clock.t,
			...over,
		});
	const say = (body: string) =>
		trigger({ source: "conversation", threads: [{ id: CONVERSATION_THREAD_ID }], sender: "user", body });
	const due = (kind?: string) => kernel.dueActions(1000).filter((a) => kind === undefined || a.kind === kind);
	const notices = () => due("router.notify").map((a) => a.payload);
	const wakes = () => due("worker.wake").map((a) => (a.payload as { ticketId: string }).ticketId);
	const drain = () => { for (const a of kernel.dueActions(1000)) kernel.completeAction(a.id); };

	function open(basis: Basis, { threads = [] as string[], title = `${basis} 任务`, source = "generic", domain = undefined as string | null | undefined, ruleId = "rule-1" } = {}) {
		let triggerId: string | undefined;
		if (basis === "request") triggerId = say(title).triggerId;
		if (basis === "rule") triggerId = trigger({ source, threads: [{ id: `thr_${source}:rule-${++n}` }], body: title }).triggerId;
		for (const id of threads) trigger({ threads: [{ id }] });
		const [result] = kernel.route([
			{ kind: "open_ticket", title, basis, ruleId: basis === "rule" ? ruleId : undefined, domain, triggerId, threads, brief: title },
		]);
		assert.ok(result.ok, `open_ticket rejected: ${!result.ok && result.reason}`);
		return result.ticketId!;
	}

	function run(ticketId: string) {
		assert.equal(kernel.claimSlot(ticketId), true);
		kernel.workerStarted(ticketId, { model: "openai-codex/gpt-6.1-sol" });
		kernel.markInputsDelivered(ticketId, kernel.pendingInputs(ticketId).map((i) => i.id));
	}

	function idle(ticketId: string) {
		run(ticketId);
		kernel.workerTurnEnded(ticketId, { bgRunning: false });
	}

	function handOverUserMessage(ticketId: string, body = "改成方案 B") {
		const { triggerId } = say(body);
		const [result] = kernel.route([{ kind: "hand_over", triggerId, ticketId }]);
		assert.ok(result.ok);
	}

	const stage = (ticketId: string) => kernel.getTicket(ticketId)!.stage;

	return { db, kernel, clock, logs, trigger, say, due, notices, wakes, drain, open, run, idle, handOverUserMessage, stage };
}

test("内核不引用任何 Pi 的包", () => {
	const dir = new URL("../src/kernel/", import.meta.url);
	const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
	assert.ok(files.length >= 4);
	for (const file of files) {
		assert.doesNotMatch(readFileSync(new URL(file, dir), "utf8"), /@earendil-works\//, file);
	}
});

test("同一条触发提交两次只存一次", () => {
	const { kernel, trigger, due } = setup();
	const first = trigger({ externalId: "same" });
	const actionsAfterFirst = due().length;
	const second = trigger({ externalId: "same", body: "换了正文" });
	assert.equal(second.duplicate, true);
	assert.equal(second.triggerId, first.triggerId);
	assert.equal(kernel.triggerLog().length, 1);
	assert.equal(due().length, actionsAfterFirst);
});

test("同一个 externalId 在不同来源下是两条触发", () => {
	const { kernel, trigger } = setup();
	trigger({ source: "a", externalId: "x" });
	assert.equal(trigger({ source: "b", externalId: "x" }).duplicate, false);
	assert.equal(kernel.triggerLog().length, 2);
});

test("每条触发都有去向记录", () => {
	const { kernel, trigger, say, open } = setup();
	open("rule", { threads: ["thr_pr"] });
	const ignored = trigger({ source: "noise" }).triggerId;
	const delivered = trigger({ threads: [{ id: "thr_pr" }] }).triggerId;
	const candidate = trigger({ threads: [{ id: "thr_new" }] }).triggerId;
	const routerIgnored = trigger({ threads: [{ id: "thr_new2" }] }).triggerId;
	kernel.route([{ kind: "ignore", triggerId: routerIgnored, reason: "与规则无关" }]);
	say("你好");

	const log = kernel.triggerLog();
	for (const t of log) assert.ok(DISPOSITIONS.includes(t.disposition), t.id);
	const byId = new Map(log.map((t) => [t.id, t]));
	assert.equal(byId.get(ignored)!.disposition, "ignored");
	assert.equal(byId.get(delivered)!.disposition, "delivered");
	assert.equal(byId.get(candidate)!.disposition, "to_router");
	assert.equal(byId.get(routerIgnored)!.disposition, "router_ignored");
	assert.equal(byId.get(routerIgnored)!.dispositionDetail, "与规则无关");
});

test("触发落到已订阅的线程：直接成为任务的输入，不产生给 Router 的候选", () => {
	const { kernel, trigger, notices, wakes, drain, open, idle } = setup();
	const ticketId = open("rule", { threads: ["thr_pr"] });
	idle(ticketId);
	drain();

	const { triggerId } = trigger({ threads: [{ id: "thr_pr" }], body: "CI 失败了" });

	assert.deepEqual(notices(), []);
	assert.deepEqual(wakes(), [ticketId]);
	const inputs = kernel.pendingInputs(ticketId);
	assert.equal(inputs.length, 1);
	assert.equal(inputs[0].kind, "trigger");
	assert.equal(inputs[0].triggerId, triggerId);
	assert.equal(inputs[0].body, "CI 失败了");
});

test("触发落到未订阅的线程：产生一条给 Router 的候选", () => {
	const { trigger, notices, wakes, open, drain } = setup();
	open("rule", { threads: ["thr_pr"] });
	drain();
	const { triggerId } = trigger({ threads: [{ id: "thr_other" }] });
	assert.deepEqual(notices(), [{ kind: "candidate", triggerId }]);
	assert.deepEqual(wakes(), []);
});

test("对话线程上的触发永远到 Router，即使有任务正在执行", () => {
	const { kernel, say, notices, drain, open, run } = setup();
	const ticketId = open("request");
	run(ticketId);
	drain();

	const { triggerId } = say("顺便看看天气");

	assert.equal(kernel.getTicket(ticketId)!.stage, "running");
	assert.deepEqual(notices(), [{ kind: "conversation", triggerId }]);
	assert.deepEqual(kernel.pendingInputs(ticketId), []);
});

test("对话线程不能被任务订阅", () => {
	const { kernel, say } = setup();
	const { triggerId } = say("帮我盯着");
	const [result] = kernel.route([
		{ kind: "open_ticket", title: "t", basis: "request", triggerId, threads: [CONVERSATION_THREAD_ID], brief: "b" },
	]);
	assert.equal(result.ok, false);
	assert.deepEqual(kernel.listTickets(), []);
});

test("来源配置为忽略的触发只留记录", () => {
	const { kernel, trigger, due, open, drain } = setup();
	open("rule", { threads: ["thr_pr"] });
	drain();
	const { triggerId } = trigger({ source: "noise", threads: [{ id: "thr_pr" }] });
	assert.equal(kernel.triggerLog().find((t) => t.id === triggerId)!.disposition, "ignored");
	assert.deepEqual(due(), []);
});

test("阶段：新任务在排队", () => {
	const { open, stage } = setup();
	assert.equal(stage(open("request")), "queued");
});

test("阶段：拿到名额后执行中", () => {
	const { open, run, stage } = setup();
	const id = open("request");
	run(id);
	assert.equal(stage(id), "running");
});

test("阶段：一轮结束且没有后台命令时空闲", () => {
	const { open, idle, stage } = setup();
	const id = open("request");
	idle(id);
	assert.equal(stage(id), "idle");
});

test("阶段：一轮结束仍有后台命令时保持执行中", () => {
	const { kernel, open, run, stage } = setup();
	const id = open("request");
	run(id);
	kernel.workerTurnEnded(id, { bgRunning: true });
	assert.equal(stage(id), "running");
});

test("阶段：一轮结束时还有未送达的输入，保持执行中并再次唤醒", () => {
	const { kernel, open, run, stage, drain, wakes } = setup();
	const id = open("request");
	run(id);
	drain();
	kernel.note({ ticketId: id, text: "补充一条事实" });
	drain();
	kernel.workerTurnEnded(id, { bgRunning: false });
	assert.equal(stage(id), "running");
	assert.deepEqual(wakes(), [id]);
});

test("阶段：Worker 提问后等你回答，使用者说话后不再等待", () => {
	const { kernel, open, idle, stage, handOverUserMessage } = setup();
	const id = open("request");
	idle(id);
	kernel.workerReport(id, { status: "progress", summary: "需要选方案", question: "用 A 还是 B？" });
	assert.equal(stage(id), "awaiting_answer");
	handOverUserMessage(id, "用 B");
	assert.equal(stage(id), "queued");
});

test("阶段：未答的问题优先于就绪", () => {
	const { kernel, open, run, stage } = setup();
	const id = open("request");
	run(id);
	kernel.workerReport(id, { status: "ready", summary: "草稿好了", question: "可以发吗？", waiting: true });
	assert.equal(stage(id), "awaiting_answer");
});

test("阶段：最近一条汇报是就绪时等你验收", () => {
	const { kernel, open, run, stage } = setup();
	const id = open("request");
	run(id);
	kernel.workerReport(id, { status: "ready", summary: "做完了", waiting: true });
	assert.equal(stage(id), "awaiting_review");
});

test("阶段：就绪之后又有新输入，不再算等你验收", () => {
	const { kernel, open, run, stage, handOverUserMessage } = setup();
	const id = open("request");
	run(id);
	kernel.workerReport(id, { status: "ready", summary: "做完了", waiting: true });
	handOverUserMessage(id, "再加一个图表");
	assert.notEqual(stage(id), "awaiting_review");
});

test("对话历史按先后列出使用者的话和 Router 的回复", () => {
	const { kernel, clock } = setup();
	const { triggerId } = kernel.submitTrigger({ source: "conversation", externalId: "c1", threads: [{ id: CONVERSATION_THREAD_ID }], sender: "user", body: "查天气", occurredAt: clock.now() });
	clock.t += 1000;
	kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "好的，去查了。", cause: triggerId });
	assert.deepEqual(kernel.conversation().map((m) => [m.who, m.text]), [["user", "查天气"], ["router", "好的，去查了。"]]);
});

test("对话去向：开了新任务、交给已有任务、幕僚长直接回答、幕僚长处理中、判断无需处理；幕僚长看过却什么都没做的不写", () => {
	const { kernel, say, drain } = setup();
	const opened = say("查天气").triggerId;
	const [first] = kernel.route([{ kind: "open_ticket", title: "查天气", basis: "request", triggerId: opened, brief: "查天气" }]);
	const handed = say("顺便看看明天").triggerId;
	kernel.route([{ kind: "hand_over", triggerId: handed, ticketId: first.ticketId! }]);
	const answered = say("在吗").triggerId;
	kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "在。", cause: answered });
	const dismissed = say("谢谢").triggerId;
	kernel.route([{ kind: "ignore", triggerId: dismissed, reason: "客套话" }]);
	const dropped = say("嗯").triggerId;
	drain();
	const pending = say("再查一下 NVDA").triggerId;
	assert.deepEqual(kernel.conversationRoutes(), {
		[opened]: { kind: "opened_ticket", ticketId: first.ticketId },
		[handed]: { kind: "handed_over", ticketId: first.ticketId },
		[answered]: { kind: "answered" },
		[dismissed]: { kind: "router_ignored" },
		[pending]: { kind: "pending" },
	});
	assert.equal(dropped in kernel.conversationRoutes(), false);
});

test("阶段：受阻或失败，直到使用者再说话", () => {
	const { kernel, open, idle, stage, handOverUserMessage } = setup();
	const blocked = open("request");
	idle(blocked);
	kernel.workerReport(blocked, { status: "blocked", summary: "缺少权限" });
	assert.equal(stage(blocked), "blocked_or_failed");
	handOverUserMessage(blocked, "权限给你了");
	assert.equal(stage(blocked), "queued");

	const failed = open("request");
	idle(failed);
	kernel.workerReport(failed, { status: "failed", summary: "编译不过" });
	assert.equal(stage(failed), "blocked_or_failed");
});

test("阶段：就绪且不再等待时任务结束，保留订阅记录", () => {
	const { kernel, open, idle, stage } = setup();
	const id = open("rule", { threads: ["thr_pr"] });
	idle(id);
	kernel.workerReport(id, { status: "ready", summary: "已合并" });
	assert.equal(stage(id), "closed");
	const found = kernel.read("thr_pr");
	assert.ok(found?.type === "thread");
	assert.deepEqual(found.subscribedTicketIds, [id]);
});

test("已结束任务订阅过的线程来新触发：不直达它，作为候选交给 Router，任务保持结束", () => {
	const { kernel, trigger, open, idle, drain, notices, wakes, stage } = setup();
	const id = open("rule", { threads: ["thr_pr"] });
	idle(id);
	kernel.workerReport(id, { status: "ready", summary: "已合并" });
	drain();

	const { triggerId } = trigger({ threads: [{ id: "thr_pr" }], body: "PR 有新评论" });

	assert.equal(kernel.triggerLog()[0].disposition, "to_router");
	assert.deepEqual(notices(), [{ kind: "candidate", triggerId }]);
	assert.deepEqual(wakes(), []);
	assert.equal(stage(id), "closed");
	assert.deepEqual(kernel.pendingInputs(id), []);
});

test("已结束任务订阅过的线程来新触发：Router 可以凭它开规则任务", () => {
	const { kernel, trigger, open, idle } = setup();
	const old = open("rule", { threads: ["thr_toy-market:TOYX"] });
	idle(old);
	kernel.workerReport(old, { status: "ready", summary: "报了一次价" });

	const { triggerId } = trigger({ source: "toy-market", threads: [{ id: "thr_toy-market:TOYX" }], body: "TOYX 跌 6%" });
	const [result] = kernel.route([
		{ kind: "open_ticket", basis: "rule", ruleId: "toy-market/big-move", triggerId, threads: ["thr_toy-market:TOYX"], title: "核实", brief: "核实" },
	]);

	assert.ok(result.ok, !result.ok ? result.reason : "");
	assert.notEqual(result.ticketId, old);
	assert.equal(kernel.getTicket(old)!.stage, "closed");
});

test("已结束任务订阅过的线程来新触发：Router 可以把它转交回旧任务，旧任务重新打开", () => {
	const { kernel, trigger, open, idle, wakes, drain, stage } = setup();
	const id = open("rule", { threads: ["thr_pr"] });
	idle(id);
	kernel.workerReport(id, { status: "ready", summary: "已合并" });
	drain();
	const { triggerId } = trigger({ threads: [{ id: "thr_pr" }], body: "PR 被回滚了" });

	const [result] = kernel.route([{ kind: "hand_over", triggerId, ticketId: id }]);

	assert.ok(result.ok, !result.ok ? result.reason : "");
	assert.notEqual(stage(id), "closed");
	assert.deepEqual(wakes(), [id]);
	assert.deepEqual(kernel.pendingInputs(id).map((i) => [i.kind, i.triggerId]), [["trigger", triggerId]]);
	trigger({ threads: [{ id: "thr_pr" }], body: "又有新评论" });
	assert.equal(kernel.triggerLog()[0].disposition, "delivered");
});

test("同一线程上既有已结束任务又有未结束任务：只直达未结束的那个", () => {
	const { kernel, trigger, open, idle, drain, notices, wakes } = setup();
	const closed = open("rule", { threads: ["thr_pr"] });
	idle(closed);
	kernel.workerReport(closed, { status: "no_action", summary: "无事" });
	const live = open("rule", { threads: ["thr_pr"] });
	idle(live);
	drain();

	trigger({ threads: [{ id: "thr_pr" }], body: "CI 失败了" });

	assert.deepEqual(notices(), []);
	assert.deepEqual(wakes(), [live]);
	assert.deepEqual(kernel.pendingInputs(closed), []);
});

test("汇报就绪、受阻、失败时通知 Router；进展不通知", () => {
	const { kernel, open, run, drain, notices } = setup();
	const id = open("request");
	run(id);
	drain();
	kernel.workerReport(id, { status: "progress", summary: "做了一半" });
	assert.deepEqual(notices(), []);
	const { reportId } = kernel.workerReport(id, { status: "blocked", summary: "缺少权限" });
	assert.deepEqual(notices(), [{ kind: "report", ticketId: id, reportId }]);
});

test("汇报带问题时以提问通知 Router", () => {
	const { kernel, open, run, drain, notices } = setup();
	const id = open("request");
	run(id);
	drain();
	const { reportId } = kernel.workerReport(id, { status: "progress", summary: "s", question: "A 还是 B？" });
	assert.deepEqual(notices(), [{ kind: "question", ticketId: id, reportId }]);
});

test("汇报无需处理：任务结束，不通知 Router，不产生回复动作", () => {
	const { kernel, open, run, drain, due, stage } = setup();
	const id = open("inference");
	run(id);
	drain();
	kernel.workerReport(id, { status: "no_action", summary: "行情正常" });
	assert.equal(stage(id), "closed");
	assert.deepEqual(due(), []);
});

test("使用者叫停的任务不再接收任何输入", () => {
	const { kernel, trigger, say, open, run, drain, due, notices, wakes, stage } = setup();
	const id = open("rule", { threads: ["thr_pr"] });
	run(id);
	drain();
	kernel.note({ ticketId: id, text: "x" });

	const [stopped] = kernel.route([{ kind: "stop", ticketId: id }]);
	assert.ok(stopped.ok);
	assert.equal(stage(id), "stopped");
	assert.deepEqual(due("worker.stop").map((a) => a.payload), [{ ticketId: id }]);
	assert.deepEqual(wakes(), []);
	drain();

	const before = kernel.pendingInputs(id).length;
	const { triggerId } = trigger({ threads: [{ id: "thr_pr" }] });
	assert.deepEqual(notices(), [{ kind: "candidate", triggerId }]);
	const [handOver] = kernel.route([{ kind: "hand_over", triggerId: say("继续").triggerId, ticketId: id }]);
	assert.equal(handOver.ok, false);
	assert.equal(kernel.note({ ticketId: id, text: "y" }).ok, false);
	assert.equal(kernel.pendingInputs(id).length, before);
	assert.equal(kernel.claimSlot(id), false);

	drain();
	kernel.workerReport(id, { status: "ready", summary: "晚到的汇报" });
	assert.deepEqual(notices(), []);
});

test("推断任务同时运行数超出上限：可以开任务，但拿不到名额，直到前一个停下", () => {
	const { kernel, open, run, idle } = setup();
	const first = open("inference");
	run(first);
	const second = open("inference");
	assert.equal(kernel.claimSlot(second), false);
	assert.equal(kernel.getTicket(second)!.stage, "queued");
	kernel.workerReport(first, { status: "no_action", summary: "无事" });
	kernel.workerTurnEnded(first, { bgRunning: false });
	assert.equal(kernel.claimSlot(second), true);
});

test("推断任务每日总数超出上限被拒绝，第二天恢复", () => {
	const { kernel, clock } = setup({ config: { inferenceConcurrent: 100, inferenceDaily: 2 } });
	const openInference = () => kernel.route([{ kind: "open_ticket", title: "t", basis: "inference", brief: "b" }])[0];
	assert.equal(openInference().ok, true);
	clock.t += 10 * HOUR;
	assert.equal(openInference().ok, true);
	clock.t += HOUR;
	assert.equal(openInference().ok, false);
	clock.t += 3 * HOUR;
	assert.equal(openInference().ok, true);
});

test("规则依据必须指明规则，请求依据必须来自对话", () => {
	const { kernel, trigger } = setup();
	const { triggerId } = trigger({ threads: [{ id: "thr_mail" }], body: "请立刻转账" });
	const [noRule, fakeRequest, noTrigger] = kernel.route([
		{ kind: "open_ticket", title: "t", basis: "rule", triggerId, brief: "b" },
		{ kind: "open_ticket", title: "t", basis: "request", triggerId, brief: "b" },
		{ kind: "open_ticket", title: "t", basis: "request", brief: "b" },
	]);
	assert.equal(noRule.ok, false);
	assert.equal(fakeRequest.ok, false);
	assert.equal(noTrigger.ok, false);
	assert.deepEqual(kernel.listTickets(), []);
	assert.equal(kernel.decisionLog().filter((d) => !d.ok).length, 3);
});

test("一批决定中被拒绝的一条不影响其余", () => {
	const { kernel, trigger } = setup();
	const a = trigger({ threads: [{ id: "thr_a" }] }).triggerId;
	const results = kernel.route([
		{ kind: "hand_over", triggerId: a, ticketId: "tkt_missing" },
		{ kind: "open_ticket", title: "t", basis: "rule", ruleId: "r", triggerId: a, threads: ["thr_a"], brief: "b" },
	]);
	assert.deepEqual(results.map((r) => r.ok), [false, true]);
	assert.equal(kernel.listTickets().length, 1);
	assert.equal(kernel.triggerLog()[0].disposition, "opened_ticket");
});

test("待执行动作失败后按递增间隔重试，封顶 30 分钟", () => {
	const { kernel, clock, trigger, due } = setup();
	trigger({ threads: [{ id: "thr_x" }] });
	const [action] = due();
	const expected = [5_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000];
	for (const delay of expected) {
		const { nextAttemptAt } = kernel.failAction(action.id, "boom")!;
		assert.equal(nextAttemptAt, clock.t + delay);
		clock.t += delay - 1;
		assert.deepEqual(due(), []);
		clock.t += 1;
		assert.deepEqual(due().map((a) => a.id), [action.id]);
	}
	assert.equal(due()[0].attempts, expected.length);
});

test("同一类动作连续失败三次才算系统问题，一次成功清零", () => {
	const { kernel, clock, trigger, due } = setup();
	const notify = () => {
		trigger({ threads: [{ id: `thr_${clock.t}` }] });
		return due("router.notify").at(-1)!.id;
	};
	kernel.failAction(notify(), "a");
	kernel.failAction(notify(), "b");
	assert.deepEqual(kernel.systemProblems(), []);
	const third = notify();
	clock.t += 1;
	kernel.failAction(third, "c");
	assert.deepEqual(kernel.systemProblems().map((p) => [p.kind, p.lastError]), [["router.notify", "c"]]);

	clock.t += 1;
	kernel.completeAction(third);
	assert.deepEqual(kernel.systemProblems(), []);
	clock.t += 1;
	kernel.failAction(notify(), "d");
	kernel.failAction(notify(), "e");
	assert.deepEqual(kernel.systemProblems(), []);
});

test("关闭再打开数据库后，任务、订阅、待执行动作都还在", () => {
	const dir = mkdtempSync(join(tmpdir(), "kernel-test-"));
	try {
		const path = join(dir, "state.db");
		const first = setup({ path });
		const id = first.open("rule", { threads: ["thr_pr"] });
		const pending = first.due().map((a) => a.id).sort();
		assert.ok(pending.length > 0);
		first.db.close();
		const reopened = setup({ path });
		assert.equal(reopened.kernel.getTicket(id)!.title, "rule 任务");
		const thread = reopened.kernel.read("thr_pr");
		assert.ok(thread?.type === "thread");
		assert.deepEqual(thread.subscribedTicketIds, [id]);
		assert.deepEqual(reopened.due().map((a) => a.id).sort(), pending);
		reopened.trigger({ externalId: "after-restart", threads: [{ id: "thr_pr" }] });
		assert.equal(reopened.kernel.triggerLog()[0].disposition, "delivered");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("回复超过 200 字被拒绝，按字符计数", () => {
	const { kernel, due, say } = setup();
	const cause = say("说点什么").triggerId;
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "字".repeat(201), cause }).ok, false);
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "🙂".repeat(200), cause }).ok, true);
	const replies = due("channel.reply");
	assert.equal(replies.length, 1);
	assert.equal((replies[0].payload as { text: string }).text, "🙂".repeat(200));
});

test("回复送达后记下回执，重复标记无效", () => {
	const { kernel, say } = setup();
	const result = kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "好的", cause: say("在吗").triggerId });
	assert.ok(result.ok);
	assert.equal(kernel.markReplyDelivered(result.replyId), true);
	assert.equal(kernel.markReplyDelivered(result.replyId), false);
});

test("推断任务不发确认：没有结果时针对它的回复被拒绝", () => {
	const { kernel, open, run } = setup();
	const id = open("inference");
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "已开始", cause: id }).ok, false);
	run(id);
	kernel.workerReport(id, { status: "progress", summary: "查到一半" });
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "进行中", cause: id }).ok, false);
	kernel.workerReport(id, { status: "ready", summary: "发现异常", drafts: [{ to: "x", body: "y" }] });
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "发现异常", cause: id }).ok, true);

	const request = open("request");
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "收到", cause: request }).ok, true);
});

test("名额：3 个执行中时第 4 个规则或推断任务排队，请求任务用保留名额", () => {
	const { kernel, open, run, stage } = setup({ config: { inferenceConcurrent: 10 } });
	for (let i = 0; i < 3; i++) run(open("rule"));
	const rule = open("rule");
	const inference = open("inference");
	assert.equal(kernel.claimSlot(rule), false);
	assert.equal(kernel.claimSlot(inference), false);
	assert.equal(stage(rule), "queued");

	const request = open("request");
	assert.equal(kernel.claimSlot(request), true);
	assert.equal(kernel.claimSlot(open("request")), false);
});

test("名额：使用者对已有任务的后续消息可以用保留名额", () => {
	const { kernel, open, idle, run, handOverUserMessage } = setup();
	const followed = open("rule");
	const noted = open("rule");
	idle(followed);
	idle(noted);
	for (let i = 0; i < 3; i++) run(open("rule"));

	kernel.note({ ticketId: noted, text: "一条事实" });
	assert.equal(kernel.claimSlot(noted), false);
	handOverUserMessage(followed);
	assert.equal(kernel.claimSlot(followed), true);
});

test("名额空出时唤醒排队最久的任务，带使用者消息和请求依据的优先", () => {
	const { kernel, open, run, drain, wakes } = setup({ config: { reservedSlots: 0 } });
	const busy = [open("rule"), open("rule"), open("rule")];
	busy.forEach(run);
	const olderRule = open("rule");
	const newerRequest = open("request");
	assert.equal(kernel.claimSlot(olderRule), false);
	assert.equal(kernel.claimSlot(newerRequest), false);
	drain();

	kernel.workerTurnEnded(busy[0], { bgRunning: false });
	assert.deepEqual(wakes(), [newerRequest]);
	drain();
	assert.equal(kernel.claimSlot(newerRequest), true);
	kernel.workerExited(busy[1]);
	assert.deepEqual(wakes(), [olderRule]);
});

test("重启恢复：执行中的任务附恢复说明重新唤醒，等你回答的任务保持原状", () => {
	const { kernel, open, run, idle, drain, wakes, stage } = setup();
	const running = open("request");
	run(running);
	const asking = open("request");
	idle(asking);
	kernel.workerReport(asking, { status: "progress", summary: "s", question: "A 还是 B？" });
	const idleTicket = open("request");
	idle(idleTicket);
	drain();

	assert.deepEqual(kernel.recoverOnStartup(), [running]);
	assert.deepEqual(wakes(), [running]);
	assert.equal(stage(running), "queued");
	assert.deepEqual(kernel.pendingInputs(running).map((i) => i.kind), ["recovery"]);
	assert.equal(stage(asking), "awaiting_answer");
	assert.deepEqual(kernel.pendingInputs(asking), []);
	assert.equal(stage(idleTicket), "idle");
	assert.deepEqual(kernel.recoverOnStartup(), []);
});

test("问状态只对空闲的 Worker 有效", () => {
	const { kernel, open, run, idle } = setup();
	const busy = open("request");
	run(busy);
	assert.equal(kernel.askStatus({ ticketId: busy }).ok, false);
	const quiet = open("request");
	idle(quiet);
	assert.equal(kernel.askStatus({ ticketId: quiet }).ok, true);
	assert.deepEqual(kernel.pendingInputs(quiet).map((i) => i.kind), ["status_query"]);
});

test("Worker 交回的输入通知 Router", () => {
	const { kernel, open, drain, notices } = setup();
	const id = open("request");
	drain();
	kernel.workerHandBack(id, { body: "这封邮件不属于本任务" });
	assert.deepEqual(notices(), [{ kind: "handback", ticketId: id, body: "这封邮件不属于本任务" }]);
});

test("后台命令结束的结果作为新输入送回", () => {
	const { kernel, open, run, drain, wakes } = setup();
	const id = open("request");
	run(id);
	kernel.workerTurnEnded(id, { bgRunning: true });
	drain();
	assert.ok(kernel.addBackgroundResult(id, "测试全部通过").ok);
	assert.deepEqual(kernel.pendingInputs(id).map((i) => [i.kind, i.body]), [["bg_result", "测试全部通过"]]);
	assert.deepEqual(wakes(), [id]);
});

test("读取：按 id 返回对象及下一跳的 id", () => {
	const { kernel, trigger } = setup();
	const { triggerId } = trigger({ threads: [{ id: "thr_pr", title: "PR #1" }] });
	const [opened] = kernel.route([
		{ kind: "open_ticket", title: "修 CI", basis: "rule", ruleId: "ci", triggerId, threads: ["thr_pr"], brief: "修好它" },
	]);
	assert.ok(opened.ok);
	const ticketId = opened.ticketId!;

	const t = kernel.read(triggerId);
	assert.ok(t?.type === "trigger");
	assert.deepEqual(t.threadIds, ["thr_pr"]);
	assert.deepEqual(t.ticketIds, [ticketId]);

	const th = kernel.read("thr_pr");
	assert.ok(th?.type === "thread");
	assert.equal(th.thread.title, "PR #1");
	assert.deepEqual(th.recentTriggerIds, [triggerId]);
	assert.deepEqual(th.subscribedTicketIds, [ticketId]);

	const tk = kernel.read(ticketId);
	assert.ok(tk?.type === "ticket");
	assert.equal(tk.originTriggerId, triggerId);
	assert.deepEqual(tk.threadIds, ["thr_pr"]);
	assert.deepEqual(tk.recentInputs.map((i) => i.kind), ["brief"]);

	assert.equal(kernel.read("tkt_missing"), undefined);
	assert.equal(kernel.read("whatever"), undefined);
});

test("看板显示模型、工具调用、token 用量和已运行时长", () => {
	const { kernel, clock, open, run } = setup();
	const id = open("request", { title: "写周报" });
	run(id);
	kernel.recordWorkerProgress(id);
	kernel.recordWorkerProgress(id);
	kernel.recordUsage(id, { provider: "deepseek", tokensIn: 1000, tokensOut: 200 });
	kernel.workerReport(id, { status: "progress", summary: "写了一半" });
	const reportedAt = clock.t;
	clock.t += 90_000;

	const [row] = kernel.listTickets();
	assert.deepEqual(
		{ ...row, id: undefined },
		{
			id: undefined,
			title: "写周报",
			stage: "running",
			basis: "request",
			latestSummary: "写了一半",
			question: null,
			stall: null,
			model: "openai-codex/gpt-6.1-sol",
			fellBack: false,
			toolCalls: 2,
			tokensIn: 1000,
			tokensOut: 200,
			elapsedMs: 90_000,
			lastProgressAt: reportedAt,
			helper: { name: SOLO_NAMES[0], role: "conversation", seq: 1 },
			workerState: "running",
			startedAt: reportedAt,
			endedAt: null,
		},
	);
	assert.equal(kernel.usageToday("deepseek"), 1200);
	clock.t += 24 * HOUR;
	assert.equal(kernel.usageToday("deepseek"), 0);
});

test("依据为规则的任务必须引用使用者写过的规则", () => {
	const kernel = new Kernel({
		db: openStore(":memory:"),
		clock: { now: () => 0 },
		sourcePolicy: () => "candidate",
		ruleAllows: (id) => id === "toy/big-move",
	});
	const { triggerId } = kernel.submitTrigger({ source: "toy", externalId: "q1", threads: [{ id: "thr_toy:q" }], sender: "feed", body: "涨 9%", occurredAt: 0 });
	const [fake, real] = kernel.route([
		{ kind: "open_ticket", basis: "rule", ruleId: "made-up", triggerId, title: "x", brief: "x" },
		{ kind: "open_ticket", basis: "rule", ruleId: "toy/big-move", triggerId, title: "x", brief: "x" },
	]);
	assert.equal(fake.ok, false);
	assert.equal(real.ok, true);
});

test("来源的读取位置跨重启保存", () => {
	const kernel = new Kernel({ db: openStore(":memory:"), clock: { now: () => 0 }, sourcePolicy: () => "candidate" });
	assert.equal(kernel.sourceCursor("timer"), undefined);
	kernel.setSourceCursor("timer", "100");
	kernel.setSourceCursor("timer", "200");
	assert.equal(kernel.sourceCursor("timer"), "200");
});

test("请求任务可以订阅还没出现过的来源线程，之后那条线程上的触发直达它", () => {
	const kernel = new Kernel({ db: openStore(":memory:"), clock: { now: () => 0 }, sourcePolicy: () => "candidate" });
	const { triggerId } = kernel.submitTrigger({ source: "conversation", externalId: "u1", threads: [{ id: CONVERSATION_THREAD_ID }], sender: "user", body: "盯着 build-42", occurredAt: 0 });
	const [bad, good] = kernel.route([
		{ kind: "open_ticket", basis: "request", triggerId, threads: ["build-42"], title: "x", brief: "x" },
		{ kind: "open_ticket", basis: "request", triggerId, threads: ["thr_ci:build-42"], title: "盯 CI", brief: "盯" },
	]);
	assert.equal(bad.ok, false);
	assert.equal(good.ok, true);
	kernel.submitTrigger({ source: "ci", externalId: "b1", threads: [{ id: "thr_ci:build-42" }], sender: "ci", body: "失败", occurredAt: 0 });
	assert.equal(kernel.triggerLog()[0].disposition, "delivered");
});

test("Worker 退出窗口里到达的输入不会丢：退出时补一次唤醒", () => {
	const kernel = new Kernel({ db: openStore(":memory:"), clock: { now: () => 0 }, sourcePolicy: () => "candidate" });
	const { triggerId } = kernel.submitTrigger({ source: "conversation", externalId: "u", threads: [{ id: CONVERSATION_THREAD_ID }], sender: "user", body: "盯着", occurredAt: 0 });
	const [opened] = kernel.route([{ kind: "open_ticket", basis: "request", triggerId, threads: ["thr_ci:b"], title: "盯", brief: "盯" }]);
	const id = (opened as { ticketId: string }).ticketId;
	kernel.claimSlot(id);
	kernel.markInputsDelivered(id, kernel.pendingInputs(id).map((i) => i.id));
	for (const a of kernel.dueActions()) kernel.completeAction(a.id);
	kernel.workerTurnEnded(id, { bgRunning: false });
	kernel.submitTrigger({ source: "ci", externalId: "b1", threads: [{ id: "thr_ci:b" }], sender: "ci", body: "失败", occurredAt: 0 });
	for (const a of kernel.dueActions()) kernel.completeAction(a.id);
	kernel.workerExited(id);
	assert.deepEqual(kernel.dueActions().map((a) => a.kind), ["worker.wake"]);
});

test("回退上限造成的受阻：任务记一条受阻汇报并移出排队，空出名额时不会被反复唤醒", () => {
	const { kernel, open, run, idle } = setup({ maxWorkers: 1, reservedSlots: 0 });
	const busy = open("request", { title: "占名额" });
	run(busy);
	const capped = open("request", { title: "被上限挡住" });
	kernel.blockForCap(capped, "回退模型今日用量已达上限");
	assert.equal(kernel.getTicket(capped)!.stage, "blocked_or_failed");
	kernel.blockForCap(capped, "回退模型今日用量已达上限");
	assert.equal(kernel.read(capped)!.type === "ticket" && (kernel.read(capped) as any).recentReports.length, 1);
	for (const a of kernel.dueActions()) kernel.completeAction(a.id);
	idle(busy);
	assert.ok(!kernel.dueActions().some((a) => a.kind === "worker.wake" && a.payload.ticketId === capped));
});

test("Router 的用量也按提供方计入每日累计", () => {
	const { kernel } = setup();
	kernel.recordRouterUsage({ provider: "deepseek", tokensIn: 300, tokensOut: 100 });
	assert.equal(kernel.usageToday("deepseek"), 400);
});

test("阶段：汇报就绪但附了一个问题时是等你回答，不是已结束", () => {
	const { kernel, open, run, stage } = setup();
	const id = open("request");
	run(id);
	kernel.workerReport(id, { status: "ready", summary: "草稿好了", question: "可以发吗？" });
	assert.equal(stage(id), "awaiting_answer");
});

test("对话历史每一行带稳定的 id：使用者的话是触发 id，Router 的回复是回复 id", () => {
	const { kernel, clock } = setup();
	const { triggerId } = kernel.submitTrigger({ source: "conversation", externalId: "c-id", threads: [{ id: CONVERSATION_THREAD_ID }], sender: "user", body: "查天气", occurredAt: clock.now() });
	const reply = kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "好的", cause: triggerId });
	assert.deepEqual(kernel.conversation().map((m) => m.id), [triggerId, reply.ok ? reply.replyId : "-"]);
});

function authoritySetup() {
	const kernel = new Kernel({
		db: openStore(":memory:"),
		clock: { now: () => 0 },
		sourcePolicy: (t) => (t.body.includes("噪音") ? "ignore" : "candidate"),
		ruleAllows: (ruleId, source) => ruleId === "toy/big-move" && source === "toy",
	});
	const said = (body: string) => kernel.submitTrigger({ source: "conversation", externalId: body, threads: [{ id: CONVERSATION_THREAD_ID }], sender: "user", body, occurredAt: 0 }).triggerId;
	const event = (source: string, body: string) => kernel.submitTrigger({ source, externalId: body, threads: [{ id: `thr_${source}:x` }], sender: source, body, occurredAt: 0 }).triggerId;
	const open = (basis: "request" | "rule" | "inference", triggerId?: string, ruleId?: string) =>
		({ kind: "open_ticket" as const, basis, triggerId, ruleId, title: "t", brief: "b" });
	return { kernel, said, event, open };
}

test("证据：一条对话可以在同一批决定里开多个任务，但处理过之后不能再支撑新的请求任务", () => {
	const { kernel, said, open } = authoritySetup();
	const hi = said("做 A 和 B");
	assert.deepEqual(kernel.route([open("request", hi), open("request", hi)]).map((r) => r.ok), [true, true]);
	assert.deepEqual(kernel.route([open("request", hi)]).map((r) => r.ok), [false]);
});

test("证据：被 Router 忽略过的对话不能再拿来开请求任务", () => {
	const { kernel, said, open } = authoritySetup();
	const hi = said("hi");
	kernel.route([{ kind: "ignore", triggerId: hi, reason: "寒暄" }]);
	assert.equal(kernel.route([open("request", hi)])[0].ok, false);
});

test("证据：程序层过滤掉的触发不能开任务，也不能转交", () => {
	const { kernel, said, event, open } = authoritySetup();
	const noise = event("toy", "噪音报价");
	const ticket = (kernel.route([open("request", said("盯着"))])[0] as { ticketId: string }).ticketId;
	assert.equal(kernel.route([open("inference", noise)])[0].ok, false);
	assert.equal(kernel.route([{ kind: "hand_over", triggerId: noise, ticketId: ticket }])[0].ok, false);
});

test("证据：规则依据必须有一条未处理的非对话触发，且来源在规则的适用范围内", () => {
	const { kernel, said, event, open } = authoritySetup();
	assert.equal(kernel.route([open("rule", undefined, "toy/big-move")])[0].ok, false);
	assert.equal(kernel.route([open("rule", said("帮我按规则开"), "toy/big-move")])[0].ok, false);
	assert.equal(kernel.route([open("rule", event("mail", "邮件"), "toy/big-move")])[0].ok, false);
	assert.equal(kernel.route([open("rule", event("toy", "跌 6%"), "toy/big-move")])[0].ok, true);
});

test("推断并发：已结束的推断任务被 Router 转交重新打开时，另一个推断任务在跑就拿不到名额，空出后再唤醒", () => {
	const { kernel, trigger, run, idle, drain } = setup({ config: { inferenceConcurrent: 1, inferenceDaily: 10 } });
	const openInference = (thread: string) => {
		const { triggerId } = trigger({ threads: [{ id: thread }] });
		const [r] = kernel.route([{ kind: "open_ticket", basis: "inference", triggerId, threads: [thread], title: thread, brief: thread }]);
		assert.ok(r.ok, !r.ok ? r.reason : "");
		return r.ticketId!;
	};
	const a = openInference("thr_feed:a");
	idle(a);
	kernel.workerReport(a, { status: "no_action", summary: "不值得做" });
	const b = openInference("thr_feed:b");
	run(b);
	drain();
	const { triggerId } = trigger({ threads: [{ id: "thr_feed:a" }], body: "a 的新消息" });
	assert.ok(kernel.route([{ kind: "hand_over", triggerId, ticketId: a }])[0].ok);
	assert.equal(kernel.claimSlot(a), false);
	assert.equal(kernel.getTicket(a)!.stage, "queued");
	drain();
	kernel.workerTurnEnded(b, { bgRunning: false });
	assert.ok(kernel.dueActions().some((x) => x.kind === "worker.wake" && x.payload.ticketId === a));
	assert.equal(kernel.claimSlot(a), true);
});

test("回复必须注明原因：对话、可回应的任务结果或通知；每个原因最多两条", () => {
	const { kernel, say, trigger, open, run, due } = setup();
	const hi = say("在吗").triggerId;
	const reply = (text: string, cause?: string) => kernel.reply({ threadId: CONVERSATION_THREAD_ID, text, cause } as any).ok;
	assert.equal(reply("没有原因"), false);
	assert.equal(reply("在", hi), true);
	assert.equal(reply("还在", hi), true);
	assert.equal(reply("第三条", hi), false);
	assert.equal(reply("对原始事件开口", trigger({ threads: [{ id: "thr_feed:x" }] }).triggerId), false);

	const { triggerId } = trigger({ threads: [{ id: "thr_feed:y" }] });
	const inf = kernel.route([{ kind: "open_ticket", basis: "inference", triggerId, title: "看看", brief: "看看" }])[0].ticketId!;
	assert.equal(reply("我开始悄悄看了", inf), false);
	run(inf);
	kernel.workerReport(inf, { status: "progress", summary: "看了一半" });
	assert.equal(reply("进展", inf), false);
	kernel.workerReport(inf, { status: "ready", summary: "发现一处异常" });
	assert.equal(reply("推断任务有结果了", inf), true);

	const req = open("request");
	assert.equal(reply("请求任务的确认", req), true);

	kernel.notifyRouter("模型已回退");
	const notice = due("router.notify").find((a) => a.payload.kind === "notice")!;
	assert.equal(reply("告诉你模型回退了", notice.id), true);
});

test("推断任务汇报无需处理之后，不能再以它为原因回复", () => {
	const { kernel, trigger, run } = setup();
	const { triggerId } = trigger({ threads: [{ id: "thr_feed:z" }] });
	const inf = kernel.route([{ kind: "open_ticket", basis: "inference", triggerId, title: "看看", brief: "看看" }])[0].ticketId!;
	run(inf);
	kernel.workerReport(inf, { status: "no_action", summary: "不值得做" });
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "我看过了，没事", cause: inf } as any).ok, false);
});

test("系统问题的起点是上次成功之后的第一次失败，失败持续期间不变，成功一次后重新算", () => {
	const { kernel, clock, say } = setup();
	const failAll = () => { for (const a of kernel.dueActions(1000)) if (a.kind === "channel.reply") kernel.failAction(a.id, "down"); };
	kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "一", cause: say("a").triggerId });
	const start = clock.t;
	for (let i = 0; i < 6; i++) { failAll(); clock.t += 31 * 60_000; }
	assert.equal(kernel.systemProblems().find((p) => p.kind === "channel.reply")!.since, start);
	kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "二", cause: say("b").triggerId });
	for (const a of kernel.dueActions(1000)) if (a.kind === "channel.reply") kernel.completeAction(a.id);
	assert.equal(kernel.systemProblems().find((p) => p.kind === "channel.reply"), undefined);
});

test("开任务缺标题或任务说明时，只拒绝这一条决定，同一批的其他决定和决策日志照常保留", () => {
	const { kernel, say } = setup();
	const hi = say("做两件事").triggerId;
	const results = kernel.route([
		{ kind: "open_ticket", basis: "request", triggerId: hi, brief: "没有标题" } as any,
		{ kind: "open_ticket", basis: "request", triggerId: hi, title: "有标题", brief: "正常" },
	]);
	assert.deepEqual(results.map((r) => r.ok), [false, true]);
	assert.equal(kernel.decisionLog().length, 2);
});

test("今天的触发按来源和去向计数，从本地零点算起，不受条数上限影响", () => {
	const { kernel, clock, trigger } = setup();
	clock.t = new Date("2026-11-07T23:59:00").getTime();
	trigger({ source: "inbox" });
	clock.t = new Date("2026-11-08T00:00:00").getTime();
	for (let i = 0; i < 120; i++) trigger({ source: "inbox", threads: [{ id: `thr_${i}` }] });
	trigger({ source: "noise" });
	trigger({ source: "noise" });
	clock.t = new Date("2026-11-08T10:00:00").getTime();
	const counts = kernel.triggerCountsToday().sort((a, b) => a.source.localeCompare(b.source));
	assert.deepEqual(counts, [
		{ source: "inbox", disposition: "to_router", count: 120 },
		{ source: "noise", disposition: "ignored", count: 2 },
	]);
});

test("Worker 的问题可以带选项，读任务时原样读回；不带选项的汇报读回空列表", () => {
	const { kernel, open, run } = setup();
	const id = open("request");
	run(id);
	kernel.workerReport(id, { status: "progress", summary: "做了一半" });
	kernel.workerReport(id, { status: "blocked", summary: "两种口径", question: "要看哪部分？", options: ["只看营收", "营收和利润", "先不查"] });
	const found = kernel.read(id);
	assert.ok(found?.type === "ticket");
	assert.deepEqual(found.recentReports.map((r) => r.options), [["只看营收", "营收和利润", "先不查"], []]);
});

test("旧数据库的汇报表没有选项列：打开时补上，旧汇报读回空列表", () => {
	const path = join(mkdtempSync(join(tmpdir(), "psa-kernel-")), "state.db");
	const first = setup({ path });
	const id = first.open("request");
	first.run(id);
	first.kernel.workerReport(id, { status: "progress", summary: "旧汇报" });
	first.db.exec("ALTER TABLE reports DROP COLUMN options");
	first.db.close();
	const again = setup({ path });
	const found = again.kernel.read(id);
	assert.ok(found?.type === "ticket");
	assert.deepEqual(found.recentReports.map((r) => [r.summary, r.options]), [["旧汇报", []]]);
});

test("看板：等回答的任务带上它在等的问题（汇报 id、文字、选项、提问时间、还没回答）；其他阶段没有问题", () => {
	const { kernel, clock, open, run, idle, handOverUserMessage } = setup();
	const asking = open("request", { title: "查财报" });
	run(asking);
	const { reportId } = kernel.workerReport(asking, { status: "blocked", summary: "两种口径", question: "要看哪部分？", options: ["只看营收", "先不查"] });
	const askedAt = clock.t;
	const open2 = open("request", { title: "写周报" });
	idle(open2);
	clock.t += 1000;
	const rows = () => Object.fromEntries(kernel.listTickets().map((r) => [r.title, r.question]));
	assert.deepEqual(rows(), {
		查财报: { reportId, text: "要看哪部分？", options: ["只看营收", "先不查"], askedAt, click: null, spoke: false },
		写周报: null,
	});
	handOverUserMessage(asking, "只看营收");
	assert.equal(rows().查财报, null, "使用者回答后不再等");
});

function askSetup() {
	const s = setup();
	const ticketId = s.open("request", { title: "查财报" });
	s.run(ticketId);
	const ask = (options = ["只看营收", "营收和利润", "先不查"]) =>
		s.kernel.workerReport(ticketId, { status: "blocked", summary: "两种口径", question: "要看哪部分？", options }).reportId;
	const reportId = ask();
	s.drain();
	const answer = (option: number, id = reportId) => s.kernel.answerQuestion({ reportId: id, option, at: s.clock.t });
	const userLines = () => s.kernel.conversation().filter((l) => l.who === "user").map((l) => l.text);
	const row = () => s.kernel.listTickets().find((r) => r.id === ticketId)!;
	return { ...s, ticketId, reportId, ask, answer, userLines, row };
}

test("点选回答：成为使用者在对话里说的一句「回答任务「标题」：选项」，交给 Router 处理，任务还没收到", () => {
	const { kernel, ticketId, answer, userLines, notices, row } = askSetup();
	const result = answer(1);
	assert.ok(result.ok);
	assert.equal(result.duplicate, false);
	assert.equal(result.text, "回答任务「查财报」：营收和利润");
	assert.deepEqual(userLines().at(-1), "回答任务「查财报」：营收和利润");
	assert.deepEqual(notices(), [{ kind: "conversation", triggerId: result.triggerId }]);
	assert.deepEqual(kernel.pendingInputs(ticketId), [], "Router 转交之前任务收不到");
	assert.equal(row().stage, "awaiting_answer");
	assert.deepEqual(row().question?.click, { option: 1, state: "sent", triggerId: result.triggerId }, "所有客户端都看得到点了哪一个、还在等幕僚长转交");
});

test("点选回答转交给任务之后才算已回答：任务继续执行，看板上这个问题留着、标着点了哪一个，直到任务下一次汇报", () => {
	const { kernel, ticketId, answer, row } = askSetup();
	const { triggerId } = answer(2) as { triggerId: string };
	assert.ok(kernel.route([{ kind: "hand_over", triggerId, ticketId }])[0].ok);
	assert.equal(row().stage, "running");
	assert.deepEqual(row().question?.click, { option: 2, state: "handed_over", triggerId });
	kernel.workerReport(ticketId, { status: "progress", summary: "在查利润" });
	assert.equal(row().question, null);
});

test("幕僚长忽略点选、或处理完这张卡片却没有转交时，这次点选作废：按钮重新可点，再点是一条新的触发", () => {
	for (const end of ["ignore", "turn"] as const) {
		const { kernel, ticketId, answer, row, due, notices } = askSetup();
		const first = answer(0) as { triggerId: string };
		if (end === "ignore") assert.ok(kernel.route([{ kind: "ignore", triggerId: first.triggerId, reason: "看不懂" }])[0].ok);
		else for (const a of due("router.notify")) kernel.completeAction(a.id);
		assert.equal(row().stage, "awaiting_answer", end);
		assert.deepEqual(row().question?.click, { option: 0, state: "dropped", triggerId: first.triggerId }, end);
		const again = answer(1);
		assert.ok(again.ok && !again.duplicate, end);
		assert.notEqual(again.triggerId, first.triggerId, end);
		assert.deepEqual(row().question?.click, { option: 1, state: "sent", triggerId: again.triggerId }, end);
		assert.deepEqual(notices().at(-1), { kind: "conversation", triggerId: again.triggerId }, end);
		assert.ok(kernel.route([{ kind: "hand_over", triggerId: again.triggerId, ticketId }])[0].ok, end);
	}
});

test("点选回答的那句话里，任务标题最多 40 个字，超出的截断加省略号；看板仍然知道点的是哪一项", () => {
	const { kernel, clock, open, run, drain } = setup();
	const title = "把".repeat(45);
	const ticketId = open("request", { title });
	run(ticketId);
	const { reportId } = kernel.workerReport(ticketId, { status: "blocked", summary: "s", question: "选哪个？", options: ["甲", "乙"] });
	drain();
	const result = kernel.answerQuestion({ reportId, option: 1, at: clock.t });
	assert.ok(result.ok);
	assert.equal(result.text, `回答任务「${"把".repeat(40)}…」：乙`);
	assert.equal(kernel.listTickets()[0].question?.click?.option, 1);
});

test("点选回答是幂等的：连点同一项、另一个客户端或超时重试，都得到同一条触发，Router 只收到一次；转交之后再点同一项也一样", () => {
	const { kernel, ticketId, answer, userLines, notices } = askSetup();
	const first = answer(0);
	const again = answer(0);
	assert.ok(first.ok && again.ok);
	assert.equal(again.triggerId, first.triggerId);
	assert.equal(again.duplicate, true);
	assert.deepEqual(userLines(), ["查财报", "回答任务「查财报」：只看营收"]);
	assert.equal(notices().length, 1);
	assert.ok(kernel.route([{ kind: "hand_over", triggerId: first.triggerId, ticketId }])[0].ok);
	const late = answer(0);
	assert.ok(late.ok);
	assert.equal(late.triggerId, first.triggerId);
});

test("点过一项之后换另一项再点被拒，说明已选的是哪一项；转交之后也一样；对话里不多一句", () => {
	const { kernel, ticketId, answer, userLines } = askSetup();
	const first = answer(0) as { triggerId: string };
	assert.deepEqual(answer(2), { ok: false, refusal: { kind: "chosen", option: 0, label: "只看营收" } });
	assert.ok(kernel.route([{ kind: "hand_over", triggerId: first.triggerId, ticketId }])[0].ok);
	assert.deepEqual(answer(1), { ok: false, refusal: { kind: "chosen", option: 0, label: "只看营收" } });
	assert.deepEqual(userLines(), ["查财报", "回答任务「查财报」：只看营收"]);
	assert.equal(refusalText({ kind: "chosen", option: 0, label: "只看营收" }), "已选「只看营收」");
});

test("提问之后使用者又发了一句话、幕僚长还没处理完时，点选被拒，看板标出这一点；幕僚长把那句话交给别处或处理完之后，又可以点", () => {
	for (const end of ["elsewhere", "turn"] as const) {
		const { kernel, clock, answer, row, say, due, userLines } = askSetup();
		clock.t += 1000;
		const typed = say("顺便查一下天气").triggerId;
		assert.equal(row().question?.spoke, true, end);
		assert.deepEqual(answer(0), { ok: false, refusal: { kind: "spoke" } }, end);
		assert.ok(!userLines().some((l) => l.startsWith("回答任务")), end);
		if (end === "elsewhere") assert.ok(kernel.route([{ kind: "open_ticket", basis: "request", triggerId: typed, title: "查天气", brief: "查天气" }])[0].ok);
		else for (const a of due("router.notify")) kernel.completeAction(a.id);
		assert.equal(row().question?.spoke, false, end);
		assert.ok(answer(0).ok, end);
	}
	assert.match(refusalText({ kind: "spoke" }), /幕僚长处理完之前不能点选项/);
});

test("点选回答被拒：问题已经打字回答过、被新问题取代、选项超出范围、问题没有选项、汇报不存在；被拒时对话里不多一句", () => {
	const typed = askSetup();
	typed.handOverUserMessage(typed.ticketId, "都看");
	const superseded = askSetup();
	superseded.ask(["甲", "乙"]);
	const range = askSetup();
	const open = askSetup();
	const openId = open.kernel.workerReport(open.ticketId, { status: "blocked", summary: "s", question: "你想要什么？" }).reportId;
	const cases = [
		[typed, typed.answer(0)],
		[superseded, superseded.answer(0)],
		[range, range.answer(3)],
		[open, open.answer(0, openId)],
		[range, range.answer(0, "rpt_missing")],
	] as const;
	for (const [s, result] of cases) {
		assert.equal(result.ok, false, JSON.stringify(result));
		assert.ok(!s.userLines().some((l) => l.startsWith("回答任务")), "被拒时没有新的一句");
	}
});

test("点选回答只能转交给它回答的任务：拿去开新任务或转交给别的任务都被拒绝；转交给本任务时 Worker 收到这句使用者的话", () => {
	const { kernel, ticketId, answer, open } = askSetup();
	const other = open("request", { title: "写周报" });
	const { triggerId } = answer(0) as { triggerId: string };
	const [opened, wrong] = kernel.route([
		{ kind: "open_ticket", basis: "request", triggerId, title: "只看营收", brief: "只看营收" },
		{ kind: "hand_over", triggerId, ticketId: other },
	]);
	assert.equal(opened.ok, false);
	assert.equal(wrong.ok, false);
	assert.match(!opened.ok ? opened.reason : "", new RegExp(ticketId));
	const [right] = kernel.route([{ kind: "hand_over", triggerId, ticketId }]);
	assert.ok(right.ok);
	assert.deepEqual(kernel.pendingInputs(ticketId).map((i) => [i.kind, i.body]), [["user_message", "回答任务「查财报」：只看营收"]]);
	assert.equal(kernel.getTicket(ticketId)!.stage, "running");
});

test("读取点选回答的触发时带上它回答的任务、汇报、问题和选项；打字说的话没有", () => {
	const { kernel, ticketId, reportId, answer, say } = askSetup();
	const { triggerId } = answer(2) as { triggerId: string };
	const found = kernel.read(triggerId);
	assert.ok(found?.type === "trigger");
	assert.deepEqual(found.answers, { ticketId, reportId, question: "要看哪部分？", option: "先不查" });
	const typed = kernel.read(say("随便说一句").triggerId);
	assert.ok(typed?.type === "trigger");
	assert.equal(typed.answers, null);
});

test("对话历史里幕僚长关于某个任务的回复带上 ticketId 任务 id；回应使用者的话的回复不带", () => {
	const { kernel, ticketId } = askSetup();
	const asked = kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "要看哪部分？", cause: ticketId });
	assert.ok(asked.ok);
	const lines = kernel.conversation();
	assert.deepEqual(lines.at(-1), { id: asked.replyId, who: "router", text: "要看哪部分？", at: lines.at(-1)!.at, ticketId: ticketId });
	const hi = kernel.submitTrigger({ source: "conversation", externalId: "hi", threads: [{ id: CONVERSATION_THREAD_ID }], sender: "user", body: "在吗", occurredAt: 0 }).triggerId;
	assert.ok(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "在", cause: hi }).ok);
	assert.equal("ticketId" in kernel.conversation().at(-1)!, false);
});

test("久无进展：执行中且距上次进展达到阈值才算，看板行带开始时间和分钟数；有新进展就清除；空闲、排队、等回答的不算", () => {
	const MIN = 60_000;
	const { kernel, clock, open, run, idle } = setup({ config: { stuckMs: 10 * MIN } });
	const busy = open("request", { title: "跑回归" });
	run(busy);
	const since = clock.t;
	const quiet = open("request", { title: "空闲的" });
	idle(quiet);
	const asking = open("request", { title: "等回答" });
	run(asking);
	kernel.workerReport(asking, { status: "blocked", summary: "s", question: "选哪个？" });
	open("request", { title: "排队的" });
	const stalls = () => Object.fromEntries(kernel.listTickets().map((r) => [r.title, r.stall]));
	clock.t = since + 10 * MIN - 1;
	assert.equal(stalls().跑回归, null);
	clock.t = since + 42 * MIN;
	assert.deepEqual(stalls(), { 跑回归: { since, minutes: 42 }, 空闲的: null, 等回答: null, 排队的: null });
	kernel.recordWorkerProgress(busy);
	assert.equal(stalls().跑回归, null);
});

test("下一次久无进展的时刻：执行中、还没久无进展的任务里最早的那个；没有这样的任务时为空", () => {
	const MIN = 60_000;
	const { kernel, clock, open, run } = setup({ config: { stuckMs: 10 * MIN } });
	const next = () => nextStallAt(kernel.listTickets(), 10 * MIN);
	assert.equal(next(), null);
	const first = open("request", { title: "一" });
	run(first);
	const firstAt = clock.t;
	clock.t += 3 * MIN;
	run(open("request", { title: "二" }));
	assert.equal(next(), firstAt + 10 * MIN);
	clock.t = firstAt + 11 * MIN;
	assert.equal(next(), firstAt + 13 * MIN, "已经久无进展的不再排");
});

const helperOf = (kernel: Kernel, id: string) => kernel.listTickets().find((r) => r.id === id)!.helper;
const closeTicket = (s: ReturnType<typeof setup>, id: string) => {
	s.run(id);
	s.kernel.workerReport(id, { status: "no_action", summary: "无需处理" });
};

test("助手角色按任务来源：你的话是对话助手，行情来源的规则是行情助手，其他规则是规则助手，主动发现是观察助手；序号按角色从 1 数", () => {
	const s = setup({ config: { inferenceConcurrent: 10 } });
	const ids = [s.open("request"), s.open("rule"), s.open("rule", { source: "toy-market" }), s.open("inference"), s.open("request"), s.open("rule", { source: "toy-market" })];
	assert.deepEqual(
		ids.map((id) => { const h = helperOf(s.kernel, id)!; return `${h.role} #${h.seq}`; }),
		["conversation #1", "rule #1", "market #1", "watch #1", "conversation #2", "market #2"],
	);
});

test("助手序号按纽约日期分天：纽约午夜之后同一角色从 1 重新数", () => {
	const s = setup({ at: "2026-11-09T04:30:00Z" });
	const lateNight = s.open("request");
	s.clock.t += HOUR;
	const nextDay = [s.open("request"), s.open("request")];
	assert.deepEqual([lateNight, ...nextDay].map((id) => helperOf(s.kernel, id)!.seq), [1, 1, 2]);
});

test("助手名字按建任务的先后从名字池里依次取，在岗的助手不重名；池用完时加「·二」", () => {
	const s = setup();
	const ids = SOLO_NAMES.map(() => s.open("request"));
	assert.deepEqual(ids.map((id) => helperOf(s.kernel, id)!.name), [...SOLO_NAMES]);
	const overflow = s.open("request");
	assert.equal(helperOf(s.kernel, overflow)!.name, `${SOLO_NAMES[0]}·二`);
	closeTicket(s, ids[4]);
	assert.equal(helperOf(s.kernel, s.open("request"))!.name, SOLO_NAMES[4], "下一位从第二个名字往后找，第一个空出来的是刚完成的那位");
});

test("完成或停止的助手让出名字：之后轮到这个名字时可以再用", () => {
	const s = setup();
	const first = s.open("request");
	closeTicket(s, first);
	const rest = SOLO_NAMES.slice(1).map(() => s.open("request"));
	assert.equal(rest.length, SOLO_NAMES.length - 1);
	assert.equal(helperOf(s.kernel, s.open("request"))!.name, SOLO_NAMES[0]);
});

test("助手名字、角色和序号存在状态库里，重启后不变", () => {
	const path = join(mkdtempSync(join(tmpdir(), "psa-kernel-")), "state.db");
	const first = setup({ path });
	const ids = [first.open("request"), first.open("rule", { source: "toy-market" })];
	const before = ids.map((id) => helperOf(first.kernel, id));
	first.db.close();
	const again = setup({ path });
	assert.deepEqual(ids.map((id) => helperOf(again.kernel, id)), before);
});

test("旧状态库没有助手列：打开时补上，补名字时按建任务的先后，角色看依据和来源", () => {
	const path = join(mkdtempSync(join(tmpdir(), "psa-kernel-")), "state.db");
	const first = setup({ path });
	const ids = [first.open("request"), first.open("rule", { source: "toy-market" }), first.open("request"), first.open("rule")];
	closeTicket(first, ids[0]);
	for (const column of ["helper_name", "helper_role", "helper_seq"]) first.db.exec(`ALTER TABLE tickets DROP COLUMN ${column}`);
	first.db.close();
	const again = setup({ path });
	assert.deepEqual(ids.map((id) => helperOf(again.kernel, id)), ids.map(() => null), "宿主补名字之前没有助手");
	again.kernel.nameUnnamedHelpers();
	assert.deepEqual(
		ids.map((id) => helperOf(again.kernel, id)),
		[
			{ name: SOLO_NAMES[0], role: "conversation", seq: 1 },
			{ name: SOLO_NAMES[1], role: "market", seq: 1 },
			{ name: SOLO_NAMES[2], role: "conversation", seq: 2 },
			{ name: SOLO_NAMES[3], role: "rule", seq: 1 },
		],
	);
	again.clock.t += 1000;
	const next = again.open("request");
	assert.deepEqual(helperOf(again.kernel, next), { name: SOLO_NAMES[4], role: "conversation", seq: 3 });
});

test("看板行带结束时间：完成取关闭时刻，停止取停止时刻，进行中为空", () => {
	const s = setup();
	const [done, stopped, live] = [s.open("request"), s.open("request"), s.open("request")];
	closeTicket(s, done);
	const closedAt = s.clock.t;
	s.clock.t += 1000;
	s.kernel.route([{ kind: "stop", ticketId: stopped }]);
	const rows = new Map(s.kernel.listTickets().map((r) => [r.id, r]));
	assert.deepEqual([done, stopped, live].map((id) => rows.get(id)!.endedAt), [closedAt, closedAt + 1000, null]);
});

test("今日助手：纽约今天建的任务数和它们的 token 合计；昨天建的不算", () => {
	const s = setup({ at: "2026-11-09T04:30:00Z" });
	const yesterday = s.open("request");
	s.run(yesterday);
	s.kernel.recordUsage(yesterday, { provider: "p", tokensIn: 5000, tokensOut: 5000 });
	s.clock.t += HOUR;
	assert.deepEqual(s.kernel.helpersToday(), { count: 0, tokens: 0 });
	const [a, b] = [s.open("request"), s.open("rule", { source: "toy-market" })];
	s.run(a);
	s.kernel.recordUsage(a, { provider: "p", tokensIn: 1000, tokensOut: 200 });
	s.kernel.recordUsage(yesterday, { provider: "p", tokensIn: 7, tokensOut: 0 });
	assert.deepEqual(s.kernel.helpersToday(), { count: 2, tokens: 1200 });
	assert.ok(b);
});

const DOMAINS: DomainBook = new Map([["news", { team: "新闻队", onRoster: true }], ["watch", { team: "看盘队", onRoster: true }], ["mail", { team: null, onRoster: true }]]);
const WITH_UNLISTED: DomainBook = new Map([...DOMAINS, ["quiet", { team: "安静队", onRoster: false }]]);
const domainOf = (kernel: Kernel, id: string) => kernel.getTicket(id)!.domain;

test("任务最多属于一个领域：open_ticket 省略 domain 就是没有领域，填了领域簿里的模块名就记在任务上", () => {
	const s = setup({ domains: DOMAINS });
	assert.equal(domainOf(s.kernel, s.open("request")), null);
	assert.equal(domainOf(s.kernel, s.open("request", { domain: "news" })), "news");
	assert.equal(domainOf(s.kernel, s.open("request", { domain: "mail" })), "mail");
	assert.equal(domainOf(s.kernel, s.open("inference", { domain: "watch" })), "watch");
});

test("open_ticket 的 domain 是空串或只有空白：当作没填，任务没有领域", () => {
	const s = setup({ domains: DOMAINS });
	assert.equal(domainOf(s.kernel, s.open("request", { domain: "" })), null);
	assert.equal(domainOf(s.kernel, s.open("request", { domain: "  " })), null);
});

test("open_ticket 的 domain 是 null：当作没填；按规则开的任务照样归规则所在的模块", () => {
	const s = setup({ domains: DOMAINS });
	assert.equal(domainOf(s.kernel, s.open("request", { domain: null })), null);
	assert.equal(domainOf(s.kernel, s.open("rule", { ruleId: "news/breaking", domain: null })), "news");
	assert.deepEqual(s.logs, []);
});

test("open_ticket 的 domain 两头的空白去掉再认；大小写不同不算同一个领域", () => {
	const s = setup({ domains: DOMAINS });
	assert.equal(domainOf(s.kernel, s.open("request", { domain: " news\n" })), "news");
	const [shouted] = s.kernel.route([{ kind: "open_ticket", title: "t", basis: "request", triggerId: s.say("查新闻").triggerId, domain: "NEWS", brief: "b" }]);
	assert.deepEqual(shouted, { ok: false, reason: "unknown domain NEWS; the domains are news, watch, mail (omit domain when none fits)" });
});

test("不在名册上的领域幕僚长不能选：拒绝并说明原因，列出的只有名册上的领域；它的规则开的任务照样归它", () => {
	const s = setup({ domains: WITH_UNLISTED });
	const decision = { kind: "open_ticket", title: "t", basis: "request", triggerId: s.say("安静一下").triggerId, brief: "b" } as const;
	const [picked] = s.kernel.route([{ ...decision, domain: "quiet" }]);
	assert.deepEqual(picked, { ok: false, reason: "domain quiet is not on your roster (its module has no description), so you cannot pick it; the domains are news, watch, mail (omit domain when none fits)" });
	const [typo] = s.kernel.route([{ ...decision, domain: "quite" }]);
	assert.deepEqual(typo, { ok: false, reason: "unknown domain quite; the domains are news, watch, mail (omit domain when none fits)" });
	const [byUserRule] = s.kernel.route([{ kind: "open_ticket", title: "t", basis: "rule", ruleId: "user/ci", triggerId: s.trigger({ threads: [{ id: "thr_generic:u" }] }).triggerId, domain: "quiet", brief: "b" }]);
	assert.equal(byUserRule.ok, false);
	const ruled = s.open("rule", { ruleId: "quiet/hush" });
	assert.equal(domainOf(s.kernel, ruled), "quiet");
	assert.deepEqual(helperOf(s.kernel, ruled), { name: TEAM_NAMES[0], team: "安静队", seq: 1 });
	assert.equal(domainOf(s.kernel, s.open("rule", { ruleId: "quiet/hush", domain: "quiet" })), "quiet", "填的正是规则所在的模块：没有选，照开");
	assert.deepEqual(s.logs, []);
});

test("加载的模块都不在名册上时，幕僚长没有可选的领域", () => {
	const s = setup({ domains: new Map([["quiet", { team: null, onRoster: false }]]) });
	const [result] = s.kernel.route([{ kind: "open_ticket", title: "t", basis: "request", triggerId: s.say("x").triggerId, domain: "quite", brief: "b" }]);
	assert.deepEqual(result, { ok: false, reason: "unknown domain quite; there are no domains (omit domain)" });
});

test("没有加载任何模块时，内核不认任何领域", () => {
	const s = setup();
	assert.equal(domainOf(s.kernel, s.open("request")), null);
	const [result] = s.kernel.route([{ kind: "open_ticket", title: "t", basis: "request", triggerId: s.say("查新闻").triggerId, domain: "news", brief: "b" }]);
	assert.deepEqual(result, { ok: false, reason: "unknown domain news; there are no domains (omit domain)" });
});

test("不存在的领域：拒绝这个决定，理由里写出有哪些领域；这条触发还能再用", () => {
	const s = setup({ domains: DOMAINS });
	const { triggerId } = s.say("看下财报");
	const decision = { kind: "open_ticket", title: "t", basis: "request", triggerId, brief: "b" } as const;
	const [typo] = s.kernel.route([{ ...decision, domain: "新闻队" }]);
	assert.deepEqual(typo, { ok: false, reason: "unknown domain 新闻队; the domains are news, watch, mail (omit domain when none fits)" });
	const [notText] = s.kernel.route([{ ...decision, domain: 7 as unknown as string }]);
	assert.equal(notText.ok, false);
	assert.equal(s.kernel.listTickets().length, 0);
	const [retry] = s.kernel.route([{ ...decision, domain: "news" }]);
	assert.ok(retry.ok);
});

test("模块规则开的任务属于规则所在的模块：幕僚长省略或填对了都不记日志；模块没有成员也一样归它", () => {
	const s = setup({ domains: DOMAINS });
	assert.equal(domainOf(s.kernel, s.open("rule", { ruleId: "news/breaking" })), "news");
	assert.equal(domainOf(s.kernel, s.open("rule", { ruleId: "news/breaking", domain: "news" })), "news");
	assert.equal(domainOf(s.kernel, s.open("rule", { ruleId: "news/breaking", domain: " " })), "news");
	assert.equal(domainOf(s.kernel, s.open("rule", { ruleId: "mail/new" })), "mail");
	assert.deepEqual(s.logs, []);
});

test("幕僚长给模块规则的任务填了别的领域：内核按规则所在的模块定，并记一行日志", () => {
	const s = setup({ domains: DOMAINS });
	const id = s.open("rule", { ruleId: "news/breaking", domain: "watch" });
	assert.equal(domainOf(s.kernel, id), "news");
	assert.deepEqual(helperOf(s.kernel, id), { name: TEAM_NAMES[0], team: "新闻队", seq: 1 });
	assert.deepEqual(s.logs, [`[kernel] 规则 news/breaking 属于领域「news」，幕僚长填的是「watch」，任务 ${id} 按「news」开`]);
});

test("模块规则的任务填了不存在的领域，照样拒绝，不悄悄改回", () => {
	const s = setup({ domains: DOMAINS });
	const { triggerId } = s.trigger({ threads: [{ id: "thr_generic:r" }] });
	const [result] = s.kernel.route([{ kind: "open_ticket", title: "t", basis: "rule", ruleId: "news/breaking", triggerId, domain: "财报", brief: "b" }]);
	assert.equal(result.ok, false);
	assert.deepEqual(s.logs, []);
});

test("使用者自己的规则和不属于任何已加载模块的规则没有自己的领域：幕僚长填的算数，不填就没有领域", () => {
	const s = setup({ domains: DOMAINS });
	assert.equal(domainOf(s.kernel, s.open("rule", { ruleId: "user/ci" })), null);
	assert.equal(domainOf(s.kernel, s.open("rule", { ruleId: "user/ci", domain: "watch" })), "watch");
	assert.equal(domainOf(s.kernel, s.open("rule", { ruleId: "gone/old", domain: "news" })), "news");
	assert.deepEqual(s.logs, []);
});

test("规则的归属只管按规则开的任务：使用者开口要的任务即使带着规则编号，也由幕僚长选领域", () => {
	const s = setup({ domains: DOMAINS });
	const [result] = s.kernel.route([{ kind: "open_ticket", title: "t", basis: "request", ruleId: "news/breaking", triggerId: s.say("看盘").triggerId, domain: "watch", brief: "b" }]);
	assert.equal(domainOf(s.kernel, result.ticketId!), "watch");
	assert.deepEqual(s.logs, []);
});

test("任务的领域存在状态库里：重启后不变，即使那个模块已经拿掉", () => {
	const path = join(mkdtempSync(join(tmpdir(), "psa-kernel-")), "state.db");
	const first = setup({ path, domains: DOMAINS });
	const ids = [first.open("request", { domain: "news" }), first.open("request")];
	first.db.close();
	const again = setup({ path });
	assert.deepEqual(ids.map((id) => domainOf(again.kernel, id)), ["news", null]);
});

test("旧状态库的任务没有领域：打开时补上 domain 列，旧任务读出来没有领域；旧的 team 列留在原处，不读也不写", () => {
	const path = join(mkdtempSync(join(tmpdir(), "psa-kernel-")), "state.db");
	const first = setup({ path });
	const old = first.open("request");
	const before = helperOf(first.kernel, old);
	first.db.exec("ALTER TABLE tickets DROP COLUMN domain; ALTER TABLE tickets ADD COLUMN team TEXT; UPDATE tickets SET team = '新闻队'");
	first.db.close();
	const again = setup({ path, domains: DOMAINS });
	assert.equal(domainOf(again.kernel, old), null);
	assert.deepEqual(helperOf(again.kernel, old), before);
	again.clock.t += 1000;
	assert.equal(domainOf(again.kernel, again.open("request", { domain: "news" })), "news");
	assert.deepEqual(again.db.prepare("SELECT team, domain FROM tickets ORDER BY created_at").all().map((r) => [r.team, r.domain]), [["新闻队", null], [null, "news"]]);
});

test("新建的状态库没有 team 列", () => {
	const s = setup();
	assert.ok(!s.db.prepare("PRAGMA table_info(tickets)").all().some((c) => c.name === "team"));
});

test("领域有成员的任务取四字名，身份是名字、模块的队名和序号；没有领域和领域没有成员的任务仍是两字名加角色", () => {
	const s = setup({ domains: DOMAINS });
	const ids = [s.open("request", { domain: "news" }), s.open("request"), s.open("request", { domain: "mail" }), s.open("rule", { domain: "watch", source: "toy-market" })];
	assert.deepEqual(ids.map((id) => helperOf(s.kernel, id)), [
		{ name: TEAM_NAMES[0], team: "新闻队", seq: 1 },
		{ name: SOLO_NAMES[0], role: "conversation", seq: 1 },
		{ name: SOLO_NAMES[1], role: "conversation", seq: 2 },
		{ name: TEAM_NAMES[1], team: "看盘队", seq: 1 },
	]);
});

test("团队任务的序号按领域在纽约同一天里数：各领域数各的，不占单个助手的序号，过了纽约午夜从 1 重新数", () => {
	const s = setup({ domains: DOMAINS, at: "2026-11-09T04:30:00Z" });
	const seqs = (ids: string[]) => ids.map((id) => helperOf(s.kernel, id)!.seq);
	const lateNight = [s.open("request", { domain: "news" }), s.open("request", { domain: "news" }), s.open("request", { domain: "watch" }), s.open("request")];
	assert.deepEqual(seqs(lateNight), [1, 2, 1, 1]);
	s.clock.t += HOUR;
	assert.deepEqual(seqs([s.open("request", { domain: "news" }), s.open("request")]), [1, 1]);
});

test("两个名字池各自轮转：团队任务不推进两字池，四字池整池在岗时加「·二」", () => {
	const s = setup({ domains: DOMAINS });
	const teamIds = TEAM_NAMES.map(() => s.open("request", { domain: "news" }));
	assert.deepEqual(teamIds.map((id) => helperOf(s.kernel, id)!.name), [...TEAM_NAMES]);
	assert.equal(helperOf(s.kernel, s.open("request"))!.name, SOLO_NAMES[0]);
	assert.equal(helperOf(s.kernel, s.open("request", { domain: "watch" }))!.name, `${TEAM_NAMES[0]}·二`);
	assert.equal(helperOf(s.kernel, s.open("request"))!.name, SOLO_NAMES[1]);
});

test("在岗的名字不分池：旧版本开的任务带着四字名和角色还在岗时，新的团队任务不取同一个名字", () => {
	const s = setup({ domains: DOMAINS });
	const old = s.open("request");
	s.db.prepare("UPDATE tickets SET helper_name = ? WHERE id = ?").run(TEAM_NAMES[0], old);
	assert.deepEqual(helperOf(s.kernel, old), { name: TEAM_NAMES[0], role: "conversation", seq: 1 });
	assert.deepEqual(helperOf(s.kernel, s.open("request", { domain: "news" })), { name: TEAM_NAMES[1], team: "新闻队", seq: 1 });
	assert.deepEqual(helperOf(s.kernel, s.open("request")), { name: SOLO_NAMES[1], role: "conversation", seq: 2 });
});

test("名字和四字还是两字在开任务时定下，之后不变；队名在读任务时取模块现在写的 team", () => {
	const path = join(mkdtempSync(join(tmpdir(), "psa-kernel-")), "state.db");
	const first = setup({ path, domains: DOMAINS });
	const ids = [first.open("request", { domain: "news" }), first.open("request", { domain: "mail" })];
	assert.deepEqual(ids.map((id) => helperOf(first.kernel, id)), [{ name: TEAM_NAMES[0], team: "新闻队", seq: 1 }, { name: SOLO_NAMES[0], role: "conversation", seq: 1 }]);
	first.db.close();
	const helpers = (domains?: DomainBook) => ids.map((id) => helperOf(setup({ path, domains }).kernel, id));
	const solo = { name: SOLO_NAMES[0], role: "conversation", seq: 1 };
	assert.deepEqual(helpers(new Map([["news", { team: "要闻队", onRoster: true }], ["mail", { team: "邮件队", onRoster: true }]])), [{ name: TEAM_NAMES[0], team: "要闻队", seq: 1 }, solo], "模块改了队名、另一个模块后来有了成员");
	assert.deepEqual(helpers(new Map([["news", { team: null, onRoster: true }]])), [{ name: TEAM_NAMES[0], team: "news", seq: 1 }, solo], "模块没了成员：写模块名");
	assert.deepEqual(helpers(), [{ name: TEAM_NAMES[0], team: "news", seq: 1 }, solo], "模块拿掉了：写模块名");
});

test("T1 开的团队任务只有四字名、没有领域：读出来队名的位置写「团队」", () => {
	const s = setup({ domains: DOMAINS });
	const id = s.open("request", { domain: "news" });
	s.db.prepare("UPDATE tickets SET domain = NULL WHERE id = ?").run(id);
	assert.deepEqual(helperOf(s.kernel, id), { name: TEAM_NAMES[0], team: "团队", seq: 1 });
});

test("成员上限的问答记在状态库里：重开数据库读得回来，记了到期的放宽不再读出", () => {
	const dir = mkdtempSync(join(tmpdir(), "psa-cap-"));
	try {
		const path = join(dir, "state.db");
		const first = setup({ path });
		assert.deepEqual(first.kernel.capAsks.latest(), { state: "none" });
		first.kernel.capAsks.save({ state: "asked", day: "2026-11-08", askedAt: 100 });
		assert.deepEqual(first.kernel.capAsks.latest(), { state: "asked", day: "2026-11-08", askedAt: 100 });
		first.kernel.capAsks.save({ state: "granted", day: "2026-11-08", askedAt: 100, answeredAt: 200 }, "回答成员上限：今天放宽到 10");
		first.db.close();
		const second = setup({ path });
		assert.deepEqual(second.kernel.capAsks.latest(), { state: "granted", day: "2026-11-08", askedAt: 100, answeredAt: 200 });
		second.kernel.capAsks.expire("2026-11-08", 300);
		assert.deepEqual(second.kernel.capAsks.latest(), { state: "none" });
		second.kernel.capAsks.save({ state: "declined", day: "2026-11-09", askedAt: 400, answeredAt: 500 }, "回答成员上限：保持 4");
		assert.deepEqual(second.kernel.capAsks.latest(), { state: "declined", day: "2026-11-09", askedAt: 400, answeredAt: 500 });
		second.db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("成员上限：记了到期的那一天又被问起（时钟往回拨过了零点），到期的记号清掉，之后的放宽重启后读得回来", () => {
	const { kernel } = setup();
	const day = "2026-11-08";
	kernel.capAsks.save({ state: "asked", day, askedAt: 100 });
	kernel.capAsks.save({ state: "granted", day, askedAt: 100, answeredAt: 200 }, "回答成员上限：今天放宽到 10");
	kernel.capAsks.expire(day, 300);
	kernel.capAsks.save({ state: "asked", day, askedAt: 400 });
	assert.deepEqual(kernel.capAsks.latest(), { state: "asked", day, askedAt: 400 }, "重新问的问题读得回来，提问时间是这一次的");
	kernel.capAsks.save({ state: "granted", day, askedAt: 400, answeredAt: 500 }, "回答成员上限：今天放宽到 10");
	assert.deepEqual(kernel.capAsks.latest(), { state: "granted", day, askedAt: 400, answeredAt: 500 });
});

test("成员上限：状态库不收对不上的记录。回答必须带使用者的那句话，没答的问题不能带", () => {
	const { kernel } = setup();
	const day = "2026-11-08";
	assert.throws(() => kernel.capAsks.save({ state: "granted", day, askedAt: 100, answeredAt: 200 }), /CHECK constraint failed/, "放宽没有那句话");
	assert.throws(() => kernel.capAsks.save({ state: "declined", day, askedAt: 100, answeredAt: 200 }), /CHECK constraint failed/, "保持没有那句话");
	assert.throws(() => kernel.capAsks.save({ state: "asked", day, askedAt: 100 }, "回答成员上限：今天放宽到 10"), /CHECK constraint failed/, "没答的问题带着一句话");
	assert.deepEqual(kernel.capAsks.latest(), { state: "none" });
});

test("使用者对成员上限的回答是对话里他自己的一句话，但不是触发：幕僚长收不到通知，也没有可转交的东西", () => {
	const { kernel, say } = setup();
	const { triggerId } = say("查天气");
	const pending = kernel.dueActions().length;
	kernel.capAsks.save({ state: "asked", day: "2026-11-08", askedAt: Date.parse("2026-11-08T10:00:01") });
	assert.deepEqual(kernel.conversation().map((l) => l.id), [triggerId], "问了还没答，对话里没有这句话");
	kernel.capAsks.save({ state: "granted", day: "2026-11-08", askedAt: Date.parse("2026-11-08T10:00:01"), answeredAt: Date.parse("2026-11-08T10:00:02") }, "回答成员上限：今天放宽到 10");
	assert.deepEqual(kernel.conversation().map((l) => [l.id, l.who, l.text, l.at]), [
		[triggerId, "user", "查天气", Date.parse("2026-11-08T10:00:00")],
		["ask_cap_2026-11-08", "user", "回答成员上限：今天放宽到 10", Date.parse("2026-11-08T10:00:02")],
	]);
	assert.equal(kernel.dueActions().length, pending, "没有给幕僚长的新通知");
	assert.equal(kernel.read("ask_cap_2026-11-08"), undefined);
	assert.equal(kernel.triggerLog().length, 1);
});

function replied(s: ReturnType<typeof setup>, cause: string, text: string, { delivered = true } = {}) {
	const result = s.kernel.reply({ threadId: CONVERSATION_THREAD_ID, text, cause });
	assert.ok(result.ok, `reply rejected: ${!result.ok && result.reason}`);
	if (delivered) s.kernel.markReplyDelivered(result.replyId);
	return result.replyId;
}

test("清屏后对话只列清屏之后的话；被清掉的行仍在库里，kernel.read 照常读得到", () => {
	const s = setup();
	const old = s.say("查天气").triggerId;
	replied(s, old, "好的，去查了。");
	s.clock.t += 1000;
	s.kernel.clearConversation();
	s.clock.t += 1000;
	const now = s.say("刚才那件事呢").triggerId;
	assert.deepEqual(s.kernel.conversation().map((l) => l.id), [now]);
	const found = s.kernel.read(old);
	assert.ok(found?.type === "trigger", "清掉的触发仍读得到");
	assert.equal(found.trigger.body, "查天气");
	assert.equal(s.kernel.triggerLog().length, 2);
});

test("清屏只收走已经送到屏幕上的回复：还没投递的回复清屏后仍在对话里", () => {
	const s = setup();
	const said = s.say("查天气").triggerId;
	const pending = replied(s, said, "好的，去查了。", { delivered: false });
	s.kernel.clearConversation();
	assert.deepEqual(s.kernel.conversation().map((l) => l.id), [pending]);
	assert.deepEqual(s.kernel.cleared()!.lines.map((l) => l.id), [said]);
});

test("cleared() 给出最近一次清屏的时间和最新的被清掉的行，按对话顺序，最多 limit 条", () => {
	const s = setup();
	for (let i = 0; i < 60; i++) {
		s.say(`第 ${i} 句`);
		s.clock.t += 10;
	}
	const before = s.kernel.conversation(100);
	const at = s.clock.t;
	s.kernel.clearConversation();
	const cleared = s.kernel.cleared(50)!;
	assert.equal(cleared.at, at);
	assert.equal(cleared.lines.length, 50);
	assert.deepEqual(cleared.lines, before.slice(-50));
});

test("没有可清的行时清屏什么都不做：返回 null，清屏时间不变，库里不多写", () => {
	const s = setup();
	assert.equal(s.kernel.clearConversation(), null);
	assert.equal(s.kernel.cleared(), null);
	s.say("查天气");
	const first = s.kernel.clearConversation();
	assert.ok(first);
	s.clock.t += 1000;
	assert.equal(s.kernel.clearConversation(), null);
	assert.equal(s.kernel.cleared()!.at, first.at);
});

test("时钟不动时连清两次屏，第二次的时间也严格更晚", () => {
	const s = setup();
	s.say("一");
	const first = s.kernel.clearConversation()!;
	s.say("二");
	const second = s.kernel.clearConversation()!;
	assert.equal(second.at, first.at + 1);
	assert.deepEqual(s.kernel.conversation(), []);
});

test("清屏不产生触发，也不排任何动作，幕僚长不会被叫醒", () => {
	const s = setup();
	s.say("查天气");
	const triggers = s.kernel.triggerLog().length;
	const actions = s.kernel.dueActions(10);
	s.kernel.clearConversation();
	assert.equal(s.kernel.triggerLog().length, triggers);
	assert.deepEqual(s.kernel.dueActions(10), actions);
});

test("答过的成员上限问题那句话随清屏收走，还没答的不算", () => {
	const s = setup();
	const day = "2026-11-08";
	s.kernel.capAsks.save({ state: "granted", day, askedAt: Date.parse("2026-11-08T10:00:01"), answeredAt: Date.parse("2026-11-08T10:00:02") }, "回答成员上限：今天放宽到 10");
	s.kernel.capAsks.save({ state: "asked", day: "2026-11-09", askedAt: Date.parse("2026-11-08T10:00:03") });
	s.kernel.clearConversation();
	assert.deepEqual(s.kernel.cleared()!.lines.map((l) => l.id), [`ask_cap_${day}`]);
	assert.deepEqual(s.kernel.conversation(), []);
});

test("旧的 state.db 打开后清屏表自动建好，原有对话全部可见", () => {
	const path = join(mkdtempSync(join(tmpdir(), "psa-kernel-")), "state.db");
	const first = setup({ path });
	first.say("查天气");
	const before = first.kernel.conversation();
	first.db.exec("DROP TABLE IF EXISTS conversation_hidden");
	first.db.close();
	const again = setup({ path });
	assert.deepEqual(again.kernel.conversation(), before);
	assert.equal(again.kernel.cleared(), null);
});

function quoteCounts(s: ReturnType<typeof setup>) {
	const n = (sql: string) => (s.db.prepare(sql).get() as { n: number }).n;
	return {
		triggers: n("SELECT COUNT(*) AS n FROM triggers"),
		quotes: n("SELECT COUNT(*) AS n FROM trigger_quotes"),
		notices: n("SELECT COUNT(*) AS n FROM actions WHERE kind = 'router.notify' AND status = 'pending'"),
	};
}

test("引用：说话时引用一条幕僚长的话，库里记下被引用行的编号、谁说的、什么时候、一行快照和当时的任务；conversation() 和 read() 都带出同一个引用", () => {
	const s = setup();
	const ticketId = s.open("request", { title: "换供应商" });
	s.clock.t += 1000;
	const replyAt = s.clock.t;
	const replyId = replied(s, ticketId, "方案 A：\n先停掉旧任务");
	s.clock.t += 1000;
	const said = s.kernel.userSaidQuoting({ text: "改成 B", at: s.clock.t, lineId: replyId });
	assert.ok(said);
	assert.deepEqual(said.quote, { lineId: replyId, who: "router", at: replyAt, text: "方案 A： 先停掉旧任务", ticketId });
	const found = s.kernel.read(said.triggerId);
	assert.ok(found?.type === "trigger");
	assert.deepEqual(found.quote, said.quote);
	assert.deepEqual(s.kernel.conversation().at(-1), { id: said.triggerId, who: "user", text: "改成 B", at: s.clock.t, quote: said.quote });
	assert.deepEqual(s.notices().at(-1), { kind: "conversation", triggerId: said.triggerId }, "和普通的话一样交给幕僚长");
});

test("引用：被引用的话有换行和很长时，快照压成一行、最多 200 字、截断处带「…」", () => {
	const s = setup();
	const long = s.say(`第一行\r\n第二行 第三行\n${"长".repeat(500)}`).triggerId;
	const short = s.say("短短一句话，原样存下来。").triggerId;
	const longQuote = s.kernel.userSaidQuoting({ text: "a", at: s.clock.t, lineId: long })!.quote;
	assert.doesNotMatch(longQuote.text, /[^\S ]| {2}/u, "只剩单个空格");
	assert.equal([...longQuote.text].length, 201);
	assert.ok(longQuote.text.startsWith("第一行 第二行 第三行 长"));
	assert.ok(longQuote.text.endsWith("长…"));
	assert.equal(s.kernel.userSaidQuoting({ text: "b", at: s.clock.t, lineId: short })!.quote.text, "短短一句话，原样存下来。");
});

test("引用：快照去掉看不见的控制字符", () => {
	const s = setup();
	const id = s.say("前\u0000面\u0007的\u001b[31m话\u0085完").triggerId;
	assert.equal(s.kernel.userSaidQuoting({ text: "a", at: s.clock.t, lineId: id })!.quote.text, "前面的[31m话完");
});

test("引用：编号不在对话里、或是还没送到屏幕上的回复时，什么都不写，返回 null", () => {
	const s = setup();
	const source = s.trigger().triggerId;
	const said = s.say("查天气").triggerId;
	const undelivered = replied(s, said, "好的", { delivered: false });
	const before = quoteCounts(s);
	for (const lineId of ["rpl_missing", source, "", undelivered]) {
		assert.equal(s.kernel.userSaidQuoting({ text: "改成 B", at: s.clock.t, lineId }), null, lineId);
	}
	assert.deepEqual(quoteCounts(s), before);
});

test("引用：清屏藏起来的行照样能引用，新的话带着引用出现在对话里", () => {
	const s = setup();
	const old = s.say("查天气").triggerId;
	s.kernel.clearConversation();
	s.clock.t += 1000;
	const said = s.kernel.userSaidQuoting({ text: "刚才那件事呢", at: s.clock.t, lineId: old })!;
	assert.equal(said.quote.text, "查天气");
	assert.deepEqual(s.kernel.conversation().map((l) => [l.id, l.quote?.lineId]), [[said.triggerId, old]]);
});

test("引用：可以引用成员上限的回答，它不属于任何任务", () => {
	const s = setup();
	const day = "2026-11-08";
	const answeredAt = Date.parse("2026-11-08T10:00:02");
	s.kernel.capAsks.save({ state: "granted", day, askedAt: answeredAt - 1000, answeredAt }, "回答成员上限：今天放宽到 10");
	const said = s.kernel.userSaidQuoting({ text: "为什么放宽", at: s.clock.t, lineId: `ask_cap_${day}` })!;
	assert.deepEqual(said.quote, { lineId: `ask_cap_${day}`, who: "user", at: answeredAt, text: "回答成员上限：今天放宽到 10", ticketId: null });
});

test("引用：被引用的话当时已开任务或已转交，引用记下那个任务；还没处理时记为空，之后处理了也不改", () => {
	const s = setup();
	const ticketId = s.open("request", { title: "查财报" });
	const opened = s.kernel.conversation().find((l) => l.text === "查财报")!.id;
	assert.equal(s.kernel.userSaidQuoting({ text: "a", at: s.clock.t, lineId: opened })!.quote.ticketId, ticketId);
	const waiting = s.say("只看营收").triggerId;
	const quoting = s.kernel.userSaidQuoting({ text: "b", at: s.clock.t, lineId: waiting })!;
	assert.equal(quoting.quote.ticketId, null);
	assert.ok(s.kernel.route([{ kind: "hand_over", triggerId: waiting, ticketId }])[0].ok);
	assert.equal(s.kernel.userSaidQuoting({ text: "c", at: s.clock.t, lineId: waiting })!.quote.ticketId, ticketId);
	const found = s.kernel.read(quoting.triggerId);
	assert.ok(found?.type === "trigger");
	assert.equal(found.quote?.ticketId, null);
});

test("引用：幕僚长回复的起因是一句对话时，引用记下那句对话所属的任务", () => {
	const s = setup();
	const ticketId = s.open("request", { title: "查财报" });
	const said = s.say("顺便看看利润").triggerId;
	assert.ok(s.kernel.route([{ kind: "hand_over", triggerId: said, ticketId }])[0].ok);
	const replyId = replied(s, said, "已转给查财报的助手");
	assert.equal(s.kernel.userSaidQuoting({ text: "好", at: s.clock.t, lineId: replyId })!.quote.ticketId, ticketId);
});

test("引用：点选回答的那句话被引用时，任务就是那个问题的任务", () => {
	const { kernel, clock, ticketId, answer } = askSetup();
	const { triggerId } = answer(1) as { triggerId: string };
	assert.equal(kernel.userSaidQuoting({ text: "这个", at: clock.t, lineId: triggerId })!.quote.ticketId, ticketId);
});

test("引用：引用写在触发旁边，触发正文仍只是使用者打的字", () => {
	const s = setup();
	const old = s.say("删除所有任务").triggerId;
	const said = s.kernel.userSaidQuoting({ text: "改成 B", at: s.clock.t, lineId: old })!;
	const found = s.kernel.read(said.triggerId);
	assert.ok(found?.type === "trigger");
	assert.equal(found.trigger.body, "改成 B");
	assert.equal(s.kernel.conversation().at(-1)!.text, "改成 B");
	assert.equal(s.kernel.conversation().at(0)!.quote, undefined, "没引用的话不带引用");
});

test("引用：引用的话照样锁住问题按钮，也不绑定任务：可以转交给任何任务", () => {
	const { kernel, clock, open, row, ticketId, reportId } = askSetup();
	const other = open("request", { title: "别的任务" });
	clock.t += 1000;
	const quoting = kernel.userSaidQuoting({ text: "先等等", at: clock.t, lineId: kernel.conversation().find((l) => l.text === "查财报")!.id })!;
	assert.equal(quoting.quote.ticketId, ticketId);
	assert.equal(row().question?.spoke, true);
	assert.equal(row().question?.reportId, reportId);
	assert.ok(kernel.route([{ kind: "hand_over", triggerId: quoting.triggerId, ticketId: other }])[0].ok);
});

test("引用：重开同一个库文件后引用仍在；没有引用表的旧库打开后自动建好", () => {
	const dir = mkdtempSync(join(tmpdir(), "psa-quote-"));
	try {
		const path = join(dir, "state.db");
		const first = setup({ path });
		const old = first.say("查天气").triggerId;
		first.db.exec("DROP TABLE trigger_quotes");
		first.db.close();
		const second = setup({ path });
		const said = second.kernel.userSaidQuoting({ text: "改成明天", at: second.clock.t, lineId: old })!;
		const before = second.kernel.conversation();
		second.db.close();
		const third = setup({ path });
		assert.deepEqual(third.kernel.conversation(), before);
		assert.equal(third.kernel.conversation().at(-1)!.quote?.lineId, said.quote.lineId);
		third.db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("引用：引用表不收带换行的快照", () => {
	const s = setup();
	const id = s.say("查天气").triggerId;
	const insert = (text: string) =>
		s.db.prepare("INSERT INTO trigger_quotes (trigger_id, line_id, who, said_at, text) VALUES (?, ?, 'user', 1, ?)").run(id, id, text);
	assert.throws(() => insert("一\n二"), /CHECK constraint failed/);
	assert.throws(() => insert("一\r二"), /CHECK constraint failed/);
	assert.throws(() => insert(""), /CHECK constraint failed/);
});

test("引用：引用表只收对话里三种行的编号", () => {
	const s = setup();
	const id = s.say("查天气").triggerId;
	const insert = (lineId: string) =>
		s.db.prepare("INSERT INTO trigger_quotes (trigger_id, line_id, who, said_at, text) VALUES (?, ?, 'user', 1, '查天气')").run(id, lineId);
	assert.throws(() => insert("tkt_1"), /CHECK constraint failed/);
	assert.throws(() => insert("act_1"), /CHECK constraint failed/);
	insert("ask_cap_2026-11-10");
});
