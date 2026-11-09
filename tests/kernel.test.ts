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

test("推断任务同时运行数超出上限：开任务被拒绝并留记录", () => {
	const { kernel, open, run } = setup();
	const first = open("inference");
	const [rejected] = kernel.route([{ kind: "open_ticket", title: "第二个", basis: "inference", brief: "b" }]);
	assert.equal(rejected.ok, false);
	const [logged] = kernel.decisionLog();
	assert.equal(logged.ok, false);
	assert.equal(logged.decision.kind, "open_ticket");
	assert.match(logged.reason!, /inference/);

	run(first);
	kernel.workerReport(first, { status: "no_action", summary: "无事" });
	const [accepted] = kernel.route([{ kind: "open_ticket", title: "第三个", basis: "inference", brief: "b" }]);
	assert.equal(accepted.ok, true);
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
		const { nextAttemptAt } = kernel.failAction(action.id, "boom");
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
	const { kernel, due } = setup();
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "字".repeat(201) }).ok, false);
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "🙂".repeat(200) }).ok, true);
	const replies = due("channel.reply");
	assert.equal(replies.length, 1);
	assert.equal((replies[0].payload as { text: string }).text, "🙂".repeat(200));
});

test("回复送达后记下回执，重复标记无效", () => {
	const { kernel } = setup();
	const result = kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "好的" });
	assert.ok(result.ok);
	assert.equal(kernel.markReplyDelivered(result.replyId), true);
	assert.equal(kernel.markReplyDelivered(result.replyId), false);
});

test("推断任务不发确认：没有结果时针对它的回复被拒绝", () => {
	const { kernel, open, run } = setup();
	const id = open("inference");
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "已开始", ticketId: id }).ok, false);
	run(id);
	kernel.workerReport(id, { status: "progress", summary: "查到一半" });
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "进行中", ticketId: id }).ok, false);
	kernel.workerReport(id, { status: "ready", summary: "发现异常", drafts: [{ to: "x", body: "y" }] });
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "发现异常", ticketId: id }).ok, true);

	const request = open("request");
	assert.equal(kernel.reply({ threadId: CONVERSATION_THREAD_ID, text: "收到", ticketId: request }).ok, true);
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
		},
	);
	assert.equal(kernel.usageToday("deepseek"), 1200);
	clock.t += 24 * HOUR;
	assert.equal(kernel.usageToday("deepseek"), 0);
});
