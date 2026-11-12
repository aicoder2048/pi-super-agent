/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/g3-live.ts [lanes|perf] [outDir]
 *
 * Lanes 2 to 9 replay Worker calls from the fake model in tests/e2e/fake-model.ts on one host, with a fake
 * Telegram chat. Lane 1 runs the us-market tripwire in-process on a detached worktree of `origin/main` at
 * <outDir>/trunk and on this tree. The perf baseline runs a detached worktree of G2 (`origin/psa/mod-g2-data-tool`)
 * at <outDir>/g2. Lane 10 calls real openai-codex models and needs the Pi login in ~/.pi/agent.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const SAMPLE = join(HEAD, "docs/modules/architecture/sample");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const USER = 42;
const NOTICE = "个人医疗健康 有新内容，请在网页上查看";
const [mode = "lanes", outDir = "/tmp/swarm-g3/owner"] = process.argv.slice(2);
const TREES = { trunk: { dir: join(outDir, "trunk"), ref: "origin/main" }, g2: { dir: join(outDir, "g2"), ref: "origin/psa/mod-g2-data-tool" } };
mkdirSync(outDir, { recursive: true });

const { fakeModels } = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
type Fake = InstanceType<typeof FakeModel>;
type Telegram = InstanceType<typeof FakeTelegram>;
type Host = Awaited<ReturnType<(typeof import("../../tests/e2e/harness.ts"))["startHost"]>>;
type Call = { name: string; args: Record<string, unknown> };
type Exchange = import("../../tests/e2e/fake-model.ts").Exchange;

function tree(name: keyof typeof TREES): string {
	const { dir, ref } = TREES[name];
	if (!existsSync(dir)) {
		spawnSync("git", ["worktree", "add", "--detach", dir, ref], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(dir, "node_modules"));
	}
	return dir;
}

const made: string[] = [];
const stateDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "psa-g3-"));
	made.push(dir);
	return dir;
};
const place = (state: string, from: string, name: string) => cpSync(from, join(state, "modules", name), { recursive: true, force: true });

function just(state: string, args: string[]) {
	const run = spawnSync("just", args, { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300" }, encoding: "utf8", timeout: 60_000 });
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
const data = (state: string, sql: string) => query<Record<string, unknown>>(join(state, "modules-data/personal-health/data.db"), sql);
const moduleState = (state: string, name: string) => {
	const [row] = state_(state, `SELECT record FROM module_records WHERE name = '${name}'`);
	return row?.record ? (JSON.parse(row.record as string) as { state: { at: string } }).state : undefined;
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
async function turnOn(state: string): Promise<number> {
	just(state, ["module", "on", "personal-health"]);
	return within(20_000, () => moduleState(state, "personal-health")?.at === "active");
}

async function boot(state: string, fake: Fake | null, tg?: Telegram): Promise<Host> {
	const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
	const env = { ...(fake === null ? {} : fakeAgentEnv(fake, join(state, "pi"))), ...(tg && { PSA_E2E_TELEGRAM_URL: tg.url }) };
	if (tg) writeFileSync(join(state, "secrets.env"), `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`);
	const config = { webPort: 0, ...(tg && { secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } }) };
	return harness.startHost({ models: fake === null ? REAL : fakeModels, stateDir: state, logFile: join(state, "host.log"), config, env, timeoutMs: 60_000, ...(tg && { imports: ["./tests/e2e/telegram-preload.mjs"] }) });
}

const results: string[] = [];
async function lane(n: number, slug: string, body: () => Promise<{ pass: boolean | "inconclusive"; evidence: string }>): Promise<void> {
	let verdict: { pass: boolean | "inconclusive"; evidence: string };
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const word = verdict.pass === "inconclusive" ? "INCONCLUSIVE" : verdict.pass ? "PASS" : "FAIL";
	const file = join(outDir, `g3-${slug}.txt`);
	writeFileSync(file, `${word} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

/** The us-market tripwire on one tree, in-process with fake quotes: set a day and a cost condition, move NVDA, read the alerts. */
async function marketAlerts(dir: string): Promise<string[]> {
	const load = (path: string) => import(join(dir, path));
	const [{ Kernel }, { openStore }, { MarketClient }, { MarketSource }, { parseMarketSettings }, { fakeHttp, snapshotBody, tickerRow }] = await Promise.all(
		["src/kernel/kernel.ts", "src/kernel/store.ts", "src/sources/market/client.ts", "src/sources/market/source.ts", "src/sources/market/settings.ts", "tests/helpers/market.ts"].map(load),
	);
	const prices: Record<string, number> = { NVDA: 100, SPY: 600 };
	const { clock, http } = fakeHttp((_url: string, now: number) => Response.json(snapshotBody(Object.entries(prices).map(([s, p]) => tickerRow(s, p, s === "SPY" ? 600 : 100, now - 60_000)))), Date.parse("2026-11-09T15:00:00Z"));
	const kernel = new Kernel({ db: openStore(join(stateDir(), "state.db")), clock, sourcePolicy: () => "candidate" });
	const settings = parseMarketSettings({ watchlist: ["NVDA", "SPY"], bands: { default: [3, 5, 8] }, volumeSpikeX: 5, everySeconds: 60, minGapMs: 0, baseURL: "https://api.massive.com" }, undefined, "g3-live");
	const source = new MarketSource({
		source: "us-market", title: "美股行情", settings,
		client: new MarketClient({ key: "sk-test", baseURL: "https://api.massive.com", minGapMs: 0, http, clock, sleep: async () => {} }),
		ctx: {
			clock, submit: (t: unknown) => void kernel.submitTrigger(t),
			readCursor: () => kernel.sourceCursor("us-market"), writeCursor: (v: string) => kernel.setSourceCursor("us-market", v),
			readUserData: () => kernel.sourceUserData("us-market"), writeUserData: (v: string) => kernel.setSourceUserData("us-market", v),
			post: (line: unknown) => void kernel.postHostLine("us-market", line), raised: (id: string) => kernel.raised("us-market", id),
			alertsSince: (since: number) => kernel.alertsSince("us-market", since), log: () => {},
		},
	});
	source.tripwires("set", { symbol: "NVDA", condition: { kind: "day", pct: 5 } });
	source.tripwires("set", { symbol: "NVDA", condition: { kind: "cost", pct: 10, basis: 106 } });
	prices.NVDA = 94.9;
	await source.tick();
	return kernel.conversation().filter((l: { who: string }) => l.who === "alert").map((l: { text: string }) => l.text);
}

const exchangesOf = (fake: Fake, conversation: string): Exchange[] => fake.exchanges.filter((e: Exchange) => e.conversation === conversation);
const inHealth = (call: Call, basis: string) => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain: "personal-health", basis })) } });
const opens = (brief: string, basis = "request") => on(`开 ${brief}`, new RegExp(`^\\[对话\\][\\s\\S]*使用者：${brief}`), (c: string) => [inHealth(openTicket(c, brief), basis), reply(c, `好，${brief}`)]);
const relay = on("转述汇报", /^\[Worker 汇报\]/, (c: string) => [reply(c, `转述：${c.split("\n")[1] ?? ""}`)]);
const watchCall = (key: string, condition: object): Call => ({ name: "watch", args: { op: "set", collection: "lab-results", key, condition } });
const reading = (key: string, value: number, takenAt: string): Call => ({ name: "data", args: { op: "write", collection: "lab-results", rows: [{ item: key, value, unit: "mmol/L", takenAt }], from: "使用者口述" } });

/** A helper that sets one condition on `key`, writes `values` one row per call (a day apart from 2026-11-01), then reports. */
function setThenWrite(brief: string, key: string, condition: object, values: number[], days?: string[]) {
	const at = (i: number) => days?.[i] ?? `2026-11-${String(i + 1).padStart(2, "0")}`;
	return worker(
		brief,
		on("设条件", /^\[任务说明\]/, () => [watchCall(key, condition)]),
		...values.map((v, i) => on(`写第 ${i + 1} 行`, i === 0 ? /^\[提醒条件\]/ : /^\[模块数据\]/, () => [reading(key, v, at(i))])),
		on("汇报", /^\[模块数据\]/, () => [report("ready", `${key} 记好了`)]),
	);
}

const L = { above: "L2 高于", below: "L3 低于边界", streak: "L4 三连涨", change: "L5 涨跌幅", cross: "L6 均线", dedupe: "L7 同一行两次", infer: "L8 推断设条件" };

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		const trunk = await marketAlerts(tree("trunk"));
		const head = await marketAlerts(HEAD);
		return { pass: trunk.length > 0 && JSON.stringify(trunk) === JSON.stringify(head), evidence: `NVDA day 5% and cost 10% vs 106, price 100 -> 94.9\ntrunk (${TREES.trunk.ref}) alerts:\n${trunk.join("\n")}\nhead alerts:\n${head.join("\n")}` };
	});

	const state = stateDir();
	place(state, join(SAMPLE, "personal-health"), "personal-health");
	const tg = await FakeTelegram.start();
	const fake = await FakeModel.start({
		router: [opens(L.above), opens(L.below), opens(L.streak), opens(L.change), opens(L.cross), opens(L.dedupe), opens(L.infer, "inference"), ...Array.from({ length: 14 }, () => relay)],
		workers: [
			setThenWrite(L.above, "空腹血糖", { when: "above", value: 7 }, [6.8, 7.4]),
			setThenWrite(L.below, "血钾", { when: "below", value: 3.5 }, [3.5]),
			setThenWrite(L.streak, "CEA", { when: "rising-streak", times: 3 }, [3, 3.2, 3.5, 3.9, 4.4]),
			setThenWrite(L.change, "ALT", { when: "change-pct", atLeast: 50, direction: "up", basis: 40 }, [55, 62, 65]),
			setThenWrite(L.cross, "体重", { when: "crosses-average", points: 3, direction: "down" }, [70, 71, 72, 73, 69]),
			setThenWrite(L.dedupe, "尿酸", { when: "above", value: 420 }, [460, 460], ["2026-11-10", "2026-11-10"]),
			worker(L.infer, on("推断任务设条件", /^\[任务说明\]/, () => [watchCall("血红蛋白", { when: "below", value: 110 })]), on("汇报", /^\[提醒条件\]/, () => [report("ready", "设不了")])),
		],
	});
	let host: Host | undefined;
	const phone = () => tg.sent.filter((m: { chatId: number }) => m.chatId === USER).map((m: { text: string }) => m.text as string);
	const alertsOn = (key: string) => state_(state, `SELECT external_id, text, module_title, module_private FROM host_lines WHERE kind = 'alert' AND source = 'module:personal-health' ORDER BY rowid`).filter((r) => String(r.text).includes(` ${key} `));
	const say = async (brief: string) => {
		just(state, ["say", brief]);
		return within(60_000, () => state_(state, `SELECT 1 FROM tickets t JOIN reports r ON r.ticket_id = t.id WHERE t.title = '${brief}'`).length > 0);
	};
	const show = (rows: Record<string, unknown>[]) => rows.map((r) => JSON.stringify(r)).join("\n") || "(none)";
	const conditionsOf = (key: string) => data(state, `SELECT id, key, kind, params FROM _conditions WHERE key = '${key}'`);
	try {
		host = await boot(state, fake, tg);
		const took = await turnOn(state);
		if (took < 0) throw new Error(`personal-health did not start serving: ${JSON.stringify(state_(state, "SELECT name, record FROM module_records"))}`);
		tg.userSays(USER, "/start");
		await within(10_000, () => phone().length > 0);

		await lane(2, "above", async () => {
			const took = await say(L.above);
			const alerts = alertsOn("空腹血糖");
			const text = String(alerts[0]?.text ?? "");
			return { pass: took >= 0 && alerts.length === 1 && text.includes("7.4") && text.includes("2026-11-02") && text.includes("使用者口述"), evidence: `above 7, wrote 6.8 then 7.4; report after ${took} ms\nconditions: ${show(conditionsOf("空腹血糖"))}\nhost_lines alerts (what the web page shows):\n${show(alerts)}` };
		});

		await lane(3, "below", async () => {
			const took = await say(L.below);
			const alerts = alertsOn("血钾");
			return { pass: took >= 0 && conditionsOf("血钾").length === 1 && alerts.length === 0, evidence: `below 3.5, wrote 3.5 (the boundary); report after ${took} ms\nconditions: ${show(conditionsOf("血钾"))}\nalerts: ${show(alerts)}` };
		});

		await lane(4, "streak", async () => {
			const took = await say(L.streak);
			const alerts = alertsOn("CEA");
			return { pass: took >= 0 && alerts.length === 1 && String(alerts[0]!.text).includes("2026-11-04") && String(alerts[0]!.text).includes("连续 3 次上涨"), evidence: `rising-streak 3, wrote 3, 3.2, 3.5, 3.9, 4.4 (11-01..11-05); the third rise is the 11-04 row\nreport after ${took} ms\nalerts:\n${show(alerts)}` };
		});

		await lane(5, "change", async () => {
			const took = await say(L.change);
			const alerts = alertsOn("ALT");
			return { pass: took >= 0 && alerts.length === 1 && String(alerts[0]!.text).includes("相对 40 涨了 55%") && String(alerts[0]!.text).includes("2026-11-02"), evidence: `change-pct up 50% vs basis 40, wrote 55 (+37.5%), 62 (+55%), 65 (+62.5%, still past)\nreport after ${took} ms\nalerts:\n${show(alerts)}` };
		});

		await lane(6, "cross", async () => {
			const took = await say(L.cross);
			const alerts = alertsOn("体重");
			return { pass: took >= 0 && alerts.length === 1 && String(alerts[0]!.text).includes("2026-11-05") && String(alerts[0]!.text).includes("下穿最近 3 次的均值"), evidence: `crosses-average down over 3 rows, wrote 70, 71, 72, 73, 69; 73 sits above its average 72, 69 falls below 71.33\nreport after ${took} ms\nalerts:\n${show(alerts)}` };
		});

		await lane(7, "dedupe", async () => {
			const took = await say(L.dedupe);
			const alerts = alertsOn("尿酸");
			const rows = data(state, `SELECT _id, item, value, takenAt FROM "lab-results" WHERE item = '尿酸'`);
			return { pass: took >= 0 && rows.length === 2 && alerts.length === 1, evidence: `above 420, wrote 460 at 2026-11-10 twice\nrows: ${show(rows)}\nalerts:\n${show(alerts)}` };
		});

		await lane(8, "infer", async () => {
			const before = data(state, "SELECT COUNT(*) AS n FROM _conditions")[0]?.n;
			const took = await say(L.infer);
			const card = exchangesOf(fake, L.infer).flatMap((e) => e.cards).find((c) => c.startsWith("[提醒条件]")) ?? "";
			const after = data(state, "SELECT COUNT(*) AS n FROM _conditions")[0]?.n;
			return { pass: took >= 0 && /只读/.test(card) && before === after && conditionsOf("血红蛋白").length === 0, evidence: `inference ticket set below 110 on 血红蛋白\nresult card:\n${card}\n_conditions rows before ${before}, after ${after}` };
		});

		await lane(9, "private", async () => {
			const all = state_(state, "SELECT id, text, module_title, module_private FROM host_lines WHERE kind = 'alert' ORDER BY rowid");
			const sent = () => state_(state, `SELECT key, body ->> '$.text' AS text, sent_version = version AS sent FROM telegram_messages WHERE chat_id = ${USER} AND key LIKE 'alert:%' ORDER BY created_at`);
			await within(15_000, () => sent().filter((m) => m.sent === 1).length >= all.length);
			const messages = sent();
			const each = all.every((a) => messages.some((m) => m.key === `alert:${a.id}` && m.sent === 1 && m.text === NOTICE));
			const leaked = phone().filter((m) => all.some((a) => m.includes(String(a.text))) || /7\.4|空腹血糖/.test(m));
			return {
				pass: all.length >= 4 && all.every((a) => a.module_title === "个人医疗健康" && a.module_private === 1) && each && messages.length === all.length && leaked.length === 0,
				evidence: `alerts on the web page (lab-results is private):\n${show(all)}\ntelegram_messages alert: rows for chat ${USER}:\n${show(messages)}\nTelegram recorder lines carrying an alert's content: ${leaked.length}`,
			};
		});
	} finally {
		writeFileSync(join(outDir, "g3-fake.jsonl"), fake.jsonl());
		if (existsSync(join(state, "host.log"))) cpSync(join(state, "host.log"), join(outDir, "g3-host.log"));
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
			await turnOn(real);
			just(real, ["say", "在个人医疗健康模块里帮我设个提醒：空腹血糖高于 7 提醒我。单位是 mmol/L，严格大于 7 才算，直接设好，不用再问我。"]);
			const took = await within(300_000, () => state_(real, "SELECT id FROM reports WHERE status IN ('ready', 'blocked', 'failed', 'no_action')").length > 0);
			const conditions = query<Record<string, unknown>>(join(real, "modules-data/personal-health/data.db"), "SELECT * FROM _conditions");
			const receipts = sessionLines(real).filter((l) => l.includes("提醒条件 cnd_"));
			const reports = state_(real, "SELECT status, summary FROM reports ORDER BY seq");
			const set = conditions.some((c) => c.kind === "above" && JSON.parse(String(c.params)).value === 7);
			const ran = took >= 0 || reports.length > 0;
			return {
				pass: !ran ? "inconclusive" : set && receipts.length > 0,
				evidence: `models ${JSON.stringify(REAL)}\nreport after ${took} ms\ntickets: ${JSON.stringify(state_(real, "SELECT id, domain, basis, title FROM tickets"))}\n_conditions: ${JSON.stringify(conditions)}\nreceipt lines in the Worker's session: ${receipts.slice(0, 2).join("\n") || "(none)"}\nreports:\n${reports.map((r) => `${r.status}: ${r.summary}`).join("\n")}`,
			};
		} finally {
			await host.stop();
		}
	});
	console.log(`\n${results.join("\n")}`);
}

/** The receipt the Worker read: tool results in its Pi session files, one string per line that holds one. */
function sessionLines(state: string): string[] {
	const dir = join(state, "sessions");
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith(".jsonl")).map((f) => join(f.parentPath, f.name));
	return files.flatMap((f) => readFileSync(f, "utf8").split("\n")).flatMap((line) => [...line.matchAll(/(已[设改]提醒条件 cnd_[^"\\]*)/g)].map((m) => m[1]!));
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (name: string, xs: number[]) => `${name}: median ${median(xs).toFixed(2)} ms, min ${Math.min(...xs).toFixed(2)}, max ${Math.max(...xs).toFixed(2)}, spread ${(Math.max(...xs) - Math.min(...xs)).toFixed(2)} ms, runs ${xs.length}`;

/** 100 one-row writes into lab-results holding 100,000 rows, on one tree. With `conditions`, key M0 carries 20 of every kind first. */
async function writes(dir: string, conditions: boolean): Promise<{ runs: number[]; alerts: number }> {
	const { instanceData } = await import(join(dir, "src/modules/instance-data.ts"));
	const { scanPackage } = await import(join(dir, "src/modules/validate.ts"));
	const scan = scanPackage(join(dir, "docs/modules/architecture/sample/personal-health"), { runCases: false, folder: "personal-health" });
	if (!scan.ok) throw new Error("personal-health does not scan");
	const components = scan.scan.components;
	const state = stateDir();
	const rows = instanceData(state);
	rows.migrate("personal-health", components);
	const db = new DatabaseSync(join(state, "modules-data/personal-health/data.db"));
	db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99999)
		INSERT INTO "lab-results" (_from, item, value, unit, takenAt, lab)
		SELECT 'blobs/r-' || i || '.pdf', 'M' || (i % 100), i / 100.0, 'ng/mL', date('2020-01-01', '+' || (i / 100) || ' days'), '协和' FROM n`);
	db.close();
	if (conditions) {
		const kinds = [
			{ when: "above", value: 900 }, { when: "below", value: 1 }, { when: "rising-streak", times: 5 }, { when: "falling-streak", times: 5 },
			{ when: "change-pct", atLeast: 5, direction: "either" }, { when: "change-pct", atLeast: 5, direction: "up", basis: 500 },
			{ when: "crosses-average", points: 200, direction: "up" }, { when: "crosses-average", points: 20, direction: "down" },
		];
		for (let i = 0; i < 20; i++) rows.watch("personal-health", components, { kind: "watch", collection: "lab-results", op: "set", watch: { key: "M0", condition: kinds[i % kinds.length] } }, "perf");
	}
	const runs: number[] = [];
	let alerts = 0;
	for (let i = 0; i < 100; i++) {
		const started = performance.now();
		alerts += rows.write("personal-health", components, "lab-results", [{ item: "M0", value: 1000 + (i % 7), takenAt: `2026-11-12T${String(i).padStart(4, "0")}` }], "perf", "perf helper").alerts?.length ?? 0;
		runs.push(performance.now() - started);
	}
	return { runs, alerts };
}

async function perf(): Promise<void> {
	const { runs: baseline } = await writes(tree("g2"), false);
	const { runs: head, alerts } = await writes(HEAD, true);
	const extra = median(head) - median(baseline);
	const report = [
		`${extra <= 20 ? "PASS" : "FAIL"} write one row and check 20 conditions on its key, lab-results with 100,000 rows, 100 writes per tree (rule: head median over G2 median by more than 20 ms fails); head - G2 = ${extra.toFixed(2)} ms`,
		line(`  G2 write, no conditions (${TREES.g2.ref})`, baseline),
		line("  head write + 20 conditions (crosses-average up to 200 rows of history)", head),
		`  alerts the 100 head writes raised: ${alerts} (the checks ran)`,
	].join("\n");
	writeFileSync(join(outDir, "g3-perf.txt"), `${report}\n`);
	console.log(report);
}

try {
	await (mode === "perf" ? perf() : lanes());
} finally {
	for (const { dir } of Object.values(TREES)) if (existsSync(dir)) spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: HEAD });
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
}
