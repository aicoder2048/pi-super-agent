import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODELS, parseModelRef, type ModelRef } from "../models.ts";
import type { KernelConfig } from "../kernel/types.ts";
import { ConfigError, readJsonFile } from "../config-error.ts";

export interface HostConfig {
	stateDir: string;
	models: { router: ModelRef; worker: ModelRef; fallback: ModelRef };
	kernel: Partial<KernelConfig>;
	bgMaxMinutes: number;
	fallbackDailyTokens: number;
	/** Each consult question's time limit. */
	consultTimeoutSeconds: number;
	/** Experts answering at once across the host; the rest queue. */
	maxConcurrentExperts: number;
	retryAttempts: number;
	probePrimaryMinutes: number;
	heartbeatSeconds: number;
	watchdog: { intervalMinutes: number; stuckMinutes: number; staleSeconds: number };
	modulesDirs: string[];
	/** The user's own role files. */
	rolesDir: string;
	webPort: number;
	secretsFile?: string;
	sources: Record<string, unknown>;
}

const STUCK_MINUTES_MAX = 1440;
const CONSULT_TIMEOUT_MAX = 1800;

export function defaultStateDir(): string {
	return resolve(process.env.PSA_STATE_DIR ?? join(homedir(), ".pi-super-agent"));
}

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
	if (raw.secretsFile !== undefined && typeof raw.secretsFile !== "string") {
		throw new ConfigError(`${file}：secretsFile（${JSON.stringify(raw.secretsFile)}）必须是 .env 文件的路径字符串`);
	}
	const secretsFile = raw.secretsFile === undefined ? undefined : resolve(stateDir, raw.secretsFile);
	if (secretsFile && !existsSync(secretsFile)) throw new ConfigError(`${file}：secretsFile 指向的 ${secretsFile} 不存在`);
	const consultTimeoutSeconds = raw.consultTimeoutSeconds ?? 180;
	if (typeof consultTimeoutSeconds !== "number" || !(consultTimeoutSeconds > 0 && consultTimeoutSeconds <= CONSULT_TIMEOUT_MAX)) {
		throw new ConfigError(`${file}：consultTimeoutSeconds（${JSON.stringify(consultTimeoutSeconds)}）必须是大于 0、不超过 ${CONSULT_TIMEOUT_MAX} 的秒数`);
	}
	const maxConcurrentExperts = raw.maxConcurrentExperts ?? 4;
	if (!Number.isInteger(maxConcurrentExperts) || maxConcurrentExperts < 1 || maxConcurrentExperts > 16) {
		throw new ConfigError(`${file}：maxConcurrentExperts（${JSON.stringify(maxConcurrentExperts)}）必须是 1 到 16 的整数`);
	}
	const sources = raw.sources ?? {};
	if (sources === null || typeof sources !== "object" || Array.isArray(sources)) {
		throw new ConfigError(`${file}：sources（${JSON.stringify(sources)}）必须是以来源名为键的对象`);
	}
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
		consultTimeoutSeconds,
		maxConcurrentExperts,
		retryAttempts: raw.retryAttempts ?? 3,
		probePrimaryMinutes: raw.probePrimaryMinutes ?? 15,
		heartbeatSeconds,
		watchdog,
		modulesDirs: raw.modulesDirs ?? [fileURLToPath(new URL("../../modules", import.meta.url)), join(stateDir, "modules")],
		rolesDir: join(stateDir, "roles"),
		webPort,
		secretsFile,
		sources,
	};
}
