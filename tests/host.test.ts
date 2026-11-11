import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { HostConnection } from "../src/client/connection.ts";
import type { HostToClient } from "../src/client/protocol.ts";
import { ROUTER_TOOL_NAMES } from "../src/host/router.ts";
import { domainsOf, ids, ofType, openOnConversation, startHost, tempStateDir, until, type Brain } from "./helpers/fakes.ts";

const replyOnReport: Brain = (cards) =>
	cards.flatMap((card) => {
		if (card.startsWith("[对话]")) return openOnConversation(card);
		if (card.startsWith("[Worker 汇报]")) return [{ name: "reply", args: { text: `结果：${card.split("\n")[1]}`, cause: ids(card, "tkt") } }];
		return [];
	});

test("一条请求的完整往返：确认、派出 Worker、汇报后回复结果", async (t) => {
	const { host, said } = await startHost(replyOnReport, (w) => {
		w.report({ status: "ready", summary: "明天晴" });
		w.settle();
	});
	t.after(() => host.stop());
	host.say("查明天天气");
	await until(() => said().length === 2, "两条回复");
	assert.deepEqual(said(), ["收到：查明天天气", "结果：明天晴"]);
	await until(() => host.workers.liveCount() === 0, "Worker 空闲后退出");
	assert.equal(host.kernel.listTickets()[0].stage, "closed");
});

test("Router 的工具集里没有执行命令和读写文件的工具", async (t) => {
	const { host } = await startHost(() => [], () => {});
	t.after(() => host.stop());
	const tools = (host.router as any).session.getActiveToolNames();
	assert.deepEqual([...tools].sort(), [...ROUTER_TOOL_NAMES].sort());
	for (const forbidden of ["bash", "read_file", "write", "edit", "grep", "find", "ls"]) assert.ok(!tools.includes(forbidden), forbidden);
});

test("连发两句：两个 Worker 并行，第二句的确认不等第一个任务完成", async (t) => {
	let releaseA!: () => void;
	const aDone = new Promise<void>((r) => (releaseA = r));
	const { host, spawner, said } = await startHost(replyOnReport, async (w, input) => {
		if (input.includes("A 任务")) await aDone;
		w.report({ status: "ready", summary: input.includes("A 任务") ? "A 完成" : "B 完成" });
		w.settle();
	});
	t.after(() => host.stop());
	host.say("A 任务");
	host.say("B 任务");
	await until(() => said().includes("结果：B 完成"), "B 先完成");
	assert.ok(said().includes("收到：A 任务") && said().includes("收到：B 任务"), JSON.stringify([said(), host.kernel.decisionLog(), host.kernel.listTickets()]));
	assert.ok(!said().includes("结果：A 完成"));
	assert.equal(spawner.spawned.length, 2);
	releaseA();
	await until(() => said().includes("结果：A 完成"), "A 完成");
});

test("Worker 的推理和工具调用不出现在回复里，只有汇报到达 Router", async (t) => {
	const { host, router, said } = await startHost(replyOnReport, (w) => {
		w.report({ status: "progress", summary: "正在跑 bash：curl wttr.in" });
		w.report({ status: "ready", summary: "明天晴" });
		w.settle();
	});
	t.after(() => host.stop());
	host.say("查天气");
	await until(() => said().length === 2, "两条回复");
	const seen = router.batches.flat().join("\n");
	assert.doesNotMatch(seen, /curl wttr/);
	assert.doesNotMatch(said().join("\n"), /curl/);
});

test("Router 推理期间到达的多条汇报在下一步一并注入", async (t) => {
	let gate!: () => void;
	const held = new Promise<void>((r) => (gate = r));
	let workersDone = 0;
	const brain: Brain = async (cards) => {
		if (cards.some((c) => c.includes("[对话]") && c.includes("开三个"))) {
			const triggerId = ids(cards[0], "trg");
			return [{
				name: "route",
				args: { decisions: ["甲", "乙", "丙"].map((title) => ({ kind: "open_ticket", basis: "request", triggerId, title, brief: title })) },
			}];
		}
		if (cards.some((c) => c.includes("[对话]") && c.includes("慢慢想"))) {
			await held;
			return [];
		}
		return replyOnReport(cards, 0);
	};
	const { host, router } = await startHost(brain, (w) => {
		w.report({ status: "ready", summary: `${w.spec.ticketId} 完成` });
		workersDone++;
		w.settle();
	});
	t.after(() => host.stop());
	host.kernel.config.maxWorkers = 3;
	host.say("开三个任务");
	await until(() => host.kernel.listTickets().length === 3, "三个任务");
	host.say("慢慢想一下");
	await until(() => router.batches.some((b) => b.some((c) => c.includes("慢慢想"))), "Router 开始推理");
	await until(() => workersDone === 3, "三个汇报都已提交");
	await new Promise((r) => setTimeout(r, 50));
	gate();
	await until(() => router.batches.some((b) => b.filter((c) => c.startsWith("[Worker 汇报]")).length >= 2), "批量注入");
});

test("名额满时新任务排队，使用者的后续消息仍能唤醒已有任务", async (t) => {
	const brain: Brain = (cards) =>
		cards.flatMap((card) => {
			const trg = ids(card, "trg");
			if (card.includes("后续")) {
				const target = host.kernel.listTickets().find((r) => r.title === "请求甲")!;
				return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: trg, ticketId: target.id }] } }];
			}
			if (card.startsWith("[对话]")) return openOnConversation(card, "请求甲");
			if (card.startsWith("[候选触发]")) {
				return [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "rule", ruleId: "r1", triggerId: trg, title: card.includes("x1") ? "规则一" : "规则二", brief: "看一下" }] } }];
			}
			return [];
		});
	const { host, spawner } = await startHost(brain, (w, input) => {
		if (w.spec.ticketId && input.includes("看一下")) return;
		w.report({ status: "progress", summary: "处理中" });
		w.settle();
	}, { config: { maxWorkers: 1, reservedSlots: 1 } });
	t.after(() => host.stop());
	const external = (id: string) =>
		host.kernel.submitTrigger({ source: "generic", externalId: id, threads: [{ id: `thr_${id}` }], sender: "bot", body: id, occurredAt: Date.now() });
	const byTitle = (title: string) => host.kernel.listTickets().find((r) => r.title === title);

	external("x1");
	await until(() => byTitle("规则一")?.stage === "running", "规则一占住普通名额");
	host.say("请求甲");
	await until(() => spawner.spawned.includes(byTitle("请求甲")?.id ?? "-"), "请求任务用上保留名额");
	await until(() => byTitle("请求甲")?.stage === "idle" && host.workers.liveCount() === 1, "请求甲空闲退出");
	external("x2");
	await until(() => byTitle("规则二")?.stage === "queued", "规则二排队");
	host.say("后续：再补充一点");
	await until(() => spawner.spawned.filter((id) => id === byTitle("请求甲")!.id).length === 2, "后续消息重新拉起请求甲");
	assert.equal(byTitle("规则二")!.stage, "queued");
});

test("宿主停止后，它的分发器不再执行任何动作", async () => {
	const { host } = await startHost(() => [], () => {});
	await host.stop();
	host.kernel.notifyRouter("停止之后的通知");
	host.dispatcher.kick();
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(host.kernel.dueActions().length, 1);
});

test("叫停一个 Worker 还在启动中的任务：宿主不崩溃，Worker 启动后立即被停掉，收不到任何输入", async (t) => {
	const { host, spawner } = await startHost(replyOnReport, (w) => {
		w.report({ status: "ready", summary: "不该运行" });
		w.settle();
	});
	t.after(() => host.stop());
	let release!: () => void;
	spawner.spawnGate = new Promise((r) => (release = r));
	const errors: unknown[] = [];
	const onRejection = (e: unknown) => errors.push(e);
	process.on("unhandledRejection", onRejection);
	t.after(() => process.off("unhandledRejection", onRejection));
	host.say("开始整理照片");
	await until(() => spawner.spawned.length === 1, "Worker 开始启动");
	const id = host.kernel.listTickets()[0].id;
	assert.deepEqual(host.kernel.route([{ kind: "stop", ticketId: id }]).map((r) => r.ok), [true]);
	host.dispatcher.kick();
	release();
	await until(() => spawner.stopped.includes(id), "启动完成后被停掉");
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(errors, []);
	assert.deepEqual(spawner.workers.get(id)!.inputs, []);
	assert.equal(host.kernel.listTickets()[0].stage, "stopped");
});

test("Worker 一轮以普通模型错误结束：任务汇报失败，使用者经 Router 得知", async (t) => {
	const { host, said } = await startHost(replyOnReport, (w) => w.settle("500 Internal Server Error"));
	t.after(() => host.stop());
	host.say("整理本周账单");
	await until(() => host.kernel.listTickets()[0]?.stage === "blocked_or_failed", "任务进入失败");
	assert.match(host.kernel.listTickets()[0].latestSummary!, /500 Internal Server Error/);
	await until(() => said().some((s) => s.startsWith("结果：")), "Router 转告");
});

test("Worker 子进程在一轮中途退出：任务汇报失败，使用者经 Router 得知", async (t) => {
	const { host, said } = await startHost(replyOnReport, (w) => w.crash());
	t.after(() => host.stop());
	host.say("备份照片");
	await until(() => host.kernel.listTickets()[0]?.stage === "blocked_or_failed", "任务进入失败");
	assert.match(host.kernel.listTickets()[0].latestSummary!, /退出/);
	await until(() => said().some((s) => s.startsWith("结果：")), "Router 转告");
});

test("对话卡片列出进行中的任务，Router 只凭卡片就能把“刚才那个”转交给它", async (t) => {
	const brain: Brain = (cards) =>
		cards.flatMap((card) => {
			if (!card.startsWith("[对话]")) return [];
			if (card.includes("使用者：帮我整理照片")) return openOnConversation(card, "整理照片");
			const target = card.match(/(tkt_[\w-]+)「整理照片」/)?.[1];
			return target ? [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: ids(card, "trg"), ticketId: target }] } }] : [];
		});
	const { host, spawner } = await startHost(brain, (w) => {
		w.report({ status: "progress", summary: "整理中" });
		w.settle();
	});
	t.after(() => host.stop());
	host.say("帮我整理照片");
	await until(() => host.kernel.listTickets()[0]?.stage === "idle", "第一轮结束");
	host.say("刚才那个改成只要 2024 年的");
	const id = host.kernel.listTickets()[0].id;
	await until(() => spawner.workers.get(id)!.inputs.some((i) => i.includes("只要 2024 年")), "后续消息转交给了原任务");
});

test("状态目录路径太长、socket 超出系统上限时，启动前就给出说得清原因的错误，且不改动已有状态", async () => {
	const long = join(tempStateDir(), "a-really-long-directory-name-to-push-the-socket-path-over-the-unix-limit", "and-some-more");
	mkdirSync(long, { recursive: true });
	const marker = join(long, "location.json");
	writeFileSync(marker, JSON.stringify({ path: "/somewhere/else" }));
	await assert.rejects(startHost(() => [], () => {}, { stateDir: long }), /状态目录路径太长.*PSA_STATE_DIR/s);
	assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { path: "/somewhere/else" });
});

test("宿主启动时状态目录不存在就建成 0700", async (t) => {
	const stateDir = join(tempStateDir(), "state");
	const { host } = await startHost(() => [], () => {}, { stateDir });
	t.after(() => host.stop());
	assert.equal(statSync(stateDir).mode & 0o777, 0o700);
});

const NEWS_DOMAINS = domainsOf({
	news: { team: "新闻队", crew: [{ name: "news-researcher", title: "新闻研究员", description: "查新闻", tools: undefined, skills: [], model: undefined, prompt: "", file: "/modules/news/agents/news.md" }], skillsDir: "/modules/news/skills", prepare: "npm ci" },
	mail: { skillsDir: "/modules/mail/skills" },
});
const DISPATCH = { timeoutMs: 1000, codingTimeoutMs: 1000, stallMs: 1000, maxConcurrent: 1 };

test("宿主把领域簿交给内核，任务的领域决定启动助手时交给它哪些成员；领域没有成员和没有领域的任务都是单个助手", async (t) => {
	const brain: Brain = (cards) =>
		cards.flatMap((card) => (card.startsWith("[对话]") ? [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId: ids(card, "trg"), title: "t", brief: "b", ...(card.includes("新闻") && { domain: "news" }), ...(card.includes("邮件") && { domain: "mail" }) }] } }] : []));
	const { host, spawner } = await startHost(brain, (w) => w.settle(), { domains: NEWS_DOMAINS, dispatch: DISPATCH });
	t.after(() => host.stop());
	host.say("看下听证会的新闻");
	host.say("回一下邮件");
	host.say("查明天天气");
	await until(() => spawner.workers.size === 3, "三个助手都启动");
	const seen = host.kernel.listTickets().map((row) => [host.kernel.getTicket(row.id)!.domain, "team" in row.helper! && row.helper.team, spawner.workers.get(row.id)!.spec.crew.map((m) => m.name)]);
	assert.deepEqual(seen, [["news", "新闻队", ["news-researcher"]], ["mail", false, []], [null, false, []]]);
});

test("幕僚长经 route 工具把 domain 填成 null 或两头带空白：null 当没填，空白去掉", async (t) => {
	const brain: Brain = (cards) =>
		cards.flatMap((card) => (card.startsWith("[对话]") ? [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId: ids(card, "trg"), title: "t", brief: "b", domain: card.includes("新闻") ? " news " : null }] } }] : []));
	const { host, spawner } = await startHost(brain, (w) => w.settle(), { domains: NEWS_DOMAINS });
	t.after(() => host.stop());
	host.say("看下听证会的新闻");
	host.say("查明天天气");
	await until(() => spawner.workers.size === 2, "两个助手都启动");
	assert.deepEqual(host.kernel.listTickets().map((row) => host.kernel.getTicket(row.id)!.domain), ["news", null]);
});

test("知识跟着领域走：对话里开的任务属于哪个领域，助手就拿到那个模块的技能目录和 prepare；没有领域的助手什么都不带", async (t) => {
	const brain: Brain = (cards) =>
		cards.flatMap((card) => (card.startsWith("[对话]") ? [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId: ids(card, "trg"), title: "t", brief: "b", ...(card.includes("新闻") && { domain: "news" }), ...(card.includes("邮件") && { domain: "mail" }) }] } }] : []));
	const { host, spawner } = await startHost(brain, (w) => w.settle(), { domains: NEWS_DOMAINS });
	t.after(() => host.stop());
	host.say("看下听证会的新闻");
	host.say("回一下邮件");
	host.say("查明天天气");
	await until(() => spawner.workers.size === 3, "三个助手都启动");
	const handed = host.kernel.listTickets().map((row) => spawner.workers.get(row.id)!.spec).map((spec) => [spec.skillsDir, spec.prepare, spec.crew.length]);
	assert.deepEqual(handed, [["/modules/news/skills", "npm ci", 0], ["/modules/mail/skills", undefined, 0], [undefined, undefined, 0]], "这个宿主不能派活，成员名单是空的，技能照给");
	assert.ok(!("ruleId" in spawner.workers.values().next().value!.spec));
});

test("幕僚长给模块规则的任务填了别的领域时，助手拿到的是规则所在模块的成员，内核记的那一行写进宿主日志", async (t) => {
	const logs: string[] = [];
	const brain: Brain = (cards) =>
		cards.flatMap((card) => (card.startsWith("[候选触发]") ? [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "rule", ruleId: "news/breaking", domain: "mail", triggerId: ids(card, "trg"), title: "t", brief: "b" }] } }] : []));
	const { host, spawner } = await startHost(brain, (w) => w.settle(), { domains: NEWS_DOMAINS, dispatch: DISPATCH, ruleAllows: () => true, log: (line) => logs.push(line) });
	t.after(() => host.stop());
	host.kernel.submitTrigger({ source: "feeds", externalId: "n1", threads: [{ id: "thr_feeds:n1" }], sender: "rss", body: "听证会", occurredAt: Date.now() });
	await until(() => spawner.workers.size === 1, "助手启动");
	assert.deepEqual([...spawner.workers.values()][0].spec.crew.map((m) => m.name), ["news-researcher"]);
	assert.equal(logs.filter((line) => line.startsWith("[kernel] 规则 news/breaking 属于领域「news」，幕僚长填的是「mail」")).length, 1, logs.join("\n"));
});

test("同一句话带同一个 externalId 再说一次：只记一条触发，客户端只收到一次", async (t) => {
	const { host } = await startHost(() => [], () => {});
	const got: HostToClient[] = [];
	const conn = new HostConnection({ socketPath: host.socketPath, onMessage: (m) => got.push(m), retryMs: 30 });
	conn.open();
	t.after(async () => {
		conn.close();
		await host.stop();
	});
	await until(() => conn.connected, "连接");
	const first = host.say("查一下 NVDA", { externalId: "tg:123:5" });
	assert.equal(host.say("查一下 NVDA", { externalId: "tg:123:5" }), first);
	host.say("另一句", { externalId: "tg:123:6" });
	await until(() => ofType(got, "user").length === 2, "两句话到达客户端");
	await host.settled();
	assert.deepEqual(ofType(got, "user").map((m) => m.text), ["查一下 NVDA", "另一句"]);
	assert.deepEqual(host.kernel.conversation().filter((l) => l.who === "user").map((l) => l.text), ["查一下 NVDA", "另一句"]);
});
