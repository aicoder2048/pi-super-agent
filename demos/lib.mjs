// Shared helpers for the visible-browser demos. Processes start and stop through tests/e2e/harness.ts,
// which signals only the process groups this script started (or that its own watchdog started).
import { chromium } from "playwright-core";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, adoptGroup, startGroup, startHost, stopAllGroups, writeConfig } from "../tests/e2e/harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FLAGS = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
// Subscription models only; writeConfig refuses anthropic/* and deepseek/*.
const MODELS = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const RUN = ["--import", "./src/pi-runtime.mjs"];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Demo {
	constructor(name, { port, config = {}, dwellMs = 20_000, preload }) {
		this.name = name;
		this.dwellMs = dwellMs;
		this.preload = preload;
		this.port = port;
		this.out = join(HERE, "out", name);
		mkdirSync(this.out, { recursive: true });
		this.stateDir = mkdtempSync(join(tmpdir(), "psa-demo-"));
		this.config = { webPort: port, ...config };
		writeConfig(this.stateDir, MODELS, this.config);
		this.env = { ...process.env, PSA_STATE_DIR: this.stateDir };
		this.results = [];
		this.t0 = Date.now();
		this.logFile = join(this.out, "run.log");
		writeFileSync(this.logFile, "");
		for (const f of ["host.log", "watchdog.log", "say-cli.log"]) writeFileSync(join(this.out, f), "");
		this.log(`repo ${REPO}, state dir ${this.stateDir}, port ${port}`);
	}

	log(s) {
		const line = `${new Date().toISOString().slice(11, 19)} [${this.name}] ${s}`;
		console.log(line);
		appendFileSync(this.logFile, `${line}\n`);
	}

	async startHost() {
		this.host = await startHost({ models: MODELS, stateDir: this.stateDir, logFile: join(this.out, "host.log"), config: this.config, imports: this.preload ? [this.preload] : [], timeoutMs: 90_000 });
		this.log(`started host group ${this.host.pid}`);
		return this.host.url.href;
	}

	startWatchdog() {
		const wd = startGroup(["src/watchdog/main.ts"], { env: { ...this.env, PSA_RESTART_GRACE_MS: "20000" }, logFile: join(this.out, "watchdog.log") });
		this.log(`started watchdog group ${wd.pid}`);
		return wd;
	}

	/** Host pids our own watchdog reported starting; each leads its own process group. */
	watchdogHosts() {
		return [...this.watchdogLog().matchAll(/已拉起宿主，pid (\d+)/g)].map((m) => Number(m[1]));
	}

	hostLog() {
		const f = join(this.stateDir, "host.log");
		return existsSync(f) ? readFileSync(f, "utf8") : "";
	}

	watchdogLog() {
		const f = join(this.out, "watchdog.log");
		return existsSync(f) ? readFileSync(f, "utf8") : "";
	}

	hostUrls() {
		return [...this.hostLog().matchAll(/\[host\] 网页 (http\S+)/g)].map((m) => m[1]);
	}

	heartbeatPid() {
		try {
			return JSON.parse(readFileSync(join(this.stateDir, "heartbeat.json"), "utf8")).pid;
		} catch {
			return undefined;
		}
	}

	cli(args, label = args[0]) {
		const r = spawnSync(process.execPath, [...RUN, ...args], { cwd: REPO, env: this.env, encoding: "utf8", timeout: 60_000 });
		const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
		this.log(`$ ${label}: ${out.split("\n").at(-1)}`);
		return out;
	}

	secondChannelSay(text) {
		const child = startGroup(["src/cli/say.ts", "say", text], { env: { ...this.env, PSA_SAY_WAIT_MS: "20000" }, logFile: join(this.out, "say-cli.log") });
		this.log(`started say.ts (second client) group ${child.pid}`);
		return child;
	}

	state() {
		const r = spawnSync(process.execPath, [...RUN, join(HERE, "inspect.mts")], { cwd: REPO, env: this.env, encoding: "utf8", timeout: 30_000 });
		try {
			return JSON.parse(r.stdout);
		} catch {
			this.log(`(inspect failed: ${(r.stderr ?? "").split("\n")[0]})`);
			return { tickets: [], triggers: [], conversation: [], decisions: [], today: [] };
		}
	}

	triggerLog() {
		return spawnSync(process.execPath, [...RUN, "src/cli/log.ts", "100"], { cwd: REPO, env: this.env, encoding: "utf8" }).stdout.trim();
	}

	async until(label, fn, ms, every = 1500) {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			try {
				const v = await fn();
				if (v) return v;
			} catch {}
			await sleep(every);
		}
		this.log(`(timeout ${Math.round(ms / 1000)}s: ${label})`);
		return null;
	}

	async openBrowser(url) {
		this.browser = await chromium.launch({ headless: false, handleSIGINT: false, slowMo: 50, args: ["--window-size=1460,1000"] });
		this.ctx = await this.browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true, recordVideo: { dir: this.out, size: { width: 1440, height: 900 } } });
		this.page = await this.ctx.newPage();
		await this.goto(url);
	}

	async goto(url) {
		await this.page.goto(url);
		await this.page.waitForFunction(() => document.querySelector("#status")?.dataset.status === "connected", null, { timeout: 30_000 });
		if (this.captionState) await this.#paint(...this.captionState);
	}

	async caption(title, bot, agent) {
		this.captionState = [title, bot, agent];
		this.log(`== ${title} | 普通聊天机器人：${bot} | Pi Super Agent：${agent}`);
		await this.#paint(title, bot, agent).catch(() => {});
	}

	#paint(title, bot, agent) {
		return this.page.evaluate(([t, b, a]) => {
			let box = document.getElementById("__demo_caption");
			if (!box) {
				box = document.createElement("div");
				box.id = "__demo_caption";
				box.style.cssText = "position:fixed;left:50%;bottom:110px;transform:translateX(-50%);z-index:99999;background:rgba(17,24,39,.93);color:#fff;padding:12px 22px;border-radius:14px;font:15px/1.55 'PingFang SC',system-ui;box-shadow:0 8px 30px rgba(0,0,0,.25);width:min(860px,90vw);pointer-events:none";
				document.body.append(box);
			}
			const line = (text, css) => Object.assign(document.createElement("div"), { textContent: text, style: css });
			box.replaceChildren(
				line(t, "font-weight:700;font-size:17px;margin-bottom:4px;text-align:center"),
				line(`普通聊天机器人：${b}`, "opacity:.7"),
				line(`Pi Super Agent：${a}`, "color:#7dd3fc;font-weight:600"),
			);
		}, [title, bot, agent]);
	}

	async say(text, { delay = 30 } = {}) {
		const box = this.page.locator("#composer");
		await box.click();
		await box.pressSequentially(text, { delay });
		if ((await box.inputValue()) !== text) {
			this.log(`(typed text came out as "${(await box.inputValue()).slice(-30)}"; filling the full sentence)`);
			await box.fill(text);
		}
		await sleep(400);
		await this.page.locator("#send").click();
		const sentAt = Date.now();
		const ok = await this.page.waitForFunction(() => document.getElementById("say-status")?.dataset.state === "delivered", null, { timeout: 8_000 }).then(() => true, () => false);
		this.log(`said "${text.slice(0, 30)}…" ${ok ? `delivered in ${Date.now() - sentAt}ms` : "(no delivered ack)"}`);
		return ok;
	}

	card(text) {
		return this.page.locator("#left .card", { hasText: text });
	}

	async openCard(text) {
		const card = this.card(text).first();
		if (!(await card.isVisible().catch(() => false))) {
			const details = this.page.locator("#done");
			if ((await details.count()) && !(await details.evaluate((d) => d.open))) await this.page.locator("#done > summary").click();
			await sleep(800);
		}
		await card.scrollIntoViewIfNeeded().catch(() => {});
		await card.click({ timeout: 10_000 });
	}

	async scene(name, captionLines, fn) {
		const start = Date.now();
		let result;
		try {
			await this.caption(name, ...captionLines);
			result = (await fn()) ?? { status: "SKIP", evidence: "scene returned nothing" };
		} catch (e) {
			result = { status: "SKIP", evidence: `error: ${String(e.message).split("\n")[0]}` };
		}
		const left = this.dwellMs - (Date.now() - start);
		if (left > 0) await sleep(left);
		this.results.push({ name, ...result });
		this.log(`-- ${result.status} ${name}: ${result.evidence}`);
		return result;
	}

	static check(ok, evidence, why) {
		return ok ? { status: "PASS", evidence } : { status: "SKIP", evidence: `${why}; observed: ${evidence}` };
	}

	async cleanup() {
		try {
			if (this.page) await this.page.screenshot({ path: join(this.out, "final.png") }).catch(() => {});
			await this.ctx?.close();
			await this.browser?.close();
		} catch {}
		for (const pid of this.watchdogHosts()) adoptGroup(pid);
		const left = await stopAllGroups();
		this.log(left.length ? `STILL ALIVE process groups: ${left.join(", ")}` : "every process group this demo started is stopped");
		for (const f of ["host.log", "heartbeat.json"]) if (existsSync(join(this.stateDir, f))) copyFileSync(join(this.stateDir, f), join(this.out, f === "host.log" ? "host-statedir.log" : f));
		writeFileSync(join(this.out, "trigger-log.txt"), this.lastTriggerLog ?? "");
		writeFileSync(join(this.out, "state.json"), JSON.stringify(this.lastState ?? {}, null, 2));
		if (!left.length) rmSync(this.stateDir, { recursive: true, force: true });
	}

	summary() {
		const secs = Math.round((Date.now() - this.t0) / 1000);
		const lines = [`\n===== ${this.name} summary (${Math.floor(secs / 60)}m${secs % 60}s) =====`, ...this.results.map((r) => `${r.status}  ${r.name}  |  ${r.evidence}`), `video dir: ${this.out}`];
		for (const l of lines) this.log(l);
		writeFileSync(join(this.out, "summary.txt"), `${lines.join("\n")}\n`);
	}

	async run(body) {
		const stop = async () => {
			this.log("interrupted; cleaning up");
			await this.cleanup();
			process.exit(130);
		};
		process.once("SIGINT", stop);
		try {
			await body();
		} catch (e) {
			this.log(`ERROR ${e.stack}`);
		} finally {
			try {
				this.lastState = this.state();
				this.lastTriggerLog = this.triggerLog();
			} catch {}
			await this.cleanup();
			this.summary();
		}
	}
}

export const ticketsWith = (state, pred) => state.tickets.filter(pred);
export const fmtTicket = (t) => `${t.id}「${t.title}」${t.stage}/${t.basis}${t.ruleId ? `/${t.ruleId}` : ""}`;
export const fmtTrigger = (t) => `${t.source} ${t.disposition}${t.detail ? `(${t.detail})` : ""} "${t.body.slice(0, 30)}"`;
