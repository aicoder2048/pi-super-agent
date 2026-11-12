/**
 * The live module table, the driver step that moves one module record, and the module store.
 * The host wiring (state.db, the switches, building a table) is in `src/host/live-modules.ts`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { settle, transition, type Effect, type ModuleEvent, type ModuleRecord } from "./lifecycle.ts";
import type { Digest, ModuleName } from "./manifest.ts";
import type { LiveRegistry } from "./registry.ts";

export function liveRegistry<S>(initial: S): LiveRegistry<S> {
	let current = initial;
	return {
		current: () => current,
		publish: (next) => void (current = next),
	};
}

/** Whether the user's switch is on, as the record holds it. */
function isOn(record: ModuleRecord): boolean {
	const state = record.state;
	return state.at === "staging" || state.at === "active" || (state.at === "missing" && state.wasOn);
}

/** The event that brings the record to the user's switch, or null when it is there already. */
export function switchEvent(record: ModuleRecord, on: boolean): ModuleEvent | null {
	if (isOn(record) === on) return null;
	return { type: on ? "enable" : "disable" };
}

/**
 * Applies `event` (none: only finish the outbox) and runs the outbox to the end. `save` runs
 * before each effect and after the last, so a crash leaves the effect still pending.
 */
export function drive(record: ModuleRecord, event: ModuleEvent | null, save: (record: ModuleRecord) => void, run: (effect: Effect) => ModuleEvent | null): ModuleRecord {
	let next = event === null ? record : transition(record, event).record;
	save(next);
	for (let effect = next.pending[0]; effect !== undefined; effect = next.pending[0]) {
		const result = run(effect);
		next = settle(next);
		if (result !== null) next = transition(next, result).record;
		save(next);
	}
	return next;
}

/** `<stateDir>/module-store/<name>/<digest>/`: one read-only copy per package version. The only writer there. */
export class ModuleStore {
	readonly #root: string;

	constructor(root: string) {
		this.#root = root;
	}

	dirOf(module: ModuleName, digest: Digest): string {
		return join(this.#root, module, digest);
	}

	/** A second call for the same digest does nothing. */
	keep(module: ModuleName, digest: Digest, from: string): string {
		const dir = this.dirOf(module, digest);
		if (existsSync(dir)) return dir;
		const partial = `${dir}.partial`;
		rmSync(partial, { recursive: true, force: true });
		mkdirSync(join(this.#root, module), { recursive: true });
		cpSync(from, partial, { recursive: true });
		renameSync(partial, dir);
		return dir;
	}

	/** Deletes every copy whose `<name>/<digest>` is not in `inUse`. */
	collect(inUse: ReadonlySet<string>): void {
		if (!existsSync(this.#root)) return;
		for (const module of readdirSync(this.#root)) {
			for (const digest of readdirSync(join(this.#root, module))) {
				if (!inUse.has(`${module}/${digest}`)) rmSync(join(this.#root, module, digest), { recursive: true, force: true });
			}
		}
	}
}
