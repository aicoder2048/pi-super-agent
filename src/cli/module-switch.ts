import { join } from "node:path";
import { exitOnConfigError } from "../config-error.ts";
import { loadConfig, loadModules } from "../host/config.ts";
import { moduleRows, openStore, setModuleSwitch } from "../kernel/store.ts";

/** Writes the switch only. A package that is away still has its record, so it can be switched off until it returns. A running host picks it up at its next poll, otherwise at its next start. */
export function switchModule(name: string, on: boolean): number {
	try {
		const config = loadConfig();
		const modules = loadModules(config);
		const found = [...modules.found, ...modules.packages].map((m) => m.name);
		const db = openStore(join(config.stateDir, "state.db"));
		try {
			const rows = moduleRows(db);
			const names = [...new Set([...found, ...rows.filter((r) => r.record !== null).map((r) => r.name)])].sort();
			if (!names.includes(name)) {
				console.log(`${name} 不是已发现的模块，已发现：${names.join("、") || "（没有）"}`);
				return 1;
			}
			setModuleSwitch(db, name, on);
			console.log(`${on ? "打开" : "关掉"}了 ${name}：宿主在运行就马上生效，没在运行就下次启动时生效。用 just modules 看状态`);
		} finally {
			db.close();
		}
		return 0;
	} catch (error) {
		return exitOnConfigError(error);
	}
}
