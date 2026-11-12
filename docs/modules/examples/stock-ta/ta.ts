/**
 * Every call works on clones of the project's databases with the market API pointed at a closed
 * port, because even a read opens a write transaction that bumps the SQLite header, and a cache
 * miss would fetch from the network.
 */
import { spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Command = "structure" | "signals" | "note" | "prices" | "conditions" | "rules" | "screen";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

const LIMIT_BYTES = 20_000;
const UNDER_HOST_LIMIT_MS = 18_000;
const DAY_MS = 86_400_000;
const NOW_AFTER_SYNC_MS = 60_000;
const SETUP = "见 docs/modules/stock-ta.md";
const TIERS = [
	{ items: 20, chars: 4000, depth: 8 },
	{ items: 10, chars: 1000, depth: 6 },
	{ items: 5, chars: 300, depth: 5 },
	{ items: 3, chars: 120, depth: 4 },
	{ items: 1, chars: 60, depth: 3 },
];

type Kind = "text" | "number" | "list";

/** Copies only the named fields, because `ta` rejects any field it does not know. */
export function argsOf(input: unknown, fields: Readonly<Record<string, Kind>>): JsonObject {
	const given = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	const args: JsonObject = {};
	for (const [key, kind] of Object.entries(fields)) {
		const value = given[key];
		if (value === undefined || value === null || value === "") continue;
		if (kind === "number") {
			const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
			if (!Number.isFinite(number)) throw new Error(`${key} 要是数字，收到 ${JSON.stringify(value)}`);
			args[key] = number;
		} else if (kind === "list") {
			args[key] = (Array.isArray(value) ? value : String(value).split(/[,，\s]+/)).map(String).filter((item) => item !== "");
		} else args[key] = String(value).trim();
	}
	return args;
}

export function ta(command: Command, args: JsonObject): JsonObject {
	const root = process.env["TA_ROOT"];
	if (!root) throw new Error(`没有设置 TA_ROOT：在宿主的密钥文件里写一行 TA_ROOT=<你的技术分析项目>，${SETUP}`);
	const project = join(root, "app/trading");
	if (!existsSync(project)) throw new Error(`TA_ROOT 指向的目录里没有 app/trading，不像技术分析项目，${SETUP}`);
	const scratch = mkdtempSync(join(tmpdir(), "stock-ta-"));
	try {
		const env: Record<string, string> = {
			PATH: process.env["PATH"] ?? "",
			HOME: process.env["HOME"] ?? "",
			TA_ROOT: root,
			MASSIVE_BASE_URL: "http://127.0.0.1:9",
			TA_DB_PATH: clone(join(root, "app/data/ta.sqlite"), scratch),
		};
		if (command === "screen") env["TA_MARKET_DB_PATH"] = clone(join(root, "app/data/market.sqlite"), scratch);
		const input = command === "structure" ? structureInput(args, env["TA_DB_PATH"]!) : args;
		const run = spawnSync("uv", ["run", "--no-sync", "--project", project, "ta", command], {
			input: JSON.stringify(input), env, cwd: scratch, encoding: "utf8", timeout: UNDER_HOST_LIMIT_MS, maxBuffer: 64 * 1024 * 1024,
		});
		if (run.error) throw new Error((run.error as NodeJS.ErrnoException).code === "ENOENT" ? "找不到 uv：宿主的 PATH 里要有 uv" : `ta ${command} 没跑完：${run.error.message}`);
		if (run.status !== 0) throw new Error(failure(command, run.status, run.stderr));
		const last = run.stdout.trim().split("\n").at(-1);
		if (!last) throw new Error(`ta ${command} 没有输出结果（退出码 0），再试一次；还是这样就在技术分析项目里直接跑这个子命令看看`);
		return trim(JSON.parse(last) as JsonObject);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** A copy-on-write clone on APFS, so even the 400 MB market database costs nothing. */
function clone(file: string, into: string): string {
	if (!existsSync(file)) throw new Error(`技术分析项目里没有 app/data/${basename(file)}，${SETUP}`);
	const copy = join(into, basename(file));
	copyFileSync(file, copy, constants.COPYFILE_FICLONE);
	return copy;
}

/**
 * `ta structure` refetches a symbol's dividends unless `now` falls 0 to 1 day after its last
 * sync, and its momentum part reads QQQ and SPY the same way. A `now` just after the newest of
 * those syncs keeps every read on the cache only while the oldest sync is under a day before that now.
 */
function structureInput(args: JsonObject, db: string): JsonObject {
	const symbol = String(args["symbol"] ?? "").toUpperCase().replace("-", ".");
	const opened = new DatabaseSync(db, { readOnly: true });
	let synced: { symbol: string; synced_ms: number }[];
	try {
		synced = opened.prepare("SELECT symbol, synced_ms FROM dividend_sync WHERE symbol IN (?, 'QQQ', 'SPY')").all(symbol) as typeof synced;
	} finally {
		opened.close();
	}
	const times = synced.map((row) => row.synced_ms);
	const newest = Math.max(...times);
	if (!synced.some((row) => row.symbol === symbol) || newest + NOW_AFTER_SYNC_MS - Math.min(...times) >= DAY_MS) {
		throw new Error(`本机缓存里没有 ${symbol || "这个标的"} 足够新的日线，这个工具不联网；先在技术分析项目里扫描一次，或换一个自选股里的标的`);
	}
	return { timeframe: "1d", ...args, symbol, now: new Date(newest + NOW_AFTER_SYNC_MS).toISOString() };
}

function failure(command: Command, status: number | null, stderr: string): string {
	for (const line of stderr.split("\n")) {
		try {
			const { error } = JSON.parse(line) as { error?: { message?: string; hint?: string } };
			if (error?.message) return `${error.message}${error.hint ?? ""}`;
		} catch {
			// `ta` also writes plain warning lines to stderr.
		}
	}
	return `ta ${command} 失败（退出码 ${status ?? "无"}）：${stderr.trim().split("\n").slice(0, 2).join(" ") || "没有输出"}`;
}

function trim(data: JsonObject): JsonObject {
	const fits = (value: JsonObject) => Buffer.byteLength(JSON.stringify(value)) <= LIMIT_BYTES;
	const whole = { ...data, truncated: false };
	if (fits(whole)) return whole;
	for (const tier of TIERS) {
		const cut = { ...(bound(data, tier.items, tier.chars, tier.depth) as JsonObject), truncated: true };
		if (fits(cut)) return cut;
	}
	return { truncated: true, note: "结果太大，缩小查询范围再试，例如只查一个标的或减小 limit" };
}

function bound(value: Json, items: number, chars: number, depth: number): Json {
	if (typeof value === "string") return value.length > chars ? `${value.slice(0, chars)}…` : value;
	if (value === null || typeof value !== "object") return value;
	if (depth === 0) return "…";
	if (Array.isArray(value)) return value.slice(0, items).map((item) => bound(item, items, chars, depth - 1));
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bound(item, items, chars, depth - 1)]));
}
