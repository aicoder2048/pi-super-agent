/**
 * What the host swaps on hot-plug.
 *
 * A `RegistrySnapshot` is immutable, exactly like today's `Modules`. The change is that
 * nobody holds a snapshot: every holder keeps the `LiveRegistry` and asks for `current()`
 * when it needs an answer. Publishing a new snapshot is one assignment, so a reader sees
 * the whole old table or the whole new one.
 */
import type { ModuleEvent, ModuleRecord } from "./lifecycle.ts";
import type { Component, DataClass, Digest, ModuleName, PackageScan, Permissions } from "./manifest.ts";
import type { Caller, Provider } from "./protocol.ts";

/** A read-only copy of one package version under `<stateDir>/module-store/<name>/<digest>/`. */
export interface PackageSnapshot {
	module: ModuleName;
	digest: Digest;
	/** Where Pi's `--skill` and each call's process point. Never the folder the author edits. Holds the scanned files only. */
	dir: string;
	scan: PackageScan;
}

export interface ServingModule {
	snapshot: PackageSnapshot;
	/** The derived permissions of this version. The user's grant covers exactly these. */
	permissions: Permissions;
	/** From the collection's descriptor. Where the class may go is the user's `dataRoutes`, not the module's. */
	classOf(collection: string): DataClass;
	/** `feedClass` of the feed. Its items and its triggers have this class. */
	feedClassOf(feed: string): DataClass;
}

export interface RuleView {
	id: string;
	text: string;
	sources: readonly string[];
}

export interface RegistrySnapshot {
	/** Rises by one on every publish. Shown in logs and on Router cards. */
	readonly generation: number;
	readonly serving: ReadonlyMap<ModuleName, ServingModule>;

	/**
	 * The kernel's questions, answered from this snapshot. Today's `Kernel` stores the
	 * `DomainBook` map it is given, so its `domains` option becomes a function that the
	 * kernel calls each time, and the host passes `() => live.current().domainBook()`.
	 */
	domainBook(): ReadonlyMap<ModuleName, { team: string | null; onRoster: boolean }>;
	/** Same argument as today's `SourcePolicy`: the submitted trigger. A feed's `ignore` patterns answer `ignore`. */
	sourcePolicy(trigger: { source: string; body: string }): "candidate" | "ignore" | "notice";
	ruleAllows(ruleId: string, triggerSource: string): boolean;
	rulesFor(source: string): readonly RuleView[];

	/**
	 * The block the host puts in front of every Router input: one roster line per module
	 * and the current text of every rule. Trigger cards carry rule ids only, and the rule
	 * text is in the system prompt today, so the text has to travel here once rules can change.
	 */
	preamble(): string;
	/** Every feed of every serving module, for the scheduler and the page. */
	feeds(): readonly { source: string; module: ModuleName; class: DataClass; component: Extract<Component, { kind: "feeds" }> }[];
}

export interface RegistryChange {
	from: RegistrySnapshot;
	to: RegistrySnapshot;
	added: readonly ModuleName[];
	removed: readonly ModuleName[];
	replaced: readonly ModuleName[];
}

export interface LiveRegistry {
	current(): RegistrySnapshot;
	/** Atomic. Listeners run after the swap, in registration order, and may not throw. */
	publish(next: RegistrySnapshot): void;
	onChange(listener: (change: RegistryChange) => void): () => void;
}

export function createLiveRegistry(): LiveRegistry {
	throw new Error("not implemented");
}

/** Builds the next snapshot from the current one. Pure. */
export function withModule(current: RegistrySnapshot, module: ModuleName, serving: ServingModule | null): RegistrySnapshot {
	throw new Error("not implemented");
}

/** Owns `<stateDir>/module-store/`. The only writer there. */
export interface ModuleStore {
	/** Copies the files the scan accepted into the store under the digest. A second call for the same digest does nothing. */
	keep(scan: PackageScan): PackageSnapshot;
	/** For a ticket's pin. Throws only if the store was damaged; a pinned snapshot is never collected. */
	open(pin: { module: ModuleName; digest: Digest }): PackageSnapshot;
	/** Deletes snapshots that are not serving, not pinned by an open ticket, and not the one instance data was last structured to. */
	collect(inUse: ReadonlySet<Digest>): void;
}

/** Owns `<stateDir>/modules-data/<module>/`. The only code that opens a module's instance data. */
export interface InstanceData {
	/** Creates the directory and database on first use. Never touches the package. */
	open(module: ModuleName): InstanceHandle;
	sizeBytes(module: ModuleName): number;
	/** Irreversible. Called only for the `purge-data` effect. */
	purge(module: ModuleName): void;
}

export interface InstanceHandle {
	/**
	 * The version whose collections and fields the data has now, null before the first
	 * enable. The `checking` stage compares a new version against this one
	 * (`structureProblems`), and the store keeps its snapshot for that.
	 */
	structuredTo(): Digest | null;
	/** Copy-on-write snapshot taken before a migration. `restore` puts it back. */
	snapshot(): { restore(): void; discard(): void };
	/** Rows a Worker wrote that the user has not confirmed yet. Shown on the modules page. */
	unconfirmed(): number;
	accessLog(since: string): readonly { at: string; caller: Caller["who"]; ticket: string | null; request: string; rows: number }[];
}

/** Starts and stops what runs on a clock or on a push, per module, from registry changes. */
export interface Scheduler {
	/** Subscribes to the registry. A removed or replaced module's entries stop before the new ones start. */
	follow(registry: LiveRegistry): void;
	health(source: string): { lastOk: string | null; problem: string | null };
}

/** Finds the provider for a component of a pinned version. Starts nothing: module code runs one process per call. */
export interface Providers {
	for(pin: { module: ModuleName; digest: Digest }, component: Component): Provider;
}

/**
 * The highest class each model session has read: one entry per Worker session and one
 * for the Router session. The gateway raises it on every reply, and the host asks
 * `mayContinueOn` with it before it switches a session to another provider.
 */
export interface SessionClasses {
	highest(session: string): DataClass | null;
	raise(session: string, to: DataClass): void;
}

/**
 * The lifecycle driver, one per host. It owns every module's record. For one module it
 * handles one thing at a time: an event, or the first entry of the record's `pending`.
 * The loop is in the header of lifecycle.ts.
 */
export interface ModuleLifecycle {
	/** Applies `transition`, persists the record, then works through `pending`. */
	submit(module: ModuleName, event: ModuleEvent): Promise<void>;
	/** After a restart: continues every record's `pending` from where it stopped. */
	resumeAll(): Promise<void>;
	records(): readonly ModuleRecord[];
}
