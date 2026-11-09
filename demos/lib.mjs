// Shared helpers for the visible-browser demos. Processes start and stop through tests/e2e/harness.ts,
// which signals only the process groups this script started (or that its own watchdog started).
import { chromium } from "playwright-core";
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readHeartbeat } from "../src/heartbeat.ts";
import { Kernel } from "../src/kernel/kernel.ts";
import { HOST_URL, REPO, adoptGroup, groupAlive, runSync, sayInPage, sleep, startGroup, startHost, stopAllGroups, stopGroup, waitStatus, writeConfig } from "../tests/e2e/harness.ts";

export { sleep };
const HERE = dirname(fileURLToPath(import.meta.url));
export const FLAGS = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
// Subscription models only; writeConfig refuses pay-per-use providers.
const MODELS = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
export const ACTIVE = ["queued", "running", "idle"];
export const DONE = ["awaiting_review", "closed"];
const NO_STATE = { tickets: [], triggers: [], conversation: [], decisions: [], today: [] };

/** A scene result for a condition outside the demo's control (market moves, model timing). Everything else that does not PASS is a FAIL. */
export const skip = (evidence) => ({ status: "SKIP", evidence });

export class Demo {
	#db;
	#kernel;

	constructor(name, { port, config = {}, dwellMs = 20_000, preload }) {
		this.name = name;
		this.dwellMs = dwellMs;
		this.preload = preload;
		this.out = join(HERE, "out", name);
		mkdirSync(this.out, { recursive: true });
		this.stateDir = mkdtempSync(join(tmpdir(), "psa-demo-"));
		this.config = { webPort: port, ...config };
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

	/** The watchdog starts the host itself, so here the demo writes config.json instead of startHost. */
	startWatchdog() {
		writeConfig(this.stateDir, MODELS, this.config);
		this.watchdog = startGroup(["src/watchdog/main.ts"], { env: { ...this.env, PSA_RESTART_GRACE_MS: "20000" }, logFile: join(this.out, "watchdog.log") });
		this.log(`started watchdog group ${this.watchdog.pid}`);
	}

	/**
	 * The watchdog starts each host detached, so the host leads its own process group, and the heartbeat in
	 * this demo's own state dir names the current one. Adopting it puts that group (host and Workers) under cleanup.
	 */
	adoptHeartbeatHost() {
		const pid = readHeartbeat(this.stateDir)?.pid;
		if (pid && groupAlive(pid)) {
			adoptGroup(pid);
			this.log(`adopted heartbeat host group ${pid}`);
		}
		return pid;
	}

	/** The log a watchdog-started host writes into the state dir (startHost's own log is this.host.log()). */
	stateDirHostLog() {
		const f = join(this.stateDir, "host.log");
		return existsSync(f) ? readFileSync(f, "utf8") : "";
	}

	watchdogLog() {
		const f = join(this.out, "watchdog.log");
		return existsSync(f) ? readFileSync(f, "utf8") : "";
	}

	hostUrls() {
		return [...this.stateDirHostLog().matchAll(HOST_URL)].map((m) => m[1]);
	}

	cli(args, label = args[0]) {
		const r = runSync(args, this.env);
		const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
		this.log(`$ ${label}: ${out.split("\n").at(-1)}`);
		return out;
	}

	secondChannelSay(text) {
		const child = startGroup(["src/cli/say.ts", "say", text], { env: { ...this.env, PSA_SAY_WAIT_MS: "20000" }, logFile: join(this.out, "say-cli.log") });
		this.log(`started say.ts (second client) group ${child.pid}`);
		return child;
	}

	/** The kernel's view of the host's state.db, through one read-only connection opened on first use. */
	state() {
		const file = join(this.stateDir, "state.db");
		if (!this.#kernel) {
			if (!existsSync(file)) return NO_STATE;
			this.#db = new DatabaseSync(file, { readOnly: true });
			this.#db.exec("PRAGMA busy_timeout = 5000");
			this.#kernel = new Kernel({ db: this.#db, clock: { now: () => Date.now() }, sourcePolicy: () => "candidate" });
		}
		const kernel = this.#kernel;
		const tickets = kernel.listTickets().map((r) => {
			const read = kernel.read(r.id);
			const ticket = read?.type === "ticket" ? read : undefined;
			return {
				id: r.id, title: r.title, stage: r.stage, basis: r.basis, ruleId: kernel.getTicket(r.id)?.ruleId ?? null, toolCalls: r.toolCalls, latest: r.latestSummary,
				threads: ticket?.threadIds ?? [], inputs: (ticket?.recentInputs ?? []).map((i) => ({ kind: i.kind, triggerId: i.triggerId, body: i.body.slice(0, 120) })),
			};
		});
		return {
			tickets,
			triggers: kernel.triggerLog(100).reverse().map((t) => ({ id: t.id, source: t.source, disposition: t.disposition, detail: t.dispositionDetail, body: t.body.slice(0, 120), receivedAt: t.receivedAt })),
			conversation: kernel.conversation(50).map((m) => ({ who: m.who, text: m.text, at: m.at })),
			decisions: kernel.decisionLog(50).map((x) => ({ kind: x.decision.kind, ok: x.ok, reason: x.reason, ticketId: x.ticketId, decision: x.decision })),
			today: kernel.triggerCountsToday(),
		};
	}

	triggerLog() {
		return runSync(["src/cli/log.ts", "100"], this.env).stdout.trim();
	}

	/** Polls fn until it returns something truthy; null after ms. Errors from fn propagate and fail the scene. */
	async until(label, fn, ms, every = 1500) {
		const end = Date.now() + ms;
		for (;;) {
			const v = await fn();
			if (v) return v;
			if (Date.now() >= end) break;
			await sleep(Math.min(every, end - Date.now()));
		}
		this.log(`(timeout ${Math.round(ms / 1000)}s: ${label})`);
		return null;
	}

	/** Waits until ticket id satisfies pred; returns { st, t } or null after ms. */
	untilTicket(id, pred, ms, every = 3000) {
		return this.until(`ticket ${id}`, () => {
			const st = this.state();
			const t = st.tickets.find((x) => x.id === id);
			return t && pred(t) ? { st, t } : null;
		}, ms, every);
	}

	async openBrowser(url) {
		this.browser = await chromium.launch({ headless: false, handleSIGINT: false, slowMo: 50, args: ["--window-size=1460,1000"] });
		this.ctx = await this.browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true, recordVideo: { dir: this.out, size: { width: 1440, height: 900 } } });
		this.page = await this.ctx.newPage();
		await this.goto(url);
	}

	async goto(url) {
		await this.page.goto(url);
		await waitStatus(this.page, "connected", 30_000);
		if (this.captionState) await this.#paint(...this.captionState);
	}

	async caption(title, bot, agent) {
		this.captionState = [title, bot, agent];
		this.log(`== ${title} | 普通聊天机器人：${bot} | Pi Super Agent：${agent}`);
		if (this.page) await this.#paint(title, bot, agent).catch(() => {});
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

	/** Types the sentence on camera and waits for the delivered ack; throws (failing the scene) without one. */
	async say(text, { delay = 30 } = {}) {
		await sayInPage(this.page, text, { typeDelayMs: delay });
		this.log(`said "${text.slice(0, 30)}…" (delivered)`);
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
			result = (await fn()) ?? { status: "FAIL", evidence: "scene returned nothing" };
		} catch (e) {
			result = { status: "FAIL", evidence: `error: ${String(e.message).split("\n")[0]}` };
		}
		const left = this.dwellMs - (Date.now() - start);
		if (left > 0) await sleep(left);
		this.results.push({ name, ...result });
		this.log(`-- ${result.status} ${name}: ${result.evidence}`);
		return result;
	}

	static check(ok, evidence, why) {
		return ok ? { status: "PASS", evidence } : { status: "FAIL", evidence: `${why}; observed: ${evidence}` };
	}

	/** The closing caption every demo ends on. */
	async outro(title, bot, agent) {
		await this.caption(title, bot, agent);
		await sleep(8000);
	}

	/** Returns the process groups that would not stop. */
	async cleanup() {
		try {
			if (this.page) await this.page.screenshot({ path: join(this.out, "final.png") }).catch(() => {});
			await this.ctx?.close();
			await this.browser?.close();
		} catch {}
		this.#db?.close();
		// Stop the watchdog first so it cannot start another host, then re-read the heartbeat for the host it left running.
		if (this.watchdog) await stopGroup(this.watchdog.pid);
		this.adoptHeartbeatHost();
		const left = await stopAllGroups();
		this.log(left.length ? `STILL ALIVE process groups: ${left.join(", ")}` : "every process group this demo started is stopped");
		for (const f of ["host.log", "heartbeat.json"]) if (existsSync(join(this.stateDir, f))) copyFileSync(join(this.stateDir, f), join(this.out, f === "host.log" ? "host-statedir.log" : f));
		writeFileSync(join(this.out, "trigger-log.txt"), this.lastTriggerLog ?? "");
		writeFileSync(join(this.out, "state.json"), JSON.stringify(this.lastState ?? {}, null, 2));
		if (!left.length) rmSync(this.stateDir, { recursive: true, force: true });
		return left;
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
		let left = [];
		try {
			await body();
		} catch (e) {
			this.log(`ERROR ${e.stack}`);
			this.results.push({ name: "(demo script)", status: "FAIL", evidence: String(e.message).split("\n")[0] });
		} finally {
			try {
				this.lastState = this.state();
				this.lastTriggerLog = this.triggerLog();
			} catch (e) {
				this.log(`(final state not read: ${e.message})`);
			}
			left = await this.cleanup();
			this.summary();
		}
		if (left.length || this.results.some((r) => r.status === "FAIL")) process.exitCode = 1;
	}
}
export const fmtTicket = (t) => `${t.id}「${t.title}」${t.stage}/${t.basis}${t.ruleId ? `/${t.ruleId}` : ""}`;
export const fmtTrigger = (t) => `${t.source} ${t.disposition}${t.detail ? `(${t.detail})` : ""} "${t.body.slice(0, 30)}"`;
