import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Kernel } from "../src/kernel/kernel.ts";
import { openStore } from "../src/kernel/store.ts";
import { CONVERSATION_THREAD_ID, DISPOSITIONS } from "../src/kernel/types.ts";
import type { Basis, KernelConfig, TriggerSubmission } from "../src/kernel/types.ts";

const HOUR = 3_600_000;

function setup({ config, path = ":memory:" }: { config?: Partial<KernelConfig>; path?: string } = {}) {
	const clock = { t: new Date("2026-11-08T10:00:00").getTime(), now() { return this.t; } };
	const db = openStore(path);
	const kernel = new Kernel({
		db,
		clock,
		sourcePolicy: (t) => (t.source === "noise" ? "ignore" : "candidate"),
		config,
	});
	let n = 0;
	const trigger = (over: Partial<TriggerSubmission> = {}) =>
		kernel.submitTrigger({
			source: "generic",
			externalId: `e${++n}`,
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

	function open(basis: Basis, { threads = [] as string[], title = `${basis} 任务` } = {}) {
		let triggerId: string | undefined;
		if (basis === "request") triggerId = say(title).triggerId;
		if (basis === "rule") triggerId = trigger({ threads: [{ id: `thr_generic:rule-${++n}` }], body: title }).triggerId;
		for (const id of threads) trigger({ threads: [{ id }] });
		const [result] = kernel.route([
			{ kind: "open_ticket", title, basis, ruleId: basis === "rule" ? "rule-1" : undefined, triggerId, threads, brief: title },
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

	return { db, kernel, clock, trigger, say, due, notices, wakes, drain, open, run, idle, handOverUserMessage, stage };
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

test("阶段：就绪且不再等待时任务结束，订阅的线程来新触发会重新打开", () => {
	const { kernel, trigger, open, idle, stage } = setup();
	const id = open("rule", { threads: ["thr_pr"] });
	idle(id);
	kernel.workerReport(id, { status: "ready", summary: "已合并" });
	assert.equal(stage(id), "closed");

	trigger({ threads: [{ id: "thr_pr" }], body: "PR 有新评论" });
	assert.notEqual(stage(id), "closed");
	assert.equal(kernel.pendingInputs(id).length, 1);
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
			model: "openai-codex/gpt-6.1-sol",
			fellBack: false,
			toolCalls: 2,
			tokensIn: 1000,
			tokensOut: 200,
			elapsedMs: 90_000,
			lastProgressAt: reportedAt,
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

test("推断并发：已结束的推断任务被订阅线程重新打开时，另一个推断任务在跑就拿不到名额，空出后再唤醒", () => {
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
	trigger({ threads: [{ id: "thr_feed:a" }], body: "a 的新消息" });
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
