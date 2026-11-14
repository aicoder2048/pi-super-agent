// node --import ./src/pi-runtime.mjs docs/modules/evidence/p3-parity.ts <p2 dir> <signals.csv> [outDir]
// ma-break migration parity: replays every session of the host's two years of `ta` daily signals (exported as in p3-noise.ts)
// through stock-ta's scan feed on main before phase 3 (be11bde, settings.signals.rules plus rules.md ma-break) and on this tree
// (the watch-rules table), each through the host's runFeed with the repo's fake `ta` answering that session's real signals and
// daily bars. Every old 50-day trigger must come out as the same symbol and session's R-MA-2-50:down hit, and only in the ways
// the user decided: a silent line (level 2), a structure-trend task when the day's volume backs it, or level 0 when `ta` graded
// the signal noise. An old 50-day recovery trigger (the Router opened nothing for it) must come out as a level-0 record.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { daily, STOCKS } from "./p2-measure-data.ts";

const HEAD = resolve(import.meta.dirname, "../../..");
const [dir = "/tmp/p2m", signalsFile = "/tmp/p3m/signals.csv", outDir = "/tmp/p3-parity"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const TRUNK = join(outDir, "trunk");
if (!existsSync(TRUNK)) {
	spawnSync("git", ["worktree", "add", "--detach", TRUNK, "be11bde"], { cwd: HEAD, stdio: "inherit" });
	symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
}

const { fakeTa } = await import(join(HEAD, "tests/helpers/fake-ta.ts"));
const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const lines = readFileSync(signalsFile, "utf8");
const rows: { symbol: string; rule_id: string; kind: string; direction: string; data_start_ms: number; data_end_ms: number; price: number; values: unknown; attention: string }[] = [];
{
	const { csv } = { csv: (text: string) => {
		const out: string[][] = [];
		let row: string[] = [], cell = "", quoted = false;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i]!;
			if (quoted) ch === '"' && text[i + 1] === '"' ? ((cell += '"'), i++) : ch === '"' ? (quoted = false) : (cell += ch);
			else if (ch === '"') quoted = true;
			else if (ch === ",") (row.push(cell), (cell = ""));
			else if (ch === "\n") (row.push(cell), out.push(row), (row = []), (cell = ""));
			else if (ch !== "\r") cell += ch;
		}
		return out;
	} };
	for (const [symbol, rule_id, kind, direction, start, end, price, vals, attention] of csv(lines).slice(1)) {
		rows.push({ symbol: symbol!, rule_id: rule_id!, kind: kind!, direction: direction!, data_start_ms: Number(start), data_end_ms: Number(end), price: Number(price), values: JSON.parse(vals!), attention: attention! });
	}
}
const dateOf = (ms: number) => NY.format(new Date(ms));
const sessions = [...new Set(rows.filter((r) => STOCKS.includes(r.symbol) && r.rule_id === "R-MA-2-50").map((r) => dateOf(r.data_end_ms)))].sort();
const bars = daily(dir);
const barsThrough = (date: string) => STOCKS.flatMap((symbol) => {
	const all = bars.get(symbol) ?? [];
	const i = all.findIndex((b) => b.date === date);
	return i < 0 ? [] : all.slice(Math.max(0, i - 259), i + 1).map((b) => ({ symbol, date: b.date, close: b.close, volume: b.volume }));
});

type Run = { notices: { id: string; body: string }[]; alerts: { externalId: string; push?: string }[]; hits: { id: string; rule: string; level: number; combo?: string; text: string }[] };
async function replay(tree: string): Promise<Map<string, Run>> {
	const { Modules } = await import(join(tree, "src/modules.ts"));
	const { runFeed } = await import(join(tree, "src/modules/feed-runner.ts"));
	const { instanceData } = await import(join(tree, "src/modules/instance-data.ts"));
	const { servedAsHost } = await import(join(tree, "tests/helpers/fakes.ts"));
	const root = mkdtempSync(join(tmpdir(), "psa-p3-parity-"));
	try {
		const pkg = join(root, "modules", "stock-ta");
		cpSync(join(tree, "docs/modules/examples/stock-ta"), pkg, { recursive: true });
		const fake = fakeTa(join(root, "fake"));
		const data = instanceData(join(root, "state"));
		const feedJson = join(pkg, "feeds", "scan", "feed.json");
		const descriptor = JSON.parse(readFileSync(feedJson, "utf8"));
		const load = (now: string) => {
			writeFileSync(feedJson, JSON.stringify({ ...descriptor, settings: { ...descriptor.settings, now, ta: fake.script } }));
			return servedAsHost(Modules.load([join(root, "modules")])).feeds().find((e: { source: string }) => e.source === "stock-ta/scan");
		};
		const watched = load("2024-11-01T23:00:00.000Z");
		data.write("stock-ta", watched.components, "watchlist", STOCKS.map((symbol) => ({ symbol })), "使用者口述", "parity");
		const out = new Map<string, Run>();
		let run: Run = { notices: [], alerts: [], hits: [] };
		const ports = { data, submit: (n: { id: string; body: string }) => void run.notices.push(n), alert: (_: string, a: { externalId: string; push?: string }) => run.alerts.push(a) > 0, problem: () => {}, secret: (name: string) => (name === "POLYGON_API_KEY" ? "parity" : undefined), now: () => Date.now() };
		fake.setPlan({ kind: "ok" });
		await runFeed(watched, [], ports);
		for (const date of sessions) {
			run = { notices: [], alerts: [], hits: [] };
			const signals = rows.filter((r) => dateOf(r.data_end_ms) === date).map((r) => ({ ...r, timeframe: "1d" }));
			fake.setPlan({ kind: "ok", signals, bars: barsThrough(date) });
			const result = await runFeed(load(`${date}T23:00:00.000Z`), [], ports);
			if (!result.ok) throw new Error(`${tree} ${date}: ${result.note}`);
			const file = join(data.dir("stock-ta"), "files", "hits", date, "scan.json");
			if (existsSync(file)) run.hits = JSON.parse(readFileSync(file, "utf8")).hits;
			out.set(date, run);
		}
		return out;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const before = await replay(TRUNK);
const after = await replay(HEAD);
const problems: string[] = [];
const outcomes = new Map<string, number>();
const count = (k: string) => outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
for (const date of sessions) {
	const old = before.get(date)!;
	const now = after.get(date)!;
	for (const notice of old.notices) {
		const [, symbol, , , , direction] = notice.id.split(":") as [string, string, string, string, string, string];
		const id = `R-MA-2-50:${direction === "bearish" ? "down" : "up"}:${symbol}:${date}`;
		const hit = now.hits.find((h) => h.id === id);
		const signal = rows.find((r) => r.symbol === symbol && r.rule_id === "R-MA-2-50" && dateOf(r.data_end_ms) === date && r.direction === direction)!;
		if (hit === undefined) { problems.push(`${date} ${notice.id}: no ${id} hit`); continue; }
		if (direction !== "bearish") {
			if (hit.level !== 0 || now.alerts.some((a) => a.externalId === id) || now.notices.some((n) => n.id === id)) problems.push(`${date} ${id}: recovery is not a silent record`);
			count("50-day recovery: trigger before, level-0 record after");
			continue;
		}
		const comboId = `volume-close+R-MA-2-50:down:${symbol}:${date}`;
		if (signal.attention === "noise") {
			if (hit.level !== 0 || now.alerts.some((a) => a.externalId === id) || now.notices.some((n) => n.id === id)) problems.push(`${date} ${id}: noise is not a record`);
			count("50-day break, ta noise: task before, level-0 record after");
		} else if (hit.combo !== undefined) {
			if (!now.notices.some((n) => n.id === comboId && n.body.includes("做法 structure-trend"))) problems.push(`${date} ${id}: combo without a structure-trend task`);
			count("50-day break with volume: task before, structure-trend task after");
		} else {
			const line = now.alerts.find((a) => a.externalId === id);
			if (hit.level < 2 || line?.push !== (hit.level === 2 ? "silent" : undefined) || now.notices.some((n) => n.id === id)) problems.push(`${date} ${id}: level ${hit.level} line ${line?.push ?? "none"}`);
			count(`50-day break: task before, ${hit.level === 2 ? "silent line" : `level ${hit.level} line (同向升一层)`} after`);
		}
	}
	const extra = now.hits.filter((h) => h.rule.startsWith("R-MA-2-50") && !old.notices.some((n) => `R-MA-2-50:${n.id.split(":")[5] === "bearish" ? "down" : "up"}:${n.id.split(":")[1]}:${date}` === h.id));
	for (const h of extra) problems.push(`${date} ${h.id}: new 50-day hit without an old trigger`);
}
console.log(`${sessions.length} sessions with a 50-day signal on the watchlist (${sessions[0]} to ${sessions.at(-1)}), 8 stocks`);
console.log(`old 50-day triggers: ${[...before.values()].reduce((n, r) => n + r.notices.length, 0)}`);
for (const [k, v] of [...outcomes].sort()) console.log(`  ${v}  ${k}`);
console.log(problems.length === 0 ? "parity: every old trigger accounted for, only the decided differences" : `PROBLEMS ${problems.length}:\n${problems.slice(0, 20).join("\n")}`);
process.exit(problems.length === 0 ? 0 : 1);
