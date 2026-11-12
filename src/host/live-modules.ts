/**
 * Keeps the host's module table live. Every module, legacy or package, has a lifecycle record
 * in state.db. The user's switch sits next to it in its own column, written by
 * `just module on|off` whether or not the host runs. The host polls the switches and drives
 * each record to match, so a switch takes effect within one poll.
 */
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { moduleRows, pinnedCopies, saveModuleRecord, setModuleSwitch } from "../kernel/store.ts";
import { packageModule, type DomainKit, type LoadedModule, type Modules } from "../modules.ts";
import { initialRecord, type Effect, type ModuleEvent, type Version } from "../modules/lifecycle.ts";
import { drive, liveRegistry, ModuleStore, switchEvent } from "../modules/live.ts";
import type { Digest, ModuleName, PackageScan, Problem, ScanResult } from "../modules/manifest.ts";
import type { LiveRegistry } from "../modules/registry.ts";
import { digestOf, hasCases, runCasesAsync, scanPackage } from "../modules/validate.ts";

const POLL_MS = 500;
const LEGACY_LABEL = "旧布局";

export interface LiveModules {
	readonly live: LiveRegistry<Modules>;
	/** `pin` null: the serving table. Otherwise the ticket's copy, served even after the module is switched off. */
	kitFor(domain: string, pin: string | null): DomainKit | undefined;
	tick(): void;
	stop(): void;
}

export interface LiveModulesOptions {
	db: DatabaseSync;
	stateDir: string;
	discovered: Modules;
	/** config.json's `modules`, imported into the switches on the first boot only. */
	configSwitches: Record<string, boolean>;
	log: (line: string) => void;
}

const versionOf = (dir: string, scan: ScanResult): Version =>
	scan.ok ? { digest: scan.scan.digest, label: scan.scan.manifest.version } : { digest: digestOf(dir), label: "?" };

/** `legacy` is set for a module the legacy loader read; it serves from its folder, with no copy. */
type Found = { dir: string; version: Version; legacy?: LoadedModule };

export function startLiveModules({ db, stateDir, discovered, configSwitches, log }: LiveModulesOptions): LiveModules {
	const store = new ModuleStore(join(stateDir, "module-store"));
	const found = new Map<string, Found>([
		...discovered.found.map((m): [string, Found] => [m.name, { dir: m.dir, version: { digest: digestOf(m.dir), label: LEGACY_LABEL }, legacy: m }]),
		...discovered.packages.map(({ name, dir, scan }): [string, Found] => [name, { dir, version: versionOf(dir, scan) }]),
	]);
	const defaultOn = (name: string) => {
		const legacy = found.get(name)?.legacy;
		return legacy !== undefined && legacy.manifest.defaultEnabled !== false;
	};
	const safely = (what: string, work: () => void) => {
		try {
			work();
		} catch (error) {
			log(`[modules] ${what}出错：${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const copies = new Map<Digest, LoadedModule | undefined>();
	const fromCopy = (module: ModuleName, digest: Digest): LoadedModule | undefined => {
		if (!copies.has(digest)) {
			try {
				copies.set(digest, packageModule(store.dirOf(module, digest), module));
			} catch (error) {
				copies.set(digest, undefined);
				log(`[modules] ${module} 的副本 ${digest.slice(0, 12)} 用不了：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return copies.get(digest);
	};

	const rows = moduleRows(db);
	const records = new Map(rows.flatMap((r) => (r.record ? [[r.name, r.record] as const] : [])));
	if (records.size === 0) {
		const switched = new Set(rows.filter((r) => r.switch !== null).map((r) => r.name));
		for (const name of found.keys()) if (!switched.has(name)) setModuleSwitch(db, name, configSwitches[name] ?? defaultOn(name));
	} else if (Object.keys(configSwitches).length > 0) {
		log("[modules] config.json 的 modules 开关已在第一次启动时导入，之后不再读它；开关模块用 just module on <名字> 或 just module off <名字>");
	}

	const caseResults = new Map<string, { digest: Digest; problems: readonly Problem[] | null }>();
	let stopped = false;
	const runCases = (name: string, scan: PackageScan) => {
		caseResults.set(name, { digest: scan.digest, problems: null });
		void runCasesAsync(scan).then((problems) => {
			if (stopped || caseResults.get(name)?.digest !== scan.digest) return;
			caseResults.set(name, { digest: scan.digest, problems });
			safely("工具测试用例跑完后更新模块", () => {
				step(name, null);
				live.publish(table());
			});
		});
	};
	const check = (name: string, entry: Found, version: Version): ModuleEvent | "wait" => {
		const ok = (problems: readonly Problem[] = []): ModuleEvent => ({ type: "checked", digest: version.digest, problems });
		if (entry.legacy) return ok();
		const result = scanPackage(entry.dir, { runCases: false });
		if (!result.ok) return ok(result.problems);
		if (result.scan.digest !== version.digest) return { type: "package-found", version: versionOf(entry.dir, result) };
		if (!hasCases(result.scan)) return ok();
		const ran = caseResults.get(name);
		if (ran?.digest !== version.digest) runCases(name, result.scan);
		else if (ran.problems !== null) {
			caseResults.delete(name);
			return ok(ran.problems);
		}
		return "wait";
	};
	const run = (name: string) => (effect: Effect): ModuleEvent | null | "wait" => {
		const entry = found.get(name);
		if (effect.do === "migrate") return { type: "migrated", attempt: effect.attempt };
		if (effect.do === "check") return entry === undefined ? null : check(name, entry, effect.version);
		if (effect.do !== "publish" || effect.serve === null || entry === undefined || entry.legacy) return null;
		if (store.keep(name as ModuleName, effect.serve.digest, entry.dir)) {
			// A copy that failed to load earlier exists now.
			copies.delete(effect.serve.digest);
			return null;
		}
		log(`[modules] ${name} 的文件在复制时变了，重新检查`);
		return { type: "package-found", version: versionOf(entry.dir, scanPackage(entry.dir, { runCases: false })) };
	};
	const step = (name: string, event: ModuleEvent | null) => {
		const record = drive(records.get(name) ?? initialRecord(name as ModuleName), event, (r) => saveModuleRecord(db, r), run(name));
		records.set(name, record);
	};

	const table = (): Modules => {
		const serving = [...found].flatMap(([name, entry]): LoadedModule[] => {
			const record = records.get(name);
			if (record?.state.at !== "active") return [];
			return entry.legacy ? [entry.legacy] : (fromCopy(name as ModuleName, record.state.serving.digest) ?? []);
		});
		return discovered.serve(serving);
	};
	const collect = () => {
		const serving = [...records.values()].flatMap((r) => (r.state.at === "active" ? [`${r.name}/${r.state.serving.digest}`] : []));
		safely("回收旧副本", () => store.collect(new Set([...serving, ...pinnedCopies(db).map((p) => `${p.module}/${p.digest}`)])));
	};
	const reconcile = (): boolean => {
		let changed = false;
		const switches = new Map(moduleRows(db).map((r) => [r.name, r.switch]));
		for (const [name, record] of records) {
			const event = switchEvent(record, switches.get(name) ?? defaultOn(name));
			if (event === null) continue;
			step(name, event);
			changed = true;
		}
		return changed;
	};

	for (const [name, { version }] of found) step(name, { type: "package-found", version });
	for (const name of records.keys()) if (!found.has(name)) step(name, { type: "package-gone" });
	reconcile();
	const live = liveRegistry(table());
	collect();

	const tick = () => {
		if (reconcile()) live.publish(table());
		collect();
	};
	const timer = setInterval(() => safely("开关轮询", tick), POLL_MS);
	timer.unref();

	return {
		live,
		kitFor: (domain, pin) => {
			if (pin === null) return live.current().kitFor(domain);
			const copy = fromCopy(domain as ModuleName, pin as Digest);
			return copy && discovered.serve([copy]).kitFor(domain);
		},
		tick,
		stop: () => {
			stopped = true;
			clearInterval(timer);
		},
	};
}
