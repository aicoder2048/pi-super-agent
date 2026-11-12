import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { constants } from "node:os";
import { formatModelRef } from "../models.ts";
import { loadConfig, loadModules } from "./config.ts";
import { Host } from "./host.ts";
import { exitOnConfigError } from "../config-error.ts";
import { createHostOptions } from "./wiring.ts";
import { problemLine } from "../modules/validate.ts";
import { openStore } from "../kernel/store.ts";
import { startLiveModules } from "./live-modules.ts";
import { join } from "node:path";

async function main(): Promise<void> {
	const config = loadConfig();
	const log = (line: string) => console.error(`${new Date().toISOString()} ${line}`);
	const discovered = loadModules(config);
	for (const { name, scan } of discovered.packages) if (!scan.ok) log(`[host] 新布局包 ${name} 无效：${scan.problems.map(problemLine).join("；")}`);
	const live = startLiveModules({ db: openStore(join(config.stateDir, "state.db")), stateDir: config.stateDir, discovered, configSwitches: config.moduleSwitches, log });
	const modules = live.live.current();
	const off = [...discovered.found, ...discovered.packages.filter((p) => p.scan.ok)].map((m) => m.name).filter((name) => !modules.book.has(name));
	log(`[host] 模块：${modules.modules.map((m) => (m.team ? `${m.name}（${m.team.name}）` : m.name)).join(", ") || "无"}${off.length ? `；停用 ${off.join(", ")}` : ""}；规则 ${modules.allRules().length} 条`);
	for (const id of modules.skippedUserRules) log(`[host] 规则 ${id} 没写「来源:」，不生效`);

	const host = await Host.start(createHostOptions({ config, modules: live, modelRuntime: await ModelRuntime.create(), log }));
	log(`[host] 已启动，状态目录 ${config.stateDir}，Router ${formatModelRef(config.models.router)}，Worker ${formatModelRef(config.models.worker)}，回退 ${formatModelRef(config.models.fallback)}`);
	log(`[host] 网页 ${host.webUrl}`);
	for (const url of host.remoteWebUrls) log(`[host] 网页（远程） ${url}`);

	let stopping = false;
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, async () => {
			if (stopping) {
				log(`[host] 再次收到 ${signal}，立即退出`);
				process.exit(128 + constants.signals[signal]);
			}
			stopping = true;
			log(`[host] 收到 ${signal}，正在停止${signal === "SIGINT" ? "（再按一次 Ctrl+C 立即退出）" : ""}`);
			await host.stop();
			log("[host] 已停止");
			process.exit(0);
		});
	}
}

main().catch(exitOnConfigError);
