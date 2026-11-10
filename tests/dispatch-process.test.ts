import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DispatchDesk, memberSessionDir, type MemberRun } from "../src/host/dispatch.ts";
import { PiWorkerSpawner } from "../src/host/pi-worker.ts";
import type { TranscriptMessage } from "../src/client/protocol.ts";
import type { Basis } from "../src/kernel/types.ts";
import type { Member } from "../src/teams.ts";
import { FAKE_PROVIDER, FakeModel, fakeAgentEnv, on, worker } from "./e2e/fake-model.ts";
import { until, within } from "./helpers/fakes.ts";

// Stands in for `pi --mode json -p`: records how it was started, optionally leaves a grandchild in its
// process group, waits, then prints the JSON events Pi prints and exits.
const FAKE_PI = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const tag = argv.at(-1).split("\\n")[1];
writeFileSync(\`argv-\${tag}.json\`, JSON.stringify(argv));
writeFileSync(\`env-\${tag}.json\`, JSON.stringify(process.env));
writeFileSync(\`pid-\${tag}\`, String(process.pid));
if (process.env.FAKE_PI_GRANDCHILD) {
	const grandchild = spawn("sleep", ["30"], { stdio: process.env.FAKE_PI_GRANDCHILD === "holds-stdout" ? ["ignore", "inherit", "ignore"] : "ignore" });
	grandchild.unref();
	writeFileSync(\`grandchild-\${tag}.pid\`, String(grandchild.pid));
}
if (process.env.FAKE_PI_IGNORE_TERM) process.on("SIGTERM", () => {});
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
setTimeout(() => {
	say({ type: "agent_start" });
	say({ type: "message_end", message: { role: "user", content: [{ type: "text", text: argv.at(-1) }] } });
	const usage = { input: 90, output: 10, cacheRead: 10 };
	say({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "先" } });
	say({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } });
	say({ type: "message_end", message: { role: "assistant", provider: "openai-codex", content: [{ type: "text", text: "先查一下" }], usage, stopReason: "toolUse" } });
	say({ type: "tool_execution_start", toolCallId: "c1", toolName: "web_get", args: { url: "https://example.com/a" } });
	say({ type: "tool_execution_end", toolCallId: "c1", toolName: "web_get", result: {}, isError: false });
	say({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "web_get", content: [{ type: "text", text: "网页内容" }], isError: false } });
	const final = tag === "broken"
		? { role: "assistant", provider: "openai-codex", content: [], usage, stopReason: "error", errorMessage: "429 Too Many Requests" }
		: { role: "assistant", provider: "openai-codex", content: [{ type: "text", text: \`\${tag} 的回复\` }], usage, stopReason: "stop" };
	say({ type: "message_end", message: final });
	say({ type: "agent_settled" });
}, Number(process.env.FAKE_PI_DELAY_MS ?? 0));
`;

const member = (over: Partial<Member>): Member => ({ name: "news-researcher", title: "新闻研究员", description: "查新闻", tools: undefined, skills: [], model: undefined, prompt: "你是新闻研究员。", file: "/agents/news.md", ...over });
const MARKET = member({ name: "market-analyst", title: "行情分析师", tools: ["web_get", "bash", "read"], prompt: "你是行情分析师。" });
const NEWS = member({});

function withEnv(t: TestContext, env: Record<string, string>): void {
	const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
	Object.assign(process.env, env);
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	});
}

function setup(t: TestContext, env: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "psa-member-"));
	const cliPath = join(dir, "fake-pi.mjs");
	writeFileSync(cliPath, FAKE_PI);
	withEnv(t, env);
	const spawner = new PiWorkerSpawner({ socketPath: join(dir, "h.sock"), sessionDir: join(dir, "sessions"), cliPath, lookupHelp: "us-market quote" });
	const usage: number[] = [];
	const activity: (string | undefined)[] = [];
	const messages: TranscriptMessage[] = [];
	const run = (who: Member, tag: string, basis: Basis = "request", signal = new AbortController().signal) =>
		spawner.runMember({
			ticketId: "tkt_helper", member: who, task: `${tag}\n细节`, basis, token: `token-${tag}`, workdir: dir, sessionDir: memberSessionDir(dir, "tkt_helper", who.name), signal,
			model: { provider: "openai-codex", id: "gpt-6.1-sol" },
			onUsage: (u) => usage.push(u.tokensIn + u.tokensOut),
			onActivity: (step) => activity.push(step),
			onMessage: (message) => messages.push(message),
			callId: `call-${tag}`,
		} satisfies MemberRun);
	const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));
	return { dir, run, usage, activity, messages, read };
}

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("成员做一件事：Pi 打印模式，会话放在任务里这位成员自己的目录并接着上次，工具取交集，回复取最后一条，用量逐条上报", async (t) => {
	const { dir, run, usage, read } = setup(t);
	assert.equal(await run(MARKET, "m"), "m 的回复");
	const args: string[] = read("argv-m.json");
	assert.equal(flag(args, "--mode"), "json");
	assert.ok(args.includes("-p") && args.includes("--no-mcp") && args.includes("--no-extensions") && args.includes("--no-skills"));
	assert.equal(flag(args, "--session-dir"), join(dir, "workers", "tkt_helper", "team", "market-analyst"));
	assert.ok(args.includes("--continue"), "同一任务再派给它时接着上次的会话");
	assert.ok(!args.includes("--no-session"));
	assert.equal(flag(args, "--model"), "openai-codex/gpt-6.1-sol");
	assert.deepEqual(flag(args, "--tools")!.split(","), ["read", "bash", "web_get"]);
	assert.ok(args.includes("你是行情分析师。"));
	assert.deepEqual(args.slice(-2), ["--", "[派活] 行情分析师\nm\n细节"]);
	assert.deepEqual(usage, [110, 110]);
	await run(NEWS, "n");
	assert.equal(flag(read("argv-n.json"), "--session-dir"), join(dir, "workers", "tkt_helper", "team", "news-researcher"), "每位成员各有会话目录");
	assert.deepEqual(flag(read("argv-n.json"), "--tools")!.split(","), ["read", "bash", "edit", "write", "grep", "find", "ls", "web_get", "lookup"]);
});

test("推断任务里的成员即使写了 bash 也只读；交集为空时一个工具也没有", async (t) => {
	const { run, read } = setup(t);
	await run(MARKET, "m", "inference");
	assert.deepEqual(flag(read("argv-m.json"), "--tools")!.split(","), ["read", "web_get"]);
	await run(member({ name: "runner", tools: ["bash"] }), "r", "inference");
	const args: string[] = read("argv-r.json");
	assert.ok(args.includes("--no-tools") && !args.includes("--tools"));
});

test("成员进程拿不到密钥类变量；扩展以成员身份运行：带任务、自己的令牌和算好的工具清单，没有本队名册", async (t) => {
	const { run, read } = setup(t, { MASSIVE_API_KEY: "sk-market", FOO_TOKEN: "tok" });
	await run(MARKET, "m", "inference");
	const env = read("env-m.json");
	assert.equal(env.MASSIVE_API_KEY, undefined);
	assert.equal(env.FOO_TOKEN, undefined);
	assert.equal(env.PSA_MEMBER_TOOLS, "read,web_get");
	assert.equal(env.PSA_TICKET, "tkt_helper");
	assert.equal(env.PSA_TOKEN, "token-m");
	assert.equal(env.PSA_BASIS, "inference");
	assert.equal(env.PSA_LOOKUPS, "us-market quote");
	assert.equal(env.PSA_CREW, undefined, "成员不能再往下派");
	assert.equal(env.PSA_CALL_ID, "call-m", "成员进程知道这是助手的哪一次派活");
});

test("模型出错时这次派活失败并带上错误", async (t) => {
	const { run } = setup(t);
	await assert.rejects(run(NEWS, "broken"), /429/);
});

test("三位成员并行：总耗时远小于各自耗时之和", async (t) => {
	const { run } = setup(t, { FAKE_PI_DELAY_MS: "600" });
	const started = Date.now();
	await Promise.all([MARKET, NEWS, member({ name: "earnings" })].map((who, i) => run(who, `p${i}`)));
	const wall = Date.now() - started;
	assert.ok(wall < 1500, `串行至少 1800 ms，并行实际 ${wall} ms`);
});

test("中止一次派活：成员进程连同它起的子进程一起结束，不留孤儿", async (t) => {
	const { dir, run } = setup(t, { FAKE_PI_DELAY_MS: "30000", FAKE_PI_GRANDCHILD: "1" });
	const stop = new AbortController();
	const reply = run(NEWS, "g", "request", stop.signal);
	const pidFile = join(dir, "grandchild-g.pid");
	await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, "成员起了子进程", 10_000);
	const grandchild = Number(readFileSync(pidFile, "utf8"));
	const pid = Number(readFileSync(join(dir, "pid-g"), "utf8"));
	assert.ok(alive(grandchild) && alive(pid));
	stop.abort(new Error("任务已停止"));
	await assert.rejects(reply, /任务已停止/);
	assert.equal(alive(pid), false, "派活结束时成员进程已经没了");
	await until(() => !alive(grandchild), "子进程随进程组结束", 3000);
});

test("成员正常做完后，它留在进程组里的子进程也被清掉，哪怕那个子进程还占着成员的输出管道", async (t) => {
	const { dir, run } = setup(t, { FAKE_PI_GRANDCHILD: "holds-stdout" });
	assert.equal(await within(run(NEWS, "d"), 5000, "成员退出后派活就该结束"), "d 的回复");
	const grandchild = Number(readFileSync(join(dir, "grandchild-d.pid"), "utf8"));
	await until(() => !alive(grandchild), "子进程随进程组结束", 3000);
});

test("不理会 SIGTERM 的成员进程被 SIGKILL 结束", async (t) => {
	const { dir, run } = setup(t, { FAKE_PI_DELAY_MS: "30000", FAKE_PI_IGNORE_TERM: "1" });
	const stop = new AbortController();
	const reply = run(NEWS, "k", "request", stop.signal);
	await until(() => existsSync(join(dir, "pid-k")) && readFileSync(join(dir, "pid-k"), "utf8").length > 0, "成员进程起来了", 10_000);
	const pid = Number(readFileSync(join(dir, "pid-k"), "utf8"));
	await new Promise((done) => setTimeout(done, 100));
	stop.abort(new Error("任务已停止"));
	await assert.rejects(within(reply, 3000, "SIGTERM 没用时要补一个 SIGKILL"), /任务已停止/);
	assert.equal(alive(pid), false);
});

test("成员进程退出后不再往它的进程组发信号", async (t) => {
	const { dir, run } = setup(t, { FAKE_PI_DELAY_MS: "30000" });
	const stop = new AbortController();
	const reply = run(NEWS, "s", "request", stop.signal);
	await until(() => existsSync(join(dir, "pid-s")) && readFileSync(join(dir, "pid-s"), "utf8").length > 0, "成员进程起来了", 10_000);
	const pid = Number(readFileSync(join(dir, "pid-s"), "utf8"));
	stop.abort(new Error("任务已停止"));
	await assert.rejects(reply, /任务已停止/);
	const late: unknown[][] = [];
	const kill = t.mock.method(process, "kill", (...args: unknown[]) => (late.push(args), true));
	await new Promise((done) => setTimeout(done, 1200));
	kill.mock.restore();
	assert.deepEqual(late.filter(([target]) => target === -pid), [], "进程组已经没了，那个 pid 可能已经是别的进程");
});

test("成员进程在跑时，它的会话目录里记着进程号；进程没了记录也清掉", async (t) => {
	const { dir, run } = setup(t, { FAKE_PI_DELAY_MS: "400" });
	const ledger = join(memberSessionDir(dir, "tkt_helper", "news-researcher"), "running.json");
	const reply = run(NEWS, "l");
	await until(() => existsSync(join(dir, "pid-l")) && readFileSync(join(dir, "pid-l"), "utf8").length > 0, "成员进程起来了", 10_000);
	assert.equal(JSON.parse(readFileSync(ledger, "utf8")).pgid, Number(readFileSync(join(dir, "pid-l"), "utf8")));
	await assert.rejects(run(NEWS, "second"), /新闻研究员在这个任务里的上一个进程还没结束/);
	assert.equal(existsSync(join(dir, "pid-second")), false, "不起第二个进程去写同一份会话");
	await reply;
	assert.equal(existsSync(ledger), false);
});

test("成员进程的每个事件都是一次动静；开始用工具或模型开始出字时带上这一步的中文说法", async (t) => {
	const { run, activity } = setup(t);
	await run(NEWS, "a");
	assert.deepEqual(activity, [undefined, undefined, "思考", undefined, undefined, "读取网页", undefined, undefined, undefined, undefined]);
});

test("成员自己说的话和工具结果逐条交给宿主，派给它的那句话不算", async (t) => {
	const { run, messages } = setup(t);
	await run(NEWS, "t");
	assert.deepEqual(messages.map((m) => [m.role, m.toolName ?? (m.content as { text: string }[])[0].text]), [["assistant", "先查一下"], ["toolResult", "web_get"], ["assistant", "t 的回复"]]);
});

test("成员定义里的技能目录交给它的进程，全局技能仍然不加载", async (t) => {
	const { run, read } = setup(t);
	await run(member({ name: "skilled", skills: ["/agents/skills/charts", "/agents/skills/filings"] }), "k");
	const args: string[] = read("argv-k.json");
	assert.ok(args.includes("--no-skills"));
	assert.deepEqual(args.flatMap((a, i) => (a === "--skill" ? [args[i + 1]] : [])), ["/agents/skills/charts", "/agents/skills/filings"]);
	await run(NEWS, "n");
	assert.ok(!read("argv-n.json").includes("--skill"), "没写技能的成员不带");
});

test("真的 Pi 进程：成员跑一条比无进展时限还久、一声不吭的命令，照常做完，不被当成无进展", async (t) => {
	const QUIET_S = 5;
	const STALL_MS = 3000;
	const task = "跑一条安静的命令";
	const fake = await FakeModel.start({ router: [], workers: [worker(
		task,
		on("程序员跑一条安静的命令", /^\[派活\] 程序员\n/, () => [{ name: "bash", args: { command: `sleep ${QUIET_S}; echo '[命令输出] 跑完了'` } }]),
		on("程序员回复", /^\[命令输出\] 跑完了/, () => "命令跑完了，没有报错。"),
	)] });
	t.after(() => fake.close());
	const dir = mkdtempSync(join(tmpdir(), "psa-member-pi-"));
	withEnv(t, fakeAgentEnv(fake, join(dir, "pi")));
	const spawner = new PiWorkerSpawner({ socketPath: join(dir, "h.sock"), sessionDir: join(dir, "sessions") });
	const desk = new DispatchDesk({ queueTimeoutMs: 5000, stallMs: STALL_MS, maxConcurrent: 1, run: (run) => spawner.runMember(run), onChange() {} });
	const coder = member({ name: "coder", title: "程序员", tools: ["bash"], prompt: "你是程序员。" });
	const { details } = await desk.dispatch({
		ticketId: "tkt_helper", callId: "call-quiet", member: coder, task, basis: "request", model: { provider: FAKE_PROVIDER, id: "worker" },
		workdir: dir, sessionDir: memberSessionDir(dir, "tkt_helper", coder.name), limitMs: 25_000, onUsage() {}, onMessage() {}, onProgress() {},
	});
	assert.deepEqual([details.state, details.reply, details.note ?? null], ["done", "命令跑完了，没有报错。", null]);
	assert.ok(details.ms >= QUIET_S * 1000, `命令安静地跑了 ${QUIET_S} 秒，超过 ${STALL_MS} ms 的无进展时限，实际 ${details.ms} ms`);
	assert.deepEqual(fake.leftovers(), { unused: [], unmatched: [], stray: [] });
});
