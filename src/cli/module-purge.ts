import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { exitOnConfigError } from "../config-error.ts";
import { loadConfig } from "../host/config.ts";
import { inTransaction, moduleRows, openStore, saveModuleRecord } from "../kernel/store.ts";
import { instanceData } from "../modules/instance-data.ts";
import { moduleDataDir } from "../modules/knowledge.ts";
import { initialRecord, transition } from "../modules/lifecycle.ts";
import { drive } from "../modules/live.ts";
import type { ModuleName } from "../modules/manifest.ts";

async function firstLine(prompt: string): Promise<string> {
	process.stdout.write(prompt);
	const lines = createInterface({ input: process.stdin });
	for await (const line of lines) {
		lines.close();
		return line.trim();
	}
	return "";
}

export async function purgeModule(name: string, confirm: string | undefined): Promise<number> {
	try {
		const { stateDir } = loadConfig();
		const dir = moduleDataDir(stateDir, name);
		if (!existsSync(dir)) {
			console.log(`${name} 没有实例数据，不用删`);
			return 0;
		}
		const db = openStore(join(stateDir, "state.db"));
		// The switch can be on before the host's next poll moves the record out of disabled.
		const purgeable = () => {
			const row = moduleRows(db).find((r) => r.name === name);
			const record = row?.record ?? initialRecord(name as ModuleName);
			return row?.switch === true || record.pending.length > 0 || transition(record, { type: "purge" }).effects.length === 0 ? null : record;
		};
		const stillOn = () => {
			console.log(`${name} 还开着，先 just module off ${name}，等 just modules 显示已停用再删`);
			return 1;
		};
		try {
			if (purgeable() === null) return stillOn();
			const typed = confirm ?? (await firstLine(`要删除 ${name} 的全部实例数据（${dir}），删了找不回来。再输入一次模块名确认：`));
			if (typed !== name) {
				console.log(`输入的是「${typed}」，和 ${name} 不一样，什么都没删`);
				return 1;
			}
			const data = instanceData(stateDir);
			// Read again under the write lock: the module may have been switched on while the prompt waited.
			const purged = inTransaction(db, () => {
				const record = purgeable();
				if (record === null) return false;
				drive(record, { type: "purge" }, (r) => saveModuleRecord(db, r), (effect) => {
					if (effect.do === "purge-data") data.purge(name as ModuleName);
					return null;
				});
				return true;
			});
			if (!purged) return stillOn();
			console.log(`删掉了 ${name} 的全部实例数据（${dir}）。模块包没动`);
			return 0;
		} finally {
			db.close();
		}
	} catch (error) {
		return exitOnConfigError(error);
	}
}
