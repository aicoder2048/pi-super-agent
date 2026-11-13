/**
 * What the host swaps on hot-plug. A `RegistrySnapshot` is immutable, like today's
 * `Modules`. The change is that nobody holds a snapshot: every holder keeps the
 * `LiveRegistry` and asks for `current()`. Publishing a new snapshot is one assignment, so
 * a reader sees the whole old table or the whole new one.
 */
import type { Component, Digest, ModuleName, PackageScan, Problem } from "./manifest.ts";

/** A read-only copy of one package version under `<stateDir>/module-store/<name>/<digest>/`. */
export interface PackageSnapshot {
	module: ModuleName;
	digest: Digest;
	/** Where Pi's `--skill` and each call's process point. Never the folder the author edits. */
	dir: string;
	scan: PackageScan;
}

export interface RegistrySnapshot {
	readonly serving: ReadonlyMap<ModuleName, PackageSnapshot>;
	/**
	 * The kernel's questions, answered from this snapshot. Today's `Kernel` stores the
	 * `DomainBook` map it is given, so its `domains` option becomes a function that the
	 * kernel calls each time, and the host passes `() => live.current().domainBook()`.
	 */
	domainBook(): ReadonlyMap<ModuleName, { team: string | null; onRoster: boolean }>;
	/** Same argument as today's `SourcePolicy`: the submitted trigger. A feed's `ignore` patterns answer `ignore`. */
	sourcePolicy(trigger: { source: string; body: string }): "candidate" | "ignore" | "notice";
	ruleAllows(ruleId: string, triggerSource: string): boolean;
	/**
	 * The block the host puts in front of every Router input: one roster line per module
	 * and the current text of every rule. The rule text is in the system prompt today, so
	 * it has to travel here once rules can change while the host runs.
	 */
	preamble(): string;
	/** Every feed of every serving module, for the scheduler and the page. */
	feeds(): readonly { source: string; module: ModuleName; component: Extract<Component, { kind: "feeds" }> }[];
}

/** `S` is the table the host serves. Until every module is a package, that is the legacy `Modules` (see `src/host/live-modules.ts`). */
export interface LiveRegistry<S> {
	current(): S;
	/** Atomic: one assignment. A holder of the old table keeps reading the whole old table. */
	publish(next: S): void;
}

/** Owns `<stateDir>/modules-data/<module>/`. The only host code that opens a module's instance data. */
export interface InstanceData {
	/** What `components` would break in the stored structure. Nothing stored: none. */
	check(module: ModuleName, components: readonly Component[]): readonly Problem[];
	/**
	 * Grows the stored structure to cover `components`, creating the directory and database on
	 * first use. Snapshots the database first and restores it on failure, so the data is either
	 * the old structure or the new one. Safe to run again after a crash.
	 */
	migrate(module: ModuleName, components: readonly Component[]): { ok: true } | { ok: false; reason: string };
	/** `<stateDir>/modules-data/<module>/`. The module's code gets this path and writes only under its `files/`. */
	dir(module: ModuleName): string;
	/** Irreversible. */
	purge(module: ModuleName): void;
}

/** Runs each serving module's feeds on a clock or on a push, and follows registry changes. */
export interface Scheduler {
	/** A removed or replaced module's entries stop before the new ones start. Cursors stay in instance data. */
	follow(registry: LiveRegistry<RegistrySnapshot>): void;
	health(source: string): { lastOk: string | null; problem: string | null };
}

