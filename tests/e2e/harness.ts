import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { PAY_PER_USE_PROVIDERS, parseModelRef } from "../../src/models.ts";
import { freePort } from "../helpers/fakes.ts";
import { FAKE_PROVIDER, FakeModel, type Script } from "./fake-model.ts";

export const REPO = resolve(import.meta.dirname, "../..");
// One folder per `just e2e` run, so two runs in the same checkout never clear each other's reports.
// node --test runs each file as a child of one runner, so the runner pid names the run when PSA_E2E_RUN is unset.
const OUT = join(REPO, "tests/e2e/.out", process.env.PSA_E2E_RUN || `run-${process.ppid}`);
const RUN = ["--import", "./src/pi-runtime.mjs"];
/** The line the host prints once its web page is up; the trailing whitespace makes sure the URL is complete. */
export const HOST_URL = /\[host\] 网页 (\S+)\s/g;

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export type Models = { router: string; worker: string; fallback: string };
export const fakeModels: Models = { router: `${FAKE_PROVIDER}/router`, worker: `${FAKE_PROVIDER}/worker`, fallback: `${FAKE_PROVIDER}/fallback` };

/** All three roles are always written, so the host never falls back to the default deepseek model. */
export function writeConfig(stateDir: string, models: Models, config: Record<string, unknown> = {}): void {
	for (const ref of Object.values(models)) {
		if (PAY_PER_USE_PROVIDERS.includes(parseModelRef(ref.trim()).provider.trim().toLowerCase())) throw new Error(`拒绝使用 ${ref}：按量计费，自动化里禁用`);
	}
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, "config.json"), JSON.stringify({ ...config, models }, null, 2));
}

const liveGroups = new Set<number>();
process.on("exit", () => {
	for (const pgid of liveGroups) signalGroup(pgid, "SIGKILL");
});

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(-pgid, signal);
		return true;
	} catch (error) {
		// ESRCH: no such group. EPERM: on macOS a group holding only zombies, or a pgid now owned by another user.
		// Neither is a group this run can or should still stop.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH" || code === "EPERM") return false;
		throw error;
	}
}

export const groupAlive = (pgid: number) => signalGroup(pgid, 0);

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
	const child = spawn(process.execPath, [...RUN, ...args], { cwd: REPO, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	if (!child.pid) throw new Error(`无法启动 ${args.join(" ")}`);
	const pid = child.pid;
	liveGroups.add(pid);
	const log = createWriteStream(options.logFile, { flags: "a" });
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8").on("data", (text: string) => {
			log.write(text);
			options.onOutput?.(text);
		});
	}
	child.once("close", () => log.end());
	return { pid, exited: new Promise((done) => child.once("exit", (code) => done(code))) };
}

/** Runs a short repo CLI to completion (not in its own group; the timeout bounds it). */
export function runSync(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000) {
	return spawnSync(process.execPath, [...RUN, ...args], { cwd: REPO, env, encoding: "utf8", timeout: timeoutMs });
}

/** Adopts a group that a process we started has started (the watchdog's hosts), so cleanup reaches it. */
export function adoptGroup(pgid: number): void {
	liveGroups.add(pgid);
}

export async function stopAllGroups(): Promise<number[]> {
	const left: number[] = [];
	for (const pgid of [...liveGroups]) if (!(await stopGroup(pgid))) left.push(pgid);
	return left;
}

export interface HostRun {
	readonly url: URL;
	readonly pid: number;
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
	/** The environment to start from instead of process.env, e.g. with market keys removed. */
	baseEnv?: NodeJS.ProcessEnv;
	imports?: string[];
	timeoutMs?: number;
}

export async function startHost(options: StartHostOptions): Promise<HostRun> {
	writeConfig(options.stateDir, options.models, options.config);
	const env = { ...(options.baseEnv ?? process.env), ...options.env, PSA_STATE_DIR: options.stateDir };
	let text = "";
	const groups: number[] = [];
	let current = 0;
	let url!: URL;

	const timeoutMs = options.timeoutMs ?? 30_000;
	const boot = () =>
		new Promise<URL>((done, fail) => {
			let own = "";
			const timer = setTimeout(() => fail(new Error(`宿主 ${Math.round(timeoutMs / 1000)} 秒内没有打印网址，日志：${options.logFile}`)), timeoutMs);
			const onOutput = (t: string) => {
				text += t;
				own += t;
				const found = new RegExp(HOST_URL.source).exec(own);
				if (!found) return;
				clearTimeout(timer);
				done((url = new URL(found[1])));
			};
			const proc = startGroup([...(options.imports ?? []).flatMap((f) => ["--import", f]), "src/host/main.ts"], { env, logFile: options.logFile, onOutput });
			groups.push(proc.pid);
			current = proc.pid;
			void proc.exited.then((code) => {
				clearTimeout(timer);
				fail(new Error(`宿主启动失败（退出码 ${code}）：${own.trim().split("\n").slice(-3).join(" ")}`));
			});
		});

	// Forget groups once they are gone, so a later stop never signals a recycled pgid.
	const stopAll = async () => {
		const left: number[] = [];
		for (const pgid of groups) if (!(await stopGroup(pgid))) left.push(pgid);
		groups.splice(0, groups.length, ...left);
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

export type Status = "connecting" | "connected" | "disconnected" | "expired";

/** The page's connection state lives on #status[data-status]; the connected chip is hidden, so this reads the attribute. */
export function waitStatus(page: Page, status: Status, timeoutMs = 15_000): Promise<unknown> {
	return page.waitForFunction((s) => document.querySelector("#status")?.getAttribute("data-status") === s, status, { timeout: timeoutMs });
}

/** Sends one sentence from the composer and waits for the delivered ack. `typeDelayMs` types it key by key, for recordings. */
export async function sayInPage(page: Page, text: string, { typeDelayMs }: { typeDelayMs?: number } = {}): Promise<void> {
	const box = page.locator("#composer");
	if (typeDelayMs === undefined) await box.fill(text);
	else {
		await box.click();
		await box.pressSequentially(text, { delay: typeDelayMs });
		if ((await box.inputValue()) !== text) await box.fill(text);
	}
	await page.click("#send");
	await page.waitForFunction(() => document.getElementById("say-status")?.dataset.state === "delivered", null, { timeout: 8_000 });
}

export interface Story {
	page: Page;
	host: HostRun;
	fake: FakeModel;
	/** One node:test subtest. After a failed step the rest are skipped and the report names the step. */
	step(name: string, body: (page: Page) => Promise<unknown>): Promise<void>;
	/** Opens another page whose console also goes into the report. */
	open(url: URL, options?: { fakeClock?: boolean }): Promise<Page>;
	cli(args: string[]): Promise<string>;
}

export interface StoryOptions {
	config?: Record<string, unknown>;
	/** Pins webPort so a restarted host serves the same origin as the open page. */
	fixedPort?: boolean;
	/** Installs page.clock before the first load so a test can fast-forward the page's timers. */
	fakeClock?: boolean;
	/** See parseSabotage in fake-model.ts. Defaults to PSA_E2E_SABOTAGE. */
	sabotage?: string;
	/** Role files written into the state dir's roles/ before the host starts, file name → content. */
	roles?: Record<string, string>;
}

let sharedBrowser: Promise<Browser> | undefined;
/** One headless Chromium per test file, launched by the first story. Each file closes it with after(closeBrowser). */
const launchBrowser = () => (sharedBrowser ??= chromium.launch());
export async function closeBrowser(): Promise<void> {
	const browser = sharedBrowser;
	sharedBrowser = undefined;
	const problems = await teardown([["关闭浏览器", async () => (await browser)?.close()]]);
	if (problems.length) process.stderr.write(`${problems.join("\n")}\n`);
}

/**
 * Runs every cleanup step even when one throws or never settles (a browser frozen by a system sleep
 * never answers close), so the host and fake model are still stopped and the test process can exit.
 */
export async function teardown(steps: [name: string, run: () => unknown][], ms = 10_000): Promise<string[]> {
	const problems: string[] = [];
	for (const [name, run] of steps) {
		const timer = new AbortController();
		const timedOut = delay(ms, undefined, { signal: timer.signal }).then(() => { throw new Error(`${ms} ms 内没有完成`); }, () => {});
		try {
			await Promise.race([Promise.resolve().then(run), timedOut]);
		} catch (error) {
			problems.push(`${name}：${(error as Error).message}`);
		} finally {
			timer.abort();
		}
	}
	return problems;
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
	const consoleLog = join(out, "page-console.log");
	writeFileSync(consoleLog, "");
	const consoleStream = createWriteStream(consoleLog);
	const fake = await FakeModel.start(script, options.sabotage).catch((error) => {
		consoleStream.end();
		throw error;
	});
	const root = mkdtempSync(join(tmpdir(), "psa-e2e-"));
	const env = fakeAgentEnv(fake, join(root, "pi"));
	const pages: Page[] = [];
	const contexts: BrowserContext[] = [];
	let host: HostRun | undefined;
	let failed = false;

	const open = async (url: URL, opts: { fakeClock?: boolean } = {}) => {
		const context = await (await launchBrowser()).newContext();
		contexts.push(context);
		const page = await context.newPage();
		page.setDefaultTimeout(10_000);
		const n = pages.push(page);
		page.on("console", (m) => consoleStream.write(`[page ${n}] ${m.type()} ${m.text()}\n`));
		page.on("pageerror", (e) => consoleStream.write(`[page ${n}] pageerror ${e.message}\n`));
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
	let cleanup: string[] = [];
	try {
		await step("宿主启动，页面已连接", async () => {
			const webPort = options.fixedPort ? await freePort() : 0;
			if (options.roles) {
				mkdirSync(join(root, "s", "roles"), { recursive: true });
				for (const [file, content] of Object.entries(options.roles)) writeFileSync(join(root, "s", "roles", file), content);
			}
			const started = startHost({ models: fakeModels, stateDir: join(root, "s"), logFile: join(out, "host.log"), config: { webPort, modulesDirs: [], ...options.config }, env });
			const [run] = await Promise.all([started.then((h) => (host = h)), launchBrowser()]);
			await waitStatus(await open(run.url, { fakeClock: options.fakeClock }), "connected");
		});
		if (!failed) await body({ page: pages[0], host: host!, fake, step, open, cli });
		await step("假模型脚本用完", async () => {
			const timeout = new AbortController();
			await Promise.race([fake.drained, delay(10_000, undefined, { signal: timeout.signal }).catch(() => {})]).finally(() => timeout.abort());
			assert.deepEqual(fake.leftovers(), { unused: [], unmatched: [], stray: [] });
		});
	} finally {
		cleanup = await teardown([
			...contexts.map((context, i): [string, () => unknown] => [`关闭页面 ${i + 1}`, () => context.close()]),
			["停宿主", async () => { left = (await host?.stop()) ?? []; }],
			["写日志", () => { consoleStream.end(); writeFileSync(join(out, "fake-model.jsonl"), fake.jsonl()); }],
			["关假模型", () => fake.close()],
			["删临时目录", () => rmSync(root, { recursive: true, force: true })],
		]);
	}
	assert.deepEqual(cleanup, [], `收尾出错：${cleanup.join("；")}`);
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
