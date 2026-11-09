import { ConfigError } from "../../config-error.ts";
import { BASE_URLS } from "./client.ts";
import type { DetectSettings } from "./detect.ts";

export interface MarketSettings extends DetectSettings {
	watchlist: string[];
	everySeconds: number;
	minGapMs: number;
	baseURL: (typeof BASE_URLS)[number];
}

const FIELDS = ["watchlist", "bands", "volumeSpikeX", "everySeconds", "minGapMs", "baseURL"];
const SYMBOL = /^[A-Z][A-Z0-9]{0,9}(\.[A-Z0-9]{1,3})?$/;

export function parseSymbol(raw: unknown): string | undefined {
	const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
	return SYMBOL.test(s) ? s : undefined;
}

const isBands = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((n, i) => typeof n === "number" && n > 0 && (i === 0 || n > v[i - 1]));

/** Module defaults, overridden field by field by stateDir/config.json `sources.<name>`. */
export function parseMarketSettings(defaults: unknown, override: unknown, where: string): MarketSettings {
	const raw = { ...(defaults as object), ...(override as object) } as Record<string, any>;
	const fail = (field: string, need: string) => {
		throw new ConfigError(`${where}：行情设置 ${field}（${JSON.stringify(raw[field])}）${need}`);
	};
	for (const field of Object.keys(raw)) if (!FIELDS.includes(field)) fail(field, `不是可用字段，可用：${FIELDS.join("、")}`);
	const watchlist = Array.isArray(raw.watchlist) ? raw.watchlist.map(parseSymbol) : [];
	if (!watchlist.length || watchlist.some((s) => !s)) fail("watchlist", "必须是非空的股票代码列表");
	const bands = raw.bands ?? {};
	if (!isBands(bands.default) || !Object.values(bands.bySymbol ?? {}).every(isBands)) fail("bands", "的每组档位必须是递增的正数");
	if (!(raw.volumeSpikeX > 1)) fail("volumeSpikeX", "必须大于 1");
	if (!(raw.everySeconds >= 15)) fail("everySeconds", "不能小于 15");
	if (!(raw.minGapMs >= 0)) fail("minGapMs", "不能小于 0");
	if (!BASE_URLS.includes(raw.baseURL)) fail("baseURL", `只能是 ${BASE_URLS.join(" 或 ")}`);
	return { ...raw, watchlist: watchlist as string[], bands: { default: bands.default, bySymbol: bands.bySymbol ?? {} } } as MarketSettings;
}
