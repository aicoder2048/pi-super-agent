import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { Clock } from "../kernel/types.ts";
import { ConfigError } from "../config-error.ts";
import { ModelSelector } from "../model-selector.ts";
import { formatModelRef, type ModelRef } from "../models.ts";
import type { Modules } from "../modules.ts";
import { BUILTIN_ROLES_DIR, Roster } from "../roles.ts";
import type { WatchedSource } from "../client/protocol.ts";
import type { TimerEntry } from "../sources/timer.ts";
import { FEEDS, type FeedSpec } from "../sources/feeds.ts";
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

export function watchedSources(modules: Modules, timers: TimerEntry[]): WatchedSource[] {
	const userIds = new Set(modules.userRules.map((r) => r.id));
	const filters = modules.modules.flatMap((m) => m.manifest.sources ?? []);
	const ignored = new Set(filters.filter((s) => s.mode === "ignore").map((s) => s.name));
	const rules = modules.allRules();
	const names = new Set([...filters.map((s) => s.name), ...timers.map((t) => t.source!), ...rules.flatMap((r) => r.sources)]);
	const watched = [...names].filter((source) => !ignored.has(source)).map((source) => ({
		source,
		...pick(filters.find((s) => s.name === source)),
		timers: timers.filter((t) => t.source === source).map((t) => ({ everyMinutes: t.everyMinutes, body: t.body })),
		rules: rules.filter((r) => r.sources.includes(source)).map((r) => ({ id: r.id, text: r.text, by: userIds.has(r.id) ? ("user" as const) : ("module" as const) })),
	}));
	const hasUserRule = (w: WatchedSource) => w.rules.some((r) => r.by === "user");
	return watched.sort((a, b) => Number(hasUserRule(b)) - Number(hasUserRule(a)) || a.source.localeCompare(b.source));
}

function pick(filter: { title?: string; description?: string } | undefined) {
	return { ...(filter?.title && { title: filter.title }), ...(filter?.description && { description: filter.description }) };
}

export function feedSpecs(config: Pick<HostConfig, "stateDir" | "secretsFile" | "sources">, modules: Modules, log: (line: string) => void, env = process.env): FeedSpec[] {
	const declared = modules.modules.flatMap((m) => (m.manifest.sources ?? []).filter((s) => s.feed).map((s) => ({ module: m, source: s })));
	const names = declared.map((d) => d.source.name);
	const unknown = Object.keys(config.sources).find((name) => !names.includes(name));
	if (unknown) throw new ConfigError(`${join(config.stateDir, "config.json")}：sources.${unknown} 不是可配置的来源，可配置：${names.join("、") || "（没有）"}`);
	return declared.map(({ module: m, source: s }) => {
		const build = FEEDS[s.feed!.kind];
		if (!build) throw new ConfigError(`${join(m.dir, "module.json")}：来源 ${s.name} 的 feed.kind「${s.feed!.kind}」不存在，可用：${Object.keys(FEEDS).join("、")}`);
		return build({
			source: s.name,
			title: s.title ?? s.name,
			settings: s.feed!.settings,
			override: config.sources[s.name],
			where: `${join(config.stateDir, "config.json")} 的 sources.${s.name} 或 ${join(m.dir, "module.json")}`,
			secretsFile: config.secretsFile,
			env,
			log,
		});
	});
}

/** The built-in roles, then each module's, then the user's; the experts a rule names must be on it. */
export function loadRoster(config: Pick<HostConfig, "rolesDir" | "models">, modules: Modules): Roster {
	const subscribed = [...new Set([config.models.router.provider, config.models.worker.provider])];
	const roster = Roster.load(subscribed, [BUILTIN_ROLES_DIR, ...modules.modules.flatMap((m) => (m.rolesDir ? [m.rolesDir] : [])), config.rolesDir]);
	const experts = roster.names("expert");
	for (const rule of modules.allRules()) {
		const unknown = rule.experts?.find((e) => !experts.includes(e));
		if (unknown) throw new ConfigError(`规则 ${rule.id} 写的专家 ${unknown} 不在专家名册里，专家有：${experts.join("、")}`);
	}
	return roster;
}

export interface HostWiringInput {
	config: HostConfig;
	modules: Modules;
	modelRuntime: ModelRuntime;
	log: (line: string) => void;
	clock?: Clock;
}

export function createHostOptions({ config, modules, modelRuntime, log, clock = { now: () => Date.now() } }: HostWiringInput): HostOptions {
	const resolve = (ref: ModelRef, role?: string) => {
		const model = modelRuntime.getModel(ref.provider, ref.id);
		if (!model) throw new ConfigError(`${role ? `${join(config.stateDir, "config.json")}：models.${role}：` : ""}找不到模型 ${formatModelRef(ref)}`);
		return model;
	};
	resolve(config.models.router, "router");
	resolve(config.models.worker, "worker");
	resolve(config.models.fallback, "fallback");
	const roster = loadRoster(config, modules);
	log(`[host] 牵头角色：${roster.names("lead").join("、")}；专家：${roster.names("expert").join("、")}`);
	for (const name of roster.names()) {
		const role = roster.get(name)!;
		if (role.model && !modelRuntime.getModel(role.model.provider, role.model.id)) throw new ConfigError(`${role.file}：model：找不到模型 ${formatModelRef(role.model)}`);
	}
	const selectors = modelSelectors(config, clock);
	const timers = modules.timers();
	const feeds = feedSpecs(config, modules, log);
	return {
		stateDir: config.stateDir,
		heartbeatMs: config.heartbeatSeconds * 1000,
		webPort: config.webPort,
		config: config.kernel,
		log,
		sourcePolicy: modules.sourcePolicy,
		ruleAllows: modules.ruleAllows,
		isMarketSource: modules.isMarketSource,
		roles: roster.titles("lead"),
		ruleExperts: modules.ruleExperts,
		rulesFor: modules.rulesFor,
		timers,
		watching: watchedSources(modules, timers),
		feeds,
		consult: { experts: roster.titles("expert"), timeoutMs: config.consultTimeoutSeconds * 1000 },
		workerModels: { selector: selectors.worker, fallbackDailyTokens: config.fallbackDailyTokens, roleModel: (name) => roster.get(name)?.model },
		createRouter: (deps) =>
			Router.create({
				kernel: deps.kernel,
				modelRuntime,
				models: { selector: selectors.router, resolve },
				retry: { maxRetries: config.retryAttempts },
				cwd: join(config.stateDir, "router"),
				sessionDir: join(config.stateDir, "sessions", "router"),
				rules: modules.rulesPrompt(),
				roster: roster.rosterPrompt("lead"),
				rulesFor: deps.rulesFor,
				afterCommand: deps.afterCommand,
				onError: (e) => log(`[router] ${String(e)}`),
			}),
		createSpawner: (deps) =>
			new PiWorkerSpawner({
				socketPath: deps.socketPath,
				roster,
				sessionDir: join(config.stateDir, "sessions", "workers"),
				bgMaxMs: config.bgMaxMinutes * 60_000,
				lookupHelp: feeds.map((f) => f.lookupHelp).join("\n") || undefined,
				moduleFor: (ruleId) => {
					const mod = modules.moduleForRule(ruleId);
					return mod && { skillsDir: mod.skillsDir, prepare: mod.manifest.prepare };
				},
			}),
	};
}
