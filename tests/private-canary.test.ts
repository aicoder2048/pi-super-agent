import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Host } from "../src/host/host.ts";
import { BotApi, BotToken } from "../src/host/telegram/bot-api.ts";
import { createGateway } from "../src/modules/gateway.ts";
import { instanceData } from "../src/modules/instance-data.ts";
import { moduleDataDir } from "../src/modules/knowledge.ts";
import { ModuleStore } from "../src/modules/live.ts";
import type { Digest, ModuleName } from "../src/modules/manifest.ts";
import { privateLine } from "../src/modules/protocol.ts";
import { scanPackage } from "../src/modules/validate.ts";
import type { Domains } from "../src/modules.ts";
import type { Member } from "../src/teams.ts";
import { Watchdog } from "../src/watchdog/watchdog.ts";
import { FAKE_BOT_TOKEN, FakeTelegram } from "./helpers/fake-telegram.ts";
import { defaultWorkerModels, FakeSpawner, fauxRouter, ids, until, type Brain, type FakeWorker, type ToolCallSpec } from "./helpers/fakes.ts";

const CANARY = "CANARY-7Q4";
const USER = 42;
const HEALTH = "personal-health" as ModuleName;
const NOTICE = privateLine("个人医疗健康");
const FORGOT = "记得：（没有）";
const SAMPLE = join(import.meta.dirname, "../docs/modules/architecture/sample/personal-health");
const oncologist: Member = { name: "oncologist", title: "肿瘤科医生", description: "看肿瘤标志物", tools: ["read"], skills: [], model: undefined, prompt: "oncologist", file: "/agents/oncologist.md" };
const write = (value: number, from = "使用者口述") => ({ op: "write", collection: "lab-results", rows: [{ item: "CEA", value, unit: "ng/mL", reference: "<5", takenAt: "2026-10-01", lab: CANARY }], from });

const echoesSession = (): Brain => {
	let asking: string | undefined;
	return (cards, _call, toolResults, sessionText) => {
		const held = sessionText.includes(CANARY);
		const recalled = held ? `记得：${CANARY}` : FORGOT;
		const tail = held ? `｜${CANARY}` : "";
		const open = (triggerId: string | undefined, title: string, domain: string | undefined, basis = "request"): ToolCallSpec => ({
			name: "route",
			args: { decisions: [{ kind: "open_ticket", basis, triggerId, title: `${title}${tail}`, brief: `${title}${tail}`, domain }] },
		});
		if (cards.length === 0) return toolResults.some((r) => r.includes('"type": "ticket"') || r.includes('"type": "trigger"')) ? [{ name: "reply", args: { text: recalled, cause: asking } }] : [];
		return cards.flatMap((card): ToolCallSpec[] => {
			const kind = card.slice(0, card.indexOf("]") + 1);
			if (kind === "[Worker 汇报]" || kind === "[Worker 提问]") return [{ name: "reply", args: { text: `转述：${recalled}`, cause: ids(card, "tkt") } }];
			if (kind === "[通知]") return [{ name: "reply", args: { text: `通知：${recalled}`, cause: card.match(/act_[\w-]+/)![0] } }];
			if (kind === "[候选触发]") return card.includes("广告") ? [{ name: "route", args: { decisions: [{ kind: "ignore", triggerId: ids(card, "trg"), reason: `广告${tail}` }] } }] : [open(ids(card, "trg"), "看信", HEALTH, "inference")];
			if (kind !== "[对话]") return [];
			const triggerId = ids(card, "trg")!;
			const said = card.split("使用者：")[1]!.split("\n")[0]!;
			const answered = card.match(/点选回答：(tkt_[\w-]+)/)?.[1];
			if (answered) return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId, ticketId: answered }] } }, { name: "reply", args: { text: `回：${recalled}`, cause: triggerId } }];
			const task = said.match(/^开个任务 (\S+)/)?.[1];
			if (task) return [open(triggerId, task, task === "天气" || task === "查一下" || task === "接手" ? undefined : HEALTH), { name: "reply", args: { text: `收到：${task}`, cause: triggerId } }];
			const handTo = said.match(/^转交 (tkt_[\w-]+)/)?.[1];
			if (handTo) return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId, ticketId: handTo }] } }, { name: "reply", args: { text: `回：${recalled}`, cause: triggerId } }];
			const browse = said.match(/^翻看 ((?:tkt|trg)_[\w-]+)/)?.[1];
			if (browse) {
				asking = triggerId;
				return [{ name: "read", args: { id: browse } }];
			}
			const noted = said.match(/^备注 (tkt_[\w-]+)/)?.[1];
			if (noted) return [{ name: "note", args: { ticketId: noted, text: `补充${tail}` } }, { name: "reply", args: { text: recalled, cause: triggerId } }];
			return [{ name: "reply", args: { text: `回：${recalled}`, cause: triggerId } }];
		});
	};
};

test("金丝雀：私密模块数据里的一串字，走遍每条流程、清屏、重启，都不出现在 Telegram 上；清屏后普通回复完整", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "psa-canary-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const stateDir = join(root, "state");
	const store = new ModuleStore(join(stateDir, "module-store"));
	const scan = scanPackage(SAMPLE, { runCases: false, folder: HEALTH });
	assert.ok(scan.ok);
	const digest: Digest = scan.scan.digest;
	assert.ok(store.keep(HEALTH, digest, SAMPLE));
	const gateway = createGateway({
		copyDir: (module, d) => store.dirOf(module, d),
		serving: (module) => (module === HEALTH ? digest : undefined),
		dataDir: (module) => moduleDataDir(stateDir, module),
		rows: instanceData(stateDir),
		secret: () => undefined,
		log: () => {},
	});
	const domains: Domains = {
		book: () => new Map([[HEALTH, { team: "健康顾问团", onRoster: true, digest, title: "个人医疗健康" }]]),
		kitFor: (d) => (d === HEALTH ? { skillsDir: undefined, prepare: undefined, crew: [oncologist], granted: [] } : undefined),
	};
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());

	let host!: Host;
	const data = (worker: FakeWorker, params: object) => worker.request("worker.data", params);
	const work = async (worker: FakeWorker, input: string) => {
		const title = host.kernel.getTicket(worker.spec.ticketId)!.title;
		const heard = input.includes(CANARY) ? `｜听到 ${CANARY}` : "";
		if (!input.startsWith("[任务说明]")) {
			if (title.startsWith("卡住")) return;
			if (title.startsWith("接手") && heard) {
				worker.report({ status: "blocked", summary: `接手${heard}`, question: `按 ${CANARY} 办吗？`, options: ["好", "不"] });
				return worker.settle();
			}
			worker.report({ status: "ready", summary: `好了${heard}` });
			return worker.settle();
		}
		if (title.startsWith("记指标")) {
			await data(worker, write(4.2));
			worker.report({ status: "ready", summary: `CEA 4.2，${CANARY}` });
		} else if (title.startsWith("提问")) {
			await data(worker, { op: "query", collection: "lab-results" });
			worker.report({ status: "blocked", summary: `两次结果，一次是 ${CANARY}`, question: `按 ${CANARY} 那次？`, options: [`${CANARY} 那次`, "另一次"] });
		} else if (title.startsWith("查一下")) {
			worker.report({ status: "blocked", summary: "要查哪天", question: "查哪天？", options: ["今天", "明天"] });
		} else if (title.startsWith("卡住")) {
			await data(worker, { op: "query", collection: "lab-results" });
			return;
		} else if (title.startsWith("设提醒")) {
			await worker.request("worker.watch", { collection: "lab-results", op: "set", key: "CEA", condition: { when: "above", value: 5 } });
			await data(worker, write(9, `blobs/${CANARY}.pdf`));
			worker.report({ status: "ready", summary: "设好了" });
		} else if (title.startsWith("派活")) {
			const member = await worker.request("worker.dispatch", { agent: "oncologist", task: "看 CEA", callId: "call_1" });
			worker.report({ status: "ready", summary: `成员说：${JSON.stringify(member)}` });
		} else {
			worker.report({ status: "progress", summary: `好了${heard}` });
		}
		worker.settle();
	};

	const start = async () => {
		const spawner = new FakeSpawner((worker, input) => work(worker, input).catch((e: Error) => worker.report({ status: "failed", summary: e.message })));
		spawner.runner = async (run) => {
			const read = await spawner.request(run.ticketId, run.token, "worker.data", { op: "query", collection: "lab-results" });
			return `看了，${JSON.stringify(read).includes(CANARY) ? CANARY : "无"}`;
		};
		host = await Host.start({
			stateDir,
			createRouter: fauxRouter(echoesSession(), { persist: true }).createRouter,
			createSpawner: () => spawner,
			log: () => {},
			workerModels: defaultWorkerModels(),
			domains,
			gateway,
			config: { maxWorkers: 12, replyMaxChars: 400, repliesPerCause: 50 },
			dispatch: { timeoutMs: 5000, codingTimeoutMs: 5000, stallMs: 5000, maxConcurrent: 4 },
			telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 1, minGapMs: 5 } },
		});
		spawner.request = (...args) => host.workers.handleRequest(...args);
	};
	await start();
	t.after(() => host.stop());

	const phone = () => tg.sent.filter((m) => m.chatId === USER && !m.text.startsWith("你在网页或终端说：")).map((m) => m.text);
	const web = () => host.kernel.conversation(500).map((l) => l.text);
	const problems: string[] = [];
	const expect = (ok: boolean, label: string) => ok || problems.push(label);
	let seen = 0;
	const sweep = (name: string) => {
		const all = [...tg.sent.map((m) => m.text), ...tg.edits.map((e) => e.text)];
		for (const text of all.slice(seen)) if (text.includes(CANARY)) problems.push(`${name}：金丝雀到了 Telegram「${text}」`);
		seen = all.length;
	};
	const flow = async (name: string, drive: () => unknown, done: () => boolean) => {
		const before = phone().length;
		await drive();
		await until(done, name, 10_000).catch((e: Error) => {
			throw new Error(`${e.message}\n网页：${web().join(" / ")}\n任务：${JSON.stringify(host.kernel.listTickets().map((r) => [r.title, r.stage, r.latestSummary]))}\n手机：${phone().join(" / ")}`);
		});
		await new Promise((r) => setTimeout(r, 150));
		sweep(name);
		return phone().slice(before);
	};
	const replyCount = () => host.kernel.conversation(500).filter((l) => l.who === "router").length;
	const replied = (name: string, drive: () => unknown) => {
		const before = replyCount();
		const phoneBefore = phone().length;
		return flow(name, drive, () => replyCount() > before && phone().length > phoneBefore);
	};
	const said = (name: string, text: string) => replied(name, () => host.say(text));
	const ticket = (prefix: string) => host.kernel.listTickets().find((r) => r.title.startsWith(prefix));
	const summary = (prefix: string) => ticket(prefix)?.latestSummary ?? "";

	tg.userSays(USER, "/start");
	await until(() => tg.sent.length > 0, "聊天打开");
	sweep("聊天打开");

	expect((await flow("私密数据之前开普通任务", () => host.say("开个任务 天气"), () => summary("天气") !== "" && phone().includes("收到：天气"))).includes("收到：天气"), "私密数据之前的回复完整发到 Telegram");
	await flow("私密数据之前开普通任务，之后转交给它", () => host.say("开个任务 接手"), () => summary("接手") !== "" && phone().includes("收到：接手"));
	await flow("私密任务汇报", () => host.say("开个任务 记指标"), () => web().includes(`转述：记得：${CANARY}`));
	expect((await said("私密汇报之后问幕僚长", "刚才是多少")).join() === NOTICE, "私密汇报之后的回复是一行提示");
	await flow("幕僚长有私密数据时开任务，任务提问", () => host.say("开个任务 查一下"), () => ticket("查一下")?.question != null);
	await flow("note()：幕僚长补话给普通任务", () => host.say(`备注 ${ticket("天气")!.id}`), () => summary("天气").includes(CANARY));
	await flow("私密任务提问", () => host.say("开个任务 提问"), () => ticket("提问")?.question != null);
	await said("会卡住的私密任务", "开个任务 卡住");
	await flow("G3 私密数据上的提醒", () => host.say("开个任务 设提醒"), () => host.kernel.alertsToday().length > 0 && summary("设提醒") !== "");
	await flow("派活给成员", () => host.say("开个任务 派活"), () => summary("派活").includes(CANARY));
	await flow("私密 feed 触发", () => host.kernel.submitTrigger({ source: "personal-health/hospital-mail", externalId: "mail-1", threads: [{ id: "thr_mail" }], sender: "hospital", body: `检验单 ${CANARY}`, occurredAt: Date.now(), private: true }), () => summary("看信") !== "");

	await flow("幕僚长有私密数据时忽略一条普通候选触发", () => host.kernel.submitTrigger({ source: "generic", externalId: "ad-1", threads: [{ id: "thr_ad" }], sender: "shop", body: "广告 优惠", occurredAt: Date.now() }), () => host.kernel.triggerLog().some((t) => t.externalId === "ad-1" && t.disposition === "router_ignored"));

	host.clearConversation();
	const ad = host.kernel.triggerLog().find((t) => t.externalId === "ad-1")!;
	expect((await said("清屏后 read 幕僚长有私密数据时忽略的触发", `翻看 ${ad.id}`)).join() === NOTICE, "read 幕僚长有私密数据时写下忽略理由的触发之后，回复是一行提示");

	host.clearConversation();
	const watchdog = new Watchdog({ stateDir, clock: { now: () => Date.now() + 3_600_000 }, config: { heartbeatStaleMs: Number.POSITIVE_INFINITY, restartGraceMs: 0 }, kernel: { stuckMs: 60_000 }, startHost: () => {} });
	expect((await replied("清屏后 Watchdog 报卡住的私密任务", () => watchdog.checkOnce())).includes(`通知：${FORGOT}`), "清屏后 Watchdog 的通知完整发到 Telegram");
	expect((await said("清屏后说话，对话卡片列着最近的任务", "早上好")).includes(`回：${FORGOT}`), "清屏后普通回复完整发到 Telegram");

	expect((await said("清屏后 read 私密任务", `翻看 ${ticket("记指标")!.id}`)).join() === NOTICE, "read 私密任务之后的回复是一行提示");
	assert.ok(web().at(-1)?.includes(CANARY), "read 把金丝雀带进了幕僚长的会话");

	host.clearConversation();
	const relay = host.kernel.cleared(500)!.lines.find((l) => l.text === `转述：记得：${CANARY}`)!.id;
	expect((await replied("清屏后引用私密转述", () => host.sayQuoting("这个呢", relay))).includes(NOTICE), "引用私密转述之后的回复是一行提示");

	host.clearConversation();
	const relayAgain = host.kernel.cleared(500)!.lines.find((l) => l.text === `转述：记得：${CANARY}`)!.id;
	await flow("清屏后引用私密转述，转交给普通任务", () => host.sayQuoting(`转交 ${ticket("接手")!.id}`, relayAgain), () => ticket("接手")?.question != null);
	expect(host.kernel.touchedPrivate(ticket("接手")!.id), "带着私密引用转交过去的普通任务算私密任务");

	host.clearConversation();
	expect((await said("清屏后 read 收到私密引用的任务", `翻看 ${ticket("接手")!.id}`)).join() === privateLine("模块"), "read 收到私密引用的任务之后的回复是一行提示");

	host.clearConversation();
	const notice = tg.sent.find((m) => m.chatId === USER && m.text === NOTICE)!.messageId;
	expect((await replied("清屏后在 Telegram 上回复那行提示", () => tg.userSays(USER, "这是什么", { replyTo: notice }))).includes(NOTICE), "回复那行提示之后的回复是一行提示");

	host.clearConversation();
	const ownLine = host.kernel.cleared(500)!.lines.find((l) => l.text === "开个任务 查一下")!.id;
	expect((await replied("清屏后引用自己开私密任务的那句话", () => host.sayQuoting("这个呢", ownLine))).includes(`回：${FORGOT}`), "引用自己的话时私密任务只写模块，回复完整发到 Telegram");

	host.clearConversation();
	const question = ticket("提问")!.question!;
	await replied("清屏后在网页上点选回答私密问题", () => host.answer(question.reportId, 0));
	await until(() => summary("提问").startsWith("好了"), "提问任务收到回答");

	await host.stop();
	await start();
	expect((await said("重启后幕僚长接回会话", "刚才是多少")).join() === NOTICE, "重启后接回的会话里有私密数据，回复是一行提示");
	host.clearConversation();
	await host.stop();
	await start();
	expect((await said("清屏再重启后说话", "早上好")).includes(`回：${FORGOT}`), "清屏再重启后普通回复完整发到 Telegram");
	await new Promise((r) => setTimeout(r, 300));
	sweep("收尾");

	assert.deepEqual(problems, []);
});
