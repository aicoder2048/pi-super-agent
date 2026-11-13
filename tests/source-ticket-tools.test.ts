import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Kernel } from "../src/kernel/kernel.ts";
import { openStore } from "../src/kernel/store.ts";
import { CONVERSATION_THREAD_ID, type Basis, type Opener } from "../src/kernel/types.ts";
import type { MemberRun } from "../src/host/dispatch.ts";
import { workerArgs } from "../src/host/pi-worker.ts";
import { memberTools, profileOf, toolAllowlist } from "../src/worker/tools.ts";
import { Modules, packageModule } from "../src/modules.ts";
import { piCliPath } from "../src/pi-runtime.mjs";
import { ids, startHost, until, type Brain } from "./helpers/fakes.ts";

function kernelWithTriggers() {
	const kernel = new Kernel({ db: openStore(":memory:"), clock: { now: () => Date.now() }, sourcePolicy: () => "candidate" });
	let n = 0;
	const trigger = (source: string) =>
		kernel.submitTrigger({ source, externalId: `e${++n}`, threads: [{ id: source === "conversation" ? CONVERSATION_THREAD_ID : `thr_${source}:${n}` }], sender: source, body: "事件", occurredAt: Date.now() }).triggerId;
	const open = (basis: Basis, source: string | undefined) => {
		const [result] = kernel.route([{ kind: "open_ticket", title: "t", basis, ruleId: basis === "rule" ? "r" : undefined, triggerId: source === undefined ? undefined : trigger(source), brief: "b" }]);
		assert.ok(result.ok, !result.ok ? result.reason : "");
		return result.ticketId!;
	};
	return { kernel, trigger, open };
}

test("任务由谁开：请求是使用者；来源名是「模块/feed」的触发开的规则和推断任务是模块 feed；宿主自带来源开的是宿主来源", () => {
	const { kernel, open } = kernelWithTriggers();
	const cases: [Basis, string | undefined, Opener][] = [
		["request", "conversation", "user"],
		["rule", "stock-ta/quotes", "module-feed"],
		["inference", "stock-ta/scan", "module-feed"],
		["inference", "mail/inbox", "module-feed"],
		["rule", "us-market", "host-source"],
		["inference", "us-market", "host-source"],
		["rule", "timer", "host-source"],
		["inference", "toy-market", "host-source"],
		["rule", "watchdog", "host-source"],
	];
	for (const [basis, source, opener] of cases) assert.equal(kernel.openedBySource(open(basis, source)), opener, `${basis} · ${source}`);
});

test("没有触发的推断任务不知道读过谁的话，按模块 feed 收紧", () => {
	const { kernel, open } = kernelWithTriggers();
	assert.equal(kernel.openedBySource(open("inference", undefined)), "module-feed");
});

test("内核拒绝用模块 feed 的触发开请求任务：请求只能来自对话", () => {
	const { kernel, trigger } = kernelWithTriggers();
	const [result] = kernel.route([{ kind: "open_ticket", title: "t", basis: "request", triggerId: trigger("mail/inbox"), brief: "b" }]);
	assert.equal(result.ok, false);
	assert.match(!result.ok ? result.reason : "", /conversation trigger/);
});

test("工具档按依据和开任务的人选：模块 feed 开的规则和推断任务同一档，其余照依据", () => {
	assert.equal(profileOf("rule", "module-feed"), "module-feed");
	assert.equal(profileOf("inference", "module-feed"), "module-feed");
	assert.equal(profileOf("inference", "host-source"), "inference");
	assert.equal(profileOf("rule", "host-source"), "rule");
	assert.equal(profileOf("request", "user"), "request");
});

test("模块 feed 开的任务：读文件、汇报、模块的工具知识数据和提醒，没有 web_get、bash、edit、write、后台命令、开应用和盯盘条件", () => {
	const tools = toolAllowlist("module-feed")!;
	assert.deepEqual([...tools].sort(), ["data", "domain_tool", "find", "grep", "hand_back", "knowledge", "lookup", "ls", "read", "read_ticket", "report", "watch"]);
	for (const banned of ["web_get", "bash", "edit", "write", "bg_start", "bg_status", "bg_stop", "new_app", "tripwire"]) assert.ok(!tools.includes(banned), banned);
	assert.deepEqual(toolAllowlist("module-feed", true), [...tools, "dispatch_agent"]);
});

test("模块 feed 开的任务派的成员只有读文件的工具，领域开了时加 lookup；成员写了 bash、web_get 也拿不到", () => {
	assert.deepEqual(memberTools("module-feed", undefined), ["read", "grep", "find", "ls", "lookup"]);
	assert.deepEqual(memberTools("module-feed", ["bash", "web_get", "write", "read"]), ["read"]);
});

test("宿主来源开的推断任务保留 web_get；使用者和宿主来源开的规则任务的清单和 trunk 一样不设限", () => {
	assert.ok(toolAllowlist("inference")!.includes("web_get"));
	assert.ok(memberTools("inference", undefined).includes("web_get"));
	assert.equal(toolAllowlist("request"), undefined);
	assert.equal(toolAllowlist("rule"), undefined);
	assert.deepEqual(memberTools("rule", undefined), ["read", "bash", "edit", "write", "grep", "find", "ls", "web_get", "lookup"]);
});

test("模块 feed 开的任务的 Worker 启动参数：只给受限清单并关掉 MCP", () => {
	const args = workerArgs({ sessionDir: "/s", sessionId: "sid", extension: "/ext.ts", prompt: "p", profile: "module-feed" });
	const tools = args[args.indexOf("--tools") + 1].split(",");
	assert.ok(!tools.includes("web_get") && !tools.includes("bash"));
	assert.ok(args.includes("--no-mcp"));
});

test("模块 feed 开的任务的 Worker 提示写明为什么没有 bash 和 web_get：调不在清单里的工具，Pi 只回 Tool X not found", () => {
	const args = workerArgs({ sessionDir: "/s", sessionId: "sid", extension: "/ext.ts", prompt: "p", profile: "module-feed" });
	const prompts = args.filter((_, i) => args[i - 1] === "--append-system-prompt");
	const line = prompts.find((p) => p.startsWith("来源开的任务不能用"));
	assert.ok(line, prompts.join("\n"));
	assert.match(line, /bash/);
	assert.match(line, /web_get/);
	assert.match(line, /在汇报里请使用者在对话里提出/);
});

let loads = 0;
const home = process.env.HOME;
test.afterEach(() => {
	process.env.HOME = home;
});

async function hook(profile: string, roots: string[], extra: Record<string, string> = {}) {
	Object.assign(process.env, { PSA_SOCKET: "/nonexistent.sock", PSA_TICKET: "tkt_1", PSA_TOKEN: "tok", PSA_PROFILE: profile, PSA_READ_ROOTS: JSON.stringify(roots), PSA_PI_CLI: piCliPath() }, extra);
	const { default: workerExtension } = await import(`../src/worker/extension.ts?hook=${++loads}`);
	const handlers = new Map<string, any>();
	workerExtension({ registerTool() {}, on: (event: string, fn: any) => handlers.set(event, fn), sendMessage() {}, appendEntry() {} });
	return (toolName: string, input: Record<string, unknown>, cwd: string): Promise<{ block: true; reason: string } | undefined> => handlers.get("tool_call")({ type: "tool_call", toolCallId: "c", toolName, input }, { cwd });
}

function fakeHome() {
	const home = mkdtempSync(join(tmpdir(), "psa-src-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "auth.json"), '{"token":"pi-auth-secret"}');
	mkdirSync(join(home, "secrets"));
	writeFileSync(join(home, "secrets", ".env"), "MAIL_TOKEN=secret\n");
	const state = join(home, ".psa-state");
	const workdir = join(state, "workers", "tkt_1");
	mkdirSync(workdir, { recursive: true });
	writeFileSync(join(workdir, "notes.md"), "笔记");
	writeFileSync(join(state, "plain.txt"), "状态目录里的普通文件");
	return { home, state, workdir, roots: [realpathSync(workdir)] };
}

test("宿主来源开的推断任务读不到 ~/.pi/agent/auth.json 和 secretsFile，读得到自己的工作目录", async () => {
	const { home, workdir, roots } = fakeHome();
	const toolCall = await hook("inference", roots, { HOME: home });
	for (const path of ["~/.pi/agent/auth.json", join(home, "secrets", ".env"), "../../../secrets/.env"]) {
		const result = await toolCall("read", { path }, workdir);
		assert.equal(result?.block, true, `${path} 没被拦`);
	}
	assert.equal(await toolCall("read", { path: "notes.md" }, workdir), undefined);
	assert.equal(await toolCall("web_get", { url: "https://example.com/" }, workdir), undefined, "web_get 照常");
});

test("模块 feed 开的任务：read secretsFile、grep 状态目录、web_get、bash 都被拦，原因写着来源开的任务", async () => {
	const { home, state, workdir, roots } = fakeHome();
	const toolCall = await hook("module-feed", roots, { HOME: home });
	assert.equal((await toolCall("read", { path: "~/secrets/.env" }, workdir))?.block, true);
	assert.equal((await toolCall("grep", { pattern: "MAIL", path: state }, workdir))?.block, true);
	assert.equal((await toolCall("find", { pattern: "*.env", path: home }, workdir))?.block, true);
	assert.equal((await toolCall("ls", { path: "/" }, workdir))?.block, true);
	for (const tool of ["web_get", "bash"]) {
		const result = await toolCall(tool, {}, workdir);
		assert.equal(result?.block, true, tool);
		assert.match(result!.reason, new RegExp(`来源开的任务不能用 ${tool}`));
		assert.match(result!.reason, /在汇报里请使用者在对话里提出/);
	}
	assert.equal(await toolCall("domain_tool", { name: "x", input: {} }, workdir), undefined, "模块工具照常");
	assert.equal(await toolCall("grep", { pattern: "笔记" }, workdir), undefined, "在自己的工作目录里 grep 照常");
});

test("模块 feed 开的任务派的成员：bash、web_get 被拦，读 secretsFile 也被拦", async () => {
	const { home, workdir, roots } = fakeHome();
	const toolCall = await hook("module-feed", roots, { HOME: home, PSA_MEMBER_TOOLS: "read,grep,find,ls" });
	for (const tool of ["bash", "web_get"]) assert.equal((await toolCall(tool, {}, workdir))?.block, true, tool);
	assert.equal((await toolCall("read", { path: join(home, "secrets", ".env") }, workdir))?.block, true);
	assert.equal(await toolCall("read", { path: "notes.md" }, workdir), undefined);
});

test("使用者和宿主来源开的规则任务读文件不设根目录：状态目录里的普通文件照常读", async () => {
	const { home, state, workdir, roots } = fakeHome();
	for (const profile of ["request", "rule"]) {
		const toolCall = await hook(profile, roots, { HOME: home });
		assert.equal(await toolCall("read", { path: join(state, "plain.txt") }, workdir), undefined, profile);
		assert.equal(await toolCall("bash", { command: "echo hi" }, workdir), undefined, profile);
	}
});

test("宿主给模块 feed 开的任务的助手和成员：受限档、真实路径的三个根（工作目录、包里的 knowledge/ 和 skills/），没有成品目录规则", async (t) => {
	const pkg = mkdtempSync(join(tmpdir(), "psa-pkg-"));
	mkdirSync(join(pkg, "knowledge"));
	mkdirSync(join(pkg, "skills"));
	const member = { name: "structure-pattern", title: "结构与形态", description: "看形态", tools: ["read"], skills: [join(pkg, "skills")], model: undefined, prompt: "", file: join(pkg, "agents", "structure-pattern.md") };
	const domains = {
		book: () => new Map([["stock-ta", { team: "技术分析队", onRoster: true }]]),
		kitFor: () => ({ skillsDir: join(pkg, "skills"), knowledgeDir: join(pkg, "knowledge"), prepare: undefined, crew: [member], granted: [] }),
	};
	const brain: Brain = (cards) =>
		cards.flatMap((card) => {
			if (card.startsWith("[候选触发]")) return [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "rule", ruleId: "stock-ta/big-move", triggerId: ids(card, "trg"), title: "NVDA 大涨", brief: "看一下" }] } }];
			if (card.startsWith("[对话]")) return [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId: ids(card, "trg"), title: "问一下", brief: "问一下" }] } }];
			return [];
		});
	const runs: MemberRun[] = [];
	const { host, spawner } = await startHost(brain, () => {}, { domains, ruleAllows: () => true, dispatch: { timeoutMs: 1000, codingTimeoutMs: 1000, stallMs: 1000, maxConcurrent: 1 } });
	t.after(() => host.stop());
	spawner.runner = async (run) => (runs.push(run), "好");
	host.kernel.submitTrigger({ source: "stock-ta/quotes", externalId: "q1", threads: [{ id: "thr_stock-ta/quotes:NVDA" }], sender: "stock-ta", body: "NVDA +6%", occurredAt: Date.now() });
	await until(() => spawner.workers.size === 1, "规则任务的助手启动");
	const [feedWorker] = spawner.workers.values();
	assert.equal(feedWorker.spec.profile, "module-feed");
	assert.deepEqual(feedWorker.spec.readRoots, [realpathSync(feedWorker.spec.workdir), realpathSync(join(pkg, "knowledge")), realpathSync(join(pkg, "skills"))]);
	assert.equal(feedWorker.spec.outputRule, undefined, "没有写文件的工具，也就没有成品目录规则");
	await feedWorker.request("worker.dispatch", { agent: "structure-pattern", task: "看形态", callId: "call_1" });
	assert.equal(runs[0].profile, "module-feed");
	assert.deepEqual(runs[0].readRoots, feedWorker.spec.readRoots);
	host.say("问一下");
	await until(() => spawner.workers.size === 2, "请求任务的助手启动");
	const userWorker = [...spawner.workers.values()][1];
	assert.equal(userWorker.spec.profile, "request");
	assert.ok(userWorker.spec.outputRule);
});

test("模块包的领域工具箱带着包里的 knowledge/ 和 skills/，宿主拿它们当任务的读文件根", () => {
	const dir = join(import.meta.dirname, "..", "docs", "modules", "examples", "stock-ta");
	const kit = new Modules([packageModule(dir, "stock-ta")], [], []).kitFor("stock-ta")!;
	assert.equal(kit.knowledgeDir, join(dir, "knowledge"));
	assert.equal(kit.skillsDir, join(dir, "skills"));
});
