import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExpertAsk } from "../src/host/consult.ts";
import { PiWorkerSpawner } from "../src/host/pi-worker.ts";
import { BUILTIN_ROLES_DIR, Roster } from "../src/roles.ts";
import { until } from "./helpers/fakes.ts";

// Stands in for `pi --mode json -p`: records how it was started, optionally leaves a grandchild in its
// process group, waits, then prints the JSON events Pi prints and exits.
const FAKE_PI = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const question = argv.at(-1);
const tag = question.split("\\n")[1];
writeFileSync(\`argv-\${tag}.json\`, JSON.stringify(argv));
writeFileSync(\`env-\${tag}.json\`, JSON.stringify(process.env));
if (process.env.FAKE_PI_GRANDCHILD) writeFileSync(\`grandchild-\${tag}.pid\`, String(spawn("sleep", ["30"], { stdio: "ignore" }).pid));
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
setTimeout(() => {
	say({ type: "agent_start" });
	const usage = { input: 90, output: 10, cacheRead: 10 };
	say({ type: "message_end", message: { role: "assistant", provider: "openai-codex", content: [{ type: "text", text: "先查一下" }], usage, stopReason: "toolUse" } });
	const final = tag === "broken"
		? { role: "assistant", provider: "openai-codex", content: [], usage, stopReason: "error", errorMessage: "429 Too Many Requests" }
		: { role: "assistant", provider: "openai-codex", content: [{ type: "text", text: \`\${tag} 的回答\` }], usage, stopReason: "stop" };
	say({ type: "message_end", message: final });
	say({ type: "agent_settled" });
}, Number(process.env.FAKE_PI_DELAY_MS ?? 0));
`;

function setup(t: TestContext, env: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "psa-expert-"));
	const cliPath = join(dir, "fake-pi.mjs");
	writeFileSync(cliPath, FAKE_PI);
	const roles = join(dir, "roles");
	mkdirSync(roles);
	writeFileSync(join(roles, "market.md"), "---\nname: market-analyst\ntitle: 行情分析师\ndescription: 看盘面\ntools: web_get, bash, read\n---\n你是行情分析师。\n");
	writeFileSync(join(roles, "news.md"), "---\nname: news-researcher\ntitle: 新闻研究员\ndescription: 查新闻\n---\n你是新闻研究员。\n");
	const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
	Object.assign(process.env, env);
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	});
	const spawner = new PiWorkerSpawner({ socketPath: join(dir, "h.sock"), roster: Roster.load(["openai-codex"], [BUILTIN_ROLES_DIR, roles]), sessionDir: join(dir, "sessions"), cliPath, lookupHelp: "us-market quote" });
	const usage: number[] = [];
	const ask = (expert: string, tag: string, signal = new AbortController().signal) =>
		spawner.ask({
			ticketId: "tkt_lead", token: `token-${tag}`, expert, title: expert, question: `${tag}\n${tag}`, workdir: dir, signal,
			model: { provider: "openai-codex", id: "gpt-6.1-sol" },
			onUsage: (u) => usage.push(u.tokensIn + u.tokensOut),
		} satisfies ExpertAsk);
	const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));
	return { dir, ask, usage, read };
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

test("专家一问一答：Pi 打印模式、不留会话、只读工具与角色工具取交集、没有 consult，答案取最后一条回答，用量逐条上报", async (t) => {
	const { ask, usage, read } = setup(t);
	assert.equal(await ask("market-analyst", "m"), "m 的回答");
	const args: string[] = read("argv-m.json");
	assert.equal(flag(args, "--mode"), "json");
	assert.ok(args.includes("-p") && args.includes("--no-session") && args.includes("--no-mcp"));
	assert.equal(flag(args, "--model"), "openai-codex/gpt-6.1-sol");
	assert.deepEqual(flag(args, "--tools")!.split(",").sort(), ["read", "web_get"]);
	assert.ok(args.includes("你是行情分析师。"));
	assert.equal(args.at(-2), "--");
	assert.deepEqual(usage, [110, 110]);
	await ask("news-researcher", "n");
	assert.deepEqual(flag(read("argv-n.json"), "--tools")!.split(",").sort(), ["find", "grep", "lookup", "ls", "read", "web_get"]);
});

test("专家进程和 Worker 一样拿不到密钥类变量；扩展以专家身份运行，带牵头任务和自己的令牌", async (t) => {
	const { ask, read } = setup(t, { MASSIVE_API_KEY: "sk-market", FOO_TOKEN: "tok" });
	await ask("news-researcher", "n");
	const env = read("env-n.json");
	assert.equal(env.MASSIVE_API_KEY, undefined);
	assert.equal(env.FOO_TOKEN, undefined);
	assert.equal(env.PSA_EXPERT, "1");
	assert.equal(env.PSA_TICKET, "tkt_lead");
	assert.equal(env.PSA_TOKEN, "token-n");
	assert.equal(env.PSA_EXPERTS, undefined, "专家不会诊");
});

test("模型出错时这一问失败并带上错误", async (t) => {
	const { ask } = setup(t);
	await assert.rejects(ask("news-researcher", "broken"), /429/);
});

test("三位专家并行：总耗时远小于各自耗时之和", async (t) => {
	const { ask } = setup(t, { FAKE_PI_DELAY_MS: "600" });
	const started = Date.now();
	await Promise.all(["a", "b", "c"].map((tag) => ask("news-researcher", tag)));
	const wall = Date.now() - started;
	assert.ok(wall < 1500, `串行至少 1800 ms，并行实际 ${wall} ms`);
});

test("中止一问：专家进程连同它起的子进程一起结束，不留孤儿", async (t) => {
	const { dir, ask } = setup(t, { FAKE_PI_DELAY_MS: "30000", FAKE_PI_GRANDCHILD: "1" });
	const stop = new AbortController();
	const answer = ask("news-researcher", "g", stop.signal);
	const pidFile = join(dir, "grandchild-g.pid");
	await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, "专家起了子进程", 10_000);
	const grandchild = Number(readFileSync(pidFile, "utf8"));
	assert.ok(alive(grandchild));
	stop.abort(new Error("任务已停止"));
	await assert.rejects(answer, /任务已停止/);
	await until(() => !alive(grandchild), "子进程随进程组结束", 3000);
});
