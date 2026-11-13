// node --import ./src/pi-runtime.mjs docs/modules/evidence/r1-live.ts [lanes|perf] [outDir]
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const USER = 42;
const MINUTE = 60_000;
const [mode = "lanes", outDir = "/tmp/swarm-r1/owner"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const R = await import(join(HEAD, "docs/modules/evidence/replay-day.ts"));
type Posted = { minute: string; externalId: string; text: string };

const TRUNK = join(outDir, "trunk");
if (!existsSync(TRUNK)) {
	spawnSync("git", ["worktree", "add", "--detach", TRUNK, "origin/main"], { cwd: HEAD, stdio: "inherit" });
	symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
}

const made: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "psa-r1-"));
	made.push(dir);
	return dir;
};
const show = (posted: readonly Posted[]) => posted.map((p) => `  ${p.minute}  ${p.externalId}  ${p.text}`).join("\n") || "  (none)";
const minutes = (posted: readonly Posted[]) => posted.map((p) => p.minute);
const query = (path: string, sql: string) => {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(sql).all().map((r) => ({ ...r })) as Record<string, unknown>[];
	} finally {
		db.close();
	}
};
const dataDb = (state: string) => join(state, "modules-data", "stock-ta", "data.db");
function cli(tree: string, state: string, script: string, args: string[]) {
	const run = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", script, ...args], { cwd: tree, env: { ...process.env, PSA_STATE_DIR: state }, encoding: "utf8", timeout: 60_000 });
	return { status: run.status, out: (run.stdout + run.stderr).trim() };
}

const results: string[] = [];
type Verdict = { pass: boolean; evidence: string };
async function lane(n: number, slug: string, body: () => Promise<Verdict>): Promise<void> {
	let verdict: Verdict;
	try {
		verdict = await body();
	} catch (error) {
		verdict = { pass: false, evidence: String((error as Error).stack ?? error) };
	}
	const file = join(outDir, `r1-${slug}.txt`);
	writeFileSync(file, `${verdict.pass ? "PASS" : "FAIL"} lane ${n}\n${verdict.evidence}\n`);
	results.push(`${verdict.pass ? "PASS" : "FAIL"}  lane ${n} ${slug}  ${file}`);
	console.log(results.at(-1));
}

const dayMove = (atLeast: number, key = "NVDA", direction?: string) => ({ key, condition: { when: "day-move", atLeast, ...(direction && { direction }) } });

async function lanes(): Promise<void> {
	await lane(1, "regression", async () => {
		const day = R.scenario("nvda-5");
		const above = [{ key: "NVDA", condition: { when: "above", value: 105 } }];
		const trunk = await R.replay(TRUNK, temp(), day, ["NVDA"], above);
		const head = await R.replay(HEAD, temp(), day, ["NVDA"], above);
		const normalize = (text: string) => text.replace(/^自选股报价（延迟 15 分钟） /, "").replace(/，来自 stock-ta\/quotes）/, "，延迟行情）");
		const sameEvents = JSON.stringify(minutes(trunk.posted)) === JSON.stringify(minutes(head.posted));
		const textsDifferOnlyThere = trunk.posted.every((p: Posted, i: number) => normalize(p.text) === head.posted[i]?.text);
		return {
			pass: sameEvents && textsDifferOnlyThere && head.posted.length > 0,
			evidence: `scenario nvda-5 (${day.title}), condition above 105, same replay on trunk and head\ntrunk:\n${show(trunk.posted)}\nhead:\n${show(head.posted)}\nsame minutes and symbols: ${sameEvents}\ntexts differ only by the dropped data name and 「来自 stock-ta/quotes」→「延迟行情」: ${textsDifferOnlyThere}\ntrunk has no day-move; lanes 2 to 7 cover it`,
		};
	});

	await lane(2, "once", async () => {
		const day = R.scenario("ladder");
		const r = await R.replay(HEAD, temp(), day, ["NVDA"], [dayMove(5)], 4);
		return { pass: JSON.stringify(minutes(r.posted)) === '["11-12 09:50"]', evidence: `scenario ladder (${day.title}), day-move 5% either, host restarted before round 5\n${show(r.posted)}\nexpected one alert at 11-12 09:50, the first minute at the line` };
	});

	await lane(3, "both-ways", async () => {
		const day = R.scenario("both-ways");
		const r = await R.replay(HEAD, temp(), day, ["NVDA"], [dayMove(5, "NVDA", "either")]);
		const want = ["11-12 10:00", "11-12 13:00", "11-13 10:00", "11-13 14:00"];
		return { pass: JSON.stringify(minutes(r.posted)) === JSON.stringify(want), evidence: `scenario both-ways (${day.title}), day-move 5% either\n${show(r.posted)}\nexpected ${want.join(", ")}: day 1 up and down, day 2 up and down` };
	});

	await lane(4, "rounding", async () => {
		const day = R.scenario("rounding");
		const r = await R.replay(HEAD, temp(), day, ["NVDA"], [dayMove(5)]);
		return { pass: JSON.stringify(minutes(r.posted)) === '["11-12 09:47"]', evidence: `scenario rounding (${day.title}), day-move 5%\n${show(r.posted)}\nexpected nothing at 09:46 (+4.996%) and one alert at 09:47 (+5.00%)` };
	});

	await lane(5, "fresh", async () => {
		const pre = R.scenario("premarket-first");
		const early = await R.replay(HEAD, temp(), pre, ["NVDA"], [dayMove(5)]);
		const holiday = R.scenario("holiday");
		const off = await R.replay(HEAD, temp(), holiday, ["NVDA"], [dayMove(5)]);
		const pass = JSON.stringify(minutes(early.posted)) === '["11-12 09:40"]' && early.rows === 2 && early.notices.length === 1 && off.posted.length === 0 && off.rows === 0 && off.notices.length === 0;
		return {
			pass,
			evidence: `scenario premarket-first (${pre.title}), day-move 5%\n  quote rows written: ${early.rows} (the two 9:15 snapshots are not; 09:31 and 09:40 are)\n  5% rule notices: ${JSON.stringify(early.notices)}\n${show(early.posted)}\nscenario holiday (${holiday.title})\n  quote rows written: ${off.rows}, notices: ${off.notices.length}\n${show(off.posted)}`,
		};
	});

	const host = await stockTaHost();
	try {
		await lane(6, "chat-set", async () => {
			host.market.prevClose.AMD = 100;
			await host.say("AMD 当天涨跌 5% 提醒我");
			const set = host.conditions();
			await host.round("10:00", { AMD: 103 });
			await host.round("10:01", { AMD: 105.2 });
			await host.say("把 AMD 的提醒改成 3%");
			await host.round("10:02", { AMD: 105.3 });
			const alerts = host.alerts().filter((a) => String(a.text).startsWith("AMD"));
			const receipts = host.receipts.join("\n");
			const pass = set.length === 1 && set[0]!.kind === "day-move" && /当天相对昨收涨跌到 5%/.test(receipts) && /当天相对昨收涨跌到 3%/.test(receipts) && alerts.length === 2 && host.conditions().length === 1;
			return { pass, evidence: `a Worker on a request ticket set the condition through worker.watch, as the fake model's script does\n_conditions after the first message: ${JSON.stringify(set)}\nreceipts:\n${receipts}\n_conditions after the change: ${JSON.stringify(host.conditions())}\nalerts posted (rounds 10:00 +3%, 10:01 +5.2%, 10:02 +5.3% after the change to 3%):\n${alerts.map((a) => `  ${a.external_id}  ${a.text}`).join("\n")}` };
		});

		await lane(8, "telegram", async () => {
			host.data().watch("stock-ta", host.components(), { kind: "watch", collection: "quotes", op: "set", watch: dayMove(5) }, "page");
			for (const tick of R.ticks(R.scenario("nvda-5"))) await host.roundAt(tick);
			await host.until(() => host.phone().some((m) => m.startsWith("提醒 · 股票技术分析：NVDA")));
			const fresh = host.phone().find((m) => m.startsWith("提醒 · 股票技术分析：NVDA"))!;
			const [old] = await R.oldTripwire(TRUNK, R.scenario("nvda-5"), { symbol: "NVDA", condition: { kind: "day", pct: 5, dir: "either" } });
			const before = `盯盘提醒：${old!.text}`;
			const png = join(outDir, "r1-telegram.png");
			await sideBySide(png, before, fresh);
			const pass = fresh.split("股票技术分析").length === 2 && fresh.includes("昨收 100.00") && fresh.includes("延迟行情") && !fresh.includes("来自") && !fresh.includes("自选股报价") && !/\n/.test(fresh);
			return { pass, evidence: `fake Telegram, scenario nvda-5, day-move 5% on head; trunk's us-market tripwire (day 5%) on the same quotes\nbefore (trunk): ${before}\nafter (head):  ${fresh}\nscreenshot: ${png}` };
		});
	} finally {
		await host.stop();
	}

	await lane(7, "no-prev-close", async () => {
		const state = temp();
		const pkg = join(state, "modules", "weights");
		mkdirSync(join(pkg, "data", "weights"), { recursive: true });
		writeFileSync(join(pkg, "module.json"), JSON.stringify({ schema: 1, name: "weights", version: "0.1.0" }));
		writeFileSync(join(pkg, "data", "weights", "collection.json"), JSON.stringify({ title: "体重", kind: "series", class: "shareable", fields: { who: { type: "text", title: "谁" }, kg: { type: "number", title: "公斤" }, on: { type: "date", title: "日期" } }, watch: { key: "who", value: "kg", at: "on" } }));
		const { scanPackage } = await import(join(HEAD, "src/modules/validate.ts"));
		const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
		const scan = scanPackage(pkg, { runCases: false, folder: "weights" });
		if (!scan.ok) throw new Error(JSON.stringify(scan.problems));
		let refusal = "";
		try {
			instanceData(state).watch("weights", scan.scan.components, { kind: "watch", collection: "weights", op: "set", watch: { key: "我", condition: { when: "day-move", atLeast: 5 } } }, "page");
		} catch (error) {
			refusal = (error as Error).message;
		}
		return { pass: /没有昨收这一列/.test(refusal), evidence: `a sample module whose series has a watch without prevClose; set day-move 5%\nrefusal: ${refusal || "(none: accepted)"}` };
	});

	const migrated = temp();
	await lane(9, "migrate", async () => {
		const backup = await trunkTripwire(migrated, { kind: "day", pct: 5, dir: "either" });
		const dry = cli(HEAD, migrated, "src/cli/migrate-us-market.ts", []);
		const apply = cli(HEAD, migrated, "src/cli/migrate-us-market.ts", ["--apply"]);
		const again = cli(HEAD, migrated, "src/cli/migrate-us-market.ts", ["--apply"]);
		const conditions = query(dataDb(migrated), "SELECT id, key, kind, params FROM _conditions");
		copyFileSync(dataDb(migrated), join(migrated, "data.db.after-migrate"));
		const day = await R.stockTaDay(HEAD, migrated, []);
		for (const tick of R.ticks(R.scenario("nvda-5"))) await day.round(tick);
		day.close();
		const old = await R.oldTripwire(TRUNK, R.scenario("nvda-5"), { symbol: "NVDA", condition: { kind: "day", pct: 5, dir: "either" } });
		const bad = temp();
		await trunkTripwire(bad, { kind: "day", pct: 5, dir: "either" }, [{ symbol: "AMD", condition: { kind: "cost", pct: 10, dir: "down", basis: 150 } }, { symbol: "MSFT", condition: { kind: "cross", fast: 5, slow: 20 } }]);
		const refused = cli(HEAD, bad, "src/cli/migrate-us-market.ts", ["--apply"]);
		const badConditions = query(dataDb(bad), "SELECT id FROM _conditions");
		const pass = dry.status === 0 && (dry.out.match(/新建/g) ?? []).length === 1 && apply.status === 0 && /全部不变/.test(again.out) && conditions.length === 1 && conditions[0]!.id === "cnd_usm_NVDA_day" && JSON.stringify(minutes(day.posted)) === JSON.stringify(minutes(old)) && refused.status !== 0 && badConditions.length === 0;
		writeFileSync(join(migrated, "backup-path"), backup);
		return {
			pass,
			evidence: `dir 1: trunk's tripwire edit set a day 5% tripwire on NVDA, then head:\n$ just migrate-us-market\n${dry.out}\n$ just migrate-us-market --apply\n${apply.out}\n$ just migrate-us-market --apply\n${again.out}\n_conditions: ${JSON.stringify(conditions)}\nreplay nvda-5 on head: ${show(day.posted)}\ntrunk tripwire on the same day: ${show(old)}\ndir 2: day + cost + cross\n$ just migrate-us-market --apply\nexit ${refused.status}\n${refused.out}\n_conditions rows: ${badConditions.length}`,
		};
	});

	await lane(10, "rollback", async () => {
		const { instanceData } = await import(join(TRUNK, "src/modules/instance-data.ts"));
		const { Modules } = await import(join(TRUNK, "src/modules.ts"));
		const { servedAsHost } = await import(join(TRUNK, "tests/helpers/fakes.ts"));
		const quoteRow = { symbol: "NVDA", price: 106, changePct: 6, at: "2026-11-13T15:30:00.000Z" };
		const trunkWrite = () => {
			rmSync(join(migrated, "modules", "stock-ta"), { recursive: true, force: true });
			cpSync(join(TRUNK, "docs/modules/examples/stock-ta"), join(migrated, "modules", "stock-ta"), { recursive: true });
			const entry = servedAsHost(Modules.load([join(migrated, "modules")])).feeds().find((e: { source: string }) => e.source === "stock-ta/quotes");
			const ready = instanceData(migrated).migrate("stock-ta", entry.components);
			const written = ready.ok ? instanceData(migrated).write("stock-ta", entry.components, "quotes", [quoteRow], "stock-ta/quotes", "lane-10") : undefined;
			return { ready, problem: written?.alertProblem };
		};
		const without = trunkWrite();
		const backup = String(spawnSync("cat", [join(migrated, "backup-path")], { encoding: "utf8" }).stdout);
		copyFileSync(backup, dataDb(migrated));
		const host = await trunkHost(migrated);
		const conditions = query(dataDb(migrated), "SELECT kind FROM _conditions");
		const pass = without.problem !== undefined && host.started && !conditions.some((c) => c.kind === "day-move");
		return {
			pass,
			evidence: `after lane 9's migration, trunk's stock-ta package and code on the same state, data.db not restored:\n  structure ok: ${JSON.stringify(without.ready)}; a quote write's condition check: ${without.problem ?? "(no problem)"}\nrestored the data.db backup taken before the migration, started trunk's host in-process:\n  started and stock-ta served: ${host.started}\n  ${host.note}\n  _conditions kinds: ${JSON.stringify(conditions)}`,
		};
	});

	console.log(results.join("\n"));
}

async function trunkTripwire(state: string, day: Record<string, unknown>, more: { symbol: string; condition: Record<string, unknown> }[] = []): Promise<string> {
	const { applyEdit, parseSym, serializeBook } = await import(join(TRUNK, "src/sources/market/tripwires.ts"));
	const { Kernel } = await import(join(TRUNK, "src/kernel/kernel.ts"));
	const { openStore, setModuleSwitch } = await import(join(TRUNK, "src/kernel/store.ts"));
	const nine = ["NVDA", "AMD", "AAPL", "AMZN", "MSFT", "META", "GOOGL", "SPY", "QQQ"];
	let book = new Map();
	for (const w of [{ symbol: "NVDA", condition: day }, ...more]) {
		const applied = applyEdit(book, { op: "set", symbol: parseSym(w.symbol), patch: w.condition }, nine, Date.parse("2026-11-05T15:00:00Z"));
		if (!applied.ok) throw new Error(applied.reason);
		book = applied.book;
	}
	const db = openStore(join(state, "state.db"));
	new Kernel({ db, clock: { now: () => Date.now() }, sourcePolicy: () => "candidate" }).setSourceUserData("us-market", serializeBook(book));
	setModuleSwitch(db, "stock-ta", true);
	db.close();
	const before = await R.stockTaDay(TRUNK, state, nine);
	before.close();
	const backup = join(state, "data.db.before-migrate");
	copyFileSync(dataDb(state), backup);
	rmSync(join(state, "modules", "stock-ta"), { recursive: true, force: true });
	cpSync(join(HEAD, "docs/modules/examples/stock-ta"), join(state, "modules", "stock-ta"), { recursive: true });
	return backup;
}

async function trunkHost(state: string): Promise<{ started: boolean; note: string }> {
	const { startLiveModules } = await import(join(TRUNK, "src/host/live-modules.ts"));
	const { Modules } = await import(join(TRUNK, "src/modules.ts"));
	const { openStore } = await import(join(TRUNK, "src/kernel/store.ts"));
	const { startHost } = await import(join(TRUNK, "tests/helpers/fakes.ts"));
	const logs: string[] = [];
	const modulesDir = join(state, "modules");
	const live = startLiveModules({ db: openStore(join(state, "state.db")), stateDir: state, roots: [modulesDir], discovered: Modules.load([modulesDir]), configSwitches: {}, log: (l: string) => void logs.push(l) });
	try {
		let served = false;
		for (let i = 0; i < 100 && !served; i++) {
			live.tick();
			served = live.live.current().feeds().some((f: { source: string }) => f.source === "stock-ta/quotes");
			if (!served) await new Promise((done) => setTimeout(done, 100));
		}
		const current = () => live.live.current();
		const { host } = await startHost(() => [], () => {}, { stateDir: state, log: (l: string) => void logs.push(l), domains: { book: () => current().book, kitFor: (d: string) => current().kitFor(d) }, moduleFeeds: { feeds: () => current().feeds(), fixtures: false, tickMs: 3_600_000, secret: () => undefined } });
		await host.stop();
		return { started: served, note: logs.filter((l) => /stock-ta|error|错/.test(l)).slice(0, 5).join(" | ") };
	} finally {
		live.stop();
	}
}

async function stockTaHost() {
	const { startLiveModules } = await import(join(HEAD, "src/host/live-modules.ts"));
	const { Modules } = await import(join(HEAD, "src/modules.ts"));
	const { openStore } = await import(join(HEAD, "src/kernel/store.ts"));
	const { instanceData } = await import(join(HEAD, "src/modules/instance-data.ts"));
	const { createGateway } = await import(join(HEAD, "src/modules/gateway.ts"));
	const { ModuleStore } = await import(join(HEAD, "src/modules/live.ts"));
	const { moduleDataDir } = await import(join(HEAD, "src/modules/knowledge.ts"));
	const { ids, openOnConversation, startHost } = await import(join(HEAD, "tests/helpers/fakes.ts"));
	const { BotApi, BotToken } = await import(join(HEAD, "src/host/telegram/bot-api.ts"));
	const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
	const market = { prices: {} as Record<string, number>, prevClose: { NVDA: 100 } as Record<string, number>, at: 0 };
	const server = createServer((req, res) => {
		const asked = new URL(req.url ?? "", "http://x").searchParams.get("tickers")?.split(",") ?? [];
		const tickers = asked.filter((s) => s in market.prices).map((s) => ({ ticker: s, lastTrade: { p: market.prices[s], t: market.at * 1e6 }, min: { c: market.prices[s], t: market.at, v: 1000 }, day: { c: market.prices[s], v: 5e6 }, prevDay: { c: market.prevClose[s], v: 3.9e7 } }));
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "DELAYED", tickers }));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const state = temp();
	const pkg = join(state, "modules", "stock-ta");
	cpSync(join(HEAD, "docs/modules/examples/stock-ta"), pkg, { recursive: true });
	const feedJson = join(pkg, "feeds", "quotes", "feed.json");
	const { readFileSync } = await import("node:fs");
	writeFileSync(feedJson, JSON.stringify({ ...JSON.parse(readFileSync(feedJson, "utf8")), settings: { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` } }));
	const db = openStore(join(state, "state.db"));
	(await import(join(HEAD, "src/kernel/store.ts"))).setModuleSwitch(db, "stock-ta", true);
	const logs: string[] = [];
	const live = startLiveModules({ db, stateDir: state, roots: [join(state, "modules")], discovered: Modules.load([join(state, "modules")]), configSwitches: {}, log: (l: string) => void logs.push(l) });
	const current = () => live.live.current();
	for (let i = 0; i < 200 && !current().feeds().some((f: { source: string }) => f.source === "stock-ta/quotes"); i++) {
		live.tick();
		await new Promise((done) => setTimeout(done, 100));
	}
	const components = () => current().feeds().find((f: { source: string }) => f.source === "stock-ta/quotes").components;
	const data = () => instanceData(state);
	data().write("stock-ta", components(), "watchlist", [{ symbol: "NVDA" }, { symbol: "AMD" }], "使用者口述", "r1-live");
	const tg = await FakeTelegram.start();
	const clock = { now: R.ny("2026-11-12", "09:45") };
	const receipts: string[] = [];
	const { host } = await startHost(
		(cards: string[]) => cards.flatMap((card) => {
			if (card.startsWith("[Worker 汇报]")) return [{ name: "reply", args: { text: "好的", cause: ids(card, "tkt") } }];
			return card.startsWith("[对话]") ? openOnConversation(card, undefined, "stock-ta") : [];
		}),
		async (worker: { inputs: string[]; request(m: string, p: unknown): Promise<unknown>; report(r: object): void; settle(): void }) => {
			const input = worker.inputs.join("\n");
			const set = (atLeast: number, id?: string) => worker.request("worker.watch", { op: "set", collection: "quotes", key: "AMD", condition: { when: "day-move", atLeast }, ...(id && { id }) });
			let reply: unknown;
			if (input.includes("改成 3%")) {
				const listed = (await worker.request("worker.watch", { op: "list", collection: "quotes" })) as { conditions: { id: string; key: string }[] };
				reply = await set(3, listed.conditions.find((c) => c.key === "AMD")!.id);
			} else reply = await set(5);
			receipts.push((reply as { receipt: string }).receipt);
			worker.report({ status: "ready", summary: (reply as { receipt: string }).receipt });
			worker.settle();
		},
		{
			stateDir: state,
			log: (l: string) => void logs.push(l),
			clock: { now: () => clock.now },
			domains: { book: () => current().book, kitFor: (d: string) => current().kitFor(d) },
			moduleFeeds: { feeds: () => current().feeds(), fixtures: false, tickMs: 3_600_000, secret: (n: string) => (n === "POLYGON_API_KEY" ? "sk-fake" : undefined) },
			gateway: createGateway({ copyDir: (m: string, d: string) => new ModuleStore(join(state, "module-store")).dirOf(m, d), serving: (m: string) => current().book.get(m)?.digest, dataDir: (m: string) => moduleDataDir(state, m), rows: instanceData(state), secret: () => undefined, log: (l: string) => void logs.push(l) }),
			telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 2, minGapMs: 20 } },
		},
	);
	tg.userSays(USER, "/start");
	const until = async (ok: () => boolean, limitMs = 10_000) => {
		const started = Date.now();
		while (!ok()) {
			if (Date.now() - started > limitMs) throw new Error(`timed out; log tail:\n${logs.slice(-10).join("\n")}`);
			await new Promise((done) => setTimeout(done, 50));
		}
	};
	await until(() => tg.sent.length > 0);
	const roundAt = async (tick: { now: number; at: number; prices: Record<string, number> }) => {
		Object.assign(market.prices, tick.prices);
		market.at = tick.at;
		clock.now = Math.max(clock.now + MINUTE, tick.now);
		await host.feedScheduler.tick();
		await host.settled();
	};
	return {
		market, receipts, until, roundAt, data, components,
		async say(text: string) {
			const before = receipts.length;
			host.say(text);
			await until(() => receipts.length > before);
			await host.settled();
		},
		round: (hhmm: string, prices: Record<string, number>) => roundAt({ at: R.ny("2026-11-12", hhmm), now: R.ny("2026-11-12", hhmm) + 15 * MINUTE, prices }),
		conditions: () => query(dataDb(state), "SELECT id, key, kind, params FROM _conditions"),
		alerts: () => query(join(state, "state.db"), "SELECT external_id, text FROM host_lines WHERE kind = 'alert' ORDER BY rowid"),
		phone: () => tg.sent.filter((m: { chatId: number }) => m.chatId === USER).map((m: { text: string }) => m.text),
		async stop() {
			await host.stop();
			live.stop();
			await tg.close();
			server.close();
			writeFileSync(join(outDir, "r1-host.log"), logs.join("\n"));
		},
	};
}

async function sideBySide(png: string, before: string, after: string): Promise<void> {
	const { chromium } = await import("playwright-core");
	const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
	const bubble = (title: string, text: string) => `<section><h2>${title}</h2><div class="chat"><div class="msg">${esc(text)}<span>10:20</span></div></div></section>`;
	const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#dfe7ee;font:15px/1.45 -apple-system,"PingFang SC",sans-serif;display:flex;gap:24px}section{width:420px}h2{font-size:14px;color:#456;margin:0 0 8px}.chat{background:#b9d3a8 url();border-radius:12px;padding:16px;min-height:140px;background:#c8dcc0}.msg{background:#fff;border-radius:12px 12px 12px 4px;padding:8px 12px;box-shadow:0 1px 1px rgba(0,0,0,.15);white-space:pre-wrap}.msg span{display:block;text-align:right;color:#8a9;font-size:11px}</style>${bubble("以前 · us-market 盯盘提醒", before)}${bubble("现在 · stock-ta 的 day-move 提醒", after)}`;
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 940, height: 260 }, deviceScaleFactor: 2 });
		await page.setContent(html);
		await page.screenshot({ path: png, fullPage: true });
	} finally {
		await browser.close();
	}
}

async function perf(): Promise<void> {
	const nine = ["NVDA", "AMD", "AAPL", "AMZN", "MSFT", "META", "GOOGL", "SPY", "QQQ"];
	const setup = async (tree: string, conditions: (s: string) => Record<string, unknown>[]) => {
		const day = await R.stockTaDay(tree, temp(), nine);
		for (const s of nine) for (const condition of conditions(s)) day.watch({ key: s, condition });
		return day;
	};
	const trunk = await setup(TRUNK, () => [{ when: "above", value: 103 }, { when: "above", value: 106 }, { when: "above", value: 109 }]);
	const head = await setup(HEAD, () => [{ when: "day-move", atLeast: 3 }, { when: "day-move", atLeast: 6 }, { when: "day-move", atLeast: 9 }]);
	const times = { trunk: [] as number[], head: [] as number[] };
	const start = R.ny("2026-11-12", "09:31");
	for (let i = 0; i < 30; i++) {
		const at = start + i * MINUTE;
		const tick = { day: "2026-11-12", at, now: at + 15 * MINUTE, prices: Object.fromEntries(nine.map((s, k) => [s, 100 + ((i + k) % 12)])), prevClose: Object.fromEntries(nine.map((s) => [s, 100])) };
		const [first, second] = i % 2 === 0 ? (["trunk", "head"] as const) : (["head", "trunk"] as const);
		for (const side of [first, second]) times[side].push((await (side === "trunk" ? trunk : head).round(tick)).ms);
	}
	trunk.close();
	head.close();
	const migrations: number[] = [];
	for (let i = 0; i < 5; i++) {
		const state = temp();
		await trunkTripwire(state, { kind: "day", pct: 5, dir: "either" });
		const started = performance.now();
		const run = cli(HEAD, state, "src/cli/migrate-us-market.ts", ["--apply"]);
		migrations.push(performance.now() - started);
		if (run.status !== 0) throw new Error(run.out);
	}
	const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
	const spread = (xs: number[]) => `min ${Math.min(...xs).toFixed(1)}, max ${Math.max(...xs).toFixed(1)}`;
	const slower = median(times.head) - median(times.trunk);
	const pass = slower <= 5 && median(migrations) <= 3000;
	const report = [
		`${pass ? "PASS" : "FAIL"} perf: one quotes round of 9 rows (handler process, host write, conditions; 3 conditions per symbol), trunk above x3 vs head day-move x3, 30 rounds each, alternating. Rule: head median more than 5 ms over trunk fails; migration median over 3 s fails.`,
		`  baseline trunk: median ${median(times.trunk).toFixed(1)} ms (${spread(times.trunk)})`,
		`  head:           median ${median(times.head).toFixed(1)} ms (${spread(times.head)})`,
		`  head minus trunk: ${slower.toFixed(1)} ms`,
		`  just migrate-us-market --apply, 5 fresh state dirs (node start included): median ${median(migrations).toFixed(0)} ms (${spread(migrations)})`,
	].join("\n");
	writeFileSync(join(outDir, "r1-perf.txt"), `${report}\n`);
	console.log(report);
}

try {
	await (mode === "perf" ? perf() : lanes());
} finally {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
}
