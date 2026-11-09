import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { formatModelRef } from "../models.ts";
import { Modules } from "../modules.ts";
import { loadConfig } from "./config.ts";
import { Host } from "./host.ts";
import { PiWorkerSpawner } from "./pi-worker.ts";
import { Router } from "./router.ts";

const config = loadConfig();
const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);
const modules = Modules.load(config.modulesDirs, join(config.stateDir, "rules.md"));
log(`[host] 模块：${modules.modules.map((m) => m.name).join(", ") || "无"}；规则 ${modules.allRules().length} 条`);

const modelRuntime = await ModelRuntime.create();
const routerModel = modelRuntime.getModel(config.models.router.provider, config.models.router.id);
if (!routerModel) throw new Error(`找不到 Router 模型 ${formatModelRef(config.models.router)}`);

const host = await Host.start({
	stateDir: config.stateDir,
	config: config.kernel,
	log,
	sourcePolicy: modules.sourcePolicy,
	isKnownRule: modules.isKnownRule,
	timers: modules.timers(),
	createRouter: (deps) =>
		Router.create({
			kernel: deps.kernel,
			modelRuntime,
			model: routerModel,
			cwd: join(config.stateDir, "router"),
			sessionDir: join(config.stateDir, "sessions", "router"),
			rules: modules.rulesPrompt(),
			afterCommand: deps.afterCommand,
			onError: (e) => log(`[router] ${String(e)}`),
		}),
	createSpawner: (deps) =>
		new PiWorkerSpawner({
			socketPath: deps.socketPath,
			sessionDir: join(config.stateDir, "sessions", "workers"),
			model: () => ({ model: config.models.worker, fellBack: false }),
			bgMaxMs: config.bgMaxMinutes * 60_000,
			moduleFor: (ruleId) => {
				const mod = modules.moduleForRule(ruleId);
				return mod && { skillsDir: mod.skillsDir, prepare: mod.manifest.prepare };
			},
		}),
});

log(`[host] 已启动，状态目录 ${config.stateDir}，Router ${formatModelRef(config.models.router)}，Worker ${formatModelRef(config.models.worker)}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		if (stopping) return;
		stopping = true;
		log(`[host] 收到 ${signal}，正在停止`);
		await host.stop();
		process.exit(0);
	});
}
