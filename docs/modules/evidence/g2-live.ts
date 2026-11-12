/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/g2-live.ts [lanes|perf] [outDir]
 *   LANES=2,3,4 runs only those lanes.
 *
 * Lanes 2 to 9 replay Worker calls from the fake model in tests/e2e/fake-model.ts on one host, with a fake
 * Telegram chat. Lane 1 and the perf baseline also run a detached worktree of `origin/main` at <outDir>/trunk.
 * Lane 10 calls real openai-codex models and needs the Pi login in ~/.pi/agent.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const SAMPLE = join(HEAD, "docs/modules/architecture/sample");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const USER = 42;
const NOTICE = "个人医疗健康 有新内容，请在网页上查看";
const [mode = "lanes", outDir = "/tmp/swarm-g2/owner"] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
const ONLY = process.env.LANES?.split(",").map(Number);
mkdirSync(outDir, { recursive: true });

const { fakeModels } = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, dispatch, fakeAgentEnv, knowledge, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
const { scanPackage } = await import(join(HEAD, "src/modules/validate.ts"));
type Fake = InstanceType<typeof FakeModel>;
type Telegram = InstanceType<typeof FakeTelegram>;
type Host = Awaited<ReturnType<(typeof import("../../tests/e2e/harness.ts"))["startHost"]>>;
type Call = { name: string; args: Record<string, unknown> };
type Exchange = import("../../tests/e2e/fake-model.ts").Exchange;

function trunk(): string {
	if (!existsSync(TRUNK)) {
		spawnSync("git", ["worktree", "add", "--detach", TRUNK, "origin/main"], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
	}
	return TRUNK;
}

const stateDir = () => mkdtempSync(join(tmpdir(), "psa-g2-"));
const place = (state: string, from: string, name: string) => cpSync(from, join(state, "modules", name), { recursive: true, force: true });

function just(state: string, args: string[], cwd = HEAD) {
	const run = spawnSync("just", args, { cwd, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300" }, encoding: "utf8", timeout: 60_000 });
	return { status: run.status, out: (run.stdout + run.stderr).trim() };
}

function query<T>(path: string, sql: string): T[] {
	if (!existsSync(path)) return [];
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(sql).all().map((r) => ({ ...r })) as T[];
	} finally {
		db.close();
	}
}
const state_ = (state: string, sql: string) => query<Record<string, unknown>>(join(state, "state.db"), sql);
const data = (state: string, name: string, sql: string) => query<Record<string, unknown>>(join(state, "modules-data", name, "data.db"), sql);

const moduleState = (state: string, name: string): { at: string; serving?: { label: string } } | undefined => {
	const [row] = state_(state, `SELECT record FROM module_records WHERE name = '${name}'`);
	return row?.record ? (JSON.parse(row.record as string) as { state: { at: string; serving?: { label: string } } }).state : undefined;
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function within(limitMs: number, ok: () => boolean): Promise<number> {
	const started = performance.now();
	while (performance.now() - started < limitMs) {
		if (ok()) return Math.round(performance.now() - started);
		await sleep(20);
	}
	return ok() ? Math.round(performance.now() - started) : -1;
}
async function turnOn(state: string, names: string[], tree = HEAD): Promise<number> {
	for (const name of names) just(state, ["module", "on", name], tree);
	return within(20_000, () => names.every((n) => moduleState(state, n)?.at === "active"));
}

async function boot(state: string, fake: Fake | null, tg?: Telegram, tree = HEAD): Promise<Host> {
	const harness = await import(join(tree, "tests/e2e/harness.ts"));
	const env = { ...(fake === null ? {} : fakeAgentEnv(fake, join(state, "pi"))), ...(tg && { PSA_E2E_TELEGRAM_URL: tg.url }) };
	if (tg) writeFileSync(join(state, "secrets.env"), `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`);
	const config = { webPort: 0, ...(tg && { secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } }) };
	return harness.startHost({ models: fake === null ? REAL : fakeModels, stateDir: state, logFile: join(state, "host.log"), config, env, timeoutMs: 60_000, ...(tg && { imports: ["./tests/e2e/telegram-preload.mjs"] }) });
}

const results: string[] = [];
async function lane(n: number, slug: string, body: () => Promise<{ pass: boolean | "inconclusive"; evidence: string }>): Promise<void> {
	if (ONLY && !ONLY.includes(n)) return;
	let verdict: { pass: boolean | "inconclusive"; evidence: string };
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const word = verdict.pass === "inconclusive" ? "INCONCLUSIVE" : verdict.pass ? "PASS" : "FAIL";
	const file = join(outDir, `g2-${slug}.txt`);
	writeFileSync(file, `${word} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

const exchangesOf = (fake: Fake, conversation: string): Exchange[] => fake.exchanges.filter((e: Exchange) => e.conversation === conversation);
const cardsOf = (fake: Fake, conversation: string) => exchangesOf(fake, conversation).flatMap((e) => e.cards);
const inDomain = (call: Call, domain: string, basis = "request") => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain, basis })) } });
const dataCall = (args: Record<string, unknown>): Call => ({ name: "data", args });
const cea = (value: number, takenAt: string) => ({ item: "CEA", value, unit: "ng/mL", reference: "<5", takenAt, lab: "协和" });

const opens = (brief: string, domain: string, basis = "request") => on(`开 ${brief}`, new RegExp(`^\\[对话\\][\\s\\S]*使用者：${brief}`), (c: string) => [inDomain(openTicket(c, brief), domain, basis), reply(c, `好，${brief}`)]);
const relay = on("转述汇报", /^\[Worker 汇报\]/, (c: string) => [reply(c, `转述：${c.split("\n")[1] ?? ""}`)]);
const B = { write: "L2 记指标", alias: "L3 旧字段名", infer: "L4 推断写", uses: "L5 成员越权", other: "L6 别的模块", shareable: "L9 只读公开" };
const PHARMACIST = "L5 读病历原件";

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		const lines: string[] = [];
		const cards: string[] = [];
		for (const [name, tree] of [["trunk", trunk()], ["head", HEAD]] as const) {
			const state = stateDir();
			place(state, join(SAMPLE, "personal-health"), "personal-health");
			const brief = `${name} 查知识`;
			const fake = await FakeModel.start({
				router: [on("开任务", /^\[对话\][\s\S]*查一下肿瘤标志物/, (c: string) => [inDomain(openTicket(c, brief), "personal-health"), reply(c, "好")])],
				workers: [worker(brief, on("查知识", /^\[任务说明\]/, () => [knowledge("肿瘤标志物 复查")]), on("汇报", /肿瘤标志物/, () => [report("ready", "查到了")]))],
			});
			let host: Host | undefined;
			try {
				host = await boot(state, fake, undefined, tree);
				const took = await turnOn(state, ["personal-health"], tree);
				just(state, ["say", "查一下肿瘤标志物"], tree);
				await within(30_000, () => exchangesOf(fake, brief).some((e) => e.steps.includes("汇报")));
				const card = cardsOf(fake, brief).find((c) => !c.startsWith("[任务说明]")) ?? "";
				cards.push(card);
				lines.push(`${name}: serving after ${took} ms; knowledge result:\n${card}`);
			} finally {
				await host?.stop();
				await fake.close();
			}
		}
		return { pass: cards[0] !== "" && cards[0] === cards[1], evidence: lines.join("\n\n") };
	});

	const state = stateDir();
	for (const name of ["personal-health", "personal-tax"]) place(state, join(SAMPLE, name), name);
	const tg = await FakeTelegram.start();
	const fake = await FakeModel.start({
		router: [opens(B.write, "personal-health"), opens(B.alias, "personal-health"), opens(B.infer, "personal-health", "inference"), opens(B.uses, "personal-health"), opens(B.other, "personal-tax"), opens(B.shareable, "personal-health"), ...Array.from({ length: 12 }, () => relay)],
		workers: [
			worker(
				B.write,
				on("写", /^\[任务说明\]/, () => [dataCall({ op: "write", collection: "lab-results", rows: [cea(4.2, "2026-10-01")], from: "blobs/report-2026-10.pdf" })]),
				on("查", /^\[模块数据\] lab-results/, () => [dataCall({ op: "query", collection: "lab-results", where: { item: "CEA" }, since: "2026-09-01", until: "2026-12-31" })]),
				on("汇报", /^\[模块数据\] lab-results/, () => [report("ready", "CEA 4.2 ng/mL，比参考上限低")]),
			),
			worker(
				B.alias,
				on("按旧名写", /^\[任务说明\]/, () => [dataCall({ op: "write", collection: "lab-results", rows: [{ item: "CEA", value: 3.3, takenAt: "2026-10-02", lab: "瑞金" }], from: "使用者口述" })]),
				on("汇报", /^\[模块数据\]/, () => [report("ready", "记好了")]),
			),
			worker(
				B.infer,
				on("写", /^\[任务说明\]/, () => [dataCall({ op: "write", collection: "lab-results", rows: [cea(9.9, "2026-10-03")], from: "邮件" })]),
				on("汇报", /^\[模块数据\]/, () => [report("ready", "写不了")]),
			),
			worker(
				B.uses,
				on("派给药师", /^\[任务说明\]/, () => [dispatch("clinical-pharmacist", PHARMACIST)]),
				on("汇报", /^\[成员回复\]/, () => [report("ready", "药师读不到病历原件")]),
			),
			worker(PHARMACIST, on("药师读病历", /^\[派活\]/, () => [dataCall({ op: "query", collection: "documents" })]), on("药师回复", /^\[模块数据\]/, () => "读不到病历原件。")),
			worker(
				B.other,
				on("读别的模块", /^\[任务说明\]/, () => [dataCall({ op: "query", collection: "lab-results" })]),
				on("汇报", /^\[模块数据\]/, () => [report("ready", "查不到")]),
			),
			worker(
				B.shareable,
				on("读公开数据", /^\[任务说明\]/, () => [dataCall({ op: "list", collection: "research-updates" })]),
				on("汇报", /^\[模块数据\]/, () => [report("ready", "公开的研究进展还没有记录")]),
			),
		],
	});
	let host: Host | undefined;
	const phone = () => tg.sent.filter((m: { chatId: number }) => m.chatId === USER).map((m: { text: string }) => m.text as string);
	const lastCard = (brief: string) => cardsOf(fake, brief).filter((c) => c.startsWith("[模块数据]")).at(-1) ?? "";
	const ticketOf = (brief: string) => state_(state, `SELECT id FROM tickets WHERE title = '${brief}'`)[0]?.id as string | undefined;
	const say = async (brief: string) => {
		just(state, ["say", brief]);
		return within(60_000, () => state_(state, `SELECT 1 FROM tickets t JOIN reports r ON r.ticket_id = t.id WHERE t.title = '${brief}'`).length > 0);
	};
	const routerSaid = () => state_(state, "SELECT text FROM reply_receipts").map((r) => r.text as string);
	try {
		host = await boot(state, fake, tg);
		const on_ = await turnOn(state, ["personal-health", "personal-tax"]);
		if (on_ < 0) throw new Error(`modules did not start serving: ${JSON.stringify(state_(state, "SELECT name, record FROM module_records"))}`);
		tg.userSays(USER, "/start");
		await within(10_000, () => phone().length > 0);

		await lane(2, "write-read", async () => {
			const took = await say(B.write);
			const card = lastCard(B.write);
			const parsed = JSON.parse(card.slice(card.indexOf("：") + 1)) as { rows: { from: string; fields: Record<string, unknown> }[] };
			const stored = data(state, "personal-health", `SELECT _id, _from, item, value, takenAt FROM "lab-results"`);
			const same = parsed.rows.length === 1 && parsed.rows[0]!.from === "blobs/report-2026-10.pdf" && JSON.stringify(parsed.rows[0]!.fields) === JSON.stringify(cea(4.2, "2026-10-01"));
			return { pass: took >= 0 && same && stored.length === 1, evidence: `report after ${took} ms\nquery result card:\n${card}\ndata.db lab-results: ${JSON.stringify(stored)}` };
		});

		await lane(3, "alias", async () => {
			const pkg = join(state, "modules/personal-health");
			const collection = JSON.parse(readFileSync(join(pkg, "data/lab-results/collection.json"), "utf8"));
			const { lab, ...rest } = collection.fields;
			writeFileSync(join(pkg, "data/lab-results/collection.json"), JSON.stringify({ ...collection, fields: { ...rest, laboratory: { ...lab, was: "lab" } } }, null, 2));
			writeFileSync(join(pkg, "module.json"), readFileSync(join(pkg, "module.json"), "utf8").replace('"0.1.0"', '"0.1.1"'));
			const swapped = await within(10_000, () => moduleState(state, "personal-health")?.serving?.label === "0.1.1");
			const took = await say(B.alias);
			const card = lastCard(B.alias);
			const stored = data(state, "personal-health", `SELECT item, value, laboratory FROM "lab-results"`);
			const columns = data(state, "personal-health", `SELECT name FROM pragma_table_info('lab-results')`).map((c) => c.name);
			return { pass: swapped >= 0 && took >= 0 && stored.some((r) => r.laboratory === "瑞金") && !columns.includes("lab"), evidence: `personal-health 0.1.1 (lab renamed to laboratory) serving after ${swapped} ms\nwrote {lab: "瑞金"}; result card:\n${card}\ncolumns: ${columns.join(",")}\nrows: ${JSON.stringify(stored)}` };
		});

		await lane(4, "infer", async () => {
			const took = await say(B.infer);
			const card = lastCard(B.infer);
			const nines = data(state, "personal-health", `SELECT COUNT(*) AS n FROM "lab-results" WHERE value = 9.9`)[0]?.n;
			return { pass: took >= 0 && /只读/.test(card) && nines === 0, evidence: `inference ticket ${ticketOf(B.infer)}; write result card:\n${card}\nrows with 9.9: ${nines}` };
		});

		await lane(5, "uses", async () => {
			const took = await say(B.uses);
			const card = lastCard(PHARMACIST);
			const offered = exchangesOf(fake, PHARMACIST)[0]?.tools ?? [];
			return { pass: took >= 0 && /uses 没有列这一项/.test(card), evidence: `clinical-pharmacist (uses: knowledge, data/lab-results) asked for documents; result card:\n${card}\ntools offered: ${JSON.stringify(offered)}` };
		});

		await lane(6, "other", async () => {
			const took = await say(B.other);
			const card = lastCard(B.other);
			return { pass: took >= 0 && /没有这一项/.test(card) && !/CEA/.test(card), evidence: `personal-tax ticket asked for lab-results; result card:\n${card}` };
		});

		await lane(7, "log", async () => {
			const log = data(state, "personal-health", "SELECT who, collection, op, rows, outcome FROM _access ORDER BY rowid");
			const gateway = readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => /\[gateway\] .* data\//.test(l));
			const okCalls = gateway.filter((l) => / ok \d+ ms$/.test(l)).length;
			return { pass: okCalls === log.length && log.length === 3, evidence: `gateway data calls that went through: ${okCalls} (L2 write and query, L3 write; refusals stop before the data)\n${gateway.join("\n")}\npersonal-health _access:\n${log.map((r) => JSON.stringify(r)).join("\n")}` };
		});

		await lane(8, "private", async () => {
			const ticket = ticketOf(B.write)!;
			const marked = state_(state, `SELECT touched_private_at FROM tickets WHERE id = '${ticket}'`)[0]?.touched_private_at;
			await within(10_000, () => phone().includes(NOTICE));
			const full = routerSaid().find((t) => t.startsWith("转述：CEA 4.2"));
			const reportRow = state_(state, `SELECT summary FROM reports WHERE ticket_id = '${ticket}'`)[0]?.summary;
			const leak = phone().some((m) => m.includes("4.2"));
			return { pass: marked != null && phone().filter((m) => m === NOTICE).length >= 1 && !leak && full !== undefined && reportRow === "CEA 4.2 ng/mL，比参考上限低", evidence: `ticket ${ticket} touched_private_at ${marked}\nTelegram recorder (chat ${USER}):\n${phone().join("\n")}\nconversation the web page and TUI show: ${full}\nreport on the board: ${reportRow}` };
		});

		await lane(9, "shareable", async () => {
			const took = await say(B.shareable);
			await within(30_000, () => phone().some((m) => m.startsWith("转述：公开的研究进展")));
			const ticket = ticketOf(B.shareable)!;
			const marked = state_(state, `SELECT touched_private_at FROM tickets WHERE id = '${ticket}'`)[0]?.touched_private_at;
			return { pass: took >= 0 && marked == null && phone().includes("转述：公开的研究进展还没有记录"), evidence: `ticket ${ticket} touched_private_at ${marked}\nTelegram recorder:\n${phone().join("\n")}` };
		});
	} finally {
		writeFileSync(join(outDir, "g2-fake.jsonl"), fake.jsonl());
		if (existsSync(join(state, "host.log"))) cpSync(join(state, "host.log"), join(outDir, "g2-host.log"));
		await host?.stop();
		await fake.close();
		await tg.close();
	}

	await lane(10, "real", async () => {
		const real = stateDir();
		place(real, join(SAMPLE, "personal-health"), "personal-health");
		let host: Host;
		try {
			host = await boot(real, null);
		} catch (error) {
			return { pass: "inconclusive", evidence: `a real host could not start: ${String((error as Error).stack ?? error)}` };
		}
		try {
			await turnOn(real, ["personal-health"]);
			just(real, ["say", "请在个人医疗健康模块里帮我记下一条体检指标：2026-11-10 空腹血糖 5.4 mmol/L，参考范围 3.9-6.1，实验室 社区医院。这是我口述的。记好后告诉我。"]);
			const took = await within(300_000, () => state_(real, "SELECT id FROM reports WHERE status IN ('ready', 'blocked', 'failed', 'no_action')").length > 0);
			const rows = data(real, "personal-health", `SELECT * FROM "lab-results"`);
			const access = data(real, "personal-health", "SELECT who, collection, op, rows FROM _access");
			const reports = state_(real, "SELECT status, summary FROM reports ORDER BY seq");
			const stored = rows.some((r) => Number(r.value) === 5.4);
			const ran = took >= 0 || reports.length > 0;
			return {
				pass: !ran ? "inconclusive" : stored,
				evidence: `models ${JSON.stringify(REAL)}\nreport after ${took} ms\ntickets: ${JSON.stringify(state_(real, "SELECT id, domain, title FROM tickets"))}\nlab-results rows: ${JSON.stringify(rows)}\n_access: ${JSON.stringify(access)}\nreports:\n${reports.map((r) => `${r.status}: ${r.summary}`).join("\n")}`,
			};
		} finally {
			await host.stop();
		}
	});
	console.log(`\n${results.join("\n")}`);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (name: string, xs: number[], unit: string) => `${name}: median ${median(xs).toFixed(2)} ${unit}, runs ${xs.map((t) => t.toFixed(2)).join(" ")}, spread ${(Math.max(...xs) - Math.min(...xs)).toFixed(2)} ${unit}`;

async function perf(): Promise<void> {
	const lines: string[] = [];
	const ROWS = 100_000;
	const state = stateDir();
	const scan = scanPackage(join(SAMPLE, "personal-health"), { runCases: false, folder: "personal-health" });
	if (!scan.ok) throw new Error("personal-health does not scan");
	const components = scan.scan.components;
	const rows = instanceData(state);
	rows.migrate("personal-health", components);
	const db = new DatabaseSync(join(state, "modules-data/personal-health/data.db"));
	db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS - 1})
		INSERT INTO "lab-results" (_from, item, value, unit, takenAt, lab)
		SELECT 'blobs/r-' || i || '.pdf', 'M' || (i % 100), i / 100.0, 'ng/mL', date('2020-01-01', '+' || (i / 100) || ' days'), '协和' FROM n`);
	db.close();
	const time = (run: () => unknown) => {
		const started = performance.now();
		run();
		return performance.now() - started;
	};
	const queries: number[] = [];
	const got: number[] = [];
	for (let i = 0; i < 20; i++) {
		queries.push(time(() => got.push(rows.query("personal-health", components, "lab-results", { where: { item: `M${i}` }, since: "2020-01-01", until: "2023-12-31", limit: 100 }, "perf helper").rows.length)));
	}
	const writes: number[] = [];
	for (let i = 0; i < 20; i++) writes.push(time(() => rows.write("personal-health", components, "lab-results", [{ item: "CEA", value: i, takenAt: "2026-11-12" }], "perf", "perf helper")));
	const ok = median(queries) <= 50 && median(writes) <= 50 && got.every((n) => n === 100);
	lines.push(
		`${ok ? "PASS" : "FAIL"} data tool, host side, ${ROWS} rows in lab-results (100 items x 1000 days), 20 queries by item and a date range for 100 rows, 20 one-row writes (rule: either median over 50 ms fails)`,
		line("  query", queries, "ms"),
		`  rows per query: ${[...new Set(got)].join(",")}`,
		line("  write", writes, "ms"),
	);

	const trunkKnowledge = await knowledgeBaseline();
	lines.push(`  trunk knowledge search for comparison: ${trunkKnowledge}`);
	const report = lines.join("\n");
	writeFileSync(join(outDir, "g2-perf.txt"), `${report}\n`);
	console.log(report);
	rmSync(state, { recursive: true, force: true });
}

/** The plan's baseline: trunk's `knowledge` call, 20 searches on personal-health's bundled knowledge, in-process. */
async function knowledgeBaseline(): Promise<string> {
	const tree = trunk();
	const { searchKnowledge } = await import(join(tree, "src/modules/knowledge.ts"));
	const { scanPackage: scanTrunk } = await import(join(tree, "src/modules/validate.ts"));
	const dir = join(tree, "docs/modules/architecture/sample/personal-health");
	const scan = scanTrunk(dir, { runCases: false, folder: "personal-health" });
	if (!scan.ok) return "trunk could not scan personal-health";
	const docs = scan.scan.components.filter((c: { kind: string }) => c.kind === "knowledge");
	const state = stateDir();
	const base = { module: "personal-health", digest: scan.scan.digest, copyDir: dir, dataDir: join(state, "modules-data/personal-health"), docs };
	const runs: number[] = [];
	for (let i = 0; i < 20; i++) {
		const started = performance.now();
		searchKnowledge(base, "肿瘤标志物 复查");
		runs.push(performance.now() - started);
	}
	rmSync(state, { recursive: true, force: true });
	return line("median", runs, "ms").slice("median: ".length);
}

try {
	await (mode === "perf" ? perf() : lanes());
} finally {
	if (existsSync(TRUNK)) spawnSync("git", ["worktree", "remove", "--force", TRUNK], { cwd: HEAD });
}
