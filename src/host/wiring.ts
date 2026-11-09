import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { Clock } from "../kernel/types.ts";
import { ModelSelector } from "../model-selector.ts";
import { formatModelRef, type ModelRef } from "../models.ts";
import type { Modules } from "../modules.ts";
import type { HostConfig } from "./config.ts";
import type { HostOptions } from "./host.ts";
import { PiWorkerSpawner } from "./pi-worker.ts";
import { Router } from "./router.ts";

export type ModelWiringConfig = Pick<HostConfig, "models" | "probePrimaryMinutes">;

export function modelSelectors(config: ModelWiringConfig, clock: Clock): { router: ModelSelector; worker: ModelSelector } {
	const make = (primary: ModelRef) =>
		new ModelSelector({ primary, fallback: config.models.fallback, probeEveryMs: config.probePrimaryMinutes * 60_000, clock });
	return { router: make(config.models.router), worker: make(config.models.worker) };
}

export interface HostWiringInput {
	config: HostConfig;
	modules: Modules;
	modelRuntime: ModelRuntime;
	log: (line: string) => void;
	clock?: Clock;
}

export function createHostOptions({ config, modules, modelRuntime, log, clock = { now: () => Date.now() } }: HostWiringInput): HostOptions {
	const resolve = (ref: ModelRef) => {
		const model = modelRuntime.getModel(ref.provider, ref.id);
		if (!model) throw new Error(`找不到模型 ${formatModelRef(ref)}`);
		return model;
	};
	resolve(config.models.router);
	resolve(config.models.worker);
	resolve(config.models.fallback);
	const selectors = modelSelectors(config, clock);
	return {
		stateDir: config.stateDir,
		heartbeatMs: config.heartbeatSeconds * 1000,
		config: config.kernel,
		log,
		sourcePolicy: modules.sourcePolicy,
		ruleAllows: modules.ruleAllows,
		rulesFor: modules.rulesFor,
		timers: modules.timers(),
		workerModels: { selector: selectors.worker, fallbackDailyTokens: config.fallbackDailyTokens },
		createRouter: (deps) =>
			Router.create({
				kernel: deps.kernel,
				modelRuntime,
				models: { selector: selectors.router, resolve },
				retry: { maxRetries: config.retryAttempts },
				cwd: join(config.stateDir, "router"),
				sessionDir: join(config.stateDir, "sessions", "router"),
				rules: modules.rulesPrompt(),
				rulesFor: modules.rulesFor,
				afterCommand: deps.afterCommand,
				onError: (e) => log(`[router] ${String(e)}`),
			}),
		createSpawner: (deps) =>
			new PiWorkerSpawner({
				socketPath: deps.socketPath,
				sessionDir: join(config.stateDir, "sessions", "workers"),
				bgMaxMs: config.bgMaxMinutes * 60_000,
				moduleFor: (ruleId) => {
					const mod = modules.moduleForRule(ruleId);
					return mod && { skillsDir: mod.skillsDir, prepare: mod.manifest.prepare };
				},
			}),
	};
}
