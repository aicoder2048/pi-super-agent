/**
 * Every call works on a clone of the database with the market API pointed at a closed port: even a read
 * in `ta` opens a write transaction that bumps the SQLite header, and a cache miss would fetch from the network.
 */
import { spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listedSymbols, type WatchRow } from "./watchlist.ts";

export type Command = "structure" | "signals" | "note" | "prices" | "conditions" | "rules";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

const LIMIT_BYTES = 20_000;
const UNDER_HOST_LIMIT_MS = 18_000;
const DAY_MS = 86_400_000;
const TA_DELAY_MS = 15 * 60_000;
const NOW_MARGIN_MS = 60_000;
const GUIDE = "见 docs/modules/stock-ta.md";
const WITHOUT_DATA: ReadonlySet<Command> = new Set(["rules", "note"]);
const TIERS = [
	{ items: 20, chars: 4000, depth: 8 },
	{ items: 10, chars: 1000, depth: 6 },
	{ items: 5, chars: 300, depth: 5 },
	{ items: 3, chars: 120, depth: 4 },
	{ items: 1, chars: 60, depth: 3 },
];

type Kind = "text" | "number" | "list" | "timeframe";

const TIMEFRAMES = ["1d", "1w"];

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
		} else {
			const text = String(value).trim();
			if (kind === "timeframe" && !TIMEFRAMES.includes(text)) throw new Error(`周期只有 1d 和 1w，模块只扫日线，收到 ${JSON.stringify(value)}`);
			args[key] = text;
		}
	}
	return args;
}

export function ta(command: Command, args: JsonObject): JsonObject {
	const data = process.env["PSA_MODULE_DATA"] ?? "";
	const bin = installedTa();
	const live = join(data, "files/ta/ta.sqlite");
	const hasData = existsSync(live);
	if (!hasData && !WITHOUT_DATA.has(command)) throw new Error(`还没有数据：等 scan feed 第一次跑完（打开模块后一小时内）再问，${GUIDE}`);
	const scratch = mkdtempSync(join(tmpdir(), "stock-ta-"));
	try {
		const db = join(scratch, "ta.sqlite");
		if (!WITHOUT_DATA.has(command)) copyFileSync(live, db, constants.COPYFILE_FICLONE);
		const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", MASSIVE_BASE_URL: "http://127.0.0.1:9", MASSIVE_API_KEY: "offline", TA_DB_PATH: db };
		if (command === "note") env["TA_NOTES_DIR"] = importedNotes(data, String(args["source"] ?? ""), join(scratch, "notes"));
		const input = command === "structure" ? structureInput(args, db, data) : args;
		const run = spawnSync(bin, [command], {
			input: JSON.stringify(input), env, cwd: scratch, encoding: "utf8", timeout: UNDER_HOST_LIMIT_MS, maxBuffer: 64 * 1024 * 1024,
		});
		if (run.error) throw new Error(`ta ${command} 没跑完：${run.error.message}`);
		if (run.status !== 0) throw new Error(failure(command, run.status, run.stderr));
		const last = run.stdout.trim().split("\n").at(-1);
		if (!last) throw new Error(`ta ${command} 没有输出结果（退出码 0），再试一次；还是这样就重跑 just module setup stock-ta`);
		return trim(JSON.parse(last) as JsonObject);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Setup writes `.psa-lock` last, so a venv without it is half installed. */
export function installedTa(): string {
	const venv = process.env["PSA_MODULE_VENV"] ?? "";
	if (venv !== "" && existsSync(join(venv, ".psa-lock"))) return join(venv, "bin/ta");
	const files = join(process.env["PSA_MODULE_DATA"] ?? "", "files");
	const another = existsSync(files) && readdirSync(files).some((name) => /^venv-[0-9a-f]{12}$/.test(name) && existsSync(join(files, name, ".psa-lock")));
	if (another) throw new Error(`包里钉的 ta 版本变了：在跑宿主的机器上重跑 just module setup stock-ta，${GUIDE}`);
	throw new Error(`stock-ta 的 Python 环境还没装：先跑 just module setup stock-ta，${GUIDE}`);
}

/** `ta note` looks for `TA02 - *.md` in one directory, and `just module import` keeps each note's file name. */
function importedNotes(data: string, source: string, into: string): string {
	mkdirSync(into);
	const knowledge = join(data, "knowledge");
	const imported = existsSync(knowledge) ? readdirSync(knowledge, { withFileTypes: true }).filter((entry) => entry.isDirectory()) : [];
	const linked: string[] = [];
	for (const { name } of imported) {
		for (const file of readdirSync(join(knowledge, name))) {
			if (!/^TA\d{2} - .*\.md$/.test(file) || linked.includes(file)) continue;
			symlinkSync(join(knowledge, name, file), join(into, file));
			linked.push(file);
		}
	}
	const number = /^TA\d{2}/.exec(source)?.[0];
	if (number === undefined || linked.some((file) => file.startsWith(`${number} - `))) return into;
	const shipped = join(import.meta.dirname, "knowledge");
	const docs = readdirSync(shipped).filter((doc) => {
		const sourceFile = join(shipped, doc, "source.json");
		return existsSync(sourceFile) && (JSON.parse(readFileSync(sourceFile, "utf8")) as { title?: string }).title?.startsWith(`${number} `);
	});
	const how = docs.length > 0 ? docs.map((doc) => `just module import stock-ta ${doc} <笔记文件>`).join("；") : "模块的知识清单里没有这份笔记";
	throw new Error(`笔记 ${number} 还没导入：${how}，${GUIDE}`);
}

/**
 * `ta structure` refetches dividends for the symbol, QQQ and SPY unless `now` is 0 to 1 day after their last sync,
 * and serves only bars that closed 15 minutes before `now`. The scan keeps a sync until it is a full day old, so
 * after a day-two scan the newest sync can still be yesterday's.
 */
function structureInput(args: JsonObject, db: string, data: string): JsonObject {
	const symbol = String(args["symbol"] ?? "").toUpperCase().replace("-", ".");
	const opened = new DatabaseSync(db, { readOnly: true });
	let synced: Map<string, number>;
	let close: number | null;
	try {
		const rows = opened.prepare("SELECT symbol, synced_ms FROM dividend_sync WHERE symbol IN (?, 'QQQ', 'SPY')").all(symbol) as { symbol: string; synced_ms: number }[];
		synced = new Map(rows.map((row) => [row.symbol, row.synced_ms]));
		close = (opened.prepare("SELECT max(end_ms) AS close FROM bars WHERE symbol = ? AND timeframe = '1d' AND complete = 1").get(symbol) as { close: number | null }).close;
	} finally {
		opened.close();
	}
	if (!synced.has(symbol) || close === null) throw notScanned(symbol, data);
	const now = Math.max(...synced.values(), close + TA_DELAY_MS) + NOW_MARGIN_MS;
	const behind = [...synced].filter(([, ms]) => now - ms >= DAY_MS).map(([name]) => name);
	if (behind.includes(symbol)) throw notScanned(symbol, data);
	if (behind.length > 0) throw new Error(`基准 ${behind.join("、")} 的数据落后一天以上（上次扫描没更新到它），这个工具不联网；等下一次扫描（每个交易日收盘后）再问`);
	return { timeframe: "1d", ...args, symbol, now: new Date(now).toISOString() };
}

function notScanned(symbol: string, data: string): Error {
	if (watched(data).includes(symbol)) return new Error(`${symbol} 在自选股里，但模块的数据库还没扫到它最新的日线，这个工具不联网；等下一次扫描（每个交易日收盘后）再问`);
	return new Error(`模块的数据库里没有 ${symbol || "这个标的"} 足够新的日线，这个工具不联网；把它加进自选股，等下一次 scan 扫完再问`);
}

function watched(data: string): string[] {
	const file = join(data, "data.db");
	if (!existsSync(file)) return [];
	const opened = new DatabaseSync(file, { readOnly: true });
	try {
		if (opened.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'watchlist'").get() === undefined) return [];
		const rows = opened.prepare(`SELECT "_id" AS id, "symbol", "removedAt" FROM "watchlist"`).all() as { id: number; symbol: unknown; removedAt: unknown }[];
		return listedSymbols(rows.map((row): WatchRow => ({ id: String(row.id), fields: { symbol: row.symbol, removedAt: row.removedAt } })));
	} finally {
		opened.close();
	}
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
