/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/f2b-live.ts [lanes|perf] [outDir]
 *
 * Lanes 1 to 8 and the save-to-receipt probe run on the fake model from tests/e2e/fake-model.ts.
 * Lane 9 and the token probe use real openai-codex models through the Pi login in ~/.pi/agent.
 * Lane 1 and the token probe compare against a detached worktree of `main` at <outDir>/trunk.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const TAX_SAMPLE = join(HEAD, "docs/modules/architecture/sample/personal-tax");
const TAX = "modules/personal-tax";
const SKILL = `${TAX}/skills/year-end-estimate/SKILL.md`;
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const PI_EXPERTS = ["agent-expert", "cli-expert", "config-expert", "ext-expert", "keybinding-expert", "prompt-expert", "skill-expert", "theme-expert", "tui-expert"];
const [mode = "lanes", outDir = "/tmp/swarm-f2b/owner"] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
mkdirSync(outDir, { recursive: true });

const { fakeModels } = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
type Fake = InstanceType<typeof FakeModel>;
type Host = Awaited<ReturnType<(typeof import("../../tests/e2e/harness.ts"))["startHost"]>>;

function trunk(): string {
	if (!existsSync(TRUNK)) {
		spawnSync("git", ["worktree", "add", "--detach", TRUNK, "main"], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
	}
	return TRUNK;
}

function stateDir(withTax = true): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-f2b-"));
	if (withTax) cpSync(TAX_SAMPLE, join(dir, TAX), { recursive: true });
	return dir;
}

function just(state: string, args: string[], cwd = HEAD) {
	const run = spawnSync("just", args, { cwd, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300" }, encoding: "utf8", timeout: 60_000 });
	return { status: run.status, out: run.stdout + run.stderr };
}

function query<T>(state: string, sql: string): T[] {
	const db = new DatabaseSync(join(state, "state.db"), { readOnly: true });
	try {
		return db.prepare(sql).all() as T[];
	} finally {
		db.close();
	}
}

type ModuleRecord = { state: { at: string; serving?: { digest: string; label: string } } };
const record = (state: string, name: string): ModuleRecord | undefined => {
	const [row] = query<{ record: string | null }>(state, `SELECT record FROM module_records WHERE name = '${name}'`);
	return row?.record ? (JSON.parse(row.record) as ModuleRecord) : undefined;
};
const serving = (state: string, name: string) => record(state, name)?.state.serving?.digest;
const receipts = (state: string) => readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[modules] 收据："));
const listing = (state: string, name: string) => {
	const lines = just(state, ["modules"]).out.split("\n");
	const at = lines.findIndex((l) => l.startsWith(`${name} `));
	return at < 0 ? "" : [lines[at], ...lines.slice(at + 1).filter((_, i, rest) => rest.slice(0, i + 1).every((l) => l.startsWith("  ")))].join("\n");
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function within(limitMs: number, ok: () => boolean): Promise<number> {
	const started = performance.now();
	while (performance.now() - started < limitMs) {
		if (ok()) return Math.round(performance.now() - started);
		await sleep(10);
	}
	return ok() ? Math.round(performance.now() - started) : -1;
}

async function turnOn(state: string, name = "personal-tax"): Promise<number> {
	just(state, ["module", "on", name]);
	return within(3000, () => record(state, name)?.state.at === "active");
}

async function boot(state: string, fake: Fake | null, config: object = {}, tree = HEAD): Promise<Host> {
	const harness = await import(join(tree, "tests/e2e/harness.ts"));
	const env = fake === null ? {} : fakeAgentEnv(fake, join(state, "pi"));
	return harness.startHost({ models: fake === null ? REAL : fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0, ...config }, env, timeoutMs: 60_000 });
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
	const file = join(outDir, `f2b-${slug}.txt`);
	writeFileSync(file, `${word} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

const inDomain = (call: { name: string; args: Record<string, unknown> }, domain: string) => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain })) } });
const routerCards = (fake: Fake) => fake.exchanges.filter((e: { conversation: string }) => e.conversation === "router").flatMap((e: { cards: string[] }) => e.cards);
const isBlock = (card: string) => card.startsWith("[名单和规则]");

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		const lines: string[] = [];
		const crews: string[][] = [];
		let pass = true;
		for (const [name, tree] of [["trunk", trunk()], ["head", HEAD]] as const) {
			const state = stateDir(false);
			const fake = await FakeModel.start({
				router: [on("开 pi-pi 任务", /^\[对话\][\s\S]*施工/, (c: string) => [inDomain(openTicket(c, "施工", "做一个小工具"), "pi-pi"), reply(c, "已安排")])],
				workers: [worker("做一个小工具", on("领队汇报完成", /^\[任务说明\]/, () => [report("ready", "做好了")]))],
			});
			const host = await boot(state, fake, {}, tree);
			try {
				just(state, ["say", "帮我施工一个小工具"], tree);
				const done = await within(20_000, () => query<{ n: number }>(state, "SELECT COUNT(*) AS n FROM tickets WHERE domain = 'pi-pi' AND closed_at IS NOT NULL")[0]!.n === 1);
				const prompt: string = fake.systemPromptOf("做一个小工具");
				const crew = PI_EXPERTS.filter((m) => prompt.includes(m));
				crews.push(crew);
				const tickets = query(state, "SELECT domain, closed_at IS NOT NULL AS closed FROM tickets");
				lines.push(`${name}: pi-pi ticket closed after ${done} ms; tickets ${JSON.stringify(tickets)}; members in the 领队 prompt: ${crew.join(" ")}`);
				pass &&= done >= 0;
			} finally {
				await host.stop();
				await fake.close();
			}
		}
		pass &&= crews[0]!.length === 9 && JSON.stringify(crews[0]) === JSON.stringify(crews[1]);
		return { pass, evidence: lines.join("\n") };
	});

	{
		const state = stateDir();
		const fake = await FakeModel.start({ router: [] });
		const host = await boot(state, fake);
		try {
			await turnOn(state);

			await lane(2, "edit", async () => {
				const before = serving(state, "personal-tax");
				const seen = receipts(state).length;
				writeFileSync(join(state, SKILL), `${readFileSync(join(state, SKILL), "utf8")}\nF2b 存盘改了一行\n`);
				const took = await within(2000, () => serving(state, "personal-tax") !== before && receipts(state).length > seen);
				const receipt = receipts(state).slice(seen);
				const pass = took >= 0 && receipt.length === 1 && receipt[0]!.includes("skills/year-end-estimate/SKILL.md");
				return { pass, evidence: `serving ${before} -> ${serving(state, "personal-tax")} after ${took} ms\nreceipt: ${receipt.join("\n")}\njust modules:\n${listing(state, "personal-tax")}` };
			});

			let good = "";
			await lane(3, "bad", async () => {
				const before = serving(state, "personal-tax");
				good = readFileSync(join(state, TAX, "module.json"), "utf8");
				writeFileSync(join(state, TAX, "module.json"), '{"schema":1,');
				const took = await within(2000, () => /说明.*not valid JSON/.test(listing(state, "personal-tax")));
				const shown = listing(state, "personal-tax");
				const pass = took >= 0 && serving(state, "personal-tax") === before && /运行中/.test(shown) && host.log().includes("网页");
				return { pass, evidence: `reason shown after ${took} ms; serving still ${serving(state, "personal-tax")} (was ${before})\njust modules:\n${shown}` };
			});

			await lane(4, "fix", async () => {
				const before = serving(state, "personal-tax");
				const seen = receipts(state).length;
				writeFileSync(join(state, TAX, "module.json"), good.replace('"0.1.0"', '"0.1.1"'));
				const took = await within(2000, () => serving(state, "personal-tax") !== before);
				const shown = listing(state, "personal-tax");
				return { pass: took >= 0 && /0\.1\.1/.test(shown) && !/说明/.test(shown), evidence: `serving ${before} -> ${serving(state, "personal-tax")} after ${took} ms\nreceipt: ${receipts(state).slice(seen).join("\n")}\njust modules:\n${shown}` };
			});

			await lane(5, "add", async () => {
				const dir = join(state, "modules/notes");
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "module.json"), JSON.stringify({ schema: 1, name: "notes", version: "0.1.0", title: "笔记", description: "整理笔记" }));
				const took = await within(2000, () => record(state, "notes")?.state.at === "disabled");
				const shown = listing(state, "notes");
				return { pass: took >= 0 && /已停用/.test(shown), evidence: `notes record ${JSON.stringify(record(state, "notes"))} after ${took} ms\njust modules:\n${shown}` };
			});

			await lane(6, "remove", async () => {
				const data = join(state, "modules-data/personal-tax");
				mkdirSync(data, { recursive: true });
				writeFileSync(join(data, "kept.txt"), "使用者的数据");
				rmSync(join(state, TAX), { recursive: true });
				const took = await within(2000, () => record(state, "personal-tax")?.state.at === "missing");
				const kept = existsSync(join(data, "kept.txt"));
				return { pass: took >= 0 && kept, evidence: `record ${JSON.stringify(record(state, "personal-tax")?.state)} after ${took} ms\nmodules-data/personal-tax/kept.txt still there: ${kept} (seeded by this lane: the host does not create instance data before F4)` };
			});
		} finally {
			await host.stop();
			await fake.close();
		}
	}

	await lane(7, "burst", async () => {
		const state = stateDir();
		const fake = await FakeModel.start({ router: [] });
		const host = await boot(state, fake);
		try {
			await turnOn(state);
			const seen = receipts(state).length;
			const base = readFileSync(join(state, SKILL), "utf8");
			const started = performance.now();
			for (let i = 1; i <= 5; i++) {
				writeFileSync(join(state, SKILL), `${base}\n第 ${i} 次存盘\n`);
				await sleep(150);
			}
			const spent = Math.round(performance.now() - started);
			const { digestOf } = await import(join(HEAD, "src/modules/validate.ts"));
			const last = digestOf(join(state, TAX));
			const took = await within(2000, () => serving(state, "personal-tax") === last);
			await sleep(1000);
			const swaps = receipts(state).slice(seen);
			return { pass: spent < 1000 && took >= 0 && swaps.length === 1 && serving(state, "personal-tax") === last, evidence: `5 saves in ${spent} ms; serving the last save (${last.slice(0, 12)}) ${took} ms after it\nreceipts: ${swaps.length}\n${swaps.join("\n")}` };
		} finally {
			await host.stop();
			await fake.close();
		}
	});

	await lane(8, "roster", async () => {
		const state = stateDir();
		const fake = await FakeModel.start({ router: [] });
		const host = await boot(state, fake);
		try {
			just(state, ["say", "先说一句"]);
			await within(10_000, () => routerCards(fake).some((c: string) => c.includes("先说一句")));
			await turnOn(state);
			const seen = routerCards(fake).length;
			just(state, ["say", "名单变了以后第一句"]);
			await within(10_000, () => routerCards(fake).some((c: string) => c.includes("名单变了以后第一句")));
			const first = routerCards(fake).slice(seen);
			const mid = routerCards(fake).length;
			just(state, ["say", "名单没变再说一句"]);
			await within(10_000, () => routerCards(fake).some((c: string) => c.includes("名单没变再说一句")));
			const second = routerCards(fake).slice(mid);
			const block = first.find(isBlock) ?? "";
			const pass = first.filter(isBlock).length === 1 && block.includes("- personal-tax（个人报税）") && first.indexOf(block) < first.findIndex((c: string) => c.includes("名单变了以后第一句")) && !second.some(isBlock);
			return { pass, evidence: `after the switch, the Router got:\n${first.map((c: string) => c.slice(0, 300)).join("\n---\n")}\n\nnext input:\n${second.map((c: string) => c.slice(0, 300)).join("\n---\n")}` };
		} finally {
			await host.stop();
			await fake.close();
		}
	});

	await lane(9, "real", async () => {
		const state = stateDir();
		let host: Host;
		try {
			host = await boot(state, null);
		} catch (error) {
			return { pass: "inconclusive", evidence: `a real host could not start: ${String((error as Error).stack ?? error)}` };
		}
		try {
			await turnOn(state);
			just(state, ["say", "帮我估算一下今年的应税所得大概落在哪一档，按我券商的交易记录算"]);
			const took = await within(120_000, () => query(state, "SELECT id FROM tickets").length > 0);
			const tickets = query<{ id: string; domain: string | null; title: string }>(state, "SELECT id, domain, title FROM tickets");
			const log = readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[router]") || l.includes("[modules]"));
			return { pass: took >= 0 && tickets.some((t) => t.domain === "personal-tax"), evidence: `models ${JSON.stringify(REAL)}\nticket after ${took} ms: ${JSON.stringify(tickets)}\nhost log:\n${log.join("\n")}` };
		} finally {
			await host.stop();
		}
	});

	await lane(10, "pipi", async () => {
		const run = spawnSync("just", ["module", "check", "modules/pi-pi"], { cwd: HEAD, encoding: "utf8" });
		const out = run.stdout + run.stderr;
		return { pass: run.status === 0 && /^ok pi-pi@/m.test(out) && /agents=9\b/.test(out), evidence: out };
	});
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (name: string, xs: number[], unit: string) => `${name}: median ${median(xs).toFixed(0)} ${unit}, runs ${xs.map((t) => t.toFixed(0)).join(" ")}, spread ${(Math.max(...xs) - Math.min(...xs)).toFixed(0)} ${unit}`;

type Usage = { input: number; cacheRead?: number; cacheWrite?: number };
type Entry = { type: string; customType?: string; content?: string; message?: { role: string; usage?: Usage } };
/** Prompt tokens, cache included, of the first model call after each [对话] input the host sent to the Router. */
function routerInputTokens(state: string): number[] {
	const dir = join(state, "sessions/router");
	const entries = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry));
	const tokens: number[] = [];
	let waiting = false;
	for (const entry of entries) {
		if (entry.type === "custom_message" && entry.customType === "psa-notice") waiting = (entry.content ?? "").includes("[对话]");
		const usage = entry.message?.role === "assistant" ? entry.message.usage : undefined;
		if (waiting && usage) {
			tokens.push(usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
			waiting = false;
		}
	}
	return tokens;
}

async function perf(): Promise<void> {
	const lines: string[] = [];
	let pass = true;

	const tokens: Record<string, number[]> = { trunk: [], head: [] };
	try {
		for (let i = 1; i <= 5; i++) {
			for (const [name, tree] of [["trunk", trunk()], ["head", HEAD]] as const) {
				const state = stateDir(false);
				const host = await boot(state, null, {}, tree);
				try {
					just(state, ["say", `第 ${i} 句：只回我一个字「好」`], tree);
					await within(120_000, () => routerInputTokens(state).length > 0);
					tokens[name]!.push(routerInputTokens(state)[0]!);
				} finally {
					await host.stop();
				}
			}
		}
		const extra = median(tokens.head!) - median(tokens.trunk!);
		const ok = tokens.head!.length === 5 && tokens.trunk!.length === 5 && extra <= 100;
		pass &&= ok;
		lines.push(
			`${ok ? "PASS" : "FAIL"} Router prompt tokens of the first input in a fresh session, real ${REAL.router}, alternating trunk/head, 5 runs each (rule: head median more than 100 over trunk fails). Head's first input carries the roster block, so later inputs with an unchanged roster cost less than this.`,
			line("  trunk", tokens.trunk!, "tok"),
			line("  head", tokens.head!, "tok"),
			`  head - trunk = ${extra} tok`,
		);
	} catch (error) {
		lines.push(`INCONCLUSIVE Router prompt tokens: a real run could not finish: ${String((error as Error).message ?? error)}`);
	}

	const state = stateDir();
	const fake = await FakeModel.start({ router: [] });
	const host = await boot(state, fake);
	const latency: number[] = [];
	try {
		await turnOn(state);
		const base = readFileSync(join(state, SKILL), "utf8");
		for (let i = 1; i <= 10; i++) {
			const seen = receipts(state).length;
			writeFileSync(join(state, SKILL), `${base}\n第 ${i} 次\n`);
			latency.push(await within(5000, () => receipts(state).length > seen));
			await sleep(300);
		}
	} finally {
		await host.stop();
		await fake.close();
	}
	const slow = latency.some((ms) => ms < 0 || ms > 2000);
	pass &&= !slow;
	lines.push(`${slow ? "FAIL" : "PASS"} save to receipt, 10 saves (rule: over 2000 ms fails)`, line("  head", latency, "ms"));

	const report = [`${pass ? "PASS" : "FAIL"} perf`, ...lines].join("\n");
	writeFileSync(join(outDir, "f2b-perf.txt"), `${report}\n`);
	console.log(report);
}

await (mode === "perf" ? perf() : lanes());
