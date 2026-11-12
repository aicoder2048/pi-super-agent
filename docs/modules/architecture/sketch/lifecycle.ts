/**
 * The lifecycle of one module on this host.
 *
 * `transition` is pure. It returns the next record, and the record carries its own outbox:
 * `pending` lists the effects that still have to run, in order. The driver works on one
 * module at a time like this:
 *
 * 1. Persist the record in `state.db`.
 * 2. Run `pending[0]`. A `check` or a `migrate` ends with a result event.
 * 3. Persist `settle(record)`, or `transition(settle(record), result).record` when the
 *    effect had a result. Go to 2 until `pending` is empty.
 *
 * One module's effects never run side by side, so a `purge-data` queued behind a `migrate`
 * runs only after that migration has finished or been restored. Every effect is safe to
 * run twice. After a crash the driver continues from the persisted `pending` (`resume`),
 * so nothing a transition asked for is lost.
 */
import type { Digest, ModuleName, Problem } from "./manifest.ts";

/** One package as found on disk. Comes from `PackageScan`. */
export interface Version {
	digest: Digest;
	grantKey: Digest;
	/** The semver string, for display only. */
	label: string;
	/** From `needsCard`. False only for a package of skills, knowledge and read-only members. */
	asks: boolean;
}

/** The user's click on a grant card. It covers one `grantKey`, never "this module". */
export interface Grant {
	grantKey: Digest;
	cardId: string;
	at: string;
}

/** A version on its way in. Used both for a first enable and for an update of a serving module. */
export type Stage =
	| { at: "checking"; version: Version }
	| { at: "invalid"; version: Version; problems: readonly Problem[] }
	| { at: "awaiting-grant"; version: Version; cardId: string }
	| { at: "declined"; version: Version }
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
	/**
	 * Every grant the user gave, one per `grantKey`. A set, not one slot: an update that is
	 * granted and then fails must not erase the grant of the version that keeps serving.
	 * Grants survive disable and re-enable, so an unchanged package does not ask twice.
	 */
	grants: readonly Grant[];
	/** Every `grantKey` the user declined. Only `reconsider` takes one out. */
	declined: readonly Digest[];
	/** Cards issued so far. The next card's id ends in this number plus one. */
	cards: number;
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
	/** The user clicked the card. Never produced by a model, a feed or an IM chat. */
	| { type: "granted"; cardId: string; at: string }
	| { type: "declined"; cardId: string }
	/** The user asks, on the modules page, to be shown a card again for something they declined. */
	| { type: "reconsider" }
	| { type: "migrated"; attempt: number }
	/** The driver has already restored the instance data snapshot. */
	| { type: "migration-failed"; attempt: number; reason: string }
	/** The user confirmed deleting the instance data. */
	| { type: "purge" };

export type Effect =
	| { do: "check"; version: Version }
	/** `previous` is the latest grant. The card names what changed since it (`grantChanges`). */
	| { do: "issue-card"; cardId: string; version: Version; previous: Grant | null }
	| { do: "withdraw-card"; cardId: string }
	/**
	 * Snapshot instance data, create the collections and fields that `to` adds, restore the
	 * snapshot on failure. `to` never removes anything (the check refused that), so tickets
	 * pinned to `from` keep working and nothing waits for them. The result event carries `attempt`.
	 */
	| { do: "migrate"; from: Version | null; to: Version; attempt: number }
	/**
	 * Swap the live registry so this module serves `serve`, or is absent when null. The
	 * scheduler follows the registry, and module code runs one process per call, so there
	 * is nothing else to stop.
	 */
	| { do: "publish"; serve: Version | null }
	/** Mark the module's open tickets and tell their Workers. */
	| { do: "mark-tickets"; mark: "module-disabled" | "module-missing" }
	| { do: "purge-data" };

export interface Step {
	/** The next record. Its `pending` already ends with `effects`. */
	record: ModuleRecord;
	/** What this event added to the outbox. */
	effects: readonly Effect[];
}

export function initialRecord(name: ModuleName): ModuleRecord {
	return { name, state: { at: "missing", last: null, wasOn: false }, grants: [], declined: [], cards: 0, attempts: 0, pending: [] };
}

/**
 * The card id names the module, the exact thing being granted, and which card it is. An
 * old card cannot grant a new version, and an answered card is final: asking again makes
 * a new card with the next number. Same rule as `CAP_ASK_NEXT` in `src/kernel/cap-ask.ts`.
 */
export function cardIdFor(name: ModuleName, version: Version, card: number): string {
	return `ask_mod_${name}_${version.grantKey.slice(0, 16)}_${card}`;
}

/** What the driver runs next, in order. After a restart it is the same list. */
export function resume(record: ModuleRecord): readonly Effect[] {
	return record.pending;
}

/** The record after the driver has run `pending[0]`. */
export function settle(record: ModuleRecord): ModuleRecord {
	return { ...record, pending: record.pending.slice(1) };
}

function covered(record: ModuleRecord, version: Version): boolean {
	return !version.asks || record.grants.some((grant) => grant.grantKey === version.grantKey);
}

function withdrawals(stage: Stage | null): Effect[] {
	return stage?.at === "awaiting-grant" ? [{ do: "withdraw-card", cardId: stage.cardId }] : [];
}

type Counters = Pick<ModuleRecord, "grants" | "declined" | "cards" | "attempts">;

/** A stage's next step: another stage, or `arrived` when the version now serves. */
type Move = { change: Partial<Counters>; effects: Effect[] } & ({ stage: Stage } | { arrived: Version });

function startMigration(record: ModuleRecord, version: Version, serving: Version | null, change: Partial<Counters> = {}): Move {
	const attempt = record.attempts + 1;
	return {
		stage: { at: "migrating", version, attempt },
		change: { ...change, attempts: attempt },
		effects: [{ do: "migrate", from: serving, to: version, attempt }],
	};
}

function ask(record: ModuleRecord, version: Version, change: Partial<Counters> = {}): Move {
	const card = record.cards + 1;
	const cardId = cardIdFor(record.name, version, card);
	return {
		stage: { at: "awaiting-grant", version, cardId },
		change: { ...change, cards: card },
		effects: [{ do: "issue-card", cardId, version, previous: record.grants.at(-1) ?? null }],
	};
}

/** One version moving through its stages. `serving` is what keeps running meanwhile, if anything. */
function advance(record: ModuleRecord, stage: Stage, event: ModuleEvent, serving: Version | null): Move | null {
	const version = stage.version;
	switch (stage.at) {
		case "checking": {
			if (event.type !== "checked" || event.digest !== version.digest) return null;
			if (event.problems.length > 0) return { stage: { at: "invalid", version, problems: event.problems }, change: {}, effects: [] };
			if (covered(record, version)) return startMigration(record, version, serving);
			if (record.declined.includes(version.grantKey)) return { stage: { at: "declined", version }, change: {}, effects: [] };
			return ask(record, version);
		}
		case "awaiting-grant": {
			if (event.type === "granted" && event.cardId === stage.cardId) {
				const grant: Grant = { grantKey: version.grantKey, cardId: event.cardId, at: event.at };
				return startMigration(record, version, serving, { grants: [...record.grants, grant] });
			}
			if (event.type === "declined" && event.cardId === stage.cardId) {
				return { stage: { at: "declined", version }, change: { declined: [...record.declined, version.grantKey] }, effects: [] };
			}
			return null;
		}
		case "declined": {
			if (event.type !== "reconsider") return null;
			return ask(record, version, { declined: record.declined.filter((key) => key !== version.grantKey) });
		}
		case "migrating": {
			if (event.type === "migrated" && event.attempt === stage.attempt) {
				return { arrived: version, change: {}, effects: [{ do: "publish", serve: version }] };
			}
			if (event.type === "migration-failed" && event.attempt === stage.attempt) {
				return { stage: { at: "invalid", version, problems: [{ where: "data", reason: event.reason }] }, change: {}, effects: [] };
			}
			return null;
		}
		case "invalid":
			return null;
	}
}

/**
 * The whole state machine. An event that does not apply in the current state returns the
 * record unchanged with no effects, so a duplicate or late event is harmless.
 */
export function transition(record: ModuleRecord, event: ModuleEvent): Step {
	const unchanged: Step = { record, effects: [] };
	const state = record.state;
	const to = (next: ModuleState, effects: Effect[] = [], change: Partial<Counters> = {}): Step => ({
		record: { ...record, ...change, state: next, pending: [...record.pending, ...effects] },
		effects,
	});
	const check = (version: Version): Stage => ({ at: "checking", version });

	switch (state.at) {
		case "missing": {
			if (event.type === "package-found") {
				return state.wasOn
					? to({ at: "staging", stage: check(event.version) }, [{ do: "check", version: event.version }])
					: to({ at: "disabled", onDisk: event.version });
			}
			if (event.type === "enable" || event.type === "disable") {
				const on = event.type === "enable";
				return state.wasOn === on ? unchanged : to({ at: "missing", last: state.last, wasOn: on });
			}
			if (event.type === "purge") return to({ at: "missing", last: null, wasOn: false }, [{ do: "purge-data" }], { grants: [], declined: [] });
			return unchanged;
		}
		case "disabled": {
			if (event.type === "enable") return to({ at: "staging", stage: check(state.onDisk) }, [{ do: "check", version: state.onDisk }]);
			if (event.type === "package-found") return event.version.digest === state.onDisk.digest ? unchanged : to({ at: "disabled", onDisk: event.version });
			if (event.type === "package-gone") return to({ at: "missing", last: state.onDisk, wasOn: false });
			if (event.type === "purge") return to(state, [{ do: "purge-data" }]);
			return unchanged;
		}
		case "staging": {
			const version = state.stage.version;
			if (event.type === "package-found") {
				if (event.version.digest === version.digest) return unchanged;
				return to({ at: "staging", stage: check(event.version) }, [...withdrawals(state.stage), { do: "check", version: event.version }]);
			}
			if (event.type === "disable") return to({ at: "disabled", onDisk: version }, withdrawals(state.stage));
			if (event.type === "package-gone") return to({ at: "missing", last: version, wasOn: true }, withdrawals(state.stage));
			const moved = advance(record, state.stage, event, null);
			if (moved === null) return unchanged;
			if ("arrived" in moved) return to({ at: "active", serving: moved.arrived, update: null }, moved.effects, moved.change);
			return to({ at: "staging", stage: moved.stage }, moved.effects, moved.change);
		}
		case "active": {
			if (event.type === "package-found") {
				if (event.version.digest === (state.update?.version.digest ?? state.serving.digest)) return unchanged;
				const effects = withdrawals(state.update);
				if (event.version.digest === state.serving.digest) return to({ at: "active", serving: state.serving, update: null }, effects);
				return to({ at: "active", serving: state.serving, update: check(event.version) }, [...effects, { do: "check", version: event.version }]);
			}
			if (event.type === "disable" || event.type === "package-gone") {
				const gone = event.type === "package-gone";
				return to(
					gone ? { at: "missing", last: state.serving, wasOn: true } : { at: "disabled", onDisk: state.update?.version ?? state.serving },
					[
						...withdrawals(state.update),
						{ do: "publish", serve: null },
						{ do: "mark-tickets", mark: gone ? "module-missing" : "module-disabled" },
					],
				);
			}
			if (state.update === null) return unchanged;
			const moved = advance(record, state.update, event, state.serving);
			if (moved === null) return unchanged;
			if ("arrived" in moved) return to({ at: "active", serving: moved.arrived, update: null }, moved.effects, moved.change);
			return to({ at: "active", serving: state.serving, update: moved.stage }, moved.effects, moved.change);
		}
	}
}

/** The one line the modules page and `just module list` show. */
export function describe(record: ModuleRecord): { label: string; reason: string } {
	const stageLine = (stage: Stage): { label: string; reason: string } => {
		switch (stage.at) {
			case "checking":
				return { label: "检查中", reason: `正在检查 ${stage.version.label}` };
			case "invalid": {
				const first = stage.problems[0];
				return { label: "无效", reason: first === undefined ? "检查没有通过" : `${first.where}：${first.reason}` };
			}
			case "awaiting-grant":
				return { label: "等待确认", reason: `${stage.version.label} 用到的权限等你在卡片上确认` };
			case "declined":
				return { label: "已拒绝", reason: `你没有允许 ${stage.version.label} 用到的权限。想再看一次卡片，在模块页上点「重新考虑」` };
			case "migrating":
				return { label: "迁移中", reason: `正在给数据加上 ${stage.version.label} 新增的结构` };
		}
	};
	const state = record.state;
	switch (state.at) {
		case "missing":
			return { label: "包不在了", reason: state.last === null ? "没有见过这个模块包" : "模块包被拿掉了，数据还留着" };
		case "disabled":
			return { label: "已停用", reason: "你把它关了，数据还留着" };
		case "staging":
			return stageLine(state.stage);
		case "active": {
			if (state.update === null) return { label: "运行中", reason: state.serving.label };
			const next = stageLine(state.update);
			return { label: "运行中", reason: `${state.serving.label} 在运行；新版本${next.label}：${next.reason}` };
		}
	}
}
