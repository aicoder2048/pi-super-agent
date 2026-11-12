import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { settle, transition, type Effect, type ModuleEvent, type ModuleRecord } from "./lifecycle.ts";
import type { Digest, ModuleName } from "./manifest.ts";
import type { LiveRegistry } from "./registry.ts";
import { allFiles, digestOf } from "./validate.ts";

export function liveRegistry<S>(initial: S): LiveRegistry<S> {
	let current = initial;
	return {
		current: () => current,
		publish: (next) => void (current = next),
	};
}

function isOn(record: ModuleRecord): boolean {
	const state = record.state;
	return state.at === "staging" || state.at === "active" || (state.at === "missing" && state.wasOn);
}

export function switchEvent(record: ModuleRecord, on: boolean): ModuleEvent | null {
	if (isOn(record) === on) return null;
	return { type: on ? "enable" : "disable" };
}

/**
 * Applies `event` (none: only finish the outbox) and runs the outbox to the end. `save` runs
 * before each effect and after the last, so a crash leaves the effect still pending. `run`
 * answers `"wait"` for an effect whose result comes later: the outbox stops there, and the
 * caller drives again once the result is in.
 */
export function drive(record: ModuleRecord, event: ModuleEvent | null, save: (record: ModuleRecord) => void, run: (effect: Effect) => ModuleEvent | null | "wait"): ModuleRecord {
	let next = event === null ? record : transition(record, event).record;
	save(next);
	for (let effect = next.pending[0]; effect !== undefined; effect = next.pending[0]) {
		const result = run(effect);
		if (result === "wait") return next;
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

	/** Copies the files `digest` covers. Undefined: the copy does not hash to `digest`, because the folder changed since it was checked. */
	keep(module: ModuleName, digest: Digest, from: string): string | undefined {
		const dir = this.dirOf(module, digest);
		if (existsSync(dir)) return dir;
		const partial = `${dir}.partial`;
		rmSync(partial, { recursive: true, force: true });
		for (const path of allFiles(from)) {
			mkdirSync(dirname(join(partial, path)), { recursive: true });
			copyFileSync(join(from, path), join(partial, path));
		}
		if (digestOf(partial) !== digest) {
			rmSync(partial, { recursive: true, force: true });
			return undefined;
		}
		renameSync(partial, dir);
		return dir;
	}

	collect(inUse: ReadonlySet<string>): void {
		if (!existsSync(this.#root)) return;
		for (const module of folders(this.#root)) {
			for (const digest of folders(join(this.#root, module))) {
				if (!inUse.has(`${module}/${digest}`)) rmSync(join(this.#root, module, digest), { recursive: true, force: true });
			}
		}
	}
}

const folders = (dir: string) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name] : []));
