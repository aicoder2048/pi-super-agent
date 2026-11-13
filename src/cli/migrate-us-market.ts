/**
 * Moves the user's us-market 盯盘条件 into stock-ta's quote conditions, and by the user's decision takes AMZN and AAPL
 * off stock-ta's watchlist. Prints the plan by default; `--apply` writes it, `--undo` takes back only what it wrote.
 * Works on the state directory like `just module import`: the host reads conditions on every write, so it need not stop.
 * The us-market row in state.db is never changed.
 */
import { join } from "node:path";
import { exitOnConfigError } from "../config-error.ts";
import { loadConfig, loadModules } from "../host/config.ts";
import { moduleRows, openStore } from "../kernel/store.ts";
import { describe, directionWord } from "../modules/conditions.ts";
import { instanceData } from "../modules/instance-data.ts";
import type { Component, ComponentName, ModuleName } from "../modules/manifest.ts";
import type { Condition } from "../modules/protocol.ts";
import { nyDateOf } from "../sources/market/session.ts";
import { parseBook, type Tripwire } from "../sources/market/tripwires.ts";

const MODULE = "stock-ta" as ModuleName;
const QUOTES = "quotes" as ComponentName;
const WATCHLIST = "watchlist" as ComponentName;
const WHO = "page";
const FROM = "migrate-us-market";
const PREFIX = "cnd_usm_";
const DROPPED = ["AMZN", "AAPL"];

type DayMove = Extract<Condition, { when: "day-move" }>;
type Step =
	| { kind: "condition"; outcome: "新建" | "更新" | "不变"; symbol: string; id: string; to: DayMove }
	| { kind: "uncondition"; outcome: "删掉"; symbol: string; id: string }
	| { kind: "watchlist"; outcome: "划掉" | "加回"; symbol: string };


type WatchRow = { symbol: string; removedAt: unknown; from: string };
/** The latest row of each symbol, in the order symbols were first added: the same reading as stock-ta's watchlist.ts. */
function latestRows(rows: readonly { id: string; from: string; fields: { readonly [f: string]: unknown } }[]): Map<string, WatchRow> {
	const latest = new Map<string, WatchRow>();
	for (const row of [...rows].sort((x, y) => Number(x.id) - Number(y.id))) {
		const symbol = String(row.fields["symbol"] ?? "").trim().toUpperCase();
		if (symbol !== "") latest.set(symbol, { symbol, removedAt: row.fields["removedAt"], from: row.from });
	}
	return latest;
}

function line(step: Step): string {
	if (step.kind === "condition") return `  ${step.outcome}  ${step.symbol}  当天${directionWord[step.to.direction]} ${step.to.atLeast}%  → ${step.id} ${describe(step.to)}`;
	if (step.kind === "uncondition") return `  ${step.outcome}  ${step.symbol}  ${step.id}`;
	return `  ${step.outcome}  ${step.symbol}  自选股`;
}

export function migrate(args: readonly string[]): number {
	const apply = args.includes("--apply");
	const undo = args.includes("--undo");
	const keepWatchlist = args.includes("--keep-watchlist");
	const unknown = args.find((a) => !["--apply", "--undo", "--keep-watchlist"].includes(a));
	const say = (text: string, code: number) => (console.log(text), code);
	if (unknown !== undefined || (apply && undo)) return say("用法：just migrate-us-market [--apply | --undo] [--keep-watchlist]", 1);
	try {
		const config = loadConfig();
		const pkg = loadModules(config).packages.find((p) => p.name === MODULE);
		if (pkg === undefined || !pkg.scan.ok) return say(`没有找到 stock-ta，或者它的包没通过检查：先把包放进状态目录的 modules/，再 just modules 看状态`, 1);
		const db = openStore(join(config.stateDir, "state.db"));
		let raw: string | undefined;
		try {
			if (moduleRows(db).find((r) => r.name === MODULE)?.switch !== true) return say("stock-ta 关着：先 just module on stock-ta，再迁移", 1);
			raw = (db.prepare("SELECT data FROM source_user_data WHERE source = 'us-market'").get() as { data: string } | undefined)?.data;
		} finally {
			db.close();
		}
		const components: readonly Component[] = pkg.scan.scan.components;
		const data = instanceData(config.stateDir);
		const conditions = data.watch(MODULE, components, { kind: "watch", collection: QUOTES, op: "list" }, WHO).output;
		const existing = "conditions" in conditions ? conditions.conditions : [];
		const rows = latestRows(data.query(MODULE, components, WATCHLIST, { limit: 500 }, WHO).rows);
		const listed = (symbol: string) => {
			const row = rows.get(symbol);
			return row !== undefined && !row.removedAt;
		};

		const steps: Step[] = [];
		if (undo) {
			for (const c of existing.filter((c) => c.id.startsWith(PREFIX))) steps.push({ kind: "uncondition", outcome: "删掉", symbol: c.key, id: c.id });
			for (const symbol of DROPPED) if (rows.get(symbol)?.from === FROM && !listed(symbol)) steps.push({ kind: "watchlist", outcome: "加回", symbol });
		} else {
			let tripwires: readonly Tripwire[] = [];
			if (raw === undefined) console.log("没有盯盘条件：state.db 里没有 us-market 的数据");
			else {
				const parsed = parseBook(raw);
				if ("problem" in parsed) return say(`${parsed.problem}，什么都没写`, 1);
				tripwires = [...parsed.book.values()];
			}
			const others = tripwires.filter((t) => t.condition.kind !== "day");
			if (others.length > 0) return say(`只搬当天涨跌（day）。这些不搬，什么都没写：${others.map((t) => `${t.symbol} 的 ${t.condition.kind}`).join("、")}。你定过不要成本线（cost）和均线交叉（cross）：在 us-market 里去掉它们再迁移`, 1);
			const missing = tripwires.filter((t) => !listed(t.symbol));
			if (missing.length > 0) return say(`${missing.map((t) => t.symbol).join("、")} 不在 stock-ta 的自选股里（或已划掉），什么都没写：先在对话里把它加回自选股，再迁移`, 1);
			for (const t of tripwires.filter((t): t is Tripwire & { condition: { kind: "day" } } => t.condition.kind === "day")) {
				const id = `${PREFIX}${t.symbol}_day`;
				const to: DayMove = { when: "day-move", atLeast: t.condition.pct, direction: t.condition.dir };
				const before = existing.find((c) => c.id === id);
				const outcome = before === undefined ? "新建" : JSON.stringify(before.condition) === JSON.stringify(to) && before.key === t.symbol ? "不变" : "更新";
				steps.push({ kind: "condition", outcome, symbol: t.symbol, id, to });
			}
			const kept = new Set(tripwires.map((t) => t.symbol));
			if (!keepWatchlist) for (const symbol of DROPPED) if (listed(symbol) && !kept.has(symbol)) steps.push({ kind: "watchlist", outcome: "划掉", symbol });
		}

		const changes = steps.filter((s) => s.outcome !== "不变");
		if (changes.length === 0) return say(steps.length === 0 ? "全部不变：没有要迁移或撤销的" : `全部不变：\n${steps.map(line).join("\n")}`, 0);
		console.log(steps.map(line).join("\n"));
		if (!apply && !undo) return say(`只打印，没有写。确认后跑 just migrate-us-market --apply；以后要撤销跑 just migrate-us-market --undo`, 0);

		const today = nyDateOf(Date.now());
		for (const step of changes) {
			if (step.kind === "condition") data.watch(MODULE, components, { kind: "watch", collection: QUOTES, op: "set", watch: { id: step.id, key: step.symbol, condition: step.to } }, WHO);
			else if (step.kind === "uncondition") data.watch(MODULE, components, { kind: "watch", collection: QUOTES, op: "remove", id: step.id }, WHO);
			else data.write(MODULE, components, WATCHLIST, [step.outcome === "划掉" ? { symbol: step.symbol, removedAt: today, note: "迁移 us-market 时按你的决定划掉" } : { symbol: step.symbol }], FROM, WHO);
		}
		return say(undo ? `撤销了 ${changes.length} 项。us-market 原来的盯盘条件没动` : `写好了 ${changes.length} 项，宿主下一轮报价就按新条件判断。撤销跑 just migrate-us-market --undo`, 0);
	} catch (error) {
		return exitOnConfigError(error);
	}
}

process.exitCode = migrate(process.argv.slice(2));
