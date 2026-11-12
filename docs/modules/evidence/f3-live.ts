/**
 *   node --import ./src/pi-runtime.mjs docs/modules/evidence/f3-live.ts [lanes|perf] [outDir]
 *
 * Lanes 1 to 9 and the perf probe run on the fake model from tests/e2e/fake-model.ts, which replays the
 * Worker's tool calls. Lane 10 uses real openai-codex models through the Pi login in ~/.pi/agent.
 * Lane 1 and the perf baseline also run a detached worktree of `main` at <outDir>/trunk.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const TAX_SAMPLE = join(HEAD, "docs/modules/architecture/sample/personal-tax");
const TAX = "modules/personal-tax";
const REAL = { router: "openai-codex/gpt-6.1-terra", worker: "openai-codex/gpt-6.1-sol", fallback: "openai-codex/gpt-6.1-sol" };
const CASES = JSON.parse(readFileSync(join(TAX_SAMPLE, "tools/tax-bracket/cases.json"), "utf8")) as { input: { taxableIncome: number }; expect: Record<string, number> }[];
const [mode = "lanes", outDir = "/tmp/swarm-f3/owner"] = process.argv.slice(2);
const TRUNK = join(outDir, "trunk");
mkdirSync(outDir, { recursive: true });

const { fakeModels } = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, domainTool, dispatch, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
type Fake = InstanceType<typeof FakeModel>;
type Host = Awaited<ReturnType<(typeof import("../../tests/e2e/harness.ts"))["startHost"]>>;
type Call = { name: string; args: Record<string, unknown> };
type Exchange = import("../../tests/e2e/fake-model.ts").Exchange;

function trunk(): string {
	if (!existsSync(TRUNK)) {
		spawnSync("git", ["worktree", "add", "--detach", TRUNK, "main"], { cwd: HEAD, stdio: "inherit" });
		symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
	}
	return TRUNK;
}

const tool = (effect: string, secrets: string[] = []) =>
	JSON.stringify({ title: effect, description: `${effect} tool`, input: { note: { type: "text", title: "备注" } }, output: { done: { type: "text", title: "结果" } }, effect, ...(secrets.length && { secrets }) });

/** personal-tax plus a write tool, a tool that echoes two secrets, a tool that never returns, and a member whose `uses` names only tax-note. */
const EXTRA: Record<string, string> = {
	"tools/file-return/tool.json": tool("write"),
	"tools/file-return/index.ts": "export default () => ({ filed: true });",
	"tools/env-probe/tool.json": tool("read", ["TAX_KEY"]),
	"tools/env-probe/index.ts": "export default () => ({ named: process.env.TAX_KEY ?? null, unnamed: process.env.OTHER_KEY ?? null });",
	"tools/spin/tool.json": tool("read"),
	"tools/spin/index.ts": "export default () => { for (;;) {} };",
	"tools/tax-note/tool.json": JSON.stringify({ title: "备注", description: "回显备注", input: { note: { type: "text", title: "备注" } }, output: { note: { type: "text", title: "备注" } } }),
	"tools/tax-note/index.ts": "export default (input) => ({ note: input.note });",
	"tools/tax-note/cases.json": JSON.stringify([{ name: "回显", input: { note: "x" }, expect: { note: "x" } }]),
	"agents/clerk.md": "---\nname: clerk\ntitle: 记账员\ndescription: 只整理交易记录\ntools: read\nuses: tools/tax-note\n---\n你是记账员。",
	"secrets.env": "TAX_KEY=named-value\nOTHER_KEY=unnamed-value\n",
};

function stateDir(withTax = true): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-f3-"));
	if (!withTax) return dir;
	cpSync(TAX_SAMPLE, join(dir, TAX), { recursive: true });
	for (const [path, text] of Object.entries(EXTRA)) {
		const file = path === "secrets.env" ? join(dir, path) : join(dir, TAX, path);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, text);
	}
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

const moduleState = (state: string): { at: string; serving?: { digest: string } } | undefined => {
	const [row] = query<{ record: string | null }>(state, "SELECT record FROM module_records WHERE name = 'personal-tax'");
	return row?.record ? (JSON.parse(row.record) as { state: { at: string; serving?: { digest: string } } }).state : undefined;
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** For the fake model's answer functions, which run synchronously inside its request handler. */
const blockUntil = (limitMs: number, ok: () => boolean) => {
	const until = Date.now() + limitMs;
	while (!ok() && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
	return ok();
};

async function within(limitMs: number, ok: () => boolean): Promise<number> {
	const started = performance.now();
	while (performance.now() - started < limitMs) {
		if (ok()) return Math.round(performance.now() - started);
		await sleep(20);
	}
	return ok() ? Math.round(performance.now() - started) : -1;
}

async function turnOn(state: string): Promise<number> {
	just(state, ["module", "on", "personal-tax"]);
	return within(5000, () => moduleState(state)?.at === "active");
}

async function boot(state: string, fake: Fake | null, config: object = {}, tree = HEAD, extra: { imports?: string[]; env?: Record<string, string> } = {}): Promise<Host> {
	const harness = await import(join(tree, "tests/e2e/harness.ts"));
	const env = { ...(fake === null ? {} : fakeAgentEnv(fake, join(state, "pi"))), ...extra.env };
	const secrets = existsSync(join(state, "secrets.env")) ? { secretsFile: "secrets.env" } : {};
	return harness.startHost({ models: fake === null ? REAL : fakeModels, stateDir: state, logFile: join(state, "host.log"), config: { webPort: 0, ...secrets, ...config }, env, imports: extra.imports, timeoutMs: 60_000 });
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
	const file = join(outDir, `f3-${slug}.txt`);
	writeFileSync(file, `${word} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${word}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

const inDomain = (call: Call, domain: string, basis = "request") => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain, basis })) } });
const opens = (word: string, brief: string, domain = "personal-tax", basis = "request") =>
	on(`开 ${brief}`, new RegExp(`^\\[对话\\][\\s\\S]*${word}`), (c: string) => [inDomain(openTicket(c, brief), domain, basis), reply(c, "好")]);
const exchangesOf = (fake: Fake, conversation: string): Exchange[] => fake.exchanges.filter((e: Exchange) => e.conversation === conversation);
const toolCards = (fake: Fake, conversation: string) => exchangesOf(fake, conversation).flatMap((e) => e.cards.filter((c) => c.startsWith("[模块工具]")));
const gatewayLines = (state: string) => readFileSync(join(state, "host.log"), "utf8").split("\n").filter((l) => l.includes("[gateway]"));
const outputOf = (card: string) => JSON.parse(card.slice(card.indexOf("：") + 1)) as Record<string, unknown>;
const sameOutput = (card: string | undefined, expect: Record<string, unknown>) => card !== undefined && card.includes("：{") && JSON.stringify(outputOf(card)) === JSON.stringify(expect);

const OFFLINE_MARKET = {
	sources: [{ name: "us-market", feed: { kind: "e2e-market", settings: { watchlist: ["NVDA"], bands: { default: [3, 5, 8] }, volumeSpikeX: 5, everySeconds: 60, minGapMs: 12000, baseURL: "https://api.massive.com" } } }],
};
/** The market source with an offline client and a clock fixed at Wednesday 10:00 New York. Callers serve only the state's modules, so it does not clash with the bundled us-market. */
function marketState(tree: string, state: string) {
	const quotes = join(state, "quotes");
	mkdirSync(quotes, { recursive: true });
	writeFileSync(join(quotes, "1.json"), JSON.stringify({ symbol: "NVDA", price: 132.48, prevClose: 120 }));
	// Without its agents/ folder the copy has no team.
	const { team: _team, ...manifest } = JSON.parse(readFileSync(join(tree, "modules/us-market/module.json"), "utf8"));
	mkdirSync(join(state, "modules/us-market"), { recursive: true });
	writeFileSync(join(state, "modules/us-market/module.json"), JSON.stringify({ ...manifest, sources: OFFLINE_MARKET.sources }));
	return { imports: ["./tests/e2e/market-offline-preload.mjs"], env: { PSA_E2E_QUOTES_DIR: quotes } };
}

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		const seen: string[] = [];
		const lines: string[] = [];
		for (const [name, tree] of [["trunk", trunk()], ["head", HEAD]] as const) {
			const state = stateDir(false);
			const extra = marketState(tree, state);
			const brief = `${name} 查交易时段`;
			const fake = await FakeModel.start({
				router: [opens("查交易时段", brief, "us-market")],
				workers: [worker(brief, on("查时段", /^\[任务说明\]/, () => [{ name: "lookup", args: { source: "us-market", op: "session", args: {} } }]))],
			});
			const host = await boot(state, fake, { modulesDirs: [join(state, "modules")] }, tree, extra);
			try {
				just(state, ["say", "帮我查交易时段"], tree);
				await within(30_000, () => exchangesOf(fake, brief).some((e) => e.toolResults.length > 0));
				const result = exchangesOf(fake, brief).flatMap((e) => e.toolResults).join("\n");
				seen.push(result);
				lines.push(`${name}: lookup session -> ${result}`);
			} finally {
				await host.stop();
				await fake.close();
			}
		}
		return { pass: seen[0] !== "" && seen[0] === seen[1] && /"phase"/.test(seen[0]!), evidence: lines.join("\n") };
	});

	{
		const state = stateDir();
		const B = { call: "L2 算税", other: "L3 施工", off: "L4 停用", uses: "L5 派给记账员", member: "L5 记账", infer: "L6 推断", secret: "L7 密钥", spin: "L8 死循环", oldT: "L9 旧任务", newT: "L9 新任务" };
		const after = (label: string, next: () => Call[] | string) => on(label, /^\[模块工具\]/, () => next());
		const fake = await FakeModel.start({
			router: [
				opens("L2", B.call), opens("L3", B.other, "pi-pi"), opens("L4", B.off), opens("L5", B.uses), opens("L6", B.infer, "personal-tax", "inference"),
				opens("L7", B.secret), opens("L8", B.spin), opens("L9 旧", B.oldT), opens("L9 新", B.newT),
			],
			workers: [
				worker(B.call, on("L2 调用", /^\[任务说明\]/, () => [domainTool("tax-bracket", CASES[1]!.input)]), on("L2 汇报", /^\[模块工具\]/, (c: string) => [report("ready", c)])),
				worker(B.other, on("L3 调用", /^\[任务说明\]/, () => [domainTool("tax-bracket", CASES[1]!.input)])),
				worker(
					B.off,
					on("L4 第一次", /^\[任务说明\]/, () => [domainTool("tax-bracket", CASES[1]!.input)]),
					after("L4 关掉再调", () => {
						just(state, ["module", "off", "personal-tax"]);
						blockUntil(5000, () => moduleState(state)?.at === "disabled");
						return [domainTool("tax-bracket", CASES[1]!.input)];
					}),
					on("L4 汇报", /^\[模块工具\]/, (c: string) => [report("blocked", c)]),
				),
				worker(B.uses, on("L5 派活", /^\[任务说明\]/, () => [dispatch("clerk", B.member)]), on("L5 汇报", /^\[成员回复\]/, (c: string) => [report("ready", c)])),
				worker(B.member, on("L5 成员调用", /^\[派活\]/, () => [domainTool("tax-bracket", CASES[1]!.input)]), on("L5 成员回复", /^\[模块工具\]/, (c: string) => c)),
				worker(B.infer, on("L6 调用", /^\[任务说明\]/, () => [domainTool("file-return", { note: "x" })]), on("L6 汇报", /^\[模块工具\]/, (c: string) => [report("ready", c)])),
				worker(B.secret, on("L7 调用", /^\[任务说明\]/, () => [domainTool("env-probe", { note: "x" })]), on("L7 汇报", /^\[模块工具\]/, (c: string) => [report("ready", c)])),
				worker(B.spin, on("L8 调用", /^\[任务说明\]/, () => [domainTool("spin", { note: "x" })]), on("L8 汇报", /^\[模块工具\]/, (c: string) => [report("failed", c)])),
				worker(
					B.oldT,
					on("L9 旧任务第一次", /^\[任务说明\]/, () => [domainTool("tax-bracket", CASES[1]!.input)]),
					after("L9 改代码后旧任务再调", () => {
						const file = join(state, TAX, "tools/tax-bracket/index.ts");
						const before = moduleState(state)?.serving?.digest;
						writeFileSync(file, readFileSync(file, "utf8").replace("return { bracket: index + 1,", 'return { version: "v2", bracket: index + 1,'));
						blockUntil(10_000, () => moduleState(state)?.serving?.digest !== before);
						return [domainTool("tax-bracket", CASES[1]!.input)];
					}),
					on("L9 旧任务汇报", /^\[模块工具\]/, (c: string) => [report("ready", c)]),
				),
				worker(B.newT, on("L9 新任务调用", /^\[任务说明\]/, () => [domainTool("tax-bracket", CASES[1]!.input)]), on("L9 新任务汇报", /^\[模块工具\]/, (c: string) => [report("ready", c)])),
			],
		});
		const host = await boot(state, fake);
		const run = async (word: string, brief: string, cards: number, limitMs = 30_000) => {
			just(state, ["say", `${word} 请处理`]);
			const took = await within(limitMs, () => toolCards(fake, brief).length >= cards);
			return { took, cards: toolCards(fake, brief) };
		};
		try {
			await turnOn(state);

			await lane(2, "call", async () => {
				const { took, cards } = await run("L2", B.call, 1);
				const ok = sameOutput(cards[0], CASES[1]!.expect);
				return { pass: took >= 0 && ok, evidence: `card after ${took} ms: ${cards[0]}\ncases.json expects ${JSON.stringify(CASES[1]!.expect)}\nhelper offered: ${exchangesOf(fake, B.call)[0]?.tools.join(", ")}\naccess log:\n${gatewayLines(state).join("\n")}` };
			});

			await lane(3, "other", async () => {
				just(state, ["say", "L3 请处理"]);
				await within(30_000, () => exchangesOf(fake, B.other).some((e) => e.toolResults.length > 0));
				const offered = exchangesOf(fake, B.other)[0]?.tools ?? [];
				const result = exchangesOf(fake, B.other).flatMap((e) => e.toolResults).join("\n");
				return { pass: !offered.includes("domain_tool") && /domain_tool/.test(result) && !/bracket/.test(result), evidence: `pi-pi helper offered: ${offered.join(", ")}\ntool result: ${result}` };
			});

			await lane(4, "disabled", async () => {
				const { took, cards } = await run("L4", B.off, 2);
				const pass = took >= 0 && sameOutput(cards[0], CASES[1]!.expect) && /所属模块已停用/.test(cards[1] ?? "");
				const out = { pass, evidence: `first: ${cards[0]}\nsecond, after just module off: ${cards[1]}\nmodule state: ${JSON.stringify(moduleState(state))}\naccess log:\n${gatewayLines(state).slice(-2).join("\n")}` };
				await turnOn(state);
				return out;
			});

			await lane(5, "uses", async () => {
				const { took, cards } = await run("L5", B.member, 1);
				const offered = exchangesOf(fake, B.member)[0]?.tools ?? [];
				return { pass: took >= 0 && /uses 没有列这一项/.test(cards[0] ?? "") && offered.includes("domain_tool"), evidence: `clerk (uses: tools/tax-note) offered: ${offered.join(", ")}\nclerk's tax-bracket call: ${cards[0]}\naccess log:\n${gatewayLines(state).filter((l) => l.includes("clerk")).join("\n")}` };
			});

			await lane(6, "infer", async () => {
				const { took, cards } = await run("L6", B.infer, 1);
				const ticket = query<{ basis: string }>(state, `SELECT basis FROM tickets WHERE title = '${B.infer}'`)[0];
				return { pass: took >= 0 && ticket?.basis === "inference" && /只读/.test(cards[0] ?? ""), evidence: `ticket basis ${ticket?.basis}\nfile-return (effect write): ${cards[0]}\naccess log:\n${gatewayLines(state).filter((l) => l.includes("file-return")).join("\n")}` };
			});

			await lane(7, "secret", async () => {
				const { took, cards } = await run("L7", B.secret, 1);
				return { pass: took >= 0 && sameOutput(cards[0], { named: "named-value", unnamed: null }), evidence: `secrets.env has TAX_KEY and OTHER_KEY; tool.json names TAX_KEY\nenv-probe: ${cards[0]}` };
			});

			await lane(8, "timeout", async () => {
				const started = performance.now();
				just(state, ["say", "L8 请处理"]);
				await within(10_000, () => exchangesOf(fake, B.spin).length > 0);
				await sleep(3000);
				const pinged = performance.now();
				const page = await fetch(host.url).then((r) => r.status, (e) => String(e));
				const pingMs = Math.round(performance.now() - pinged);
				const took = await within(40_000, () => toolCards(fake, B.spin).length > 0);
				const card = toolCards(fake, B.spin)[0] ?? "";
				const total = Math.round(performance.now() - started);
				const line = gatewayLines(state).find((l) => l.includes("tools/spin")) ?? "";
				const ms = Number(line.match(/(\d+) ms$/)?.[1] ?? 0);
				return { pass: took >= 0 && /20 s/.test(card) && ms >= 19_000 && ms < 25_000 && typeof page === "number" && pingMs < 1000, evidence: `web page during the spin: status ${page} in ${pingMs} ms\nspin result after ${total} ms total: ${card}\naccess log: ${line}` };
			});

			await lane(9, "hot", async () => {
				const before = moduleState(state)?.serving?.digest;
				const old = await run("L9 旧", B.oldT, 2, 40_000);
				const fresh = await run("L9 新", B.newT, 1);
				const after = moduleState(state)?.serving?.digest;
				const pass = old.took >= 0 && fresh.took >= 0 && before !== after && sameOutput(old.cards[0], CASES[1]!.expect) && sameOutput(old.cards[1], CASES[1]!.expect) && sameOutput(fresh.cards[0], { version: "v2", ...CASES[1]!.expect });
				const pins = query(state, "SELECT title, substr(module_digest, 1, 12) AS pin FROM tickets WHERE title LIKE 'L9%'");
				return { pass, evidence: `serving ${before?.slice(0, 12)} -> ${after?.slice(0, 12)}\nold ticket before the save: ${old.cards[0]}\nold ticket after the save: ${old.cards[1]}\nnew ticket: ${fresh.cards[0]}\npins: ${JSON.stringify(pins)}` };
			});
		} finally {
			writeFileSync(join(outDir, "f3-fake.jsonl"), fake.jsonl());
			await host.stop();
			await fake.close();
		}
	}

	await lane(10, "real", async () => {
		const state = stateDir();
		let host: Host;
		try {
			host = await boot(state, null);
		} catch (error) {
			return { pass: "inconclusive", evidence: `a real host could not start: ${String((error as Error).stack ?? error)}` };
		}
		try {
			await turnOn(state);
			just(state, ["say", "我今年的应税所得是 25000 美元，按个人报税模块的税率表，落在第几档、要交多少税？"]);
			const took = await within(300_000, () => query(state, "SELECT id FROM reports WHERE status IN ('ready', 'blocked', 'failed', 'no_action')").length > 0);
			const reports = query<{ status: string; summary: string }>(state, "SELECT status, summary FROM reports ORDER BY seq");
			const tickets = query(state, "SELECT id, domain, title FROM tickets");
			const access = gatewayLines(state);
			const called = access.some((l) => /tools\/tax-bracket .* ok /.test(l));
			const cited = reports.some((r) => /(?<![\d,])4,?000(?![\d,])/.test(r.summary));
			return { pass: took >= 0 && called && cited, evidence: `models ${JSON.stringify(REAL)}\nreport after ${took} ms\ntickets: ${JSON.stringify(tickets)}\naccess log:\n${access.join("\n")}\nreports:\n${reports.map((r) => `${r.status}: ${r.summary}`).join("\n")}` };
		} finally {
			await host.stop();
		}
	});
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (name: string, xs: number[], unit: string) => `${name}: median ${median(xs).toFixed(0)} ${unit}, runs ${xs.map((t) => t.toFixed(0)).join(" ")}, spread ${(Math.max(...xs) - Math.min(...xs)).toFixed(0)} ${unit}`;
const lookupMs = (state: string) => readFileSync(join(state, "host.log"), "utf8").split("\n").flatMap((l) => (/\[us-market\] lookup session.*总计 \d+ms/.test(l) ? [Number(l.match(/总计 (\d+)ms/)![1])] : []));
const gatewayMs = (state: string) => gatewayLines(state).flatMap((l) => (/tools\/tax-bracket .* ok /.test(l) ? [Number(l.match(/(\d+) ms$/)![1])] : []));

async function perf(): Promise<void> {
	const N = 20;
	const lookup = { name: "lookup", args: { source: "us-market", op: "session", args: {} } };
	const out: string[] = [];

	const base = stateDir(false);
	{
		const tree = trunk();
		const fake = await FakeModel.start({ router: [opens("基线", "基线", "us-market")], workers: [worker("基线", on("20 次 lookup", /^\[任务说明\]/, () => Array.from({ length: N }, () => lookup)))] });
		const host = await boot(base, fake, { modulesDirs: [join(base, "modules")] }, tree, marketState(tree, base));
		try {
			just(base, ["say", "基线 请处理"], tree);
			await within(60_000, () => lookupMs(base).length >= N);
		} finally {
			await host.stop();
			await fake.close();
		}
	}

	const state = stateDir();
	const call = () => [domainTool("tax-bracket", CASES[1]!.input)];
	const fake = await FakeModel.start({
		router: [opens("算税", "算税"), opens("查时段", "查时段", "us-market")],
		workers: [
			worker("算税", on("第 1 次", /^\[任务说明\]/, call), ...Array.from({ length: N - 1 }, (_, i) => on(`第 ${i + 2} 次`, /^\[模块工具\]/, call))),
			worker("查时段", on("20 次 lookup", /^\[任务说明\]/, () => Array.from({ length: N }, () => lookup))),
		],
	});
	const host = await boot(state, fake, { modulesDirs: [join(state, "modules")] }, HEAD, marketState(HEAD, state));
	try {
		await turnOn(state);
		just(state, ["say", "算税 请处理"]);
		just(state, ["say", "查时段 请处理"]);
		await within(120_000, () => gatewayMs(state).length >= N && lookupMs(state).length >= N);
	} finally {
		await host.stop();
		await fake.close();
	}
	const turns = exchangesOf(fake, "算税").map((e) => e.at);
	const turnMs = turns.slice(1).map((at, i) => at - turns[i]!);
	const trunkLookup = lookupMs(base);
	const headLookup = lookupMs(state);
	const tax = gatewayMs(state);
	const pass = tax.length === N && median(tax) <= 150;
	out.push(
		`${pass ? "PASS" : "FAIL"} perf: domain_tool tax-bracket, host side from the request reaching the Gateway to its reply (spawn + run included), ${N} calls on one host while another ticket makes ${N} lookups (rule: median over 150 ms fails)`,
		line("  trunk lookup session (baseline, host side)", trunkLookup, "ms"),
		line("  head lookup session (host side)", headLookup, "ms"),
		line("  head tax-bracket (host side)", tax, "ms"),
		line("  head one Worker turn with one tax-bracket call (fake model request to request, Pi and the fake model included)", turnMs, "ms"),
	);
	const text = out.join("\n");
	writeFileSync(join(outDir, "f3-perf.txt"), `${text}\n`);
	console.log(text);
}

await (mode === "perf" ? perf() : lanes());
