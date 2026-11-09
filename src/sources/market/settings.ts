import { ConfigError } from "../../config-error.ts";
import { BASE_URLS } from "./client.ts";
import type { DetectSettings } from "./detect.ts";
import { parseSymbol } from "./symbol.ts";

export interface MarketSettings extends DetectSettings {
	watchlist: string[];
	everySeconds: number;
	minGapMs: number;
	baseURL: (typeof BASE_URLS)[number];
}

const FIELDS = ["watchlist", "bands", "volumeSpikeX", "everySeconds", "minGapMs", "baseURL"];
const MAX_WATCHLIST = 50;
const MAX_BANDS = 10;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function parseMarketSettings(defaults: unknown, override: unknown, where: string): MarketSettings {
	const fail = (path: string, value: unknown, need: string): never => {
		throw new ConfigError(`${where}：行情设置 ${path}（${JSON.stringify(value)}）${need}`);
	};
	if (override !== undefined && !isObject(override)) fail("sources 下的这一项", override, "必须是对象");
	const raw: Record<string, unknown> = { ...(defaults as object), ...(override as object) };
	for (const field of Object.keys(raw)) if (!FIELDS.includes(field)) fail(field, raw[field], `不是可用字段，可用：${FIELDS.join("、")}`);

	const number = (path: string, value: unknown, min: number, max: number, integer: boolean): number => {
		const ok = typeof value === "number" && Number.isFinite(value) && (!integer || Number.isInteger(value)) && value >= min && value <= max;
		return ok ? value : fail(path, value, `必须是 ${min} 到 ${max} 之间的${integer ? "整数" : "数"}`);
	};
	const bands = (path: string, value: unknown): number[] => {
		if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BANDS) return fail(path, value, `必须是 1 到 ${MAX_BANDS} 个档位`);
		const list = value.map((n, i) => number(`${path}[${i}]`, n, 0.01, 100, false));
		if (list.some((n, i) => i > 0 && n <= list[i - 1])) fail(path, value, "必须递增");
		return list;
	};

	const rawList = raw.watchlist;
	const watchlist = Array.isArray(rawList) ? rawList.map(parseSymbol) : [];
	if (!watchlist.length || watchlist.length > MAX_WATCHLIST || watchlist.some((s) => !s)) fail("watchlist", rawList, `必须是 1 到 ${MAX_WATCHLIST} 个股票代码`);
	const rawBands = raw.bands;
	if (!isObject(rawBands)) return fail("bands", rawBands, "必须是 { default, bySymbol } 对象");
	const rawBySymbol = rawBands.bySymbol ?? {};
	if (!isObject(rawBySymbol)) return fail("bands.bySymbol", rawBySymbol, "必须是以股票代码为键的对象");
	const bySymbol: Record<string, number[]> = {};
	for (const [key, value] of Object.entries(rawBySymbol)) {
		const symbol = parseSymbol(key);
		if (!symbol) fail(`bands.bySymbol.${key}`, key, "的键必须是股票代码");
		bySymbol[symbol!] = bands(`bands.bySymbol.${key}`, value);
	}
	if (!BASE_URLS.includes(raw.baseURL as never)) fail("baseURL", raw.baseURL, `只能是 ${BASE_URLS.join(" 或 ")}`);
	return {
		watchlist: watchlist as string[],
		bands: { default: bands("bands.default", rawBands.default), bySymbol },
		volumeSpikeX: number("volumeSpikeX", raw.volumeSpikeX, 1.01, 1000, false),
		everySeconds: number("everySeconds", raw.everySeconds, 15, 3600, true),
		minGapMs: number("minGapMs", raw.minGapMs, 0, 60_000, true),
		baseURL: raw.baseURL as MarketSettings["baseURL"],
	};
}
