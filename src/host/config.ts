import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODELS, parseModelRef, type ModelRef } from "../models.ts";
import type { KernelConfig } from "../kernel/types.ts";
import { ConfigError, readJsonFile } from "../config-error.ts";
import { Modules } from "../modules.ts";
import { MEMBER_CAP_DEFAULT, MEMBER_CAP_MAX } from "./member-cap.ts";
import { within } from "../worker/read-roots.ts";
import { parseWebHosts, type TailnetName } from "./web-hosts.ts";
import { parseSecretsFile } from "../secrets.ts";
import { defaultStateDir } from "../state-dir.ts";
import { UNLIMITED, type OcrConfig } from "../ocr/ocr.ts";
import { HEALTH_DEFAULTS, type HealthConfig } from "./health.ts";

export const BUNDLED_MODULES = fileURLToPath(new URL("../../modules", import.meta.url));
export interface HostConfig {
	stateDir: string;
	models: { router: ModelRef; worker: ModelRef; fallback: ModelRef };
	kernel: Partial<KernelConfig>;
	bgMaxMinutes: number;
	fallbackDailyTokens: number;
	/** One dispatch's time limit for a member that cannot write, edit or run commands in the ticket, counted from when it starts. Also how long a dispatch may wait for a slot. */
	dispatchTimeoutSeconds: number;
	/** The same limit for a member that can. */
	dispatchCodingTimeoutSeconds: number;
	/** A running member with no event of any kind for this long is ended. */
	dispatchStallSeconds: number;
	/** Member processes running at once across the host until the user raises it for a day; the rest queue. */
	maxConcurrentExperts: number;
	retryAttempts: number;
	probePrimaryMinutes: number;
	heartbeatSeconds: number;
	watchdog: { intervalMinutes: number; stuckMinutes: number; staleSeconds: number };
	modulesDirs: string[];
	moduleSwitches: Record<string, boolean>;
	webPort: number;
	/** Tailnet names the page also answers at (ADR-0014). Empty means local only. */
	webHosts: readonly TailnetName[];
	secretsFile?: string;
	/** Absolute. Where helpers and members put what they make (ADR-0015). */
	outputDir: string;
	sources: Record<string, unknown>;
	/** Set by `just module try`: each package feed runs its fixtures once, and no connector runs. */
	feedFixtures: boolean;
	/** Present means the Telegram client runs. An empty list is setup mode: it only tells whoever writes their own numeric id. */
	telegram?: { allowedUserIds: readonly number[] };
	ocr: OcrConfig;
	health: HealthConfig;
}

const STUCK_MINUTES_MAX = 1440;
const DISPATCH_TIMEOUT_MIN = 1;
const DISPATCH_TIMEOUT_MAX = 3600;
const DISPATCH_STALL_MIN = 30;

export function memberProviders(config: Pick<HostConfig, "models">): string[] {
	return [...new Set([config.models.router.provider, config.models.worker.provider])];
}

export { defaultStateDir };

export function loadConfig(stateDir = defaultStateDir()): HostConfig {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const file = join(stateDir, "config.json");
	const raw = existsSync(file) ? readJsonFile<Record<string, any>>(file) : {};
	const models = { ...DEFAULT_MODELS, ...(raw.models ?? {}) };
	const heartbeatSeconds = raw.heartbeatSeconds ?? 30;
	const watchdog = { intervalMinutes: 3, stuckMinutes: 30, staleSeconds: 120, ...(raw.watchdog ?? {}) };
	if (!(watchdog.staleSeconds > 2 * heartbeatSeconds)) {
		throw new ConfigError(`${file}：watchdog.staleSeconds（${watchdog.staleSeconds}）必须大于 heartbeatSeconds（${heartbeatSeconds}）的两倍，否则 Watchdog 会反复重启健康的宿主`);
	}
	const { stuckMinutes } = watchdog;
	if (typeof stuckMinutes !== "number" || !(stuckMinutes > 0 && stuckMinutes <= STUCK_MINUTES_MAX)) {
		throw new ConfigError(`${file}：watchdog.stuckMinutes（${JSON.stringify(stuckMinutes)}）必须是大于 0、不超过 ${STUCK_MINUTES_MAX} 的分钟数`);
	}
	if (raw.kernel?.stuckMs !== undefined) {
		throw new ConfigError(`${file}：不要写 kernel.stuckMs，久无进展的阈值只用 watchdog.stuckMinutes 设置`);
	}
	const webPort = raw.webPort ?? 4517;
	if (!Number.isInteger(webPort) || webPort < 0 || webPort > 65535) {
		throw new ConfigError(`${file}：webPort（${JSON.stringify(webPort)}）必须是 0 到 65535 之间的整数，0 表示任意空闲端口`);
	}
	const webHosts = parseWebHosts(raw.webHosts, `${file}：webHosts`);
	if (webHosts.length > 0 && webPort === 0) {
		throw new ConfigError(`${file}：webHosts 需要固定的 webPort：tailscale serve 转发到一个固定端口，webPort 是 0 时每次启动端口都不同`);
	}
	const secretsFile = parseSecretsFile(raw.secretsFile, stateDir, file);
	const outputDir = parseOutputDir(raw.outputDir, stateDir, file);
	const seconds = (key: string, fallback: number): number => {
		const value = raw[key] === undefined ? fallback : raw[key];
		if (typeof value !== "number" || !(value >= DISPATCH_TIMEOUT_MIN && value <= DISPATCH_TIMEOUT_MAX)) {
			throw new ConfigError(`${file}：${key}（${JSON.stringify(value)}）必须是不小于 ${DISPATCH_TIMEOUT_MIN}、不超过 ${DISPATCH_TIMEOUT_MAX} 的秒数`);
		}
		return value;
	};
	const dispatchTimeoutSeconds = seconds("dispatchTimeoutSeconds", 900);
	const dispatchCodingTimeoutSeconds = seconds("dispatchCodingTimeoutSeconds", 3600);
	const longestDispatch = Math.max(dispatchTimeoutSeconds, dispatchCodingTimeoutSeconds);
	const dispatchStallSeconds = raw.dispatchStallSeconds === undefined ? Math.min(180, longestDispatch) : raw.dispatchStallSeconds;
	if (raw.dispatchStallSeconds !== undefined && (typeof dispatchStallSeconds !== "number" || !(dispatchStallSeconds >= DISPATCH_STALL_MIN && dispatchStallSeconds <= longestDispatch))) {
		const shown = `${file}：dispatchStallSeconds（${JSON.stringify(dispatchStallSeconds)}）`;
		if (longestDispatch < DISPATCH_STALL_MIN) {
			throw new ConfigError(`${shown}没有可写的值：最长的派活时限现在是 ${longestDispatch} 秒，而它必须不短于 ${DISPATCH_STALL_MIN} 秒、不长于最长的派活时限。把 dispatchTimeoutSeconds 或 dispatchCodingTimeoutSeconds 调到 ${DISPATCH_STALL_MIN} 秒以上，或者去掉 dispatchStallSeconds`);
		}
		throw new ConfigError(`${shown}必须是 ${DISPATCH_STALL_MIN} 到 ${longestDispatch} 之间的秒数：不短于 ${DISPATCH_STALL_MIN} 秒，不长于最长的派活时限`);
	}
	const maxConcurrentExperts = raw.maxConcurrentExperts === undefined ? MEMBER_CAP_DEFAULT : raw.maxConcurrentExperts;
	if (!Number.isInteger(maxConcurrentExperts) || maxConcurrentExperts < 1 || maxConcurrentExperts > MEMBER_CAP_MAX) {
		throw new ConfigError(`${file}：maxConcurrentExperts（${JSON.stringify(maxConcurrentExperts)}）必须是 1 到 ${MEMBER_CAP_MAX} 的整数`);
	}
	const sources = raw.sources ?? {};
	if (sources === null || typeof sources !== "object" || Array.isArray(sources)) {
		throw new ConfigError(`${file}：sources（${JSON.stringify(sources)}）必须是以来源名为键的对象`);
	}
	const moduleSwitches = raw.modules === undefined ? {} : raw.modules;
	if (moduleSwitches === null || typeof moduleSwitches !== "object" || Array.isArray(moduleSwitches) || Object.values(moduleSwitches).some((v) => typeof v !== "boolean")) {
		throw new ConfigError(`${file}：modules（${JSON.stringify(moduleSwitches)}）必须是以模块名为键、值为 true 或 false 的对象`);
	}
	const telegram = raw.telegram === undefined ? undefined : parseTelegram(raw.telegram, file);
	const ocr = parseOcr(raw.ocr, file);
	return {
		stateDir,
		models: {
			router: parseModelRef(models.router, `${file}：models.router`),
			worker: parseModelRef(models.worker, `${file}：models.worker`),
			fallback: parseModelRef(models.fallback, `${file}：models.fallback`),
		},
		kernel: { ...(raw.kernel ?? {}), stuckMs: stuckMinutes * 60_000 },
		bgMaxMinutes: raw.bgMaxMinutes ?? 120,
		fallbackDailyTokens: raw.fallbackDailyTokens ?? 8_000_000,
		dispatchTimeoutSeconds,
		dispatchCodingTimeoutSeconds,
		dispatchStallSeconds,
		maxConcurrentExperts,
		retryAttempts: raw.retryAttempts ?? 3,
		probePrimaryMinutes: raw.probePrimaryMinutes ?? 15,
		heartbeatSeconds,
		watchdog,
		modulesDirs: raw.modulesDirs ?? [BUNDLED_MODULES, join(stateDir, "modules")],
		moduleSwitches,
		webPort,
		webHosts,
		secretsFile,
		outputDir,
		sources,
		feedFixtures: raw.feedFixtures === true,
		...(telegram && { telegram }),
		ocr,
		health: parseHealth(raw.health, file),
	};
}

function parseHealth(raw: unknown, file: string): HealthConfig {
	if (raw === undefined) return { ...HEALTH_DEFAULTS };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigError(`${file}：health 要是一个对象，例如 {"modelFailuresBeforeAlarm": 2, "feedFailuresBeforeAlarm": 3}`);
	for (const key of Object.keys(raw)) {
		if (!(key in HEALTH_DEFAULTS)) throw new ConfigError(`${file}：health.${key} 不认识，只能写 ${Object.keys(HEALTH_DEFAULTS).join("、")}`);
	}
	const health = { ...HEALTH_DEFAULTS, ...(raw as Partial<HealthConfig>) };
	for (const [key, value] of Object.entries(health)) {
		if (!Number.isInteger(value) || value < 1) throw new ConfigError(`${file}：health.${key}（${JSON.stringify(value)}）必须是 1 以上的整数：连着失败几次才在网页和 Telegram 上报警`);
	}
	return health;
}

export function loadModules(config: Pick<HostConfig, "stateDir" | "modulesDirs" | "moduleSwitches" | "models">): Modules {
	return Modules.load(config.modulesDirs, {
		stateDir: config.stateDir,
		allowedProviders: memberProviders(config),
		switches: { values: config.moduleSwitches, file: join(config.stateDir, "config.json") },
	});
}

function parseOutputDir(value: unknown, stateDir: string, file: string): string {
	if (value !== undefined && typeof value !== "string") throw new ConfigError(`${file}：outputDir（${JSON.stringify(value)}）必须是目录路径字符串，相对路径按状态目录算`);
	if (value?.startsWith("~")) throw new ConfigError(`${file}：outputDir（${JSON.stringify(value)}）不能以 ~ 开头，配置里不展开 ~，请写绝对路径`);
	const dir = resolve(stateDir, value ?? "output");
	if (within(dir, stateDir)) throw new ConfigError(`${file}：outputDir（${dir}）不能是状态目录或它的上级，否则令牌和 state.db 也算成品目录`);
	for (const own of ["workers", "sessions"]) {
		if (within(join(stateDir, own), dir)) throw new ConfigError(`${file}：outputDir（${dir}）不能放在状态目录的 ${own}/ 下面，那里是宿主自己的任务目录和会话记录`);
	}
	return dir;
}

// A token pasted into this section by mistake must not reach the error, so errors name keys and never echo values.
function parseTelegram(raw: unknown, file: string): { allowedUserIds: number[] } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ConfigError(`${file}：telegram 必须是只有 allowedUserIds 一项的对象`);
	}
	const extra = Object.keys(raw).filter((key) => key !== "allowedUserIds");
	if (extra.length > 0) {
		const named = extra.filter((key) => /^[A-Za-z_]\w{0,39}$/.test(key));
		const shown = [...named, ...(named.length < extra.length ? [`另有 ${extra.length - named.length} 个不像字段名的键`] : [])].join("、");
		throw new ConfigError(`${file}：telegram 只能有 allowedUserIds 一项，多了：${shown}。bot token 放在 secretsFile 或环境变量 TELEGRAM_BOT_TOKEN 里`);
	}
	const ids = (raw as { allowedUserIds?: unknown }).allowedUserIds;
	if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id) && id > 0) || new Set(ids).size !== ids.length) {
		throw new ConfigError(`${file}：telegram.allowedUserIds 必须是不重复的正整数数组：私聊里使用者的 Telegram 数字 id；空数组是设置模式`);
	}
	return { allowedUserIds: ids };
}

const OCR_TIMEOUT_DEFAULT = { vision: 60, unlimited: 900 } as const;

/** Vision ships with macOS. Unlimited-OCR runs only on Apple Silicon and needs the unlimited-ocr project's model and `.venv`. */
function parseOcr(raw: unknown, file: string): OcrConfig {
	if (raw === undefined) raw = {};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${file}：ocr 必须是对象，例如 {"engine": "vision"}`);
	const { engine = "vision", unlimitedHome, maxPages = 20, timeoutSeconds } = raw as Record<string, unknown>;
	if (engine === "off") return { engine };
	if (engine !== "vision" && engine !== "unlimited") throw new ConfigError(`${file}：ocr.engine（${JSON.stringify(engine)}）只能是 vision、unlimited 或 off`);
	if (!Number.isInteger(maxPages) || (maxPages as number) < 1 || (maxPages as number) > 200) throw new ConfigError(`${file}：ocr.maxPages（${JSON.stringify(maxPages)}）必须是 1 到 200 的整数`);
	const seconds = timeoutSeconds ?? OCR_TIMEOUT_DEFAULT[engine];
	if (typeof seconds !== "number" || !(seconds >= 1 && seconds <= 3600)) throw new ConfigError(`${file}：ocr.timeoutSeconds（${JSON.stringify(seconds)}）必须是 1 到 3600 的秒数`);
	const limits = { maxPages: maxPages as number, timeoutSeconds: seconds };
	if (engine === "vision") return { engine, ...limits };
	if (typeof unlimitedHome !== "string" || !isAbsolute(unlimitedHome)) throw new ConfigError(`${file}：ocr.engine 是 unlimited 时要写 ocr.unlimitedHome：unlimited-ocr 项目目录的绝对路径`);
	for (const need of [UNLIMITED.model, UNLIMITED.python]) {
		if (!existsSync(join(unlimitedHome, need))) throw new ConfigError(`${file}：ocr.unlimitedHome（${unlimitedHome}）下面没有 ${need}`);
	}
	if (process.arch !== "arm64") throw new ConfigError(`${file}：ocr.engine 是 unlimited 只能用在 Apple Silicon 的 Mac 上，这台是 ${process.arch}；用 vision`);
	return { engine, home: unlimitedHome, ...limits };
}
