// Shared by the e2e tests and the demos: start the real host in its own process group, drive a
// browser step by step, keep evidence when a step fails, and stop exactly the groups it started.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { FAKE_PROVIDER, FakeModel, type Script } from "./fake-model.ts";

export const REPO = resolve(import.meta.dirname, "../..");
const OUT = join(REPO, "tests/e2e/.out");
// Billing rule: these providers are pay-per-use API keys and never run from automation.
const BILLED = /^(anthropic|deepseek)\//i;
const HOST_URL = /\[host\] 网页 (\S+)/g;

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export type Models = { router: string; worker: string; fallback: string };
export const fakeModels: Models = { router: `${FAKE_PROVIDER}/router`, worker: `${FAKE_PROVIDER}/worker`, fallback: `${FAKE_PROVIDER}/fallback` };

/** All three roles are always written, so the host never falls back to the default deepseek model. */
export function writeConfig(stateDir: string, models: Models, config: Record<string, unknown> = {}): void {
	for (const ref of Object.values(models)) if (BILLED.test(ref)) throw new Error(`拒绝使用 ${ref}：按量计费，自动化里禁用`);
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, "config.json"), JSON.stringify({ ...config, models }, null, 2));
}

// ---- process groups ----

const liveGroups = new Set<number>();
// If the runner itself dies, take our groups with it rather than leave hosts and Workers behind.
process.on("exit", () => {
	for (const pgid of liveGroups) signalGroup(pgid, "SIGKILL");
});

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(-pgid, signal);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

export const groupAlive = (pgid: number) => signalGroup(pgid, 0);

/** SIGTERM the whole group, SIGKILL whatever is left after 3 s. Returns whether the group is gone. */
export async function stopGroup(pgid: number): Promise<boolean> {
	signalGroup(pgid, "SIGCONT");
	signalGroup(pgid, "SIGTERM");
	for (let waited = 0; waited < 3000 && groupAlive(pgid); waited += 50) await sleep(50);
	if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
	for (let waited = 0; waited < 2000 && groupAlive(pgid); waited += 50) await sleep(50);
	const gone = !groupAlive(pgid);
	if (gone) liveGroups.delete(pgid);
	return gone;
}

/**
 * Starts `node --import ./src/pi-runtime.mjs <args>` from the repo as the leader of a new process group.
 * Its pid is the group id, and every child it spawns (Workers included) stays in that group.
 */
export function startGroup(args: string[], options: { env: NodeJS.ProcessEnv; logFile: string; onOutput?: (text: string) => void }): { pid: number; exited: Promise<number | null> } {
	const child = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", ...args], { cwd: REPO, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	if (!child.pid) throw new Error(`无法启动 ${args.join(" ")}`);
	const pid = child.pid;
	liveGroups.add(pid);
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8").on("data", (text: string) => {
			appendFileSync(options.logFile, text);
			options.onOutput?.(text);
		});
	}
	return { pid, exited: new Promise((done) => child.once("exit", (code) => done(code))) };
}

/** Adopts a group that a process we started has started (the watchdog's hosts), so cleanup reaches it. */
export function adoptGroup(pgid: number): void {
	liveGroups.add(pgid);
}

/** Stops every group this process started or adopted; returns the ones that would not die. */
export async function stopAllGroups(): Promise<number[]> {
	const left: number[] = [];
	for (const pgid of [...liveGroups]) if (!(await stopGroup(pgid))) left.push(pgid);
	return left;
}

// ---- the host ----

export interface HostRun {
	readonly url: URL;
	readonly pid: number;
	readonly stateDir: string;
	log(): string;
	/** Stops the group and starts the host again on the same state dir. */
	restart(): Promise<URL>;
	freeze(): void;
	thaw(): void;
	/** Stops every group this host run started; returns the ones still alive. */
	stop(): Promise<number[]>;
}

export interface StartHostOptions {
	models: Models;
	stateDir: string;
	logFile: string;
	config?: Record<string, unknown>;
	env?: Record<string, string>;
	/** Extra `--import` modules for the host process (the market demo's request tap). */
	imports?: string[];
	timeoutMs?: number;
}

export async function startHost(options: StartHostOptions): Promise<HostRun> {
	writeConfig(options.stateDir, options.models, options.config);
	const env = { ...process.env, ...options.env, PSA_STATE_DIR: options.stateDir };
	let text = "";
	const groups: number[] = [];
	let current = 0;
	let url!: URL;

	const boot = async (): Promise<URL> => {
		const from = text.length;
		const proc = startGroup([...(options.imports ?? []).flatMap((f) => ["--import", f]), "src/host/main.ts"], { env, logFile: options.logFile, onOutput: (t) => (text += t) });
		groups.push(proc.pid);
		current = proc.pid;
		let exitCode: number | null | undefined;
		void proc.exited.then((code) => (exitCode = code));
		const deadline = Date.now() + (options.timeoutMs ?? 30_000);
		while (Date.now() < deadline) {
			const found = [...text.slice(from).matchAll(HOST_URL)][0];
			if (found) return (url = new URL(found[1]));
			if (exitCode !== undefined) throw new Error(`宿主启动失败（退出码 ${exitCode}）：${text.slice(from).trim().split("\n").slice(-3).join(" ")}`);
			await sleep(50);
		}
		throw new Error(`宿主 ${Math.round((options.timeoutMs ?? 30_000) / 1000)} 秒内没有打印网址，日志：${options.logFile}`);
	};

	const stopAll = async () => {
		const left: number[] = [];
		for (const pgid of groups) if (!(await stopGroup(pgid))) left.push(pgid);
		return left;
	};

	try {
		await boot();
	} catch (error) {
		await stopAll();
		throw error;
	}
	return {
		get url() {
			return url;
		},
		get pid() {
			return current;
		},
		stateDir: options.stateDir,
		log: () => text,
		async restart() {
			const left = await stopAll();
			if (left.length) throw new Error(`重启前停不下宿主进程组 ${left.join(", ")}`);
			return boot();
		},
		freeze: () => void signalGroup(current, "SIGSTOP"),
		thaw: () => void signalGroup(current, "SIGCONT"),
		stop: stopAll,
	};
}

/** A Pi world with only the fake provider and no credentials, plus a proxy tripwire for stray traffic. */
export function fakeAgentEnv(fake: FakeModel, agentDir: string): Record<string, string> {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(fake.modelsJson()));
	writeFileSync(join(agentDir, "auth.json"), "{}");
	const tripwire = fake.baseUrl.replace(/\/v1$/, "");
	return {
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		HTTPS_PROXY: tripwire,
		HTTP_PROXY: tripwire,
		https_proxy: tripwire,
		http_proxy: tripwire,
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
	};
}

export function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const server = createServer().once("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => done(port));
		});
	});
}

// ---- the page ----

export type Status = "connecting" | "connected" | "disconnected" | "expired";

/** The page's connection state lives on #status[data-status]; the connected chip is hidden, so this reads the attribute. */
export function waitStatus(page: Page, status: Status, timeoutMs = 15_000): Promise<unknown> {
	return page.waitForFunction((s) => document.querySelector("#status")?.getAttribute("data-status") === s, status, { timeout: timeoutMs });
}

export async function sayInPage(page: Page, text: string): Promise<void> {
	await page.fill("#composer", text);
	await page.click("#send");
	await page.waitForFunction(() => document.getElementById("say-status")?.dataset.state === "delivered", null, { timeout: 8_000 });
}

// ---- the story ----

export interface Story {
	page: Page;
	host: HostRun;
	fake: FakeModel;
	/** One node:test subtest. After a failed step the rest are skipped and the report names the step. */
	step(name: string, body: (page: Page) => Promise<unknown>): Promise<void>;
	/** Opens another page whose console also goes into the report. */
	open(url: URL, options?: { fakeClock?: boolean }): Promise<Page>;
	/** Runs a repo CLI against this host's state dir, the way the user would. */
	cli(args: string[]): Promise<string>;
}

export interface StoryOptions {
	config?: Record<string, unknown>;
	/** Pins webPort so a restarted host serves the same origin as the open page. */
	fixedPort?: boolean;
	/** Installs page.clock before the first load so a test can fast-forward the page's timers. */
	fakeClock?: boolean;
}

const slug = (name: string) => name.replace(/[^\p{L}\p{N}-]+/gu, "-").slice(0, 80);

/**
 * One end-to-end story: fake model, real host and Workers, headless Chromium on the host's URL.
 * The last step checks the fake model's script was used up with nothing unclaimed and no stray traffic.
 * Teardown always stops the browser, every host group and the fake model, and fails the test if any group survives.
 */
export async function story(t: TestContext, script: Script, body: (s: Story) => Promise<void>, options: StoryOptions = {}): Promise<void> {
	const out = join(OUT, slug(t.name));
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	const root = mkdtempSync(join(tmpdir(), "psa-e2e-"));
	const consoleLog = join(out, "page-console.log");
	writeFileSync(consoleLog, "");
	const fake = await FakeModel.start(script);
	const env = fakeAgentEnv(fake, join(root, "pi"));
	const pages: Page[] = [];
	let browser: Browser | undefined;
	let host: HostRun | undefined;
	let failed = false;

	const open = async (url: URL, opts: { fakeClock?: boolean } = {}) => {
		browser ??= await chromium.launch();
		const page = await (await browser.newContext()).newPage();
		page.setDefaultTimeout(10_000);
		const n = pages.push(page);
		page.on("console", (m) => appendFileSync(consoleLog, `[page ${n}] ${m.type()} ${m.text()}\n`));
		page.on("pageerror", (e) => appendFileSync(consoleLog, `[page ${n}] pageerror ${e.message}\n`));
		if (opts.fakeClock) await page.clock.install();
		await page.goto(url.href);
		return page;
	};

	const step: Story["step"] = (name, fn) =>
		t.test(name, { skip: failed && "前一步已失败" }, async () => {
			try {
				await fn(pages[0]);
			} catch (error) {
				failed = true;
				const report = await saveReport(out, name, error, pages, fake);
				throw new Error(`步骤「${name}」失败：${stripVTControlCharacters((error as Error).message).split("\n")[0]}\n报告：${report}`, { cause: error });
			}
		});

	const cli = async (args: string[]) => {
		const logFile = join(out, "cli.log");
		let text = "";
		const proc = startGroup(args, { env: { ...process.env, ...env, PSA_STATE_DIR: join(root, "s") }, logFile, onOutput: (s) => (text += s) });
		const code = await proc.exited;
		await stopGroup(proc.pid);
		if (code !== 0) throw new Error(`${args.join(" ")} 退出码 ${code}：${text.trim()}`);
		return text;
	};

	let left: number[] = [];
	try {
		await step("宿主启动，页面已连接", async () => {
			const webPort = options.fixedPort ? await freePort() : 0;
			host = await startHost({ models: fakeModels, stateDir: join(root, "s"), logFile: join(out, "host.log"), config: { webPort, modulesDirs: [], ...options.config }, env });
			await waitStatus(await open(host.url, { fakeClock: options.fakeClock }), "connected");
		});
		if (!failed) await body({ page: pages[0], host: host!, fake, step, open, cli });
		await step("假模型脚本用完", async () => {
			for (let waited = 0; waited < 10_000 && fake.leftovers().unused.length; waited += 100) await sleep(100);
			assert.deepEqual(fake.leftovers(), { unused: [], unmatched: [], stray: [] });
		});
	} finally {
		await browser?.close();
		left = (await host?.stop()) ?? [];
		writeFileSync(join(out, "fake-model.jsonl"), fake.jsonl());
		await fake.close();
		rmSync(root, { recursive: true, force: true });
	}
	assert.deepEqual(left, [], `收尾后仍有进程组存活：${left.join(", ")}`);
}

async function saveReport(out: string, stepName: string, error: unknown, pages: Page[], fake: FakeModel): Promise<string> {
	const shots: string[] = [];
	for (const [i, page] of pages.entries()) {
		const file = `screenshot-${i + 1}.png`;
		if (await page.screenshot({ path: join(out, file), fullPage: true }).then(() => true, () => false)) shots.push(file);
	}
	writeFileSync(join(out, "fake-model.jsonl"), fake.jsonl());
	const leftovers = fake.leftovers();
	const summary = [
		`失败步骤：${stepName}`,
		`错误：${stripVTControlCharacters((error as Error)?.message ?? String(error))}`,
		`没用到的假模型步骤：${leftovers.unused.join("、") || "无"}`,
		`没有步骤认领的卡片：${leftovers.unmatched.join(" | ") || "无"}`,
		`非模型请求：${leftovers.stray.join("、") || "无"}`,
		`截图：${shots.join("、") || "无"}`,
		"日志：page-console.log、host.log、fake-model.jsonl",
	].join("\n");
	writeFileSync(join(out, "summary.txt"), `${summary}\n`);
	const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
	writeFileSync(
		join(out, "index.html"),
		`<!doctype html><meta charset="utf-8"><title>${esc(stepName)}</title><style>body{font:14px system-ui;margin:24px}pre{white-space:pre-wrap;background:#f4f4f5;padding:12px}img{max-width:100%;border:1px solid #ccc}</style>
<h1>失败步骤：${esc(stepName)}</h1><pre>${esc(summary)}</pre>${shots.map((f) => `<p><img src="${f}"></p>`).join("")}
<p><a href="page-console.log">page-console.log</a> · <a href="host.log">host.log</a> · <a href="fake-model.jsonl">fake-model.jsonl</a></p>`,
	);
	return join(out, "index.html");
}
