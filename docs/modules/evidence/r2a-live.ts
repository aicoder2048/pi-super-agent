/**
 *   R2A_SECRETS=<host secrets .env> node --import ./src/pi-runtime.mjs docs/modules/evidence/r2a-live.ts [tools|real|news|page|media|perf] [outDir]
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/r2a-live.ts web <stateDir>
 *
 * R2A_SECRETS names a .env file the script reads POLYGON_API_KEY from; the environment wins over the file. Nothing prints a value.
 *
 * tools  Lanes 2 to 6 replay tools/quote/fixtures through a local server standing in for Massive (lane 2 through a
 *        host on the fake model), lane 8 asks real Massive once, and the quote probe calls real Massive 20 times.
 * real   Lanes 1, 7, 9 and 10 on openai-codex models through the Pi login in ~/.pi/agent, with a fake Telegram.
 *        Lane 1 asks trunk (a detached worktree of origin/main at <outDir>/trunk) and head alternately, five times
 *        each, which is also the perf probe. Every run starts from one seed data dir (`just module setup stock-ta`
 *        and one scan of NVDA and AMD, about 12 Massive requests), so trunk's experts have data as on the old Mac.
 * news   Lane 9 alone. Its last check asks the follow-up the stock-ta report suggests, alone on a fresh host.
 * perf   The price question on head only, three fresh hosts.
 * web    Lane 9's check 4 alone, on a state dir a news run left behind: node … r2a-live.ts web <stateDir>
 * page   Lane 7 alone: a real host on head answers the price question and the page is screenshotted.
 * media  The review screenshots and video: a real host on head answers a price question and a mixed one.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const USER = 42;
const PRICE_Q = "NVDA 现在多少";
const [mode = "tools", outDir = "/tmp/swarm-r2a/owner"] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
const SEED = join(outDir, "seed");
mkdirSync(outDir, { recursive: true });

const { readSecret } = await import(join(HEAD, "src/secrets.ts"));
const { runModuleCodeAsync } = await import(join(HEAD, "src/modules/run-code.ts"));
const { Modules } = await import(join(HEAD, "src/modules.ts"));
const { runFeed } = await import(join(HEAD, "src/modules/feed-runner.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
const { servedAsHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
const harness = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, domainTool, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
const { chromium } = await import("playwright-core");
type Host = Awaited<ReturnType<typeof harness.startHost>>;
type Telegram = InstanceType<typeof FakeTelegram>;
type Reply = { ok: true; output: { quotes: Record<string, unknown>[]; missing: string[] } } | { ok: false; note: string };
type Fixture = { about: string; now: string; symbols: string[]; snapshot: unknown };

const KEY = readSecret(["POLYGON_API_KEY"], "POLYGON_API_KEY", process.env, process.env["R2A_SECRETS"])?.key ?? "";
const pkgOf = (tree: string) => join(tree, "docs/modules/examples/stock-ta");
const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(pkgOf(HEAD), "tools/quote/fixtures", `${name}.json`), "utf8"));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const show = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") || "(none)";
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function just(state: string, args: string[], tree = HEAD, limitMs = 300_000) {
	const run = spawnSync("just", args, { cwd: tree, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300" }, encoding: "utf8", timeout: limitMs });
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

async function fakeMassive(body: () => unknown) {
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

const quote = (pkg: string, input: unknown, key = KEY): Promise<Reply> =>
	runModuleCodeAsync({ packageDir: pkg, component: "tools/quote", dataDir: mkdtempSync(join(tmpdir(), "psa-r2a-data-")) }, "index.ts", input, key === "" ? {} : { POLYGON_API_KEY: key });

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
	const file = join(outDir, `r2a-${slug}.txt`);
	writeFileSync(file, `${word} lane ${n}\n${verdict.evidence.replaceAll(KEY || "\0", "<key>").replaceAll(tmpdir(), "<tmp>")}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

async function replay(name: string) {
	const fx = fixture(name);
	const massive = await fakeMassive(() => fx.snapshot);
	const state = mkdtempSync(join(tmpdir(), "psa-r2a-"));
	try {
		const reply = await quote(installPackage(state, HEAD, massive.base), { symbols: fx.symbols.join(","), now: fx.now }, "fixture-key");
		return { fx, reply, urls: massive.urls, text: `fixture ${name}: ${fx.about}\nnow ${fx.now}\nrequests: ${massive.urls.join(" ")}\nreply: ${JSON.stringify(reply)}` };
	} finally {
		await massive.close();
	}
}

const quotesOf = (reply: Reply) => (reply.ok ? reply.output.quotes : []);

async function tools(): Promise<void> {
	await lane(2, "watchlist", async () => {
		const fx = fixture("regular");
		const massive = await fakeMassive(() => fx.snapshot);
		const state = mkdtempSync(join(tmpdir(), "psa-r2a-"));
		installPackage(state, HEAD, massive.base);
		writeFileSync(join(state, "secrets.env"), "POLYGON_API_KEY=fixture-key\n", { mode: 0o600 });
		const brief = "NVDA 现价";
		const fake = await FakeModel.start({
			router: [
				on("开任务", /^\[对话\][\s\S]*NVDA 现在多少/, (c: string) => {
					const open = openTicket(c, brief);
					return [{ ...open, args: { decisions: (open.args.decisions as object[]).map((d) => ({ ...d, domain: "stock-ta" })) } }];
				}),
				on("转告", /^\[Worker 汇报\]/, (c: string) => [reply(c, c.split("\n").slice(-1)[0] ?? "")]),
			],
			workers: [worker(brief, on("调 quote", /^\[任务说明\]/, () => [domainTool("quote", { symbols: "NVDA", now: fx.now })]), on("汇报", /^\[模块工具\]/, (c: string) => [report("ready", c)]))],
		});
		let host: Host | undefined;
		try {
			host = await harness.startHost({ models: harness.fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0, secretsFile: "secrets.env", modulesDirs: [join(state, "modules")] }, env: fakeAgentEnv(fake, join(state, "pi")), timeoutMs: 60_000 });
			just(state, ["module", "on", "stock-ta"]);
			await within(30_000, () => (query(join(state, "state.db"), "SELECT record FROM module_records WHERE name = 'stock-ta'").some((r) => JSON.parse(String(r["record"])).state.at === "active") ? true : undefined));
			just(state, ["say", PRICE_Q]);
			const summary = await within(60_000, () => query(join(state, "state.db"), "SELECT summary FROM reports WHERE status = 'ready'").at(0)?.["summary"] as string | undefined);
			const ticket = query(join(state, "state.db"), "SELECT domain, dispatched_to FROM tickets").at(0);
			const gateway = readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[gateway]"));
			const quoted = JSON.parse(/\{"quotes"[\s\S]*\}/.exec(summary ?? "")?.[0] ?? "{}")?.quotes?.[0] ?? {};
			return {
				pass: quoted.price === 180.4 && quoted.prevClose === 176 && quoted.changePct === 2.5 && quoted.at === "2026-11-12 10:44 美东" && quoted.session === "盘中" && ticket?.["domain"] === "stock-ta" && massive.urls.length === 1,
				evidence: `fixture regular: ${fx.about}\nthe fake Worker called domain_tool quote {symbols: NVDA, now: ${fx.now}} through a real host; the key came from the host's secrets file\nticket: ${JSON.stringify(ticket)}\nrequests to the stand-in Massive: ${massive.urls.join(" ")}\ngateway:\n${gateway.join("\n")}\nreport:\n${summary}`,
			};
		} finally {
			await host?.stop();
			await fake.close();
			await massive.close();
		}
	});

	await lane(3, "off-list", async () => {
		const run = await replay("off-list");
		const got = quotesOf(run.reply);
		return { pass: got.length === 2 && got.every((q) => typeof q["price"] === "number" && q["session"] === "盘中") && run.reply.ok && run.reply.output.missing.length === 0, evidence: `the watchlist is not read: the tool asks Massive for exactly the symbols given\n${run.text}` };
	});

	await lane(4, "after-hours", async () => {
		const run = await replay("after-hours");
		const [q] = quotesOf(run.reply);
		return { pass: run.reply.ok && q?.["price"] === 183.05 && q?.["session"] === "盘后" && q?.["at"] === "2026-11-12 17:30 美东", evidence: run.text };
	});

	await lane(5, "closed", async () => {
		const saturday = await replay("saturday");
		const holiday = await replay("holiday");
		const [sat] = quotesOf(saturday.reply);
		const [hol] = quotesOf(holiday.reply);
		return {
			pass: sat?.["session"] === "休市" && sat?.["at"] === "2026-11-13 19:59 美东" && sat?.["price"] === 182.1 && hol?.["session"] === "休市" && hol?.["at"] === "2026-11-25 19:59 美东" && hol?.["price"] === 190.5,
			evidence: `the price is the last one of the previous trading day, with that day's data time\n${saturday.text}\n\n${holiday.text}`,
		};
	});

	await lane(6, "limits", async () => {
		const massive = await fakeMassive(() => fixture("regular").snapshot);
		const state = mkdtempSync(join(tmpdir(), "psa-r2a-"));
		try {
			const pkg = installPackage(state, HEAD, massive.base);
			const eleven = await quote(pkg, { symbols: "NVDA,AMD,SPY,QQQ,META,TSM,AAPL,AMZN,MSFT,GOOGL,AVGO" }, "fixture-key");
			const keyless = await quote(pkg, { symbols: "NVDA" }, "");
			const oneLine = (r: Reply) => !r.ok && r.note.split("\n").length === 1;
			return {
				pass: oneLine(eleven) && !eleven.ok && /最多 10 个/.test(eleven.note) && oneLine(keyless) && !keyless.ok && /POLYGON_API_KEY/.test(keyless.note) && massive.urls.length === 0,
				evidence: `11 symbols: ${JSON.stringify(eleven)}\nno POLYGON_API_KEY: ${JSON.stringify(keyless)}\nrequests to the stand-in Massive: ${massive.urls.length}`,
			};
		} finally {
			await massive.close();
		}
	});

	await lane(8, "real", async () => {
		if (KEY === "") return { pass: "inconclusive", evidence: "no POLYGON_API_KEY in the environment or R2A_SECRETS" };
		const started = performance.now();
		const reply = await quote(pkgOf(HEAD), { symbols: "NVDA,SPY,QQQ,META,TSM" });
		const took = performance.now() - started;
		const got = quotesOf(reply);
		const latest = Math.max(...got.map((q) => Date.parse(`${String(q["at"]).slice(0, 16).replace(" ", "T")}:00-05:00`)));
		const fresh = Date.now() - latest < 4 * 86_400_000;
		return {
			pass: got.length === 5 && got.every((q) => typeof q["price"] === "number" && typeof q["changePct"] === "number" && ["盘中", "盘前", "盘后", "休市"].includes(String(q["session"]))) && fresh,
			evidence: `real Massive, one snapshot request for NVDA,SPY,QQQ,META,TSM, ${Math.round(took)} ms host-side\nasked at ${new Date().toISOString()}\nnewest data time within the last 4 days: ${fresh}\n${got.map((q) => JSON.stringify(q)).join("\n")}\nmissing: ${reply.ok ? reply.output.missing.join(",") || "none" : reply.note}`,
		};
	});

	await lane("perf-quote", "perf-quote", async () => {
		if (KEY === "") return { pass: "inconclusive", evidence: "no POLYGON_API_KEY" };
		const times: number[] = [];
		const notes: string[] = [];
		for (let i = 0; i < 20; i++) {
			const started = performance.now();
			const reply = await quote(pkgOf(HEAD), { symbols: "NVDA" });
			times.push(performance.now() - started);
			if (!reply.ok) notes.push(`${i + 1}: ${reply.note}`);
		}
		const noop = await (async () => {
			const xs: number[] = [];
			for (let i = 0; i < 5; i++) {
				const started = performance.now();
				await quote(pkgOf(HEAD), { symbols: "A,B,C,D,E,F,G,H,I,J,K" });
				xs.push(performance.now() - started);
			}
			return xs;
		})();
		return {
			pass: notes.length === 0 && median(times) <= 3000 && Math.max(...times) <= 18_000,
			evidence: `20 quote calls for NVDA against real Massive, each a fresh node process as the host runs it (rule: median over 3 s or any over 18 s fails)\nmedian ${Math.round(median(times))} ms, min ${Math.round(Math.min(...times))}, max ${Math.round(Math.max(...times))}, spread ${Math.round(Math.max(...times) - Math.min(...times))} ms\nruns ${times.map((t) => Math.round(t)).join(" ")}\nprocess start and input check without a request (11 symbols, refused before fetch), 5 runs: median ${Math.round(median(noop))} ms\nfailures: ${notes.join("; ") || "none"}`,
		};
	});
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
	rows.write("stock-ta", entry.components, "watchlist", [{ symbol: "NVDA" }, { symbol: "AMD" }], "使用者口述", "r2a-live");
	const run = await runFeed(entry, [], { data: rows, submit: () => {}, alert: () => {}, secret: (name: string) => (name === "POLYGON_API_KEY" ? KEY : undefined), now: () => Date.now(), limitMs: 300_000 });
	if (!existsSync(join(data, "files/ta/ta.sqlite"))) throw new Error(`the seed scan did not swap in a database: ${JSON.stringify(run)}`);
	writeFileSync(join(SEED, "seed.txt"), `scan ${JSON.stringify(run)}\nscan-runs:\n${show(query(join(data, "data.db"), "SELECT * FROM \"scan-runs\""))}\n`);
	return SEED;
}

type Real = { state: string; host: Host; tg: Telegram; tree: string; close(): Promise<void> };

async function realHost(tree: string, watch: string[] = []): Promise<Real> {
	const seeded = await seed();
	const state = mkdtempSync(join(tmpdir(), "psa-r2a-real-"));
	mkdirSync(join(state, "modules-data"), { recursive: true });
	const clone = spawnSync("cp", ["-cR", join(seeded, "modules-data/stock-ta"), join(state, "modules-data/stock-ta")]);
	if (clone.status !== 0) throw new Error("could not clone the seed data dir");
	installPackage(state, tree);
	if (watch.length > 0) {
		const modules = servedAsHost(Modules.load([join(state, "modules")]));
		instanceData(state).write("stock-ta", modules.feeds()[0].components, "watchlist", watch.map((symbol) => ({ symbol })), "使用者口述", "r2a-live");
	}
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
	return { state, host, tg, tree, close: async () => { await host.stop(); await tg.close(); } };
}

const PRICE = /\d{2,4}\.\d{1,2}/;
type Asked = { firstMs: number | undefined; answerMs: number | undefined; answer: string; sent: string[]; tickets: Record<string, unknown>[]; gateway: string[] };

async function ask(real: Real, text: string, done: (msg: string) => boolean, limitMs: number): Promise<Asked> {
	const before = real.tg.sent.length;
	const t0 = Date.now();
	real.tg.userSays(USER, text);
	const hit = await within(limitMs, () => real.tg.sent.slice(before).find((m: { chatId: number; text: string }) => m.chatId === USER && done(m.text)), 100);
	const mine = real.tg.sent.slice(before).filter((m: { chatId: number }) => m.chatId === USER);
	return {
		firstMs: mine[0] ? mine[0].at - t0 : undefined,
		answerMs: hit ? hit.at - t0 : undefined,
		answer: hit?.text ?? "",
		sent: mine.map((m: { at: number; text: string }) => `+${secs(m.at - t0)} ${m.text}`),
		tickets: query(join(real.state, "state.db"), "SELECT id, title, domain, dispatched_to FROM tickets ORDER BY rowid"),
		gateway: readFileSync(join(real.state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[gateway]")),
	};
}

async function screenshot(real: Real, file: string, wait: (page: import("playwright-core").Page) => Promise<unknown>): Promise<void> {
	const browser = await chromium.launch();
	try {
		const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		await page.goto(real.host.url.href);
		await wait(page);
		await page.screenshot({ path: file, fullPage: true });
	} finally {
		await browser.close();
	}
}

const asked = (a: Asked) => `first Telegram line after ${a.firstMs === undefined ? "never" : secs(a.firstMs)}, the answer after ${a.answerMs === undefined ? "never" : secs(a.answerMs)}\nTelegram:\n${a.sent.join("\n")}\ntickets:\n${show(a.tickets)}\ngateway:\n${a.gateway.join("\n")}`;

async function real(): Promise<void> {
	const trunk = trunkTree();
	const trunkSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: trunk, encoding: "utf8" }).stdout.trim();
	const headSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HEAD, encoding: "utf8" }).stdout.trim();
	const runs: { tree: "trunk" | "head"; a: Asked }[] = [];
	let first: Real | undefined;
	for (let i = 0; i < 5; i++) {
		for (const [name, tree] of [["trunk", trunk], ["head", HEAD]] as const) {
			const host = await realHost(tree);
			const a = await ask(host, PRICE_Q, (t) => PRICE.test(t), 300_000);
			runs.push({ tree: name, a });
			console.log(`run ${i + 1} ${name}: answer after ${a.answerMs === undefined ? "never" : secs(a.answerMs)}`);
			if (name === "head" && first === undefined) first = host;
			else await host.close();
		}
	}
	const times = (tree: string) => runs.filter((r) => r.tree === tree).map((r) => r.a.answerMs ?? Infinity);
	const head = runs.filter((r) => r.tree === "head");
	const quoted = (a: Asked) => a.gateway.some((l) => / stock-ta tools\/quote .* ok /.test(l));
	const noDispatch = (a: Asked) => a.tickets.every((t) => t["dispatched_to"] === null || t["dispatched_to"] === "[]");
	const timed = (a: Asked) => /\d{1,2}:\d{2}/.test(a.answer);
	const h1 = head[0]!.a;
	await lane(1, "regression", async () => ({
		pass: quoted(h1) && noDispatch(h1) && PRICE.test(h1.answer) && timed(h1) && h1.tickets.every((t) => t["domain"] === "stock-ta"),
		evidence: `trunk ${trunkSha}, head ${headSha}; both with us-market off and stock-ta on, seed data (NVDA, AMD scanned), models ${JSON.stringify(REAL)}\nasked on the fake Telegram: ${PRICE_Q}\n${runs.map((r, i) => `\n== run ${Math.floor(i / 2) + 1} ${r.tree}\n${asked(r.a)}`).join("\n")}`,
	}));
	await lane("perf", "perf", async () => {
		const t = median(times("trunk"));
		const h = median(times("head"));
		const line = (tree: string) => `${tree}: median ${secs(median(times(tree)))}, runs ${times(tree).map((x) => (Number.isFinite(x) ? secs(x) : "never")).join(", ")}, spread ${secs(Math.max(...times(tree)) - Math.min(...times(tree)))}`;
		return {
			pass: h <= 25_000 && h <= t && head.every((r) => quoted(r.a) && noDispatch(r.a)),
			evidence: `time from the user's line on the fake Telegram to the first Telegram line with a price, trunk and head alternating 5 each (rule: head median over 25 s or slower than trunk fails)\n${line("trunk")}\n${line("head")}\nevery head run called quote and dispatched no expert: ${head.every((r) => quoted(r.a) && noDispatch(r.a))}`,
		};
	});

	await lane(7, "no-dispatch", () => noDispatchPage(first!, h1));

	await news();

	await lane(10, "watchlist-edit", async () => {
		const host = await realHost(HEAD, ["AMZN", "AAPL"]);
		const watchlist = () => query(join(host.state, "modules-data/stock-ta/data.db"), "SELECT _id, symbol, removedAt, _from FROM watchlist ORDER BY _id");
		let a: Asked;
		try {
			a = await ask(host, "从自选股去掉 AMZN 和 AAPL", () => false, 1000);
			await within(300_000, () => (["AMZN", "AAPL"].every((s) => watchlist().some((r) => r["symbol"] === s && r["removedAt"])) ? true : undefined), 1000);
			await within(120_000, () => (host.tg.sent.filter((m: { chatId: number }) => m.chatId === USER).length > 0 ? true : undefined), 1000);
		} finally {
			await host.close();
		}
		const rows = watchlist();
		const massive = await fakeMassive(() => ({ status: "OK", tickers: [] }));
		try {
			const copy = mkdtempSync(join(tmpdir(), "psa-r2a-"));
			installPackage(copy, HEAD, massive.base);
			const modules = servedAsHost(Modules.load([join(copy, "modules")]));
			const entry = modules.feeds().find((e: { source: string }) => e.source === "stock-ta/quotes");
			const round = await runFeed(entry, [], { data: instanceData(host.state), submit: () => {}, alert: () => {}, secret: () => "fixture-key", now: () => Date.now() });
			const tickets = query(join(host.state, "state.db"), "SELECT title, domain, dispatched_to FROM tickets ORDER BY rowid");
			const asked = massive.urls.at(-1) ?? "";
			return {
				pass: tickets.some((t) => t["domain"] === "stock-ta") && ["AMZN", "AAPL"].every((s) => rows.some((r) => r["symbol"] === s && r["removedAt"])) && /tickers=AMD,NVDA$/.test(asked),
				evidence: `watchlist before: NVDA, AMD (seed) plus AMZN, AAPL\nsaid on the fake Telegram: 从自选股去掉 AMZN 和 AAPL\nTelegram:\n${host.tg.sent.filter((m: { chatId: number }) => m.chatId === USER).map((m: { text: string }) => m.text).join("\n")}\ntickets:\n${show(tickets)}\nwatchlist after:\n${show(rows)}\nthe next quotes round (run once against a stand-in Massive): ${JSON.stringify(round)}, request ${asked}`,
			};
		} finally {
			await massive.close();
		}
	});
}

const PERCENT = /\d+(\.\d+)?%/;
const CAUSE = /因为|由于|导致|源于|影响|拖累|打压|利空|利好/;
const FOLLOW_UP = /可以问「([^」]+)」/;

/** Every way a stock-ta ticket reached the web: `read_web_at` (any `web_get`, lead or member) and the lead's bash calls that name a URL or a fetcher. */
function webReads(state: string): string[] {
	const tickets = query(join(state, "state.db"), "SELECT id, worker_session_id, read_web_at FROM tickets WHERE domain = 'stock-ta'");
	const dir = join(state, "sessions/workers");
	const files = existsSync(dir) ? readdirSync(dir) : [];
	return tickets.flatMap((t) => {
		const reads = t["read_web_at"] === null ? [] : [`${t["id"]} read a web page (read_web_at ${t["read_web_at"]})`];
		const session = files.find((f) => f.endsWith(`_${t["worker_session_id"]}.jsonl`));
		const lines = session ? readFileSync(join(dir, session), "utf8").trim().split("\n") : [];
		const calls = lines.flatMap((l) => {
			const content = JSON.parse(l).message?.content;
			return Array.isArray(content) ? content.filter((p: { type: string; name: string }) => p.type === "toolCall" && p.name === "bash") : [];
		});
		const fetched = calls.map((c: { arguments: { command?: string } }) => String(c.arguments.command ?? "")).filter((cmd: string) => /https?:\/\/|\bcurl\b|\bwget\b/.test(cmd));
		return [...reads, ...fetched.map((cmd: string) => `${t["id"]} lead ran: ${cmd.slice(0, 120)}`)];
	});
}

const idle = (real: Real) => within(300_000, () => (query(join(real.state, "state.db"), "SELECT 1 FROM tickets WHERE worker_state IN ('queued', 'running')").length === 0 ? true : undefined), 1000);

/** The question the stock-ta report suggests, asked with no conversation before it: it must open a domain-null ticket, not loop back to stock-ta. */
async function followUp(question: string | undefined): Promise<{ ok: boolean; text: string }> {
	if (question === undefined) return { ok: false, text: "the stock-ta report suggested no follow-up question" };
	const host = await realHost(HEAD);
	try {
		const a = await ask(host, question, (t) => t.length > 20, 300_000);
		await idle(host);
		const tickets = query(join(host.state, "state.db"), "SELECT id, title, domain, dispatched_to FROM tickets ORDER BY rowid");
		return { ok: tickets.length > 0 && tickets.every((t) => t["domain"] === null), text: `asked alone on a fresh host: ${question}\n${asked({ ...a, tickets })}` };
	} finally {
		await host.close();
	}
}

async function newsLane(): Promise<Verdict> {
	let checks: Record<string, boolean>;
	let evidence: string;
	let suggested: string | undefined;
	const host = await realHost(HEAD);
	const db = join(host.state, "state.db");
	const allTickets = () => query(db, "SELECT id, title, domain, dispatched_to FROM tickets ORDER BY rowid");
	try {
		const news = await ask(host, "NVDA 最新新闻", (t) => t.length > 20, 300_000);
		await idle(host);
		const newsTickets = allTickets();
		const before = host.tg.sent.length;
		const mixed = await ask(host, "NVDA 跌了多少，为什么跌", (t) => PERCENT.test(t), 300_000);
		await idle(host);
		const tickets = allTickets();
		const mixedTickets = tickets.slice(newsTickets.length);
		const mixedIds = new Set(mixedTickets.map((t) => t["id"]));
		const ready = query(db, "SELECT t.id, t.domain, r.summary FROM reports r JOIN tickets t ON t.id = r.ticket_id WHERE r.status = 'ready' ORDER BY r.seq").filter((r) => mixedIds.has(r["id"]));
		const ta = ready.filter((r) => r["domain"] === "stock-ta").map((r) => String(r["summary"]));
		const general = ready.filter((r) => r["domain"] === null).map((r) => String(r["summary"]));
		const told = host.tg.sent.slice(before).filter((m: { chatId: number }) => m.chatId === USER).map((m: { text: string }) => m.text).join("\n");
		suggested = ta.map((t) => FOLLOW_UP.exec(t)?.[1]).find(Boolean);
		checks = {
			"1 news only is not stock-ta": newsTickets.length > 0 && newsTickets.every((t) => t["domain"] !== "stock-ta"),
			"2 stock-ta reports the move, no cause, and the line suggesting a follow-up question": ta.length > 0 && ta.every((t) => PERCENT.test(t) && !CAUSE.test(t) && FOLLOW_UP.test(t)),
			"3 a cause can only come from a domain-null ticket": mixedTickets.every((t) => t["domain"] === "stock-ta" || t["domain"] === null),
			"4 no stock-ta ticket reached the web": webReads(host.state).length === 0,
			"5 the mixed question dispatched no expert": mixedTickets.every((t) => t["dispatched_to"] === null || t["dispatched_to"] === "[]"),
		};
		const file = join(outDir, "r2a-news.png");
		await screenshot(host, file, (page) => harness.showScreen(page, "chat").then(() => page.getByText(PERCENT).first().waitFor({ timeout: 20_000 })).catch(() => undefined));
		evidence = `news only:\n${asked(news)}\n\nmixed:\n${asked(mixed)}\nevery Telegram line after the mixed question:\n${told}\n\nstock-ta web reads:\n${webReads(host.state).join("\n") || "(none)"}\n\nstock-ta ready reports on the mixed question:\n${ta.join("\n---\n") || "(none)"}\n\ndomain-null ready reports on the mixed question (${general.length > 0 ? "the cause was answered by a general ticket" : "no general ticket answered"}):\n${general.join("\n---\n") || "(none)"}\n\nall tickets:\n${show(tickets)}\nscreenshot ${file}`;
	} finally {
		await host.close();
	}
	const next = await followUp(suggested);
	checks["6 the suggested follow-up, asked alone, opens a domain-null ticket"] = next.ok;
	return {
		pass: Object.values(checks).every(Boolean),
		evidence: `checks:\n${Object.entries(checks).map(([k, v]) => `${v ? "ok  " : "FAIL"} ${k}`).join("\n")}\n\n${evidence}\n\nfollow-up:\n${next.text}`,
	};
}

/** Lane 7: the ticket card on the web page shows the lead worked alone. */
async function noDispatchPage(host: Real, a: Asked): Promise<Verdict> {
	const file = join(outDir, "r2a-no-dispatch.png");
	try {
		let card = "";
		await screenshot(host, file, async (page) => {
			if (await page.locator("#tab-done").isVisible()) await page.locator("#tab-done").click();
			const crew = page.locator(".card .crew-text").filter({ hasText: /暂未派活|领队未派活|领队独自完成|派给/ }).filter({ visible: true }).first();
			await crew.waitFor({ timeout: 20_000 });
			card = (await crew.textContent()) ?? "";
		});
		const noDispatch = a.tickets.every((t) => t["dispatched_to"] === null || t["dispatched_to"] === "[]");
		return { pass: existsSync(file) && card !== "" && !/派给/.test(card) && noDispatch, evidence: `the web page of the head run, its ticket card says: ${card}
screenshot ${file}
tickets: ${show(a.tickets)}
gateway:
${a.gateway.join("\n")}` };
	} finally {
		await host.close();
	}
}

async function news(): Promise<void> {
	await lane(9, "news", newsLane);
}

async function perf(): Promise<void> {
	const times: number[] = [];
	const lines: string[] = [];
	for (let i = 0; i < 3; i++) {
		const host = await realHost(HEAD);
		try {
			const a = await ask(host, PRICE_Q, (t) => PRICE.test(t), 300_000);
			times.push(a.answerMs ?? Infinity);
			lines.push(`run ${i + 1}: answer after ${a.answerMs === undefined ? "never" : secs(a.answerMs)}\ntickets:\n${show(a.tickets)}\n${a.sent.join("\n")}`);
		} finally {
			await host.close();
		}
	}
	await lane("perf-head", "perf-head", async () => ({
		pass: median(times) <= 25_000,
		evidence: `head only, ${PRICE_Q} on the fake Telegram, three fresh hosts (rule: median over 25 s fails)\nmedian ${secs(median(times))}, runs ${times.map((x) => (Number.isFinite(x) ? secs(x) : "never")).join(", ")}, spread ${secs(Math.max(...times) - Math.min(...times))}\n${lines.join("\n\n")}`,
	}));
}

async function page(): Promise<void> {
	const host = await realHost(HEAD);
	const a = await ask(host, PRICE_Q, (t) => PRICE.test(t), 300_000);
	await lane(7, "no-dispatch", () => noDispatchPage(host, a));
}

async function media(): Promise<void> {
	const host = await realHost(HEAD);
	const browser = await chromium.launch();
	const videoDir = mkdtempSync(join(tmpdir(), "psa-r2a-video-"));
	try {
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } });
		const page = await context.newPage();
		await page.goto(host.host.url.href);
		await page.waitForTimeout(1500);
		await harness.sayInPage(page, PRICE_Q, { typeDelayMs: 60 });
		await within(120_000, () => host.tg.sent.find((m: { text: string }) => PRICE.test(m.text)), 200);
		await page.waitForTimeout(2500);
		await idle(host);
		await harness.sayInPage(page, "NVDA 跌了多少，为什么跌", { typeDelayMs: 60 });
		await within(180_000, () => (host.tg.sent.filter((m: { text: string }) => PERCENT.test(m.text)).length >= 2 ? true : undefined), 500);
		await page.waitForTimeout(3000);
		await page.screenshot({ path: join(outDir, "r2a-review-web.png"), fullPage: true });
		await context.close();
		const [webm] = readdirSync(videoDir);
		copyFileSync(join(videoDir, webm!), join(outDir, "r2a-review.webm"));
		const sent = host.tg.sent.filter((m: { chatId: number }) => m.chatId === USER);
		const chat = await (await browser.newContext({ viewport: { width: 420, height: 760 } })).newPage();
		const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
		await chat.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;font:15px -apple-system,sans-serif;background:#cfe0c3"><div style="background:#527da3;color:#fff;padding:12px 16px;font-weight:600">Pi Super Agent（本地假 Telegram，lane 回放）</div><div style="padding:12px;display:flex;flex-direction:column;gap:8px">${[PRICE_Q, ...sent.map((m: { text: string }) => m.text)].map((t, i) => `<div style="max-width:80%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;align-self:${i === 0 ? "flex-end;background:#effdde" : "flex-start;background:#fff"}">${esc(t)}</div>`).join("")}</div>`);
		await chat.screenshot({ path: join(outDir, "r2a-review-telegram.png"), fullPage: true });
		writeFileSync(join(outDir, "r2a-review.txt"), `fake Telegram, sent to the user:\n${sent.map((m: { at: number; text: string }) => `${new Date(m.at).toISOString()} ${m.text}`).join("\n")}\n`);
		console.log(`media in ${outDir}: r2a-review.webm, r2a-review-web.png, r2a-review-telegram.png`);
	} finally {
		await browser.close();
		await host.close();
	}
}

if (mode === "web") {
	const reads = webReads(outDir);
	console.log(reads.length === 0 ? "ok   no stock-ta ticket reached the web" : `FAIL stock-ta reached the web\n${reads.join("\n")}`);
	process.exit(reads.length === 0 ? 0 : 1);
}
await (mode === "real" ? real() : mode === "page" ? page() : mode === "news" ? news() : mode === "media" ? media() : mode === "perf" ? perf() : tools());
process.exit(0);
