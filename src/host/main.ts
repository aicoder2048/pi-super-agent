import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { formatModelRef } from "../models.ts";
import { loadConfig, loadModules } from "./config.ts";
import { Host } from "./host.ts";
import { exitOnConfigError } from "../config-error.ts";
import { createHostOptions } from "./wiring.ts";

async function main(): Promise<void> {
	const config = loadConfig();
	const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);
	const modules = loadModules(config);
	const off = modules.found.filter((m) => !m.state.enabled).map((m) => m.name);
	log(`[host] 模块：${modules.modules.map((m) => m.name).join(", ") || "无"}${off.length ? `；停用 ${off.join(", ")}` : ""}；规则 ${modules.allRules().length} 条`);
	for (const id of modules.skippedUserRules) log(`[host] 规则 ${id} 没写「来源:」，不生效`);

	const host = await Host.start(createHostOptions({ config, modules, modelRuntime: await ModelRuntime.create(), log }));
	log(`[host] 已启动，状态目录 ${config.stateDir}，Router ${formatModelRef(config.models.router)}，Worker ${formatModelRef(config.models.worker)}，回退 ${formatModelRef(config.models.fallback)}`);
	log(`[host] 网页 ${host.webUrl}`);

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
}

main().catch(exitOnConfigError);
