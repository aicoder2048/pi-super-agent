import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HostConnection } from "../client/connection.ts";
import { exitOnConfigError } from "../config-error.ts";
import { HOST_ENTRY } from "../heartbeat.ts";
import { loadConfig, loadModules } from "../host/config.ts";
import { openStore, setModuleSwitch } from "../kernel/store.ts";
import { cloneFiles } from "../modules/files.ts";
import { moduleDataDir } from "../modules/knowledge.ts";
import type { ModuleState } from "../modules/lifecycle.ts";
import { formatModelRef, PAY_PER_USE_PROVIDERS, parseModelRef, type ModelRef } from "../models.ts";
import { examsOf, judge, verdictLine, type Attempt, type Exam } from "../modules/rehearse.ts";
import { problemLine, scanPackage } from "../modules/validate.ts";
import { secretLookup } from "../secrets.ts";

const REPO = resolve(import.meta.dirname, "../..");
const ACTIVE_MS = 60_000;
const OPEN_MS = 180_000;
const REPORT_MS = 600_000;
const ACK_MS = 5_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type Models = { router: string; worker: string; fallback: string };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const interruption = new Error("interrupted");
const paid = (models: readonly ModelRef[]) => models.find((m) => PAY_PER_USE_PROVIDERS.includes(m.provider.trim().toLowerCase()));

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

// Its own process group, so stopping it also stops every Worker it started.
function startHost(stateDir: string) {
	const child = spawn(process.execPath, ["--import", "./src/pi-runtime.mjs", HOST_ENTRY], { cwd: REPO, env: { ...process.env, PSA_STATE_DIR: stateDir }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	const gateway: string[] = [];
	let tail: string[] = [];
	let partial = "";
	let exited = false;
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8").on("data", (text: string) => {
			const lines = (partial + text).split("\n");
			partial = lines.pop() ?? "";
			gateway.push(...lines.filter((l) => l.includes("[gateway]")));
			tail = [...tail, ...lines].slice(-3);
		});
	}
	child.once("exit", () => (exited = true));
	const pgid = child.pid!;
	return {
		gateway,
		tail: () => tail.join(" "),
		alive: () => !exited,
		async stop() {
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				if (!groupAlive(pgid)) return;
				process.kill(-pgid, signal);
				for (let waited = 0; waited < 3000 && groupAlive(pgid); waited += 50) await sleep(50);
			}
		},
	};
}

export async function tryModule(target: string): Promise<number> {
	try {
		const config = loadConfig();
		const refused = paid([config.models.router, config.models.worker]);
		if (refused) return payPerUse(refused);
		const source = target.includes(sep) ? resolve(target) : loadModules(config).packages.find((p) => p.name === target)?.dir;
		if (source === undefined || statSync(source, { throwIfNoEntry: false })?.isDirectory() !== true) return refuse(`${target} 不是已发现的新布局模块，也不是一个包文件夹（just modules 看有哪些）`);
		const scanned = scanPackage(source, { secret: secretLookup(config.secretsFile) });
		if (!scanned.ok) {
			for (const problem of scanned.problems) console.log(problemLine(problem));
			return refuse(`${scanned.name} 没通过检查，先按上面改好（just module check ${source}）`);
		}
		const memberPaid = paid(scanned.scan.components.flatMap((c) => (c.kind === "agents" && c.agent.model ? [parseModelRef(c.agent.model)] : [])));
		if (memberPaid) return payPerUse(memberPaid);
		const exams = examsOf(scanned.scan);
		if (exams.length === 0) return refuse(`${scanned.scan.manifest.name} 没有考题（evals/ 是空的），没有可预演的`);
		const worker = formatModelRef(config.models.worker);
		// The fallback is the worker model, so a dry run never reaches a pay-per-use fallback.
		return await rehearse(source, scanned.scan.manifest.name, exams, { router: formatModelRef(config.models.router), worker, fallback: worker }, config);
	} catch (error) {
		return exitOnConfigError(error);
	}
}

const payPerUse = (model: ModelRef) => refuse(`拒绝预演：${formatModelRef(model)} 按量计费。预演要多次调用模型，请把 config.json 的 models 换成订阅制的模型（例如 openai-codex/*）再试`);

function refuse(line: string): number {
	console.log(line);
	return 1;
}

function invalidWhy(state: ModuleState | undefined): string | undefined {
	return state?.at === "staging" && state.stage.at === "invalid" ? state.stage.problems.map(problemLine).join("；") : undefined;
}

async function rehearse(source: string, module: string, exams: readonly Exam[], models: Models, { stateDir: realStateDir, secretsFile }: { stateDir: string; secretsFile?: string | undefined }): Promise<number> {
	const stateDir = mkdtempSync(join(tmpdir(), "psa-try-"));
	let host: ReturnType<typeof startHost> | undefined;
	let stopping = false;
	const interrupted = () => (stopping = true);
	for (const signal of SIGNALS) process.on(signal, interrupted);
	let talk: HostConnection | undefined;
	let db: DatabaseSync | undefined;
	let passed: string | undefined;
	try {
		cpSync(source, join(stateDir, "modules", module), { recursive: true });
		cloneFiles(moduleDataDir(realStateDir, module), moduleDataDir(stateDir, module));
		writeFileSync(join(stateDir, "config.json"), JSON.stringify({ models, modulesDirs: [join(stateDir, "modules")], webPort: 0, feedFixtures: true, secretsFile }));
		const store = openStore(join(stateDir, "state.db"));
		setModuleSwitch(store, module, true);
		store.close();
		console.log(`预演 ${module}：临时状态目录 ${stateDir}，模型 ${models.router}（Router）、${models.worker}（Worker）`);

		const started = (host = startHost(stateDir));
		const until = async <T>(ms: number, probe: () => T | undefined): Promise<T | undefined> => {
			for (const end = Date.now() + ms; Date.now() < end && started.alive() && !stopping; await sleep(100)) {
				const found = probe();
				if (found !== undefined) return found;
			}
			if (stopping) throw interruption;
			return probe();
		};
		const hostGone = () => refuse(`临时宿主退出了：${started.tail()}`);
		const opened = new DatabaseSync(join(stateDir, "state.db"), { readOnly: true });
		db = opened;
		const record = opened.prepare("SELECT record FROM module_records WHERE name = ?");
		const stateOf = () => {
			const row = record.get(module) as { record: string | null } | undefined;
			return row?.record ? (JSON.parse(row.record) as { state: ModuleState }).state : undefined;
		};
		const state = await until(ACTIVE_MS, () => {
			const at = stateOf();
			return at?.at === "active" || invalidWhy(at) !== undefined ? at : undefined;
		});
		if (state?.at !== "active") return refuse(`${module} 在临时宿主里没有打开：${invalidWhy(state) ?? started.tail()}`);

		const replies: string[] = [];
		const answers = new Map<string, string | null>();
		let greeted = false;
		talk = new HostConnection({
			socketPath: join(stateDir, "host.sock"),
			onMessage: (m) => {
				if (m.type === "snapshot") greeted = true;
				else if (m.type === "reply") replies.push(m.text);
				else if (m.type === "ack" || m.type === "refused") answers.set(m.requestId, m.type === "ack" ? m.triggerId : null);
			},
			retryMs: 200,
		});
		talk.open();
		if (!(await until(ACTIVE_MS, () => greeted || undefined))) return started.alive() ? refuse(`临时宿主 ${ACTIVE_MS / 1000} 秒内没有接通`) : hostGone();

		const ticketOf = opened.prepare("SELECT id, domain FROM tickets WHERE origin_trigger_id = ?");
		const reportOf = opened.prepare("SELECT status, summary FROM reports WHERE ticket_id = ? AND status <> 'progress' ORDER BY seq DESC LIMIT 1");
		let failed = 0;
		for (const exam of exams) {
			const heard = replies.length;
			const requestId = talk.say(exam.question);
			const trigger = requestId === undefined ? undefined : await until(ACK_MS, () => answers.get(requestId));
			const ticket = trigger ? await until(OPEN_MS, () => ticketOf.get(trigger) as { id: string; domain: string | null } | undefined) : undefined;
			const report = ticket ? await until(REPORT_MS, () => reportOf.get(ticket.id) as { status: string; summary: string } | undefined) : undefined;
			if (!started.alive()) return hostGone();
			const said = replies.slice(heard);
			const attempt: Attempt = ticket ? { opened: true, ticket: ticket.id, domain: ticket.domain, report: report ?? null, gateway: started.gateway } : { opened: false, replies: said };
			const verdict = judge(module, exam, attempt);
			if (!verdict.pass) failed++;
			console.log(verdictLine(exam, verdict));
			console.log(`  问：${exam.question}`);
			for (const text of said) console.log(`  Router：${text}`);
			if (report) console.log(`  汇报（${report.status}）：${report.summary}`);
		}
		passed = `${exams.length - failed}/${exams.length} 道考题通过`;
		return failed === 0 ? 0 : 1;
	} catch (error) {
		if (error === interruption) return 130;
		throw error;
	} finally {
		talk?.close();
		await host?.stop();
		rmSync(stateDir, { recursive: true, force: true });
		db?.close();
		for (const signal of SIGNALS) process.off(signal, interrupted);
		if (passed !== undefined) console.log(`${passed}；临时状态目录已删`);
	}
}
