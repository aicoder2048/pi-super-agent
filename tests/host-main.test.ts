import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Host } from "../src/host/host.ts";
import { busyPort, defaultWorkerModels, FakeSpawner, fauxRouter, freePort, ids, tempStateDir, until, within } from "./helpers/fakes.ts";

type ModuleFiles = Record<string, unknown>;

function stateWith(config: unknown, roots: Record<string, ModuleFiles> = {}) {
	return () => {
		const dir = tempStateDir();
		const modulesDirs = Object.keys(roots).map((root) => join(dir, root));
		for (const [root, modules] of Object.entries(roots)) {
			for (const [name, manifest] of Object.entries(modules)) {
				mkdirSync(join(dir, root, name), { recursive: true });
				writeFileSync(join(dir, root, name, "module.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
			}
		}
		const full = typeof config === "string" ? config : JSON.stringify({ webPort: 0, ...(config as object), ...(modulesDirs.length ? { modulesDirs } : {}) });
		writeFileSync(join(dir, "config.json"), full);
		return dir;
	};
}

function stateWithFiles(files: Record<string, string>) {
	return () => {
		const dir = stateWith({})();
		for (const [name, text] of Object.entries(files)) {
			mkdirSync(join(dir, name, ".."), { recursive: true });
			writeFileSync(join(dir, name), text);
		}
		return dir;
	};
}
const memberFile = (name: string, extra = "") => `---\nname: ${name}\ntitle: 新闻研究员\ndescription: 查新闻\n${extra}---\n`;
const NEWS_MODULE = { "modules/news/module.json": JSON.stringify({ name: "news", team: "新闻队" }), "modules/news/agents/a.md": memberFile("news-researcher") };

const HOST = "src/host/main.ts";
const WATCHDOG = "src/watchdog/main.ts";
const badInterval = { heartbeatSeconds: 10, watchdog: { staleSeconds: 1 } };

const cases = [
	{
		name: "状态目录路径太长时，just host",
		entry: HOST,
		stateDir: () => join(tempStateDir(), "a-really-long-directory-name-to-push-the-socket-path-over-the-unix-limit-xxxxxxxxxxxx"),
		message: /状态目录路径太长.*PSA_STATE_DIR/,
	},
	{ name: "config.json 的 Watchdog 间隔不合理时，just host", entry: HOST, stateDir: stateWith(badInterval), message: /watchdog\.staleSeconds.*heartbeatSeconds/ },
	{ name: "config.json 的 Watchdog 间隔不合理时，just watchdog", entry: WATCHDOG, stateDir: stateWith(badInterval), message: /watchdog\.staleSeconds.*heartbeatSeconds/ },
	{ name: "config.json 不是合法 JSON 时，just host", entry: HOST, stateDir: stateWith("{bad"), message: /config\.json 不是合法的 JSON/ },
	{ name: "config.json 不是合法 JSON 时，just watchdog", entry: WATCHDOG, stateDir: stateWith("{bad"), message: /config\.json 不是合法的 JSON/ },
	{ name: "模型写法缺少 provider 时，just host", entry: HOST, stateDir: stateWith({ models: { router: "gpt" } }), message: /config\.json.*模型写法应为 provider\/id：gpt/ },
	{ name: "模型用了禁用的提供方时，just host", entry: HOST, stateDir: stateWith({ models: { worker: "anthropic/x" } }), message: /config\.json.*拒绝使用 anthropic\/x/ },
	{ name: "模型是 Claude 时，just host", entry: HOST, stateDir: stateWith({ models: { fallback: "openai-codex/claude-x" } }), message: /config\.json.*Claude 模型/ },
	{ name: "找不到配置的模型时，just host", entry: HOST, stateDir: stateWith({ models: { router: "openai-codex/no-such-model" } }), message: /config\.json：models\.router：找不到模型 openai-codex\/no-such-model/ },
	{ name: "module.json 不是合法 JSON 时，just host", entry: HOST, stateDir: stateWith({}, { mods: { m: "{bad" } }), message: /module\.json 不是合法的 JSON/ },
	{ name: "module.json 不是 JSON 对象时，just host", entry: HOST, stateDir: stateWith({}, { mods: { m: "null" } }), message: /^\S+\/mods\/m\/module\.json：.*JSON 对象/m },
	{ name: "模块名不等于目录名时，just host", entry: HOST, stateDir: stateWith({}, { mods: { m: { name: "other" } } }), message: /name 必须等于目录名 m/ },
	{ name: "ignore 不是合法正则时，just host", entry: HOST, stateDir: stateWith({}, { mods: { m: { name: "m", sources: [{ name: "m", ignore: ["("] }] } } }), message: /module\.json.*ignore.*不是合法的正则/ },
	{ name: "两个模块重名时，just host", entry: HOST, stateDir: stateWith({}, { a: { m: { name: "m" } }, b: { m: { name: "m" } } }), message: /^\S+\/a\/m：模块重名：m 也定义在 \S+\/b\/m。/m },
	{
		name: "定时器 everyMinutes 不大于 0 时，just host",
		entry: HOST,
		stateDir: stateWith({}, { mods: { m: { name: "m", timers: [{ id: "t", everyMinutes: 0, thread: "t", body: "b" }] } } }),
		message: /定时器 m\/t 的 everyMinutes 必须大于 0/,
	},
	{
		name: "同一个模块里两个文件定义了同名成员时，just host",
		entry: HOST,
		stateDir: stateWithFiles({ ...NEWS_MODULE, "modules/news/agents/b.md": memberFile("news-researcher") }),
		message: /^\S+modules\/news\/agents\/a\.md：成员重名：news-researcher 也定义在 \S+modules\/news\/agents\/b\.md。/m,
	},
	{
		name: "模块有成员却没写 team 时，just host",
		entry: HOST,
		stateDir: stateWithFiles({ ...NEWS_MODULE, "modules/news/module.json": JSON.stringify({ name: "news" }) }),
		message: /modules\/news\/module\.json：agents\/ 里有成员，要写 team/,
	},
	{
		name: "状态目录里有 teams.yaml 时，just host",
		entry: HOST,
		stateDir: stateWithFiles({ "teams.yaml": "新闻队:\n  description: 查新闻\n  members:\n    - news-researcher\n" }),
		message: /^\S+\/teams\.yaml：不再读取状态目录下的 teams\.yaml。.*modules\/<名字>\/agents\/.*module\.json 的 team/m,
	},
	{
		name: "模块目录里有 teams.yaml 时，just host",
		entry: HOST,
		stateDir: stateWithFiles({ ...NEWS_MODULE, "modules/news/teams.yaml": "新闻队:\n  description: 查新闻\n  members:\n    - news-researcher\n" }),
		message: /^\S+modules\/news\/teams\.yaml：不再读取 teams\.yaml。.*module\.json 的 team/m,
	},
	{
		name: "状态目录的 modules/ 里直接放了 teams.yaml 时，just host",
		entry: HOST,
		stateDir: stateWithFiles({ "modules/teams.yaml": "新闻队:\n  members:\n    - news-researcher\n" }),
		message: /^\S+modules\/teams\.yaml：不再读取 teams\.yaml。.*module\.json 的 team/m,
	},
	{
		name: "状态目录的 modules/ 里直接放了成员文件时，just host",
		entry: HOST,
		stateDir: stateWithFiles({ "modules/agents/a.md": memberFile("news-researcher") }),
		message: /^\S+modules\/agents：.*不会被读取.*modules\/<名字>\/agents\//m,
	},
	{
		name: "模块文件夹有成员却没有 module.json 时，just host",
		entry: HOST,
		stateDir: stateWithFiles({ "modules/news/agents/a.md": memberFile("news-researcher") }),
		message: /^\S+modules\/news：.*没有 module\.json/m,
	},
	{
		name: "状态目录里有零散的 agents/ 时，just host",
		entry: HOST,
		stateDir: stateWithFiles({ "agents/a.md": memberFile("news-researcher") }),
		message: /^\S+\/agents：不再读取状态目录下零散的成员。.*modules\/<名字>\/agents\//m,
	},
	{
		name: "成员的模型走按量计费的提供方时，just host",
		entry: HOST,
		stateDir: stateWithFiles({ ...NEWS_MODULE, "modules/news/agents/a.md": memberFile("news-researcher", "model: deepseek/deepseek-flash\n") }),
		message: /modules\/news\/agents\/a\.md：model：拒绝使用 deepseek\/deepseek-flash/,
	},
	{
		name: "规则里写了「团队：」行时，just host",
		entry: HOST,
		stateDir: stateWithFiles({ "rules.md": "## news\n来源: rss\n团队：新闻队\n有新闻就查\n" }),
		message: /rules\.md：规则 user\/news 写了「团队：」.*删掉这一行/,
	},
];

for (const c of cases) {
	test(`${c.name} 只打印一句说明并以 1 退出，不打印堆栈`, () => {
		const run = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", c.entry], {
			env: { ...process.env, PSA_STATE_DIR: c.stateDir() },
			encoding: "utf8",
			timeout: 20_000,
			killSignal: "SIGKILL",
		});
		assert.equal(run.status, 1, run.stderr);
		assert.match(run.stderr, c.message);
		assert.doesNotMatch(run.stderr, /^\s+at /m);
		assert.doesNotMatch(run.stderr, /^file:\/\//m);
	});
}

test("just host 启动时列出加载的模块，有成员的模块后面写队名", () => {
	const stateDir = stateWithFiles({ ...NEWS_MODULE, "modules/mail/module.json": JSON.stringify({ name: "mail" }) })();
	writeFileSync(join(stateDir, "config.json"), JSON.stringify({ webPort: 0, models: { router: "openai-codex/no-such-model" } }));
	const run = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", HOST], {
		env: { ...process.env, PSA_STATE_DIR: stateDir },
		encoding: "utf8",
		timeout: 20_000,
		killSignal: "SIGKILL",
	});
	assert.match(run.stderr, /\[host\] 模块：pi-pi（Pi专家队）, toy-market, us-market（看盘队）, mail, news（新闻队）；规则 \d+ 条/);
});

test("使用者规则没写来源行时，just host 启动时逐条说明它不生效", () => {
	const stateDir = stateWith({ models: { router: "openai-codex/no-such-model" } })();
	writeFileSync(join(stateDir, "rules.md"), "## no-source\n有新邮件就看一下\n\n## ok\n来源: ci\nCI 失败时开任务\n");
	const run = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", HOST], {
		env: { ...process.env, PSA_STATE_DIR: stateDir },
		encoding: "utf8",
		timeout: 20_000,
		killSignal: "SIGKILL",
	});
	assert.match(run.stderr, /规则 user\/no-source 没写「来源:」，不生效/);
	assert.doesNotMatch(run.stderr, /规则 user\/ok 没写/);
});

test("just host 启动后打印带 token 的网页网址，打开能看到页面", async (t) => {
	const host = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", HOST], { env: { ...process.env, PSA_STATE_DIR: stateWith({})() } });
	t.after(() => host.kill("SIGKILL"));
	let stderr = "";
	host.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
	await until(() => /\[host\] 网页 http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}\n/.test(stderr), `日志里的网页网址：${stderr}`, 20_000);
	const url = /\[host\] 网页 (\S+)/.exec(stderr)![1];
	const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
	assert.equal(res.status, 200);
	assert.match(await res.text(), /Super Agent/);
});

async function hostUrlOnce(stateDir: string): Promise<string> {
	const host = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", HOST], { env: { ...process.env, PSA_STATE_DIR: stateDir } });
	const exited = new Promise((r) => host.on("exit", r));
	let stderr = "";
	host.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
	try {
		await until(() => /\[host\] 网页 \S+\n/.test(stderr), `日志里的网页网址：${stderr}`, 20_000);
		return /\[host\] 网页 (\S+)/.exec(stderr)![1];
	} finally {
		host.kill("SIGTERM");
		await within(exited, 10_000, "just host 停下");
	}
}

test("just host 重启后网址不变；just web-token-rotate 之后下一次启动换新 token", async () => {
	const stateDir = stateWith({ webPort: await freePort() })();
	const first = await hostUrlOnce(stateDir);
	assert.equal(await hostUrlOnce(stateDir), first);
	const rotate = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/cli/web-token-rotate.ts"], {
		env: { ...process.env, PSA_STATE_DIR: stateDir },
		encoding: "utf8",
		timeout: 20_000,
	});
	assert.equal(rotate.status, 0, rotate.stderr);
	assert.match(rotate.stdout, /重启/);
	const token = (url: string) => new URL(url).searchParams.get("token");
	const rotated = await hostUrlOnce(stateDir);
	assert.match(token(rotated)!, /^[0-9a-f]{64}$/);
	assert.notEqual(token(rotated), token(first));
});

test("网页端口被占用时，just host 只打印一句说明并以 1 退出，不打印堆栈", async (t) => {
	const port = await busyPort(t);
	const run = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", HOST], { env: { ...process.env, PSA_STATE_DIR: stateWith({ webPort: port })() } });
	t.after(() => run.kill("SIGKILL"));
	let stderr = "";
	run.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
	const status = await within(new Promise((r) => run.on("exit", r)), 20_000, "just host 退出");
	assert.equal(status, 1, stderr);
	assert.match(stderr, new RegExp(`网页端口 ${port} 已被占用.*webPort`));
	assert.doesNotMatch(stderr, /^\s+at /m);
});

// Stands in for `pi --mode rpc`: like Pi it handles SIGTERM and stdin EOF but not SIGINT.
const FAKE_PI = `
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const dir = process.env.FAKE_PI_DIR;
writeFileSync(dir + "/pi.pid", String(process.pid));
process.on("SIGTERM", () => {
	appendFileSync(dir + "/pi.signals", "SIGTERM\\n");
	if (!process.env.FAKE_PI_IGNORE_TERM) process.exit(143);
});
console.error("Warning: No project session found with id 'abc'; creating a new session with that id.");
console.error("Warning: something else worth seeing");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const { id, type } = JSON.parse(line);
	send({ type: "response", id, command: type, success: true, data: { disposition: "started" } });
	if (type === "prompt") {
		send({ type: "agent_start" });
		writeFileSync(dir + "/pi.prompted", "1");
	}
});
input.on("close", () => process.exit(0));
`;

async function stateWithRunningTask(): Promise<string> {
	const stateDir = stateWith({})();
	const brain = (cards: string[]) => cards.flatMap((card) => card.startsWith("[对话]") && card.includes("开个任务")
		? [{ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "request", triggerId: ids(card, "trg"), title: "执行中", brief: "执行中" }] } }]
		: []);
	const spawner = new FakeSpawner(() => {});
	const host = await Host.start({ stateDir, createRouter: fauxRouter(brain).createRouter, createSpawner: () => spawner, log: () => {}, workerModels: defaultWorkerModels() });
	host.say("开个任务");
	await until(() => host.kernel.listTickets()[0]?.stage === "running", "任务在执行中");
	await host.stop();
	writeFileSync(join(stateDir, "fake-pi.mjs"), FAKE_PI);
	return stateDir;
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// Detached so the host leads its own process group, as `just host` does in a terminal; a signal to -pid is a Ctrl+C.
async function hostWithWorker(t: TestContext, stateDir: string, env: Record<string, string> = {}) {
	const host = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", HOST], {
		env: { ...process.env, PSA_STATE_DIR: stateDir, PSA_PI_CLI: join(stateDir, "fake-pi.mjs"), FAKE_PI_DIR: stateDir, ...env },
		detached: true,
	});
	const exited = new Promise<number | null>((r) => host.on("exit", (code) => r(code)));
	const piPid = () => (existsSync(join(stateDir, "pi.pid")) ? Number(readFileSync(join(stateDir, "pi.pid"), "utf8")) : undefined);
	t.after(() => {
		for (const target of [-host.pid!, piPid()]) {
			try {
				if (target) process.kill(target, "SIGKILL");
			} catch {}
		}
	});
	let stderr = "";
	host.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
	await until(() => existsSync(join(stateDir, "pi.prompted")), `Worker 收到恢复说明：${stderr}`, 20_000);
	return { host, exited, stderr: () => stderr, piPid: piPid()! };
}

function taskState(stateDir: string) {
	const db = new DatabaseSync(join(stateDir, "state.db"));
	try {
		return db.prepare(`SELECT worker_state AS workerState, (SELECT status FROM reports r WHERE r.ticket_id = t.id ORDER BY r.rowid DESC LIMIT 1) AS lastReport FROM tickets t WHERE title = '执行中'`).get();
	} finally {
		db.close();
	}
}

test("终端 Ctrl+C：Worker 不被信号直接杀死，由宿主停止；任务保持可恢复；宿主打印「已停止」并以 0 退出", async (t) => {
	const stateDir = await stateWithRunningTask();
	const run = await hostWithWorker(t, stateDir);
	process.kill(-run.host.pid!, "SIGINT");
	const code = await within(run.exited, 10_000, "宿主退出");
	const stderr = run.stderr();
	const signals = join(stateDir, "pi.signals");
	assert.equal(existsSync(signals) ? readFileSync(signals, "utf8") : "", "SIGTERM\n", "Worker 应只被宿主用 SIGTERM 停止");
	assert.deepEqual({ ...taskState(stateDir) }, { workerState: "running", lastReport: null });
	await until(() => !alive(run.piPid), "Worker 进程已结束");
	assert.equal(code, 0, stderr);
	assert.match(stderr, /收到 SIGINT，正在停止/);
	assert.equal(stderr.match(/\[host\] 已停止/g)?.length, 1, stderr);
});

test("恢复任务时 Pi 找不到原会话：宿主日志说明上下文丢了，其他警告照常显示", async (t) => {
	const stateDir = await stateWithRunningTask();
	const run = await hostWithWorker(t, stateDir);
	await until(() => run.stderr().includes("something else worth seeing"), "其他警告");
	await until(() => /\[worker tkt_\S+\] 恢复任务时找不到原来的 Pi 会话/.test(run.stderr()), `丢失会话的说明：${run.stderr()}`);
	process.kill(-run.host.pid!, "SIGTERM");
	await within(run.exited, 10_000, "宿主退出");
});

test("停止途中再按一次 Ctrl+C：宿主立即退出并说明，不留 Worker 进程", async (t) => {
	const stateDir = await stateWithRunningTask();
	const run = await hostWithWorker(t, stateDir, { FAKE_PI_IGNORE_TERM: "1" });
	process.kill(-run.host.pid!, "SIGINT");
	await until(() => run.stderr().includes("正在停止"), "开始停止");
	const pressed = Date.now();
	process.kill(-run.host.pid!, "SIGINT");
	const code = await within(run.exited, 10_000, "宿主退出");
	assert.ok(Date.now() - pressed < 500, `第二次 Ctrl+C 后 ${Date.now() - pressed}ms 才退出`);
	assert.equal(code, 130);
	assert.match(run.stderr(), /再次收到 SIGINT，立即退出/);
	await until(() => !alive(run.piPid), "Worker 进程已结束", 5000);
});
