// node --import ./src/pi-runtime.mjs docs/modules/evidence/r5-parity.ts [outDir] [--write-expected]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HEAD = resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith("--")) ?? "/tmp/swarm-r5/owner";
mkdirSync(outDir, { recursive: true });
const R = await import(join(HEAD, "docs/modules/evidence/replay-day.ts"));

const TRUNK = join(outDir, "trunk");
if (!existsSync(TRUNK)) {
	spawnSync("git", ["worktree", "add", "--detach", TRUNK, "origin/main"], { cwd: HEAD, stdio: "inherit" });
	symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
}

/** The old Mac's one condition, migrated by R1: NVDA either way 1%. SPY and QQQ sit in both watchlists (Appendix B). */
const WATCHLIST = ["NVDA", "AMD", "SPY", "QQQ"];
const CONDITION = { symbol: "NVDA", day: { pct: 1, dir: "either" } };

type Event = { symbol: string; date: string; kind: "band" | "day-move"; level: number; side: string; minute: string };
const key = (e: Event) => `${e.date} ${e.minute.slice(6)} ${e.symbol} ${e.kind} ${e.side} ${e.level}`;

const usMarket = JSON.parse(readFileSync(join(TRUNK, "modules/us-market/module.json"), "utf8")).sources[0].feed.settings;
const isIndex = (s: string) => s === "SPY" || s === "QQQ";
/** Decided away (Appendix E 2, 3): the 3% tier, the index 1.5% tier, volume. */
const decidedAway = (b: { symbol: string; kind: string; pct?: number }) => b.kind === "volume" || (!isIndex(b.symbol) && b.pct === 3) || (isIndex(b.symbol) && b.pct === 1.5);

async function trunkEvents(name: string) {
	const s = R.scenario(name);
	const bands = await R.oldBands(TRUNK, s, WATCHLIST, usMarket);
	const wires = await R.oldTripwire(TRUNK, s, { symbol: CONDITION.symbol, condition: { kind: "day", ...CONDITION.day } });
	const kept: Event[] = bands.filter((b: { kind: string }) => !decidedAway(b)).map((b: { minute: string; symbol: string; date: string; side: string; pct: number }) => ({ symbol: b.symbol, date: b.date, kind: "band", level: b.pct, side: b.side, minute: b.minute }));
	const days: Event[] = wires.map((w: { minute: string; externalId: string }) => {
		const [symbol, date, signal] = w.externalId.split(":");
		const [, side, pct] = signal!.split("-");
		return { symbol: symbol!, date: date!, kind: "day-move", level: Number(pct), side: side!, minute: w.minute };
	});
	return { events: [...kept, ...days], dropped: bands.filter(decidedAway) };
}

async function headEvents(name: string) {
	const state = mkdtempSync(join(tmpdir(), "psa-r5-parity-"));
	try {
		const run = await R.replay(HEAD, state, R.scenario(name), WATCHLIST, [{ key: CONDITION.symbol, condition: { when: "day-move", atLeast: CONDITION.day.pct, direction: CONDITION.day.dir } }]);
		const bands: Event[] = run.triggered.map((t: { id: string; minute: string }) => {
			const [, symbol, date, band] = t.id.split(":");
			const [, side, level] = /^(up|down)(.+)$/.exec(band!)!;
			return { symbol: symbol!, date: date!, kind: "band", level: Number(level), side: side!, minute: t.minute };
		});
		const days: Event[] = run.posted.filter((p: { externalId: string }) => p.externalId.startsWith("cnd_")).map((p: { externalId: string; minute: string }) => {
			const [, date, side, level] = p.externalId.split(":");
			return { symbol: CONDITION.symbol, date: date!, kind: "day-move", level: Number(level), side: side!, minute: p.minute };
		});
		return { events: [...bands, ...days], lines: run.posted, triggers: run.triggered };
	} finally {
		rmSync(state, { recursive: true, force: true });
	}
}

const names = readdirSync(join(HEAD, "tests/fixtures/us-market-day")).filter((f) => f.endsWith(".json") && f !== "expected.json").map((f) => f.replace(/\.json$/, "")).sort();
const report: string[] = [];
const expected: Record<string, string[]> = {};
let pass = true;
for (const name of names) {
	const trunk = await trunkEvents(name);
	const head = await headEvents(name);
	const [a, b] = [trunk.events.map(key).sort(), head.events.map(key).sort()];
	const same = JSON.stringify(a) === JSON.stringify(b);
	pass &&= same;
	expected[name] = b;
	report.push(`${same ? "same" : "DIFFERENT"}  ${name}  (${R.scenario(name).title})`);
	report.push(`  trunk us-market, after dropping ${trunk.dropped.length} decided-away events ${JSON.stringify(trunk.dropped.map((d: { symbol: string; kind: string; pct?: number; side?: string }) => `${d.symbol} ${d.kind} ${d.side ?? ""}${d.pct ?? ""}`))}:`);
	report.push(...(a.length ? a.map((e) => `    ${e}`) : ["    (none)"]));
	report.push("  head stock-ta:");
	report.push(...(b.length ? b.map((e) => `    ${e}`) : ["    (none)"]));
	report.push("  head lines the user reads:");
	report.push(...(head.lines.length ? head.lines.map((l: { minute: string; text: string }) => `    ${l.minute}  ${l.text}`) : ["    (none)"]));
}
const verdict = `${pass ? "PASS" : "FAIL"} lane 1 parity: ${names.length} scenarios, watchlist ${WATCHLIST.join(",")} on both sides, NVDA day-move either 1% (the old Mac's migrated condition). Normalized {symbol, date, kind, level, side, minute}; trunk drops the 3% tier, the index 1.5% tier and volume first. Known differences (Appendix B): line text and prefix, thread ids, SPY/QQQ fetched every round (both watchlists hold them here), one line when a band and a day-move condition fire the same beat.`;
writeFileSync(join(outDir, "r5-parity.txt"), `${verdict}\n${report.join("\n")}\n`);
if (args.includes("--write-expected")) writeFileSync(join(HEAD, "tests/fixtures/us-market-day/expected.json"), `${JSON.stringify({ watchlist: WATCHLIST, condition: CONDITION, events: expected }, null, 1)}\n`);
console.log(verdict);
if (!pass) process.exitCode = 1;
