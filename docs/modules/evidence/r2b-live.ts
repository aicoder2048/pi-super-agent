/**
 *   R2B_SECRETS=<host secrets .env> node --import ./src/pi-runtime.mjs docs/modules/evidence/r2b-live.ts [tools|page|feed|real|media] [outDir]
 *
 * R2B_SECRETS names a .env file the script reads POLYGON_API_KEY from; the environment wins over the file. Nothing prints a value.
 * Trunk is a detached worktree of origin/main at <outDir>/trunk.
 *
 * replay Lane 1 alone.
 * tools  Lanes 1, 3, 4, 5, 10 offline (fixtures, a stand-in Massive, the fake model); lane 6 and the intraday probe on real Massive.
 * page   Lane 2: `just modules` and the web page's module panel, on a host with the fake model.
 * feed   Lane 7 and the feed probe, in market hours: a real host on head runs the quotes feed every 60 s while the 盘面
 *        answers three questions on openai-codex models; meanwhile trunk's and head's quotes feed rounds alternate, 10 each.
 * real   Lanes 8 and 9 on openai-codex models: `just module try` runs evals/ (market-desk among them); a support question goes to 结构与形态.
 * old    Lane 9 alone.
 * media  The You-see question on the web page: the team shows 6 members and the 盘面 answers, screenshotted.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const USER = 42;
const DESK_Q = "NVDA 今天的涨跌是它自己的事还是板块的事";
// The plan's You-see question names NVDA's move; on 2026-11-13 NVDA was down about 3%, so the media run names that.
const MEDIA_Q = "NVDA 今天跌了 3% 多，是它自己的事还是板块的事";
const [mode = "tools", outDir = "/tmp/swarm-r2b/owner"] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
const SEED = join(outDir, "seed");
mkdirSync(outDir, { recursive: true });

const { readSecret } = await import(join(HEAD, "src/secrets.ts"));
const { runModuleCodeAsync } = await import(join(HEAD, "src/modules/run-code.ts"));
const { Modules } = await import(join(HEAD, "src/modules.ts"));
const { runFeed } = await import(join(HEAD, "src/modules/feed-runner.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
const { scanPackage } = await import(join(HEAD, "src/modules/validate.ts"));
const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, dispatch, domainTool, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const R = await import(join(HEAD, "docs/modules/evidence/replay-day.ts"));
const { chromium } = await import("playwright-core");
type Host = Awaited<ReturnType<typeof harness.startHost>>;
type Telegram = InstanceType<typeof FakeTelegram>;
type Reply = { ok: true; output: Record<string, unknown> } | { ok: false; note: string };

const KEY = readSecret(["POLYGON_API_KEY"], "POLYGON_API_KEY", process.env, process.env["R2B_SECRETS"])?.key ?? "";
const pkgOf = (tree: string) => join(tree, "docs/modules/examples/stock-ta");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const show = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") || "(none)";
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const temp = () => mkdtempSync(join(tmpdir(), "psa-r2b-"));

function just(state: string, args: string[], tree = HEAD, env: Record<string, string> = {}, limitMs = 600_000) {
	const run = spawnSync("just", args, { cwd: tree, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300", ...env }, encoding: "utf8", timeout: limitMs });
	return { status: run.status, out: (run.stdout + run.stderr).trim() };
}

function query(path: string, sql: string): Record<string, unknown>[] {
	if (!existsSync(path)) return [];
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(sql).all().map((r) => ({ ...r }));
	} finally {
		db.close();
	}
}

async function within<T>(limitMs: number, probe: () => T | undefined, stepMs = 200): Promise<T | undefined> {
	for (const end = Date.now() + limitMs; Date.now() < end; await sleep(stepMs)) {
		const found = probe();
		if (found !== undefined) return found;
	}
	return probe();
}

async function standIn(body: () => unknown) {
	const { createServer } = await import("node:http");
	const urls: string[] = [];
	const server = createServer((req, res) => {
		urls.push(req.url ?? "");
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body()));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	return { urls, base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) };
}

function installPackage(state: string, tree: string, baseUrl?: string): string {
	const pkg = join(state, "modules/stock-ta");
	cpSync(pkgOf(tree), pkg, { recursive: true });
	if (baseUrl !== undefined) {
		const feedJson = join(pkg, "feeds/quotes/feed.json");
		writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), settings: { baseUrl } }));
	}
	return pkg;
}

const intraday = (pkg: string, input: unknown, key = KEY): Promise<Reply> =>
	runModuleCodeAsync({ packageDir: pkg, component: "tools/intraday", dataDir: temp() }, "index.ts", input, key === "" ? {} : { POLYGON_API_KEY: key });

const results: string[] = [];
type Verdict = { pass: boolean | "inconclusive"; evidence: string };
async function lane(n: number | string, slug: string, body: () => Promise<Verdict>): Promise<void> {
	let verdict: Verdict;
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const word = verdict.pass === "inconclusive" ? "INCONCLUSIVE" : verdict.pass ? "PASS" : "FAIL";
	const file = join(outDir, `r2b-${slug}.txt`);
	writeFileSync(file, `${word} lane ${n}\n${verdict.evidence.replaceAll(KEY || "\0", "<key>").replaceAll(tmpdir(), "<tmp>").replaceAll(HEAD, "<repo>")}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

function trunkTree(): string {
	if (!existsSync(join(TRUNK, "justfile"))) {
		spawnSync("git", ["fetch", "-q", "origin", "main"], { cwd: HEAD });
		const add = spawnSync("git", ["worktree", "add", "--detach", TRUNK, "origin/main"], { cwd: HEAD, encoding: "utf8" });
		if (add.status !== 0) throw new Error(add.stderr);
		symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
	}
	return TRUNK;
}
const shaOf = (tree: string) => spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: tree, encoding: "utf8" }).stdout.trim();

// A condition's id is a fresh UUID in every replay.
const CONDITION_ID = /cnd_[0-9a-f-]{36}/g;

async function regression(): Promise<void> {
	await lane(1, "regression", async () => {
		const trunk = trunkTree();
		const scenarios = readdirSync(join(HEAD, "tests/fixtures/us-market-day")).map((f) => f.replace(/\.json$/, "")).sort();
		const conditions = [{ key: "NVDA", condition: { when: "day-move", atLeast: 5 } }, { key: "SPY", condition: { when: "day-move", atLeast: 2 } }];
		const lines: string[] = [];
		let same = true;
		let events = 0;
		for (const name of scenarios) {
			const day = R.scenario(name);
			const watch = [...new Set(day.days.flatMap((d: { prevClose: Record<string, number> }) => Object.keys(d.prevClose)))] as string[];
			const t = await R.replay(trunk, temp(), day, watch, conditions);
			const h = await R.replay(HEAD, temp(), day, watch, conditions);
			const a = JSON.stringify({ posted: t.posted, notices: t.notices, rows: t.rows }).replace(CONDITION_ID, "cnd_<id>");
			const b = JSON.stringify({ posted: h.posted, notices: h.notices, rows: h.rows }).replace(CONDITION_ID, "cnd_<id>");
			same &&= a === b;
			events += h.posted.length + h.notices.length;
			lines.push(`${a === b ? "same" : "DIFF"}  ${name} (${day.title}): alerts ${h.posted.length}, triggers ${h.notices.length}, quote rows ${h.rows}${a === b ? "" : `\n  trunk ${a}\n  head  ${b}`}`);
		}
		return { pass: same && events > 0, evidence: `trunk ${shaOf(trunk)}, head ${shaOf(HEAD)}; every scenario in tests/fixtures/us-market-day replayed on both through the quotes feed, conditions day-move NVDA 5% and SPY 2%\n${lines.join("\n")}` };
	});
}

async function tools(): Promise<void> {
	await regression();

	await lane(3, "uses", async () => {
		const state = temp();
		installPackage(state, HEAD, "http://127.0.0.1:9");
		const brief = "NVDA 盘面";
		const task = "看 NVDA 的支撑位";
		const fake = await FakeModel.start({
			router: [on("开任务", /^\[对话\][\s\S]*NVDA 盘面/, (c: string) => {
				const open = openTicket(c, brief);
				return [{ ...open, args: { decisions: (open.args.decisions as object[]).map((d) => ({ ...d, domain: "stock-ta" })) } }, reply(c, "好")];
			})],
			workers: [
				worker(brief, on("派给盘面", /^\[任务说明\]/, () => [dispatch("market-desk", task)]), on("汇报", /^\[成员回复\]/, (c: string) => [report("ready", c)])),
				worker(task, on("越出 uses 调 structure", /^\[派活\]/, () => [domainTool("structure", { symbol: "NVDA" })]), on("交回", /[\s\S]/, (c: string) => `structure 的结果：${c.slice(0, 300)}`)),
			],
		});
		let host: Host | undefined;
		try {
			host = await harness.startHost({ models: harness.fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0, modulesDirs: [join(state, "modules")] }, env: fakeAgentEnv(fake, join(state, "pi")), timeoutMs: 60_000 });
			just(state, ["module", "on", "stock-ta"]);
			await within(30_000, () => (query(join(state, "state.db"), "SELECT record FROM module_records WHERE name = 'stock-ta'").some((r) => JSON.parse(String(r["record"])).state.at === "active") ? true : undefined));
			just(state, ["say", "NVDA 盘面"]);
			const done = await within(90_000, () => query(join(state, "state.db"), "SELECT summary FROM reports WHERE status = 'ready'").at(0)?.["summary"] as string | undefined);
			const gateway = readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[gateway]"));
			const refused = gateway.filter((l) => / stock-ta tools\/structure .*market-desk.* not-in-uses /.test(l));
			return { pass: refused.length === 1 && !gateway.some((l) => / tools\/structure .* ok /.test(l)), evidence: `the fake 盘面 called domain_tool structure, which is not in its uses\ngateway:\n${gateway.join("\n")}\nreport:\n${done ?? "(none)"}` };
		} finally {
			await host?.stop();
			await fake.close();
		}
	});

	await lane(4, "intraday-cap", async () => {
		const massive = await standIn(() => ({ status: "OK", results: [] }));
		try {
			const pkg = installPackage(temp(), HEAD, massive.base);
			const now = "2026-11-13T16:00:00.000Z";
			const five = await intraday(pkg, { symbol: "NVDA", span: "minute", from: "2026-11-09", now }, "fixture-key");
			const many = await intraday(pkg, { symbol: "NVDA", span: "minute", limit: 600, now }, "fixture-key");
			const oneLine = (r: Reply) => !r.ok && r.note.split("\n").length === 1;
			return {
				pass: oneLine(five) && oneLine(many) && !five.ok && /最多回看 4 个交易日/.test(five.note) && !many.ok && /limit 最多 500/.test(many.note) && massive.urls.length === 0,
				evidence: `now 2026-11-13 11:00 美东 (Friday)\nfrom 2026-11-09, five trading days back: ${JSON.stringify(five)}\nlimit 600: ${JSON.stringify(many)}\nrequests to the stand-in Massive: ${massive.urls.length}`,
			};
		} finally {
			await massive.close();
		}
	});

	await lane(5, "no-key", async () => {
		const massive = await standIn(() => ({ status: "OK", results: [] }));
		try {
			const r = await intraday(installPackage(temp(), HEAD, massive.base), { symbol: "NVDA", span: "minute" }, "");
			return { pass: !r.ok && r.note.split("\n").length === 1 && /POLYGON_API_KEY/.test(r.note) && /密钥文件/.test(r.note) && massive.urls.length === 0, evidence: `no POLYGON_API_KEY: ${JSON.stringify(r)}\nrequests to the stand-in Massive: ${massive.urls.length}` };
		} finally {
			await massive.close();
		}
	});

	await lane(6, "intraday-real", async () => {
		if (KEY === "") return { pass: "inconclusive", evidence: "no POLYGON_API_KEY in the environment or R2B_SECRETS" };
		const asked = new Date();
		const minute = await intraday(pkgOf(HEAD), { symbol: "NVDA", span: "minute" });
		const hour = await intraday(pkgOf(HEAD), { symbol: "SPY", span: "hour" });
		const quote = await runModuleCodeAsync({ packageDir: pkgOf(HEAD), component: "tools/quote", dataDir: temp() }, "index.ts", { symbols: "NVDA" }, { POLYGON_API_KEY: KEY });
		const lastOf = (r: Reply) => (r.ok ? ((r.output["bars"] as unknown[][]).at(-1)?.[0] as string | undefined) : undefined);
		const nyMs = (at: string) => Date.parse(`${at.slice(0, 16).replace(" ", "T")}:00-05:00`);
		const dataAt = quote.ok ? String((quote.output["quotes"] as Record<string, unknown>[])[0]?.["at"]) : "";
		const gapMin = lastOf(minute) && dataAt ? Math.abs(nyMs(dataAt) - nyMs(lastOf(minute)!)) / 60_000 : Infinity;
		const minuteBars = minute.ok ? (minute.output["bars"] as unknown[][]) : [];
		const vwapOk = minuteBars.length > 0 && minuteBars.every((b) => typeof b[6] === "number") && minute.ok && typeof (minute.output["dayVwap"] as { vwap?: number } | null)?.vwap === "number";
		const hourBars = hour.ok ? (hour.output["bars"] as unknown[][]) : [];
		const brief = (r: Reply) => (r.ok ? JSON.stringify({ ...r.output, bars: `${(r.output["bars"] as unknown[]).length} bars`, first: (r.output["bars"] as unknown[])[0], last: (r.output["bars"] as unknown[]).at(-1) }) : r.note);
		return {
			pass: minuteBars.length > 0 && hourBars.length > 0 && gapMin <= 20 && vwapOk,
			evidence: `real Massive, asked at ${asked.toISOString()}\nNVDA minute (today by default): ${brief(minute)}\nSPY hour: ${brief(hour)}\nNVDA quote data time ${dataAt}; newest minute bar ${lastOf(minute)}; gap ${gapMin} min (rule: at most 20)\nevery minute bar has a VWAP and the day VWAP is a number: ${vwapOk}`,
		};
	});

	await lane(10, "doc", async () => {
		const doc = readFileSync(join(HEAD, "docs/modules/stock-ta.md"), "utf8");
		const section = /## 联网的工具和密钥\n([\s\S]*?)\n## /.exec(doc)?.[1] ?? "";
		const checks: Record<string, boolean> = {
			"quote and intraday reach the network, read only": /`quote` 和 `intraday` 现查 Massive，只读/.test(section),
			"the key they use": /POLYGON_API_KEY/.test(section),
			"requests per call": /`quote`。\*\* 每次一个快照请求/.test(section) && /`intraday`。\*\* 每次一个分钟聚合请求/.test(section),
			"the quotes feed, both tools and the scan share one key": /报价 feed[\s\S]*`scan` feed[\s\S]*`quote` 和 `intraday`[\s\S]*共用这一把 `POLYGON_API_KEY`/.test(section),
		};
		return { pass: Object.values(checks).every(Boolean), evidence: `${Object.entries(checks).map(([k, v]) => `${v ? "ok  " : "FAIL"} ${k}`).join("\n")}\n\ndocs/modules/stock-ta.md, 联网的工具和密钥:\n${section}` };
	});

	await lane("perf-intraday", "perf-intraday", async () => {
		if (KEY === "") return { pass: "inconclusive", evidence: "no POLYGON_API_KEY" };
		const times: number[] = [];
		const notes: string[] = [];
		let bars = 0;
		for (let i = 0; i < 20; i++) {
			const started = performance.now();
			const r = await intraday(pkgOf(HEAD), { symbol: "NVDA", span: "minute" });
			times.push(performance.now() - started);
			if (!r.ok) notes.push(`${i + 1}: ${r.note}`);
			else bars = (r.output["bars"] as unknown[]).length;
		}
		const refusals: number[] = [];
		for (let i = 0; i < 5; i++) {
			const started = performance.now();
			await intraday(pkgOf(HEAD), { symbol: "NVDA", span: "minute", limit: 600 });
			refusals.push(performance.now() - started);
		}
		const limited = notes.filter((n) => /429/.test(n)).length;
		return {
			pass: notes.length === 0 && median(times) <= 3000 && Math.max(...times) <= 18_000,
			evidence: `20 intraday calls for NVDA's minute bars today against real Massive (${bars} bars each), each a fresh node process as the host runs it (rule: median over 3 s or any over 18 s fails)\nmedian ${Math.round(median(times))} ms, min ${Math.round(Math.min(...times))}, max ${Math.round(Math.max(...times))}, spread ${Math.round(Math.max(...times) - Math.min(...times))} ms\nruns ${times.map((t) => Math.round(t)).join(" ")}\nprocess start and input check without a request (limit 600, refused before fetch), 5 runs: median ${Math.round(median(refusals))} ms\n429 replies ${limited}; failures: ${notes.join("; ") || "none"}`,
		};
	});
}

async function page(): Promise<void> {
	await lane(2, "team", async () => {
		const state = temp();
		installPackage(state, HEAD, "http://127.0.0.1:9");
		const fake = await FakeModel.start({ router: [] });
		let host: Host | undefined;
		const file = join(outDir, "r2b-team.png");
		try {
			host = await harness.startHost({ models: harness.fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0, modulesDirs: [join(state, "modules")] }, env: fakeAgentEnv(fake, join(state, "pi")), timeoutMs: 60_000 });
			just(state, ["module", "on", "stock-ta"]);
			await within(30_000, () => (query(join(state, "state.db"), "SELECT record FROM module_records WHERE name = 'stock-ta'").some((r) => JSON.parse(String(r["record"])).state.at === "active") ? true : undefined));
			const listing = `${just(state, ["modules"]).out}\n${just(state, ["module", "check", join(state, "modules/stock-ta")]).out}`;
			const browser = await chromium.launch();
			let card = "";
			try {
				const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
				await page.goto(host.url.href);
				await harness.showScreen(page, "overview");
				await page.locator("#tab-modules").click();
				await page.locator('#modules .module-row.ok[data-module="stock-ta"]').waitFor({ timeout: 20_000 });
				await page.locator("#modules .more").click();
				const details = page.locator('#modules .card.module[data-module="stock-ta"]');
				await details.waitFor({ timeout: 20_000 });
				card = await details.innerText();
				await page.screenshot({ path: file, fullPage: true });
			} finally {
				await browser.close();
			}
			const scanned = scanPackage(join(state, "modules/stock-ta"));
			const agents = scanned.ok ? scanned.scan.components.filter((c: { kind: string }) => c.kind === "agents").map((c: { agent: { name: string; title: string; uses: string[] } }) => c.agent) : [];
			const desk = agents.find((a: { name: string }) => a.name === "market-desk");
			return {
				pass: /agents=6/.test(listing) && /成员 6/.test(card) && agents.length === 6 && JSON.stringify(desk?.uses) === JSON.stringify(["tools/quote", "tools/intraday", "tools/prices", "tools/note"]) && existsSync(file),
				evidence: `just modules:\n${listing.replace(/状态目录 \S+/, "状态目录 <tmp>")}\n\nweb page module panel:\n${card}\nscreenshot ${file}\n\nthe installed package's members:\n${agents.map((a: { name: string; title: string; uses: string[] }) => `${a.title} (${a.name}): ${a.uses.join(", ")}`).join("\n")}`,
			};
		} finally {
			await host?.stop();
			await fake.close();
		}
	});
}

/** setup + one scan, once per outDir; every run clones its data dir. */
async function seed(): Promise<string> {
	const data = join(SEED, "modules-data/stock-ta");
	if (existsSync(join(data, "files/ta/ta.sqlite"))) return SEED;
	if (KEY === "") throw new Error("the seed scan needs POLYGON_API_KEY");
	mkdirSync(SEED, { recursive: true });
	installPackage(SEED, HEAD);
	const setup = just(SEED, ["module", "setup", "stock-ta"]);
	if (setup.status !== 0) throw new Error(`just module setup stock-ta: ${setup.out}`);
	const modules = servedAsHost(Modules.load([join(SEED, "modules")]));
	const entry = modules.feeds().find((e: { source: string }) => e.source === "stock-ta/scan");
	const rows = instanceData(SEED);
	rows.write("stock-ta", entry.components, "watchlist", [{ symbol: "NVDA" }, { symbol: "AMD" }], "使用者口述", "r2b-live");
	const run = await runFeed(entry, [], { data: rows, submit: () => {}, alert: () => {}, problem: () => {}, secret: (name: string) => (name === "POLYGON_API_KEY" ? KEY : undefined), now: () => Date.now(), limitMs: 300_000 });
	if (!existsSync(join(data, "files/ta/ta.sqlite"))) throw new Error(`the seed scan did not swap in a database: ${JSON.stringify(run)}`);
	writeFileSync(join(SEED, "seed.txt"), `scan ${JSON.stringify(run)}\n`);
	return SEED;
}

function seededState(tree: string): string {
	const state = mkdtempSync(join(tmpdir(), "psa-r2b-real-"));
	mkdirSync(join(state, "modules-data"), { recursive: true });
	if (spawnSync("cp", ["-cR", join(SEED, "modules-data/stock-ta"), join(state, "modules-data/stock-ta")]).status !== 0) throw new Error("could not clone the seed data dir");
	installPackage(state, tree);
	return state;
}

type Real = { state: string; host: Host; tg: Telegram; close(): Promise<void> };

async function realHost(tree: string): Promise<Real> {
	await seed();
	const state = seededState(tree);
	const tg = await FakeTelegram.start();
	writeFileSync(join(state, "secrets.env"), `POLYGON_API_KEY=${KEY}\nTELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`, { mode: 0o600 });
	just(state, ["module", "off", "us-market"], tree);
	const host = await harness.startHost({
		models: REAL, stateDir: state, logFile: join(state, "host.log"), repo: tree, timeoutMs: 60_000,
		config: { webPort: 0, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } },
		env: { PSA_E2E_TELEGRAM_URL: tg.url }, imports: ["./tests/e2e/telegram-preload.mjs"],
	});
	just(state, ["module", "on", "stock-ta"], tree);
	const on = await within(30_000, () => (query(join(state, "state.db"), "SELECT record FROM module_records WHERE name = 'stock-ta'").some((r) => JSON.parse(String(r["record"])).state.at === "active") ? true : undefined));
	if (!on) throw new Error("stock-ta did not turn on");
	return { state, host, tg, close: async () => { await host.stop(); await tg.close(); } };
}

const idle = (real: Real, limitMs = 600_000) => within(limitMs, () => (query(join(real.state, "state.db"), "SELECT 1 FROM tickets WHERE worker_state IN ('queued', 'running')").length === 0 ? true : undefined), 1000);
const ticketsOf = (state: string) => query(join(state, "state.db"), "SELECT id, title, domain, dispatched_to, worker_state FROM tickets ORDER BY rowid");
const hostLog = (state: string) => readFileSync(join(state, "host.log"), "utf8").split("\n");

/** Each member's last reply, read from the lead's session: the lead may reword it in the report. */
function memberReplies(state: string): { member: string; text: string }[] {
	const dir = join(state, "sessions/workers");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").flatMap((l) => {
		const m = JSON.parse(l).message;
		if (m?.role !== "toolResult" || m.toolName !== "dispatch_agent") return [];
		const text = (m.content ?? []).map((p: { text?: string }) => p.text ?? "").join("");
		return [{ member: String(m.details?.agent ?? /agent[":\s]+([\w-]+)/.exec(text)?.[1] ?? "?"), text }];
	}));
}

async function askDesk(real: Real, question: string) {
	const before = ticketsOf(real.state).length;
	const t0 = Date.now();
	real.tg.userSays(USER, question);
	await within(60_000, () => (ticketsOf(real.state).length > before ? true : undefined), 500);
	await idle(real);
	const tickets = ticketsOf(real.state).slice(before);
	const ids = new Set(tickets.map((t) => t["id"]));
	const ready = query(join(real.state, "state.db"), "SELECT ticket_id, summary FROM reports WHERE status = 'ready' ORDER BY seq").filter((r) => ids.has(r["ticket_id"]));
	return { ms: Date.now() - t0, tickets, summary: ready.map((r) => String(r["summary"])).join("\n---\n") };
}

const deskQuestions = [DESK_Q, "AMD 今天的涨跌和半导体板块比怎么样", "QQQ 今天什么时候跌得最快"];

async function feed(): Promise<void> {
	if (KEY === "") throw new Error("feed needs POLYGON_API_KEY");
	const trunk = trunkTree();
	const real = await realHost(HEAD);
	const t0 = Date.now();
	const rounds: { tree: string; ms: number; ok: boolean; note?: string }[] = [];
	const probe = (async () => {
		for (let i = 0; i < 10; i++) {
			for (const [name, tree] of [["trunk", trunk], ["head", HEAD]] as const) {
				const state = temp();
				installPackage(state, tree);
				const modules = servedAsHost(Modules.load([join(state, "modules")]));
				const entry = modules.feeds().find((e: { source: string }) => e.source === "stock-ta/quotes");
				const rows = instanceData(state);
				rows.write("stock-ta", entry.components, "watchlist", ["NVDA", "AMD", "SPY", "QQQ", "AAPL", "MSFT", "META", "AMZN", "GOOGL"].map((symbol) => ({ symbol })), "使用者口述", "r2b-live");
				const started = performance.now();
				const run = await runFeed(entry, [], { data: rows, submit: () => {}, alert: () => {}, problem: () => {}, secret: () => KEY, now: () => Date.now() });
				rounds.push({ tree: name, ms: performance.now() - started, ok: run.ok, ...(run.ok ? {} : { note: run.note }) });
			}
			await sleep(20_000);
		}
	})();
	const answers: Awaited<ReturnType<typeof askDesk>>[] = [];
	try {
		for (const q of deskQuestions) answers.push(await askDesk(real, q));
		await probe;
	} finally {
		await real.close();
	}
	const elapsedMin = (Date.now() - t0) / 60_000;
	const log = hostLog(real.state);
	const feedLines = log.filter((l) => l.includes("[feeds] stock-ta/quotes"));
	const okRounds = feedLines.filter((l) => /：\d+ 行/.test(l));
	const at = okRounds.map((l) => Date.parse(l.slice(0, 24)));
	const gaps = at.slice(1).map((t, i) => (t - at[i]!) / 1000);
	const toolErrors = log.filter((l) => /429/.test(l));
	const deskUsed = log.filter((l) => / stock-ta tools\/(quote|intraday) /.test(l));
	const toolLimited = answers.filter((a) => /429/.test(a.summary)).length;
	const probe429 = rounds.filter((r) => /429/.test(r.note ?? "")).length;
	await lane(7, "shared-key", async () => ({
		pass: okRounds.length >= Math.floor(elapsedMin) - 1 && gaps.every((g) => g < 125) && toolErrors.length === 0 && toolLimited === 0 && probe429 === 0 && deskUsed.length > 0,
		evidence: `a real host on head ${shaOf(HEAD)}, stock-ta on, quotes feed every 60 s against real Massive; the 盘面 answered ${deskQuestions.length} questions meanwhile; trunk/head quotes rounds ran beside it (another ${rounds.length} snapshot requests)\nwindow ${elapsedMin.toFixed(1)} min, quotes feed rounds ok ${okRounds.length}, failed ${feedLines.length - okRounds.length}, largest gap ${Math.max(0, ...gaps).toFixed(0)} s (rule: no missed round)\n429 in the host log ${toolErrors.length}, in reports ${toolLimited}, in the probe rounds ${probe429}\nquote and intraday calls:\n${deskUsed.join("\n")}\n\n${answers.map((a, i) => `== ${deskQuestions[i]} (${secs(a.ms)})\ntickets ${show(a.tickets)}\n${a.summary}`).join("\n\n")}\n\nfeed lines:\n${feedLines.join("\n")}`,
	}));
	await lane("perf-feed", "perf-feed", async () => {
		const ms = (tree: string) => rounds.filter((r) => r.tree === tree && r.ok).map((r) => r.ms);
		const line = (tree: string) => `${tree}: median ${Math.round(median(ms(tree)))} ms, min ${Math.round(Math.min(...ms(tree)))}, max ${Math.round(Math.max(...ms(tree)))}, runs ${ms(tree).map((x) => Math.round(x)).join(" ")}, failed ${rounds.filter((r) => r.tree === tree && !r.ok).length}, 429 ${rounds.filter((r) => r.tree === tree && /429/.test(r.note ?? "")).length}`;
		const slower = median(ms("head")) - median(ms("trunk"));
		const t429 = rounds.filter((r) => r.tree === "trunk" && /429/.test(r.note ?? "")).length;
		const h429 = rounds.filter((r) => r.tree === "head" && /429/.test(r.note ?? "")).length;
		return {
			pass: slower <= 50 && h429 <= t429 && ms("head").length === 10 && ms("trunk").length === 10,
			evidence: `quotes feed round (9 symbols, one real snapshot request), trunk ${shaOf(trunk)} and head ${shaOf(HEAD)} alternating 10 each, 20 s apart, while the 盘面 answered questions on a real host (rule: head over 50 ms slower than trunk, or more 429 than trunk, fails)\n${line("trunk")}\n${line("head")}\nhead minus trunk median ${Math.round(slower)} ms\n429 per hour over this ${elapsedMin.toFixed(1)} min window: host ${(toolErrors.length / elapsedMin * 60).toFixed(1)}, trunk rounds ${t429}, head rounds ${h429}`,
		};
	});
	await lane("perf-desk", "perf-desk", async () => ({
		pass: true,
		evidence: `time from the user's line to the 盘面 ticket going idle, head only, three questions (no trunk: trunk has no 盘面)\n${answers.map((a, i) => `${deskQuestions[i]}: ${secs(a.ms)}`).join("\n")}\nmedian ${secs(median(answers.map((a) => a.ms)))}`,
	}));
}

const NEWS = /新闻|报道|财报|业绩|分析师|据.*消息|利好|利空/;
const PCT = /[+-−]?\d+(\.\d+)?%/;

async function realLanes(): Promise<void> {
	await seed();
	await lane(8, "eval", async () => {
		const state = seededState(HEAD);
		writeFileSync(join(state, "secrets.env"), `POLYGON_API_KEY=${KEY}\n`, { mode: 0o600 });
		writeFileSync(join(state, "config.json"), JSON.stringify({ models: REAL, secretsFile: "secrets.env" }));
		const run = just(state, ["module", "try", join(state, "modules/stock-ta")], HEAD, {}, 1_200_000);
		const block = /(PASS|FAIL) market-desk[\s\S]*?(?=\n(PASS|FAIL) |\n\d+\/\d+ 道考题)/.exec(run.out)?.[0] ?? "";
		const checks: Record<string, boolean> = {
			"the rehearsal judged market-desk PASS (stock-ta ticket, used quote and intraday, SPY and 数据时间 in the report)": /^PASS market-desk/.test(block),
			"three parts: 结论, 证据, 数据时间": ["结论", "证据", "数据时间"].every((h) => block.includes(h)),
			"relative to SPY and the sector ETF, with differences": /SPY/.test(block) && /SMH|XLK|SOXX/.test(block) && /差/.test(block) && PCT.test(block),
			"no news or earnings claims": !NEWS.test(block.replace(/不(读|看|找)[^，。]*(新闻|财报)[^，。]*/g, "").replace(/原因不在行情数据里/g, "")),
		};
		return { pass: Object.values(checks).every(Boolean), evidence: `just module try (openai-codex models ${JSON.stringify(REAL)}, real Massive)\nchecks:\n${Object.entries(checks).map(([k, v]) => `${v ? "ok  " : "FAIL"} ${k}`).join("\n")}\n\nfull output:\n${run.out.replace(/临时状态目录 \S+/, "临时状态目录 <tmp>")}` };
	});

	await oldQuestion();
}

async function oldQuestion(): Promise<void> {
	await seed();
	await lane(9, "old-question", async () => {
		const real = await realHost(HEAD);
		try {
			const a = await askDesk(real, "NVDA 的支撑在哪");
			// The seeded watchlist holds AMD, so a big-move ticket can open beside the question's own.
			const sent = a.tickets.filter((t) => String(t["title"]).includes("NVDA")).flatMap((t) => (t["dispatched_to"] ? (JSON.parse(String(t["dispatched_to"])) as string[]) : []));
			return {
				pass: sent.includes("结构与形态") && !sent.includes("盘面"),
				evidence: `asked on the fake Telegram: NVDA 的支撑在哪 (${secs(a.ms)})\ntickets:\n${show(a.tickets)}\ndispatched to: ${sent.join(", ") || "(nobody)"}\nreport:\n${a.summary}`,
			};
		} finally {
			await real.close();
		}
	});
}

async function media(): Promise<void> {
	const real = await realHost(HEAD);
	const browser = await chromium.launch();
	try {
		const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		await page.goto(real.host.url.href);
		await page.waitForTimeout(1500);
		await harness.sayInPage(page, MEDIA_Q, { typeDelayMs: 40 });
		await within(60_000, () => (ticketsOf(real.state).length > 0 ? true : undefined), 500);
		await idle(real);
		await page.waitForTimeout(3000);
		await page.screenshot({ path: join(outDir, "r2b-review-desk.png"), fullPage: true });
		const tickets = ticketsOf(real.state);
		const summary = query(join(real.state, "state.db"), "SELECT summary FROM reports WHERE status = 'ready' ORDER BY seq").map((r) => String(r["summary"])).join("\n---\n");
		const members = memberReplies(real.state);
		const web = query(join(real.state, "state.db"), "SELECT id, read_web_at FROM tickets WHERE read_web_at IS NOT NULL");
		writeFileSync(join(outDir, "r2b-review-desk.txt"), `asked on the web page: ${MEDIA_Q}\ntickets that read a web page: ${show(web)}\ntickets:\n${show(tickets)}\nreport:\n${summary}\n\nmember replies:\n${members.map((m) => `[${m.member}]\n${m.text}`).join("\n\n")}\n\ngateway:\n${hostLog(real.state).filter((l) => l.includes("[gateway]")).join("\n")}\n`);
		console.log(`media in ${outDir}: r2b-review-desk.png, r2b-review-desk.txt`);
	} finally {
		await browser.close();
		await real.close();
	}
}

await (mode === "old" ? oldQuestion() : mode === "replay" ? regression() : mode === "page" ? page() : mode === "feed" ? feed() : mode === "real" ? realLanes() : mode === "media" ? media() : tools());
process.exit(0);
