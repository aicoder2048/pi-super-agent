// node --import ./src/pi-runtime.mjs docs/modules/evidence/p1-parity.ts [outDir]
// Replays every us-market-day scenario through stock-ta's quotes feed on origin/main (settings.bands) and on this tree
// (watch-rules.ts). The bands, the lines and the trigger ids must match; the only allowed differences are the silent flag on
// the first band's line and the rule, level and plan appended to the trigger body.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HEAD = resolve(import.meta.dirname, "../../..");
const outDir = process.argv[2] ?? "/tmp/swarm-p1/parity";
mkdirSync(outDir, { recursive: true });
const R = await import(join(HEAD, "docs/modules/evidence/replay-day.ts"));

const TRUNK = join(outDir, "trunk");
if (!existsSync(TRUNK)) {
	spawnSync("git", ["worktree", "add", "--detach", TRUNK, "e9b8379"], { cwd: HEAD, stdio: "inherit" });
	symlinkSync(join(HEAD, "node_modules"), join(TRUNK, "node_modules"));
}

const WATCHLIST = ["NVDA", "AMD", "SPY", "QQQ"];
const isIndex = (s: string) => s === "SPY" || s === "QQQ";
const SUFFIX = /（规则 (move-[12])，层级 5，做法 band-move）$/;

async function run(tree: string, name: string) {
	const state = mkdtempSync(join(tmpdir(), "psa-p1-parity-"));
	try {
		return await R.replay(tree, state, R.scenario(name), WATCHLIST, []);
	} finally {
		rmSync(state, { recursive: true, force: true });
	}
}

type Line = { minute: string; externalId: string; text: string; push?: string };
type Trigger = { minute: string; id: string; thread: string; body: string };
const lineKey = (l: Line) => `${l.minute} ${l.externalId} ${l.text}`;
const triggerKey = (t: Trigger, body: string) => `${t.minute} ${t.id} ${t.thread} ${body}`;
/** The band a line reached, from its id `band:<symbol>:<date>:<side><band>`. */
const bandOf = (id: string) => ({ symbol: id.split(":")[1]!, band: Number(/(\d+(\.\d+)?)$/.exec(id)![1]) });
const firstBand = (id: string) => {
	const { symbol, band } = bandOf(id);
	return band === (isIndex(symbol) ? 2 : 5);
};

const names = readdirSync(join(HEAD, "tests/fixtures/us-market-day")).filter((f) => f.endsWith(".json") && f !== "expected.json").map((f) => f.replace(/\.json$/, "")).sort();
const report: string[] = [];
let pass = true;
let silent = 0;
let ringing = 0;
for (const name of names) {
	const trunk = await run(TRUNK, name);
	const head = await run(HEAD, name);
	const sameLines = JSON.stringify(trunk.posted.map(lineKey)) === JSON.stringify(head.posted.map(lineKey));
	const sameTriggers = JSON.stringify(trunk.triggered.map((t: Trigger) => triggerKey(t, t.body))) === JSON.stringify(head.triggered.map((t: Trigger) => triggerKey(t, t.body.replace(SUFFIX, ""))));
	const pushRight = head.posted.every((l: Line) => (l.push === "silent") === firstBand(l.externalId));
	const ruleRight = head.triggered.every((t: Trigger) => SUFFIX.exec(t.body)?.[1] === (firstBand(t.id) ? "move-1" : "move-2"));
	const ok = sameLines && sameTriggers && pushRight && ruleRight;
	pass &&= ok;
	silent += head.posted.filter((l: Line) => l.push === "silent").length;
	ringing += head.posted.filter((l: Line) => l.push === undefined).length;
	report.push(`${ok ? "same" : "DIFFERENT"}  ${name}  (${R.scenario(name).title})  lines ${sameLines ? "same" : "DIFFER"}, triggers ${sameTriggers ? "same" : "DIFFER"}, push ${pushRight ? "first band only" : "WRONG"}, trigger rule ${ruleRight ? "right" : "WRONG"}`);
	report.push("  trunk lines:", ...(trunk.posted.length ? trunk.posted.map((l: Line) => `    ${lineKey(l)}`) : ["    (none)"]));
	report.push("  head lines:", ...(head.posted.length ? head.posted.map((l: Line) => `    ${l.push === "silent" ? "[silent]" : "[ring]  "} ${lineKey(l)}`) : ["    (none)"]));
	report.push("  head triggers:", ...(head.triggered.length ? head.triggered.map((t: Trigger) => `    ${t.minute} ${t.id} ${t.body}`) : ["    (none)"]));
}
const verdict = `${pass ? "PASS" : "FAIL"} p1 parity: ${names.length} scenarios, watchlist ${WATCHLIST.join(",")}, stock-ta on e9b8379 (settings.bands) vs this tree (watch-rules.ts). Same lines (minute, id, text) and same triggers (minute, id, thread, body without the appended rule); ${silent} silent lines all at the first band (stock 5%, index 2%), ${ringing} ringing lines all at the second.`;
writeFileSync(join(outDir, "p1-parity.txt"), `${verdict}\n${report.join("\n")}\n`);
console.log(verdict);
if (!pass) process.exitCode = 1;
