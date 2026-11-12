/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/f2a-live.ts [lanes|perf] [outDir]
 *
 * Every host runs on the fake model from tests/e2e/fake-model.ts. Lane 1 and the probe compare
 * against a detached worktree of `main` at <outDir>/trunk.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const TAX_SAMPLE = join(HEAD, "docs/modules/architecture/sample/personal-tax");
const TAX_SKILL = "modules/personal-tax/skills/year-end-estimate/SKILL.md";
const OLD_SKILL = "年度应税所得估算";
const NEW_SKILL = "F2a 改过的新版技能说明";
const [mode = "lanes", outDir = "/tmp/swarm-f2a/owner"] = process.argv.slice(2);
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
	const dir = mkdtempSync(join(tmpdir(), "psa-f2a-"));
	if (withTax) cpSync(TAX_SAMPLE, join(dir, "modules/personal-tax"), { recursive: true });
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

type Row = { name: string; switch: number | null; record: string | null };
function records(state: string): Record<string, { switch: number | null; at: string | undefined; pending: number | undefined }> {
	return Object.fromEntries(query<Row>(state, "SELECT name, switch, record FROM module_records ORDER BY name").map((r) => {
		const record = r.record === null ? null : (JSON.parse(r.record) as { state: { at: string }; pending: unknown[] });
		return [r.name, { switch: r.switch, at: record?.state.at, pending: record?.pending.length }];
	}));
}

const at = (state: string, name: string) => records(state)[name]?.at;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Milliseconds until `ok()` held, or -1 after `limitMs`. */
async function within(limitMs: number, ok: () => boolean): Promise<number> {
	const started = performance.now();
	while (performance.now() - started < limitMs) {
		if (ok()) return Math.round(performance.now() - started);
		await sleep(20);
	}
	return ok() ? Math.round(performance.now() - started) : -1;
}

async function boot(state: string, fake: Fake, config: Record<string, unknown> = {}, tree = HEAD): Promise<Host> {
	const harness = await import(join(tree, "tests/e2e/harness.ts"));
	return harness.startHost({ models: fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0, ...config }, env: fakeAgentEnv(fake, join(state, "pi")) });
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const results: string[] = [];
async function lane(n: number, slug: string, body: () => Promise<{ pass: boolean; evidence: string }>): Promise<void> {
	let verdict: { pass: boolean; evidence: string };
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const file = join(outDir, `f2a-${slug}.txt`);
	writeFileSync(file, `${verdict.pass ? "PASS" : "FAIL"} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${verdict.pass ? "PASS" : "FAIL"}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

const inDomain = (call: { name: string; args: Record<string, unknown> }, domain: string) => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain })) } });

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		const lines: string[] = [];
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
				const tickets = query(state, "SELECT domain, closed_at IS NOT NULL AS closed FROM tickets");
				lines.push(`${name}: closed pi-pi ticket after ${done} ms; tickets ${JSON.stringify(tickets)}`);
				pass &&= done >= 0;
			} finally {
				await host.stop();
				await fake.close();
			}
		}
		return { pass, evidence: lines.join("\n") };
	});

	{
		const state = stateDir();
		const fake = await FakeModel.start({ router: [on("把税交给已关掉的报税领域", /^\[对话\][\s\S]*报税/, (c: string) => [inDomain(openTicket(c, "报税", "估算今年的税"), "personal-tax"), reply(c, "好")])] });
		const host = await boot(state, fake);
		const pid = host.pid;
		try {
			await lane(2, "on", async () => {
				const before = at(state, "personal-tax");
				const cli = just(state, ["module", "on", "personal-tax"]);
				const took = await within(2000, () => at(state, "personal-tax") === "active");
				const listing = just(state, ["modules"]).out.split("\n").find((l) => l.startsWith("personal-tax ")) ?? "";
				const same = host.pid === pid && alive(pid);
				return { pass: took >= 0 && /运行中/.test(listing) && same, evidence: `before: ${before}\n${cli.out}active after ${took} ms\njust modules: ${listing}\nhost pid ${pid} -> ${host.pid}, alive ${alive(pid)}` };
			});
			await lane(3, "off", async () => {
				const cli = just(state, ["module", "off", "personal-tax"]);
				const took = await within(2000, () => at(state, "personal-tax") === "disabled");
				const listing = just(state, ["modules"]).out.split("\n").find((l) => l.startsWith("personal-tax ")) ?? "";
				just(state, ["say", "帮我报税"]);
				const asked = await within(10_000, () => fake.exchanges.some((e: { steps: string[] }) => e.steps.includes("把税交给已关掉的报税领域")));
				await sleep(1500);
				const tickets = query(state, "SELECT id, domain FROM tickets");
				const pass = took >= 0 && /已停用/.test(listing) && asked >= 0 && tickets.length === 0;
				return { pass, evidence: `${cli.out}disabled after ${took} ms\njust modules: ${listing}\nRouter asked to open a personal-tax ticket after ${asked} ms; tickets now ${JSON.stringify(tickets)}\nhost pid ${pid} -> ${host.pid}` };
			});
		} finally {
			await host.stop();
			await fake.close();
		}
	}

	{
		const state = stateDir();
		const fake = await FakeModel.start({
			router: [on("把税交给报税领域", /^\[对话\][\s\S]*报税/, (c: string) => [inDomain(openTicket(c, "报税", "估算今年的税"), "personal-tax"), reply(c, "好")])],
			workers: [worker("估算今年的税", on("第一轮很慢，宿主在中间重启", /^\[任务说明\]/, () => [report("progress", "在算")], 60_000), on("重启后接着做完", /./, () => [report("ready", "算完了")], 3000))],
		});
		const host = await boot(state, fake);
		try {
			just(state, ["module", "on", "personal-tax"]);
			await within(2000, () => at(state, "personal-tax") === "active");
			let evidence4 = "";
			await lane(4, "pin", async () => {
				just(state, ["say", "帮我报税"]);
				await within(20_000, () => fake.exchanges.some((e: { conversation: string }) => e.conversation === "估算今年的税"));
				const [ticket] = query<{ id: string; module_digest: string }>(state, "SELECT id, module_digest FROM tickets");
				const skill = join(state, TAX_SKILL);
				writeFileSync(skill, readFileSync(skill, "utf8").replace(OLD_SKILL, NEW_SKILL));
				await host.restart();
				const resumed = await within(20_000, () => fake.exchanges.filter((e: { conversation: string }) => e.conversation === "估算今年的税").length >= 2);
				const prompt: string = fake.systemPromptOf("估算今年的税");
				const copies = readdirSync(join(state, "module-store/personal-tax")).sort();
				const serving = JSON.parse(query<{ record: string }>(state, "SELECT record FROM module_records WHERE name = 'personal-tax'")[0]!.record).state.serving.digest as string;
				const pinnedPath = `module-store/personal-tax/${ticket!.module_digest}/`;
				const pass = resumed >= 0 && prompt.includes(OLD_SKILL) && !prompt.includes(NEW_SKILL) && prompt.includes(pinnedPath) && copies.length === 2 && serving !== ticket!.module_digest;
				evidence4 = ticket!.module_digest;
				return { pass, evidence: `ticket ${ticket!.id} pinned to ${ticket!.module_digest}\nskill edited, host restarted; worker resumed after ${resumed} ms\nresumed worker prompt has old skill ${prompt.includes(OLD_SKILL)}, new skill ${prompt.includes(NEW_SKILL)}, pinned path ${prompt.includes(pinnedPath)}\nserving now ${serving}\nmodule-store/personal-tax: ${copies.join(" ")}` };
			});
			await lane(5, "gc", async () => {
				const closed = await within(20_000, () => query<{ n: number }>(state, "SELECT COUNT(*) AS n FROM tickets WHERE closed_at IS NOT NULL")[0]!.n === 1);
				const gone = await within(2000, () => !readdirSync(join(state, "module-store/personal-tax")).includes(evidence4));
				const copies = readdirSync(join(state, "module-store/personal-tax"));
				return { pass: closed >= 0 && gone >= 0 && copies.length === 1, evidence: `ticket closed after ${closed} ms; old copy ${evidence4} gone ${gone} ms later\nmodule-store/personal-tax: ${copies.join(" ")}` };
			});
		} finally {
			await host.stop();
			await fake.close();
		}
	}

	await lane(6, "crash", async () => {
		const state = stateDir();
		const fake = await FakeModel.start({ router: [] });
		const host = await boot(state, fake);
		try {
			await host.restart(() => {
				const db = new DatabaseSync(join(state, "state.db"));
				const record = JSON.parse((db.prepare("SELECT record FROM module_records WHERE name = 'personal-tax'").get() as { record: string }).record);
				const version = record.state.onDisk;
				const halfway = { ...record, state: { at: "staging", stage: { at: "checking", version } }, pending: [{ do: "check", version }] };
				db.prepare("UPDATE module_records SET switch = 1, record = ? WHERE name = 'personal-tax'").run(JSON.stringify(halfway));
				db.close();
			});
			const after = records(state)["personal-tax"];
			const listing = just(state, ["modules"]).out.split("\n").find((l) => l.startsWith("personal-tax ")) ?? "";
			return { pass: after?.at === "active" && after.pending === 0 && /运行中/.test(listing), evidence: `seeded while down: staging/checking with pending [check]\nafter restart: ${JSON.stringify(after)}\njust modules: ${listing}` };
		} finally {
			await host.stop();
			await fake.close();
		}
	});

	{
		const state = stateDir(false);
		const fake = await FakeModel.start({ router: [] });
		const host = await boot(state, fake, { modules: { "toy-market": false } });
		try {
			await lane(7, "import", async () => {
				const r = records(state);
				const pass = r["toy-market"]?.switch === 0 && r["toy-market"]?.at === "disabled" && r["pi-pi"]?.at === "active" && r["us-market"]?.at === "active";
				return { pass, evidence: JSON.stringify(r, null, 1) };
			});
			await lane(8, "import-once", async () => {
				const before = JSON.stringify(records(state));
				await host.restart(() => {
					const file = join(state, "config.json");
					writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), modules: { "toy-market": true, "us-market": false } }));
				});
				const after = JSON.stringify(records(state));
				const notes = readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("just module on"));
				return { pass: before === after && notes.length === 1, evidence: `before ${before}\nafter  ${after}\nlog: ${notes.join("\n")}` };
			});
		} finally {
			await host.stop();
			await fake.close();
		}
	}

	await lane(9, "away", async () => {
		const state = stateDir();
		const away = join(state, "personal-tax-away");
		const fake = await FakeModel.start({ router: [] });
		const host = await boot(state, fake);
		try {
			just(state, ["module", "on", "personal-tax"]);
			await within(2000, () => at(state, "personal-tax") === "active");
			await host.restart(() => renameSync(join(state, "modules/personal-tax"), away));
			const missing = records(state)["personal-tax"];
			const cli = just(state, ["module", "off", "personal-tax"]);
			const off = await within(2000, () => records(state)["personal-tax"]?.switch === 0);
			await host.restart(() => renameSync(away, join(state, "modules/personal-tax")));
			const back = records(state)["personal-tax"];
			return { pass: missing?.at === "missing" && off >= 0 && back?.at === "disabled", evidence: `package away: ${JSON.stringify(missing)}\n${cli.out}switch off after ${off} ms\npackage back: ${JSON.stringify(back)}` };
		} finally {
			await host.stop();
			await fake.close();
		}
	});

	await lane(10, "offline", async () => {
		const state = stateDir(false);
		const cli = just(state, ["module", "on", "toy-market"]);
		const written = records(state)["toy-market"];
		const fake = await FakeModel.start({ router: [] });
		const host = await boot(state, fake);
		try {
			const after = records(state)["toy-market"];
			return { pass: cli.status === 0 && written?.switch === 1 && written.at === undefined && after?.at === "active", evidence: `${cli.out}written with no host: ${JSON.stringify(written)}\nafter the next start: ${JSON.stringify(after)}` };
		} finally {
			await host.stop();
			await fake.close();
		}
	});

}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (name: string, xs: number[]) => `${name}: median ${median(xs).toFixed(0)} ms, runs ${xs.map((t) => t.toFixed(0)).join(" ")}, spread ${(Math.max(...xs) - Math.min(...xs)).toFixed(0)} ms`;

async function perf(runs = 5): Promise<void> {
	const trees = { trunk: trunk(), head: HEAD };
	const ready: Record<string, number[]> = { trunk: [], head: [] };
	const ticket: Record<string, number[]> = { trunk: [], head: [] };
	for (let i = 0; i < runs; i++) {
		for (const [name, tree] of Object.entries(trees)) {
			const state = stateDir(name === "head");
			const fake = await FakeModel.start({
				router: [on("候选触发开 pi-pi 任务", /^\[候选触发\]/, (c: string) => [inDomain({ name: "route", args: { decisions: [{ kind: "open_ticket", basis: "inference", triggerId: c.match(/trg_[\w-]+/)?.[0], title: "看一下", brief: "看一下这条" }] } }, "pi-pi")])],
				workers: [worker("看一下这条", on("汇报", /^\[任务说明\]/, () => [report("progress", "在看")]))],
			});
			const started = performance.now();
			const host = await boot(state, fake, {}, tree);
			ready[name]!.push(performance.now() - started);
			try {
				const dropped = performance.now();
				just(state, ["drop", "generic", "perf", "有一条新消息"], tree);
				await within(20_000, () => query<{ n: number }>(state, "SELECT COUNT(*) AS n FROM tickets").length > 0 && query<{ n: number }>(state, "SELECT COUNT(*) AS n FROM tickets")[0]!.n === 1);
				ticket[name]!.push(performance.now() - dropped);
			} finally {
				await host.stop();
				await fake.close();
			}
		}
	}

	const { startLiveModules } = await import(join(HEAD, "src/host/live-modules.ts"));
	const { loadConfig, loadModules } = await import(join(HEAD, "src/host/config.ts"));
	const { openStore, setModuleSwitch } = await import(join(HEAD, "src/kernel/store.ts"));
	const state = stateDir();
	const config = loadConfig(state);
	const db = openStore(join(state, "state.db"));
	const modules = startLiveModules({ db, stateDir: state, discovered: loadModules(config), configSwitches: {}, log: () => {} });
	const publishes: number[] = [];
	const toggles: number[] = [];
	for (let i = 0; i < 100; i++) {
		const table = modules.live.current();
		let t = performance.now();
		modules.live.publish(table);
		publishes.push(performance.now() - t);
		setModuleSwitch(db, "toy-market", i % 2 === 0);
		t = performance.now();
		modules.tick();
		toggles.push(performance.now() - t);
	}
	modules.stop();
	db.close();

	const dReady = median(ready.head!) - median(ready.trunk!);
	const dTicket = median(ticket.head!) - median(ticket.trunk!);
	const worstSwap = Math.max(...toggles);
	const pass = dReady <= 200 && dTicket <= 200 && worstSwap <= 50;
	const report = [
		`${pass ? "PASS" : "FAIL"} perf (rule: start or ticket more than 200 ms slower than trunk fails; one swap over 50 ms fails)`,
		`start to ready, head - trunk = ${dReady.toFixed(0)} ms`,
		line("  trunk", ready.trunk!),
		line("  head", ready.head!),
		`drop to ticket, head - trunk = ${dTicket.toFixed(0)} ms`,
		line("  trunk", ticket.trunk!),
		line("  head", ticket.head!),
		`publish x100: median ${median(publishes).toFixed(4)} ms, max ${Math.max(...publishes).toFixed(4)} ms`,
		`switch toy-market + tick (records, table rebuild, publish, collect) x100: median ${median(toggles).toFixed(2)} ms, max ${worstSwap.toFixed(2)} ms`,
	].join("\n");
	writeFileSync(join(outDir, "f2a-perf.txt"), `${report}\n`);
	console.log(report);
}

await (mode === "perf" ? perf() : lanes());
