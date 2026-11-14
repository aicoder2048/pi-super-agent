import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { openStore, setModuleSwitch } from "../../src/kernel/store.ts";

const PKG = join(import.meta.dirname, "../../docs/modules/examples/stock-ta");
const SET_AT = Date.parse("2026-11-05T15:00:00Z");
const NINE = ["NVDA", "AMD", "AAPL", "AMZN", "MSFT", "META", "GOOGL", "SPY", "QQQ"];

type Wire = { symbol: string; condition: Record<string, unknown> };
const day = (symbol: string, pct: number, dir = "either"): Wire => ({ symbol, condition: { kind: "day", pct, dir } });

function world(t: TestContext, o: { tripwires?: Wire[]; watchlist?: string[]; stockTa?: "on" | "off" | "absent" } = {}) {
	const state = mkdtempSync(join(tmpdir(), "psa-migrate-"));
	t.after(() => rmSync(state, { recursive: true, force: true }));
	const { tripwires, watchlist = NINE, stockTa = "on" } = o;
	if (stockTa !== "absent") cpSync(PKG, join(state, "modules", "stock-ta"), { recursive: true });
	const db = openStore(join(state, "state.db"));
	if (stockTa !== "absent") setModuleSwitch(db, "stock-ta", stockTa === "on");
	if (tripwires) db.prepare("INSERT INTO source_user_data (source, data, updated_at) VALUES ('us-market', ?, 0)").run(JSON.stringify({ version: 1, tripwires: tripwires.map((w) => ({ ...w, setAt: SET_AT })) }));
	db.close();
	const run = (...args: string[]) => {
		const r = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/cli/migrate-us-market.ts", ...args], { env: { ...process.env, PSA_STATE_DIR: state }, encoding: "utf8", timeout: 20_000 });
		return { status: r.status, out: (r.stdout + r.stderr).trim() };
	};
	if (watchlist.length > 0) {
		const seeded = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "-e", `
			const { loadConfig, loadModules } = await import("./src/host/config.ts");
			const { instanceData } = await import("./src/modules/instance-data.ts");
			const config = loadConfig();
			const pkg = loadModules(config).packages.find((p) => p.name === "stock-ta");
			instanceData(config.stateDir).write("stock-ta", pkg.scan.scan.components, "watchlist", ${JSON.stringify(watchlist.map((symbol) => ({ symbol })))}, "使用者口述", "test");
		`], { env: { ...process.env, PSA_STATE_DIR: state }, encoding: "utf8", input: "" });
		assert.equal(seeded.status, 0, seeded.stderr);
	}
	const read = <T>(sql: string): T[] => {
		const data = new DatabaseSync(join(state, "modules-data", "stock-ta", "data.db"), { readOnly: true });
		try {
			return data.prepare(sql).all().map((r) => ({ ...r })) as T[];
		} finally {
			data.close();
		}
	};
	const conditions = () => read<{ id: string; key: string; kind: string; params: string }>("SELECT id, key, kind, params FROM _conditions ORDER BY id");
	const listed = () => {
		const latest = new Map<string, boolean>();
		for (const r of read<{ symbol: string; removedAt: string | null }>("SELECT symbol, removedAt FROM watchlist ORDER BY _id")) latest.set(r.symbol, r.removedAt !== null);
		return [...latest].filter(([, out]) => !out).map(([s]) => s);
	};
	const usMarket = () => {
		const db = new DatabaseSync(join(state, "state.db"), { readOnly: true });
		try {
			return (db.prepare("SELECT data FROM source_user_data WHERE source = 'us-market'").get() as { data: string } | undefined)?.data;
		} finally {
			db.close();
		}
	};
	return { state, run, conditions, listed, usMarket };
}

test("迁移：一条 day 变成一条 day-move；默认只打印不写；自选股默认划掉 AMZN、AAPL", (t) => {
	const w = world(t, { tripwires: [day("NVDA", 1)] });
	const dry = w.run();
	assert.equal(dry.status, 0, dry.out);
	assert.match(dry.out, /新建\s+NVDA\s+当天涨跌 1%\s+→ cnd_usm_NVDA_day 当天相对昨收涨跌到 1%/);
	assert.match(dry.out, /划掉\s+AMZN/);
	assert.match(dry.out, /划掉\s+AAPL/);
	assert.match(dry.out, /只打印，没有写/);
	assert.deepEqual(w.conditions(), []);
	assert.deepEqual(w.listed(), NINE);
	const applied = w.run("--apply");
	assert.equal(applied.status, 0, applied.out);
	assert.deepEqual(w.conditions(), [{ id: "cnd_usm_NVDA_day", key: "NVDA", kind: "day-move", params: JSON.stringify({ atLeast: 1, direction: "either" }) }]);
	assert.deepEqual(w.listed(), NINE.filter((s) => s !== "AMZN" && s !== "AAPL"));
});

test("迁移：重跑 --apply 打印「全部不变」，不多出条件，也不多写自选股行", (t) => {
	const w = world(t, { tripwires: [day("NVDA", 1)] });
	w.run("--apply");
	const again = w.run("--apply");
	assert.equal(again.status, 0, again.out);
	assert.match(again.out, /全部不变/);
	assert.equal(w.conditions().length, 1);
});

test("迁移：盯盘条件的参数变了，重跑把同一条更新成新参数", (t) => {
	const w = world(t, { tripwires: [day("NVDA", 1)] });
	w.run("--apply");
	const db = openStore(join(w.state, "state.db"));
	db.prepare("UPDATE source_user_data SET data = ? WHERE source = 'us-market'").run(JSON.stringify({ version: 1, tripwires: [{ ...day("NVDA", 2, "up"), setAt: SET_AT }] }));
	db.close();
	const again = w.run("--apply");
	assert.match(again.out, /更新\s+NVDA/);
	assert.deepEqual(w.conditions().map((c) => c.params), [JSON.stringify({ atLeast: 2, direction: "up" })]);
});

test("迁移：--keep-watchlist 不动自选股", (t) => {
	const w = world(t, { tripwires: [day("NVDA", 1)] });
	const kept = w.run("--apply", "--keep-watchlist");
	assert.doesNotMatch(kept.out, /划掉/);
	assert.deepEqual(w.listed(), NINE);
});

test("迁移：--undo 只删 cnd_usm_ 开头的条件，加回迁移划掉的自选股，别的条件不动", (t) => {
	const w = world(t, { tripwires: [day("NVDA", 1)] });
	w.run("--apply");
	const mine = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "-e", `
		const { loadConfig, loadModules } = await import("./src/host/config.ts");
		const { instanceData } = await import("./src/modules/instance-data.ts");
		const config = loadConfig();
		const pkg = loadModules(config).packages.find((p) => p.name === "stock-ta");
		instanceData(config.stateDir).watch("stock-ta", pkg.scan.scan.components, { kind: "watch", collection: "quotes", op: "set", watch: { key: "AMD", condition: { when: "above", value: 200 } } }, "test");
	`], { env: { ...process.env, PSA_STATE_DIR: w.state }, encoding: "utf8" });
	assert.equal(mine.status, 0, mine.stderr);
	const undone = w.run("--undo");
	assert.equal(undone.status, 0, undone.out);
	assert.match(undone.out, /删掉\s+NVDA\s+cnd_usm_NVDA_day/);
	assert.deepEqual(w.conditions().map((c) => c.key), ["AMD"]);
	assert.deepEqual(new Set(w.listed()), new Set(NINE));
	assert.match(w.run("--undo").out, /全部不变/);
});

test("迁移：有 cost 或 cross 时 --apply 失败，说明是哪一种，什么都不写", (t) => {
	const w = world(t, { tripwires: [day("NVDA", 1), { symbol: "AMD", condition: { kind: "cost", pct: 10, dir: "down", basis: 150 } }, { symbol: "MSFT", condition: { kind: "cross", fast: 5, slow: 20 } }] });
	const run = w.run("--apply");
	assert.notEqual(run.status, 0);
	assert.match(run.out, /AMD.*cost/);
	assert.match(run.out, /MSFT.*cross/);
	assert.deepEqual(w.conditions(), []);
	assert.deepEqual(w.listed(), NINE);
});

test("迁移：代码不在 stock-ta 自选股里时失败，说明先加回自选股，什么都不写", (t) => {
	const w = world(t, { tripwires: [day("TSLA", 3)] });
	const run = w.run("--apply");
	assert.notEqual(run.status, 0);
	assert.match(run.out, /TSLA.*自选股/);
	assert.deepEqual(w.conditions(), []);
	assert.deepEqual(w.listed(), NINE);
});

test("迁移：stock-ta 关着或不在时一行说明，退出码非零", (t) => {
	const off = world(t, { tripwires: [day("NVDA", 1)], stockTa: "off", watchlist: [] }).run();
	assert.notEqual(off.status, 0);
	assert.match(off.out, /stock-ta 关着/);
	assert.equal(off.out.split("\n").length, 1);
	const absent = world(t, { tripwires: [day("NVDA", 1)], stockTa: "absent", watchlist: [] }).run();
	assert.notEqual(absent.status, 0);
	assert.match(absent.out, /没有找到 stock-ta/);
});

test("迁移：state.db 里没有 us-market 的数据时打印「没有盯盘条件」", (t) => {
	const w = world(t);
	const run = w.run("--keep-watchlist");
	assert.equal(run.status, 0, run.out);
	assert.match(run.out, /没有盯盘条件/);
});

test("迁移：不改、不删 us-market 原来的那一行", (t) => {
	const w = world(t, { tripwires: [day("NVDA", 1)] });
	const before = w.usMarket();
	w.run("--apply");
	w.run("--undo");
	assert.equal(w.usMarket(), before);
});
