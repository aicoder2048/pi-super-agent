import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_MODELS, parseModelRef, type ModelRef } from "../models.ts";
import type { KernelConfig } from "../kernel/types.ts";

export interface HostConfig {
	stateDir: string;
	models: { router: ModelRef; worker: ModelRef; fallback: ModelRef };
	kernel: Partial<KernelConfig>;
	bgMaxMinutes: number;
	fallbackDailyTokens: number;
	retryAttempts: number;
	probePrimaryMinutes: number;
	watchdog: { intervalMinutes: number; stuckMinutes: number };
	modulesDirs: string[];
}

export function defaultStateDir(): string {
	return resolve(process.env.PSA_STATE_DIR ?? join(homedir(), ".pi-super-agent"));
}

export function loadConfig(stateDir = defaultStateDir()): HostConfig {
	mkdirSync(stateDir, { recursive: true });
	const file = join(stateDir, "config.json");
	const raw = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, any>) : {};
	const models = { ...DEFAULT_MODELS, ...(raw.models ?? {}) };
	return {
		stateDir,
		models: { router: parseModelRef(models.router), worker: parseModelRef(models.worker), fallback: parseModelRef(models.fallback) },
		kernel: raw.kernel ?? {},
		bgMaxMinutes: raw.bgMaxMinutes ?? 120,
		fallbackDailyTokens: raw.fallbackDailyTokens ?? 8_000_000,
		retryAttempts: raw.retryAttempts ?? 3,
		probePrimaryMinutes: raw.probePrimaryMinutes ?? 15,
		watchdog: { intervalMinutes: 3, stuckMinutes: 30, ...(raw.watchdog ?? {}) },
		modulesDirs: raw.modulesDirs ?? [join(stateDir, "modules")],
	};
}
