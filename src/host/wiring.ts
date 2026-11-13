import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { Clock } from "../kernel/types.ts";
import { ConfigError } from "../config-error.ts";
import { ModelSelector } from "../model-selector.ts";
import { formatModelRef, type ModelRef } from "../models.ts";
import type { LoadedModule, Modules } from "../modules.ts";
import type { LiveModules } from "./live-modules.ts";
import type { WatchedSource } from "../client/protocol.ts";
import type { TimerEntry } from "../sources/timer.ts";
import { FEEDS, type FeedSpec } from "../sources/feeds.ts";
import type { HostConfig } from "./config.ts";
import type { HostOptions } from "./host.ts";
import { helperSessionDir } from "./dispatch.ts";
import { PiWorkerSpawner } from "./pi-worker.ts";
import { Router, routerPreamble } from "./router.ts";
import { readSecret, secretLookup } from "../secrets.ts";
import { createGateway } from "../modules/gateway.ts";
import { googlePort } from "../modules/google-port.ts";
import { instanceData } from "../modules/instance-data.ts";
import { moduleDataDir } from "../modules/knowledge.ts";
import { ModuleStore } from "../modules/live.ts";
import type { Digest } from "../modules/manifest.ts";
import { BotApi, BotToken } from "./telegram/bot-api.ts";
import type { TelegramOptions } from "./telegram/client.ts";

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
	const declaredBy = (list: LoadedModule[]) => list.flatMap((m) => (m.manifest.sources ?? []).filter((s) => s.feed).map((s) => ({ module: m, source: s })));
	const declared = declaredBy(modules.modules);
	const names = declaredBy(modules.found).map((d) => d.source.name);
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

export function telegramOptions(config: Pick<HostConfig, "stateDir" | "secretsFile" | "telegram">, env: Readonly<NodeJS.ProcessEnv>, log: (line: string) => void): TelegramOptions | undefined {
	if (!config.telegram) return undefined;
	const found = readSecret(["TELEGRAM_BOT_TOKEN"], "TELEGRAM_BOT_TOKEN", env, config.secretsFile);
	if (!found) throw new ConfigError(`${join(config.stateDir, "config.json")}：写了 telegram 段，但环境变量和 secretsFile 里都没有 TELEGRAM_BOT_TOKEN`);
	const token = new BotToken(found.key, found.origin);
	log(`[telegram] bot token 来自${found.origin}`);
	return { api: new BotApi({ token }), allowedUserIds: new Set(config.telegram.allowedUserIds) };
}

export interface HostWiringInput {
	config: HostConfig;
	/** The timers, the feeds and `watching` are read once here; F5 makes them follow. */
	modules: Pick<LiveModules, "live" | "kitFor" | "cards" | "setSwitch" | "onChange">;
	modelRuntime: ModelRuntime;
	log: (line: string) => void;
	clock?: Clock;
}

export function createHostOptions({ config, modules: panel, modelRuntime, log, clock = { now: () => Date.now() } }: HostWiringInput): HostOptions {
	const { live, kitFor } = panel;
	const modules = live.current();
	const resolve = (ref: ModelRef, role?: string) => {
		const model = modelRuntime.getModel(ref.provider, ref.id);
		if (!model) throw new ConfigError(`${role ? `${join(config.stateDir, "config.json")}：models.${role}：` : ""}找不到模型 ${formatModelRef(ref)}`);
		return model;
	};
	resolve(config.models.router, "router");
	resolve(config.models.worker, "worker");
	resolve(config.models.fallback, "fallback");
	for (const member of modules.modules.flatMap((m) => m.team?.members ?? [])) {
		if (member.model && !modelRuntime.getModel(member.model.provider, member.model.id)) throw new ConfigError(`${member.file}：model：找不到模型 ${formatModelRef(member.model)}`);
	}
	const selectors = modelSelectors(config, clock);
	const timers = modules.timers();
	const feeds = feedSpecs(config, modules, log);
	const telegram = telegramOptions(config, process.env, log);
	const store = new ModuleStore(join(config.stateDir, "module-store"));
	const secret = secretLookup(config.secretsFile);
	return {
		stateDir: config.stateDir,
		heartbeatMs: config.heartbeatSeconds * 1000,
		webPort: config.webPort,
		webHosts: config.webHosts,
		config: config.kernel,
		log,
		sourcePolicy: (trigger) => live.current().sourcePolicy(trigger),
		ruleAllows: (ruleId, source) => live.current().ruleAllows(ruleId, source),
		isMarketSource: (source) => live.current().isMarketSource(source),
		moduleFeeds: { feeds: () => live.current().feeds(), fixtures: config.feedFixtures, secret },
		domains: { book: () => live.current().book, kitFor },
		modules: panel,
		gateway: createGateway({
			copyDir: (module, digest) => store.dirOf(module, digest),
			serving: (module) => live.current().book.get(module)?.digest as Digest | undefined,
			dataDir: (module) => moduleDataDir(config.stateDir, module),
			rows: instanceData(config.stateDir),
			secret,
			log,
			google: googlePort({ secret, oauthUrl: process.env.PSA_GOOGLE_OAUTH_URL, fixtures: config.feedFixtures }),
		}),
		rulesFor: (source) => live.current().rulesFor(source),
		timers,
		watching: watchedSources(modules, timers),
		feeds,
		...(telegram && { telegram }),
		workerModels: { selector: selectors.worker, fallbackDailyTokens: config.fallbackDailyTokens },
		outputDir: config.outputDir,
		dispatch: {
			timeoutMs: config.dispatchTimeoutSeconds * 1000,
			codingTimeoutMs: config.dispatchCodingTimeoutSeconds * 1000,
			stallMs: config.dispatchStallSeconds * 1000,
			maxConcurrent: config.maxConcurrentExperts,
		},
		createRouter: (deps) =>
			Router.create({
				kernel: deps.kernel,
				modelRuntime,
				models: { selector: selectors.router, resolve },
				retry: { maxRetries: config.retryAttempts },
				cwd: join(config.stateDir, "router"),
				sessionDir: join(config.stateDir, "sessions", "router"),
				preamble: () => {
					const current = live.current();
					return routerPreamble(current.rosterPrompt(), current.rulesPrompt());
				},
				rulesFor: deps.rulesFor,
				afterCommand: deps.afterCommand,
				onError: (e) => log(`[router] ${String(e)}`),
			}),
		createSpawner: (deps) =>
			new PiWorkerSpawner({
				socketPath: deps.socketPath,
				sessionDir: helperSessionDir(config.stateDir),
				cliPath: process.env.PSA_PI_CLI || undefined,
				bgMaxMs: config.bgMaxMinutes * 60_000,
				lookupHelp: feeds.map((f) => f.lookupHelp).join("\n") || undefined,
				tripwireHelp: feeds.map((f) => f.tripwireHelp).filter(Boolean).join("\n") || undefined,
			}),
	};
}
