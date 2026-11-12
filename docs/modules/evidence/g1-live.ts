/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/g1-live.ts [lanes|perf] [outDir]
 *
 * Every lane runs on the fake model from tests/e2e/fake-model.ts, each in its own throwaway state dir.
 * Lane 1 and the perf baseline also run a detached worktree of `origin/main` at <outDir>/trunk.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const SAMPLE = join(HEAD, "docs/modules/architecture/sample");
const UPDATE = join(SAMPLE, "update");
const LITE = "health-lite";
const [mode = "lanes", outDir = "/tmp/swarm-g1/owner"] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
mkdirSync(outDir, { recursive: true });

const { fakeModels } = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, domainTool, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
const { scanPackage } = await import(join(HEAD, "src/modules/validate.ts"));
type Fake = InstanceType<typeof FakeModel>;
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

const stateDir = () => mkdtempSync(join(tmpdir(), "psa-g1-"));
const place = (state: string, from: string, name: string) => {
	const to = join(state, "modules", name);
	mkdirSync(to, { recursive: true });
	cpSync(from, to, { recursive: true, force: true });
};
const lite = (version: string) => join(UPDATE, version, LITE);
const save = (state: string, version: string) => {
	for (const file of ["module.json", "data/lab-results/collection.json"]) writeFileSync(join(state, "modules", LITE, file), readFileSync(join(lite(version), file)));
};

function just(state: string, args: string[], cwd = HEAD, input = "") {
	const run = spawnSync("just", args, { cwd, env: { ...process.env, PSA_STATE_DIR: state }, input, encoding: "utf8", timeout: 60_000 });
	return { status: run.status, out: (run.stdout + run.stderr).split("\n").filter((l) => !l.startsWith("node --import")).join("\n").trim() };
}

function query<T>(path: string, sql: string): T[] {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(sql).all().map((r) => ({ ...r })) as T[];
	} finally {
		db.close();
	}
}
const dataDb = (state: string, name: string) => join(state, "modules-data", name, "data.db");
const rows = (state: string, sql: string, name = LITE) => query<Record<string, unknown>>(dataDb(state, name), sql);
const columns = (state: string, table: string, name = LITE) => rows(state, `SELECT name FROM pragma_table_info('${table}')`, name).map((r) => r["name"] as string);
const userTables = (state: string, name: string) => rows(state, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name", name).map((r) => r["name"] as string);
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
function addRows(state: string, count: number): void {
	const db = new DatabaseSync(dataDb(state, LITE));
	try {
		db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
			INSERT INTO "lab-results" ("_from", item, value, takenAt, lab) SELECT 'blobs/report-' || i || '.pdf', 'CEA', i / 1000.0, '2026-10-01', '协和' FROM n`);
	} finally {
		db.close();
	}
}

type Record_ = { state: { at: string; serving?: { label: string }; update?: { at: string; problems?: { reason: string }[] } | null } };
const record = (state: string, name = LITE): Record_ | undefined => {
	const [row] = query<{ record: string | null }>(join(state, "state.db"), `SELECT record FROM module_records WHERE name = '${name}'`);
	return row?.record ? (JSON.parse(row.record) as Record_) : undefined;
};
const listing = (state: string, name = LITE) => {
	const lines = just(state, ["modules"]).out.split("\n");
	const at = lines.findIndex((l) => l.startsWith(`${name} `));
	if (at < 0) return "";
	const rest = lines.slice(at + 1);
	const end = rest.findIndex((l) => !l.startsWith("  "));
	return [lines[at], ...rest.slice(0, end < 0 ? rest.length : end)].join("\n");
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
const serving = (state: string, label: string, name = LITE) => () => record(state, name)?.state.at === "active" && record(state, name)?.state.serving?.label === label;

async function boot(state: string, fake: Fake, tree = HEAD): Promise<Host> {
	const harness = await import(join(tree, "tests/e2e/harness.ts"));
	return harness.startHost({ models: fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0 }, env: fakeAgentEnv(fake, join(state, "pi")), timeoutMs: 60_000 });
}
async function turnOn(state: string, name: string, label: string, tree = HEAD): Promise<number> {
	just(state, ["module", "on", name], tree);
	return within(5000, serving(state, label, name));
}
async function liteHost(count = 1) {
	const state = stateDir();
	place(state, lite("0.1.0"), LITE);
	const fake = await FakeModel.start({ router: [] });
	const host = await boot(state, fake);
	const on = await turnOn(state, LITE, "0.1.0");
	if (on < 0) throw new Error(`health-lite did not start serving: ${JSON.stringify(record(state))}`);
	addRows(state, count);
	return { state, host, close: async () => (await host.stop(), await fake.close()) };
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
	const file = join(outDir, `g1-${slug}.txt`);
	writeFileSync(file, `${word} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

const exchangesOf = (fake: Fake, conversation: string): Exchange[] => fake.exchanges.filter((e: Exchange) => e.conversation === conversation);
const inDomain = (call: Call, domain: string) => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain, basis: "request" })) } });

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		const lines: string[] = [];
		const cards: string[] = [];
		const dbs: boolean[] = [];
		for (const [name, tree] of [["trunk", trunk()], ["head", HEAD]] as const) {
			const state = stateDir();
			place(state, join(SAMPLE, "personal-tax"), "personal-tax");
			const brief = `${name} 算税`;
			const fake = await FakeModel.start({
				router: [on("开任务", /^\[对话\][\s\S]*算一下税/, (c: string) => [inDomain(openTicket(c, brief), "personal-tax"), reply(c, "好")])],
				workers: [worker(brief, on("调用", /^\[任务说明\]/, () => [domainTool("tax-bracket", { taxableIncome: 60000 })]), on("汇报", /^\[模块工具\]/, (c: string) => [report("ready", c)]))],
			});
			let host: Host | undefined;
			try {
				host = await boot(state, fake, tree);
				const on = await turnOn(state, "personal-tax", "0.1.0", tree);
				just(state, ["say", "帮我算一下税"], tree);
				await within(30_000, () => exchangesOf(fake, brief).some((e) => e.cards.some((c) => c.startsWith("[模块工具]"))));
				const card = exchangesOf(fake, brief).flatMap((e) => e.cards).find((c) => c.startsWith("[模块工具]")) ?? "";
				cards.push(card);
				const db = existsSync(dataDb(state, "personal-tax"));
				dbs.push(db);
				lines.push(`${name}: serving after ${on} ms; tool card ${card}; modules-data/personal-tax/data.db ${db ? `exists, tables ${userTables(state, "personal-tax").join(",")}` : "absent"}`);
			} finally {
				await host?.stop();
				await fake.close();
			}
		}
		return { pass: cards[0] !== "" && cards[0] === cards[1] && dbs[0] === false && dbs[1] === true, evidence: lines.join("\n") };
	});

	await lane(2, "tables", async () => {
		const state = stateDir();
		place(state, join(SAMPLE, "personal-health"), "personal-health");
		const fake = await FakeModel.start({ router: [] });
		const host = await boot(state, fake);
		try {
			const on = await turnOn(state, "personal-health", "0.1.0");
			const names = ["device-readings", "documents", "lab-results", "profile", "research-updates"];
			const lines = [`serving after ${on} ms`, `tables: ${userTables(state, "personal-health").join(", ")}`];
			let pass = on >= 0 && userTables(state, "personal-health").join() === names.join();
			for (const table of names) {
				const declared = Object.keys(JSON.parse(readFileSync(join(SAMPLE, "personal-health/data", table, "collection.json"), "utf8")).fields);
				const have = columns(state, table, "personal-health");
				pass &&= have.join() === ["_id", "_from", ...declared].join();
				lines.push(`${table}: columns ${have.join(", ")} | collection.json fields ${declared.join(", ")}`);
			}
			return { pass, evidence: lines.join("\n") };
		} finally {
			await host.stop();
			await fake.close();
		}
	});

	await lane(3, "add", async () => {
		const { state, close } = await liteHost();
		try {
			save(state, "0.2.0-adds-field");
			const took = await within(5000, serving(state, "0.2.0"));
			const have = columns(state, "lab-results");
			const old = rows(state, `SELECT item, lab, method FROM "lab-results"`);
			return { pass: took >= 0 && took <= 2000 && have.includes("method") && old.length === 1 && old[0]!["method"] === null, evidence: `saved 0.2.0-adds-field; serving 0.2.0 after ${took} ms\ncolumns ${have.join(", ")}\nold row ${JSON.stringify(old)}` };
		} finally {
			await close();
		}
	});

	await lane(4, "rename", async () => {
		const { state, close } = await liteHost();
		try {
			save(state, "0.2.0-renames-field");
			const took = await within(5000, serving(state, "0.2.0"));
			const have = columns(state, "lab-results");
			const moved = rows(state, `SELECT item, laboratory FROM "lab-results"`);
			const stored = rows(state, "SELECT json FROM _structure")[0]!["json"] as string;
			return {
				pass: took >= 0 && moved[0]?.["laboratory"] === "协和" && !have.includes("lab") && /"aliases":\{"lab":"laboratory"\}/.test(stored),
				evidence: `saved 0.2.0-renames-field; serving 0.2.0 after ${took} ms\ncolumns ${have.join(", ")}\nrow ${JSON.stringify(moved)}\n_structure ${stored}`,
			};
		} finally {
			await close();
		}
	});

	await lane(5, "remove", async () => {
		const { state, close } = await liteHost();
		try {
			save(state, "0.2.0-removes-field");
			const gone = await within(5000, serving(state, "0.2.0"));
			const hidden = rows(state, `SELECT lab FROM "lab-results"`);
			save(state, "0.1.0");
			const back = await within(5000, serving(state, "0.1.0"));
			const kept = rows(state, `SELECT item, lab FROM "lab-results"`);
			return {
				pass: gone >= 0 && back >= 0 && hidden[0]?.["lab"] === "协和" && kept[0]?.["lab"] === "协和",
				evidence: `saved 0.2.0-removes-field; serving 0.2.0 after ${gone} ms; the hidden column still holds ${JSON.stringify(hidden)}\nsaved 0.1.0 again; serving 0.1.0 after ${back} ms; row ${JSON.stringify(kept)}`,
			};
		} finally {
			await close();
		}
	});

	await lane(6, "unit", async () => {
		const { state, close } = await liteHost();
		try {
			const before = digest(dataDb(state, LITE));
			save(state, "0.2.0-changes-unit");
			const took = await within(5000, () => record(state)?.state.update?.at === "invalid");
			await sleep(500);
			const shown = listing(state);
			const after = digest(dataDb(state, LITE));
			return {
				pass: took >= 0 && /changed unit from mmol\/L to mg\/dL/.test(shown) && /0\.1\.0 在运行/.test(shown) && serving(state, "0.1.0")() && before === after,
				evidence: `saved 0.2.0-changes-unit; update invalid after ${took} ms\njust modules:\n${shown}\ndata.db sha256 before ${before} after ${after}`,
			};
		} finally {
			await close();
		}
	});

	await lane(7, "crash", async () => {
		const lines: string[] = [];
		let pass = true;
		let hits = 0;
		const COUNT = 2_000_000;
		for (const [n, at] of [[1, ".snapshot.partial"], [2, ".snapshot"], [3, ".snapshot"]] as const) {
			const { state, host, close } = await liteHost(COUNT);
			try {
				const path = dataDb(state, LITE);
				save(state, "0.2.0-adds-field");
				// Busy-wait so the kill lands while the file is there; a timer would sleep through the window.
				const started = Date.now();
				let seen = false;
				while (!seen && Date.now() - started < 10_000) seen = existsSync(`${path}${at}`);
				if (seen) process.kill(-host.pid, "SIGKILL");
				const left = [".snapshot", ".snapshot.partial", "-journal"].filter((s) => existsSync(`${path}${s}`));
				hits += seen ? 1 : 0;
				await host.restart();
				const back = await within(10_000, serving(state, "0.2.0"));
				const count = rows(state, `SELECT COUNT(*) AS n FROM "lab-results"`)[0]!["n"];
				const have = columns(state, "lab-results");
				const ok = back >= 0 && count === COUNT && have.includes("method") && !existsSync(`${path}.snapshot`);
				pass &&= ok;
				lines.push(`trial ${n}: waited for data.db${at}: ${seen ? "seen, SIGKILL the host group" : "never seen, the migration finished first"}; left on disk ${left.join(", ") || "nothing"}; after restart serving 0.2.0 in ${back} ms, rows ${count}, columns ${have.join(", ")}, snapshot left ${existsSync(`${path}.snapshot`)}`);
			} finally {
				await close();
			}
		}
		return { pass: hits === 0 ? "inconclusive" : pass, evidence: `${COUNT} rows in lab-results\n${lines.join("\n")}` };
	});

	await lane(8, "away", async () => {
		const { state, close } = await liteHost();
		try {
			const before = digest(dataDb(state, LITE));
			const away = join(state, "health-lite-away");
			renameSync(join(state, "modules", LITE), away);
			const gone = await within(5000, () => record(state)?.state.at === "missing");
			const whileAway = listing(state);
			const kept = digest(dataDb(state, LITE));
			renameSync(away, join(state, "modules", LITE));
			const back = await within(5000, serving(state, "0.1.0"));
			const row = rows(state, `SELECT item, lab FROM "lab-results"`);
			return {
				pass: gone >= 0 && back >= 0 && before === kept && row[0]?.["lab"] === "协和",
				evidence: `package moved away; record missing after ${gone} ms\njust modules: ${whileAway}\ndata.db sha256 before ${before}, while away ${kept}\nmoved back; serving 0.1.0 after ${back} ms; row ${JSON.stringify(row)}`,
			};
		} finally {
			await close();
		}
	});

	{
		const { state, close } = await liteHost();
		try {
			await lane(9, "purge-wrong", async () => {
				const whileOn = just(state, ["module", "purge", LITE, "--confirm", LITE]);
				just(state, ["module", "off", LITE]);
				const off = await within(5000, () => record(state)?.state.at === "disabled");
				const flag = just(state, ["module", "purge", LITE, "--confirm", "health"]);
				const typed = just(state, ["module", "purge", LITE], HEAD, "health\n");
				const still = existsSync(dataDb(state, LITE)) && rows(state, `SELECT COUNT(*) AS n FROM "lab-results"`)[0]!["n"] === 1;
				return {
					pass: whileOn.status === 1 && off >= 0 && flag.status === 1 && typed.status === 1 && still,
					evidence: `while on: exit ${whileOn.status}\n${whileOn.out}\nswitched off, disabled after ${off} ms\n--confirm health: exit ${flag.status}\n${flag.out}\ntyped "health": exit ${typed.status}\n${typed.out}\ndata.db still there with its row: ${still}`,
				};
			});
			await lane(10, "purge", async () => {
				const typed = just(state, ["module", "purge", LITE], HEAD, `${LITE}\n`);
				const gone = !existsSync(join(state, "modules-data", LITE));
				const pkg = existsSync(join(state, "modules", LITE, "module.json"));
				const shown = listing(state);
				const on = await turnOn(state, LITE, "0.1.0");
				const fresh = rows(state, `SELECT COUNT(*) AS n FROM "lab-results"`)[0]!["n"];
				return {
					pass: typed.status === 0 && gone && pkg && /已停用/.test(shown) && on >= 0 && fresh === 0,
					evidence: `typed "${LITE}": exit ${typed.status}\n${typed.out}\nmodules-data/${LITE} gone: ${gone}; package still there: ${pkg}\njust modules: ${shown}\nswitched on again: serving after ${on} ms with ${fresh} rows`,
				};
			});
		} finally {
			await close();
		}
	}
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (name: string, xs: number[], unit: string) => `${name}: median ${median(xs).toFixed(0)} ${unit}, runs ${xs.map((t) => t.toFixed(0)).join(" ")}, spread ${(Math.max(...xs) - Math.min(...xs)).toFixed(0)} ${unit}`;

async function perf(): Promise<void> {
	const lines: string[] = [];
	const boots: Record<string, number[]> = { trunk: [], head: [] };
	for (let i = 0; i < 5; i++) {
		for (const [name, tree] of [["trunk", trunk()], ["head", HEAD]] as const) {
			const state = stateDir();
			place(state, join(SAMPLE, "personal-health"), "personal-health");
			just(state, ["module", "on", "personal-health"], tree);
			const fake = await FakeModel.start({ router: [] });
			const started = performance.now();
			const host = await boot(state, fake, tree);
			boots[name]!.push(performance.now() - started);
			await host.stop();
			await fake.close();
		}
	}
	const slower = median(boots.head!) - median(boots.trunk!);
	const bootOk = slower <= 200;
	lines.push(`${bootOk ? "PASS" : "FAIL"} host start to ready, personal-health switched on before boot, alternating trunk/head (rule: head more than 200 ms over trunk fails)`, line("  trunk", boots.trunk!, "ms"), line("  head", boots.head!, "ms"), `  head - trunk = ${slower.toFixed(0)} ms`);

	const ROWS = 100_000;
	const seed = stateDir();
	const components = (version: string) => {
		const scan = scanPackage(lite(version), { runCases: false });
		if (!scan.ok) throw new Error("sample does not scan");
		return scan.scan.components;
	};
	instanceData(seed).migrate(LITE, components("0.1.0"));
	addRows(seed, ROWS);
	const size = readFileSync(dataDb(seed, LITE)).length;
	const migrations: number[] = [];
	for (let i = 0; i < 5; i++) {
		const state = stateDir();
		cpSync(join(seed, "modules-data"), join(state, "modules-data"), { recursive: true });
		const next = components("0.2.0-adds-field");
		const started = performance.now();
		const run = instanceData(state).migrate(LITE, next);
		migrations.push(performance.now() - started);
		if (!run.ok) throw new Error(run.reason);
		rmSync(state, { recursive: true, force: true });
	}
	const migrateOk = Math.max(...migrations) <= 2000;
	lines.push(`${migrateOk ? "PASS" : "FAIL"} add-field migration with snapshot, ${ROWS} rows, data.db ${(size / 1e6).toFixed(1)} MB, 5 runs on fresh copies (rule: any run over 2000 ms fails)`, line("  head", migrations, "ms"));

	const report = [`${bootOk && migrateOk ? "PASS" : "FAIL"} perf`, ...lines].join("\n");
	writeFileSync(join(outDir, "g1-perf.txt"), `${report}\n`);
	console.log(report);
}

await (mode === "perf" ? perf() : lanes());
