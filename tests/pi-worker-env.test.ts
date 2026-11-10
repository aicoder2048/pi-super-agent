import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiWorkerSpawner } from "../src/host/pi-worker.ts";

const FAKE_PI = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync("worker-env.json", JSON.stringify(process.env));
writeFileSync("worker-argv.json", JSON.stringify(process.argv));
createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, type } = JSON.parse(line);
	process.stdout.write(JSON.stringify({ type: "response", id, command: type, success: true }) + "\\n");
});
`;

test("Worker 子进程和领域的 prepare 拿不到宿主环境里的密钥类变量，只拿到宿主给它的 PSA_ 变量；领域的技能目录交给助手进程，全局技能不加载", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-env-"));
	const cliPath = join(dir, "fake-pi.mjs");
	writeFileSync(cliPath, FAKE_PI);
	const planted = { MASSIVE_API_KEY: "sk-market", FINNHUB_API_KEY: "fh-market", FOO_TOKEN: "tok-foo", DEEPSEEK_API_KEY: "sk-ds", DB_PASSWORD: "pw", SECRET_SAUCE: "s", PSA_KEEP_HOME: "kept" };
	const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
	Object.assign(process.env, planted);
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	});
	const spawner = new PiWorkerSpawner({
		socketPath: join(dir, "h.sock"),
		sessionDir: join(dir, "sessions"),
		cliPath,
	});
	const events = { turnStarted() {}, toolCalled() {}, usage() {}, settled() {}, exited() {}, transcript() {} };
	const handle = await spawner.spawn({ ticketId: "tkt_1", sessionId: "s1", workdir: dir, basis: "request", skillsDir: "/modules/news/skills", prepare: "env > prepare-env.txt", crew: [], token: "secret-ticket-token", model: { provider: "openai-codex", id: "gpt" }, resume: false }, events);
	t.after(() => handle.stop());
	const env = JSON.parse(readFileSync(join(dir, "worker-env.json"), "utf8")) as Record<string, string>;
	for (const name of ["MASSIVE_API_KEY", "FINNHUB_API_KEY", "FOO_TOKEN", "DEEPSEEK_API_KEY", "DB_PASSWORD", "SECRET_SAUCE"]) assert.equal(env[name], undefined, `Worker 环境里不该有 ${name}`);
	assert.equal(env.PSA_TOKEN, "secret-ticket-token");
	assert.equal(env.PSA_KEEP_HOME, "kept");
	assert.equal(env.PATH, process.env.PATH);
	const prepared = readFileSync(join(dir, "prepare-env.txt"), "utf8");
	assert.ok(!/MASSIVE_API_KEY|FINNHUB_API_KEY|FOO_TOKEN|DEEPSEEK_API_KEY/.test(prepared), "prepare 环境里不该有密钥类变量");
	const argv = JSON.parse(readFileSync(join(dir, "worker-argv.json"), "utf8")) as string[];
	assert.deepEqual(argv.flatMap((a, i) => (a === "--skill" ? [argv[i + 1]] : [])), ["/modules/news/skills"]);
	assert.ok(argv.includes("--no-skills"));
});

test("Worker 子进程和模块 prepare 的环境里没有客户端凭据，也没有指向它的状态目录变量，即使宿主是带着 PSA_STATE_DIR 启动的", async (t) => {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-env-"));
	const credential = "ab".repeat(32);
	writeFileSync(join(stateDir, "client-token"), `${credential}\n`, { mode: 0o600 });
	const cliPath = join(stateDir, "fake-pi.mjs");
	writeFileSync(cliPath, FAKE_PI);
	const saved = process.env.PSA_STATE_DIR;
	process.env.PSA_STATE_DIR = stateDir;
	t.after(() => {
		if (saved === undefined) delete process.env.PSA_STATE_DIR;
		else process.env.PSA_STATE_DIR = saved;
	});
	const workdir = mkdtempSync(join(tmpdir(), "psa-env-work-"));
	const spawner = new PiWorkerSpawner({
		socketPath: join(stateDir, "host.sock"),
		sessionDir: join(stateDir, "sessions"),
		cliPath,
	});
	const events = { turnStarted() {}, toolCalled() {}, usage() {}, settled() {}, exited() {}, transcript() {} };
	const handle = await spawner.spawn({ ticketId: "tkt_1", sessionId: "s1", workdir, basis: "request", prepare: "env > prepare-env.txt", crew: [], token: "secret-ticket-token", model: { provider: "openai-codex", id: "gpt" }, resume: false }, events);
	t.after(() => handle.stop());
	const env = JSON.parse(readFileSync(join(workdir, "worker-env.json"), "utf8")) as Record<string, string>;
	const prepared = readFileSync(join(workdir, "prepare-env.txt"), "utf8");
	assert.equal(env.PSA_STATE_DIR, undefined, "Worker 环境里不该有 PSA_STATE_DIR");
	assert.ok(!/^PSA_STATE_DIR=/m.test(prepared), "prepare 环境里不该有 PSA_STATE_DIR");
	for (const [where, text] of Object.entries({ Worker: JSON.stringify(env), prepare: prepared })) {
		assert.ok(!text.includes(credential), `${where} 环境里不该有凭据`);
		assert.ok(!text.includes("client-token"), `${where} 环境里不该有凭据文件的路径`);
	}
	assert.equal(env.PSA_SOCKET, join(stateDir, "host.sock"));
});

test("本队有成员时，成员名单经 PSA_CREW 交给助手进程；没有成员可派的助手没有这个变量", async (t) => {
	const crew = [{ name: "market-analyst", title: "行情分析师", description: "看盘面" }, { name: "news-researcher", title: "新闻研究员", description: "查新闻" }];
	const envOf = async (members: typeof crew) => {
		const dir = mkdtempSync(join(tmpdir(), "psa-env-"));
		const cliPath = join(dir, "fake-pi.mjs");
		writeFileSync(cliPath, FAKE_PI);
		const spawner = new PiWorkerSpawner({ socketPath: join(dir, "h.sock"), sessionDir: join(dir, "sessions"), cliPath });
		const events = { turnStarted() {}, toolCalled() {}, usage() {}, settled() {}, exited() {}, transcript() {} };
		const handle = await spawner.spawn({ ticketId: "tkt_1", sessionId: "s1", workdir: dir, basis: "request", skillsDir: undefined, prepare: undefined, crew: members as never, token: "t", model: { provider: "openai-codex", id: "gpt" }, resume: false }, events);
		t.after(() => handle.stop());
		return JSON.parse(readFileSync(join(dir, "worker-env.json"), "utf8")) as Record<string, string>;
	};
	assert.equal((await envOf(crew)).PSA_CREW, "market-analyst,news-researcher");
	const solo = await envOf([]);
	assert.equal(solo.PSA_CREW, undefined);
	assert.equal(solo.PSA_MEMBER_TOOLS, undefined);
});

test("推断开的任务只读：领域的 prepare 不跑，领域的技能目录照样交给助手；别的任务照跑 prepare", async (t) => {
	const start = async (basis: "inference" | "request") => {
		const dir = mkdtempSync(join(tmpdir(), "psa-prepare-"));
		const cliPath = join(dir, "fake-pi.mjs");
		writeFileSync(cliPath, FAKE_PI);
		const spawner = new PiWorkerSpawner({ socketPath: join(dir, "h.sock"), sessionDir: join(dir, "sessions"), cliPath });
		const events = { turnStarted() {}, toolCalled() {}, usage() {}, settled() {}, exited() {}, transcript() {} };
		const handle = await spawner.spawn({ ticketId: "tkt_1", sessionId: "s1", workdir: dir, basis, skillsDir: "/modules/news/skills", prepare: "echo ran > prepared.txt", crew: [], token: "t", model: { provider: "openai-codex", id: "gpt" }, resume: false }, events);
		t.after(() => handle.stop());
		const argv = JSON.parse(readFileSync(join(dir, "worker-argv.json"), "utf8")) as string[];
		return { prepared: existsSync(join(dir, "prepared.txt")), skills: argv.flatMap((a, i) => (a === "--skill" ? [argv[i + 1]] : [])) };
	};
	assert.deepEqual(await start("inference"), { prepared: false, skills: ["/modules/news/skills"] });
	assert.deepEqual(await start("request"), { prepared: true, skills: ["/modules/news/skills"] });
});

test("助手的领域开了 lookup，宿主才把可查来源交给它；没配来源时给一句说明；领域没开就不给，即使宿主配了来源", async (t) => {
	const helperEnv = async (lookup: boolean, lookupHelp: string | undefined) => {
		const dir = mkdtempSync(join(tmpdir(), "psa-env-"));
		const cliPath = join(dir, "fake-pi.mjs");
		writeFileSync(cliPath, FAKE_PI);
		const spawner = new PiWorkerSpawner({ socketPath: join(dir, "h.sock"), sessionDir: join(dir, "sessions"), cliPath, lookupHelp });
		const events = { turnStarted() {}, toolCalled() {}, usage() {}, settled() {}, exited() {}, transcript() {} };
		const handle = await spawner.spawn({ ticketId: "tkt_1", sessionId: "s1", workdir: dir, basis: "request", skillsDir: undefined, prepare: undefined, crew: [], lookup, token: "tok", model: { provider: "openai-codex", id: "gpt" }, resume: false }, events);
		t.after(() => handle.stop());
		return JSON.parse(readFileSync(join(dir, "worker-env.json"), "utf8")) as Record<string, string>;
	};
	assert.equal((await helperEnv(true, "us-market quote")).PSA_LOOKUPS, "us-market quote");
	assert.equal((await helperEnv(true, undefined)).PSA_LOOKUPS, "（宿主没有配置可查询的来源）");
	assert.equal((await helperEnv(false, "us-market quote")).PSA_LOOKUPS, undefined);
});
