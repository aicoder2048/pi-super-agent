/**
 * The lifecycle of one module on this host.
 *
 * Switching a module on is the user's whole authorization. After that the host follows the
 * folder: a saved file is a new version, and it serves as soon as it passes the check.
 *
 * `transition` is pure. The record it returns carries its own outbox: `pending` lists the
 * effects that still have to run, in order. The driver, for one module at a time:
 * 1. Persists the record in `state.db`.
 * 2. Runs `pending[0]`. A `check` or a `migrate` ends with a result event.
 * 3. Persists `settle(record)`, passed through `transition` with the result event when
 *    there is one. Back to 2 until `pending` is empty.
 * One module's effects never run side by side, and each is safe to run twice. After a
 * crash the driver continues from the persisted `pending`, so nothing is lost.
 */
import type { Digest, ModuleName, Problem } from "./manifest.ts";

/** One package as found on disk. `label` is the semver string, for display only. */
export interface Version {
	digest: Digest;
	label: string;
}

/** A version on its way in. Used both for a first enable and for an update of a serving module. */
export type Stage =
	| { at: "checking"; version: Version }
	| { at: "invalid"; version: Version; problems: readonly Problem[] }
	/** `attempt` names this run of the migration. A result that carries another number is from an earlier run and is ignored. */
	| { at: "migrating"; version: Version; attempt: number };

export type ModuleState =
	/** Never seen with a package, or its package folder is gone. Instance data, if any, is kept. `wasOn` is the user's switch. */
	| { at: "missing"; last: Version | null; wasOn: boolean }
	/** The package is there and the user has it switched off. Nothing of it runs. */
	| { at: "disabled"; onDisk: Version }
	/** Switched on, not serving yet. */
	| { at: "staging"; stage: Stage }
	/** Serving. `update` is a newer version on its way in while the old one keeps serving. */
	| { at: "active"; serving: Version; update: Stage | null };

export interface ModuleRecord {
	name: ModuleName;
	state: ModuleState;
	/** Migrations started so far. The next `migrate` carries this number plus one. */
	attempts: number;
	/** The outbox. `transition` appends, the driver runs the first entry and calls `settle`. */
	pending: readonly Effect[];
}

export type ModuleEvent =
	/** The watcher saw a package folder, new or changed. */
	| { type: "package-found"; version: Version }
	| { type: "package-gone" }
	/** The user switched the module on or off (web page, TUI or `just module on|off`). */
	| { type: "enable" }
	| { type: "disable" }
	| { type: "checked"; digest: Digest; problems: readonly Problem[] }
	| { type: "migrated"; attempt: number }
	/** The driver has already restored the instance data snapshot. */
	| { type: "migration-failed"; attempt: number; reason: string }
	/** The user confirmed deleting the instance data. */
	| { type: "purge" };

export type Effect =
	| { do: "check"; version: Version }
	/** Snapshot instance data, apply what `to` adds or renames, restore the snapshot on failure. The result event carries `attempt`. */
	| { do: "migrate"; from: Version | null; to: Version; attempt: number }
	/** Copy `serve` into the module store and swap the live registry so the module serves it, or is absent when null. */
	| { do: "publish"; serve: Version | null }
	/** Mark the module's open tickets and tell their Workers. */
	| { do: "mark-tickets"; mark: "module-disabled" | "module-missing" }
	| { do: "purge-data" };

export function initialRecord(name: ModuleName): ModuleRecord {
	return { name, state: { at: "missing", last: null, wasOn: false }, attempts: 0, pending: [] };
}

/** The record after the driver has run `pending[0]`. */
export function settle(record: ModuleRecord): ModuleRecord {
	return { ...record, pending: record.pending.slice(1) };
}

/** A stage's next step: another stage, or `arrived` when the version now serves. */
type Move = { attempts?: number; effects: Effect[] } & ({ stage: Stage } | { arrived: Version });

/** One version moving through its stages. `serving` is what keeps running meanwhile, if anything. */
function advance(record: ModuleRecord, stage: Stage, event: ModuleEvent, serving: Version | null): Move | null {
	const version = stage.version;
	if (stage.at === "checking" && event.type === "checked" && event.digest === version.digest) {
		if (event.problems.length > 0) return { stage: { at: "invalid", version, problems: event.problems }, effects: [] };
		const attempt = record.attempts + 1;
		return { stage: { at: "migrating", version, attempt }, attempts: attempt, effects: [{ do: "migrate", from: serving, to: version, attempt }] };
	}
	if (stage.at === "migrating" && event.type === "migrated" && event.attempt === stage.attempt) {
		return { arrived: version, effects: [{ do: "publish", serve: version }] };
	}
	if (stage.at === "migrating" && event.type === "migration-failed" && event.attempt === stage.attempt) {
		return { stage: { at: "invalid", version, problems: [{ where: "data", reason: event.reason }] }, effects: [] };
	}
	return null;
}

/**
 * The whole state machine. An event that does not apply in the current state returns the
 * record unchanged, so a duplicate or late event is harmless.
 */
export function transition(record: ModuleRecord, event: ModuleEvent): { record: ModuleRecord; effects: readonly Effect[] } {
	const unchanged = { record, effects: [] };
	const state = record.state;
	const to = (next: ModuleState, effects: Effect[] = [], attempts = record.attempts) => ({
		record: { ...record, attempts, state: next, pending: [...record.pending, ...effects] },
		effects,
	});
	const check = (version: Version): [Stage, Effect[]] => [{ at: "checking", version }, [{ do: "check", version }]];

	switch (state.at) {
		case "missing": {
			if (event.type === "package-found") {
				if (!state.wasOn) return to({ at: "disabled", onDisk: event.version });
				const [stage, effects] = check(event.version);
				return to({ at: "staging", stage }, effects);
			}
			if (event.type === "enable" || event.type === "disable") {
				const on = event.type === "enable";
				return state.wasOn === on ? unchanged : to({ at: "missing", last: state.last, wasOn: on });
			}
			if (event.type === "purge") return to({ at: "missing", last: null, wasOn: state.wasOn }, [{ do: "purge-data" }]);
			return unchanged;
		}
		case "disabled": {
			if (event.type === "enable") {
				const [stage, effects] = check(state.onDisk);
				return to({ at: "staging", stage }, effects);
			}
			if (event.type === "package-found") return event.version.digest === state.onDisk.digest ? unchanged : to({ at: "disabled", onDisk: event.version });
			if (event.type === "package-gone") return to({ at: "missing", last: state.onDisk, wasOn: false });
			if (event.type === "purge") return to(state, [{ do: "purge-data" }]);
			return unchanged;
		}
		case "staging": {
			const version = state.stage.version;
			if (event.type === "package-found") {
				if (event.version.digest === version.digest) return unchanged;
				const [stage, effects] = check(event.version);
				return to({ at: "staging", stage }, effects);
			}
			if (event.type === "disable") return to({ at: "disabled", onDisk: version });
			if (event.type === "package-gone") return to({ at: "missing", last: version, wasOn: true });
			const moved = advance(record, state.stage, event, null);
			if (moved === null) return unchanged;
			if ("arrived" in moved) return to({ at: "active", serving: moved.arrived, update: null }, moved.effects);
			return to({ at: "staging", stage: moved.stage }, moved.effects, moved.attempts);
		}
		case "active": {
			if (event.type === "package-found") {
				if (event.version.digest === (state.update?.version.digest ?? state.serving.digest)) return unchanged;
				if (event.version.digest === state.serving.digest) return to({ at: "active", serving: state.serving, update: null });
				const [stage, effects] = check(event.version);
				return to({ at: "active", serving: state.serving, update: stage }, effects);
			}
			if (event.type === "disable" || event.type === "package-gone") {
				const gone = event.type === "package-gone";
				return to(gone ? { at: "missing", last: state.serving, wasOn: true } : { at: "disabled", onDisk: state.update?.version ?? state.serving }, [
					{ do: "publish", serve: null },
					{ do: "mark-tickets", mark: gone ? "module-missing" : "module-disabled" },
				]);
			}
			if (state.update === null) return unchanged;
			const moved = advance(record, state.update, event, state.serving);
			if (moved === null) return unchanged;
			if ("arrived" in moved) return to({ at: "active", serving: moved.arrived, update: null }, moved.effects);
			return to({ at: "active", serving: state.serving, update: moved.stage }, moved.effects, moved.attempts);
		}
	}
}

export const problemText = (problem: Problem) => `${problem.where}：${problem.reason}`;

/** The one line the modules page and `just module list` show. */
export function describe(record: ModuleRecord): { label: string; reason: string } {
	const stageLine = (stage: Stage): { label: string; reason: string } => {
		if (stage.at === "checking") return { label: "检查中", reason: `正在检查 ${stage.version.label}` };
		if (stage.at === "migrating") return { label: "迁移中", reason: `正在按 ${stage.version.label} 调整数据结构` };
		const first = stage.problems[0];
		return { label: "无效", reason: first === undefined ? "检查没有通过" : problemText(first) };
	};
	const state = record.state;
	if (state.at === "missing") return { label: "包不在了", reason: state.last === null ? "没有见过这个模块包" : "模块包被拿掉了，数据还留着" };
	if (state.at === "disabled") return { label: "已停用", reason: "你把它关了，数据还留着" };
	if (state.at === "staging") return stageLine(state.stage);
	if (state.update === null) return { label: "运行中", reason: state.serving.label };
	const next = stageLine(state.update);
	return { label: "运行中", reason: `${state.serving.label} 在运行；你刚改的版本${next.label}：${next.reason}` };
}
