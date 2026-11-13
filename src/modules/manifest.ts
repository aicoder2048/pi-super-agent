/**
 * What a module package is, as the host sees it.
 *
 * `module.json` holds identity and version, nothing else. The component list is never
 * declared. It is derived by scanning the package: a folder under a kind directory is a
 * component, and its descriptor file says what it is and what it needs.
 */

export type ModuleName = string & { readonly __brand: "ModuleName" };
export type ComponentName = string & { readonly __brand: "ComponentName" };
/** sha256 hex over every file of a package. Only `scanPackage` makes one. A ticket pins it. */
export type Digest = string & { readonly __brand: "Digest" };

/** The one thing a module says about its data. It decides what Telegram shows (protocol.ts), nothing else. */
export const DATA_CLASSES = ["shareable", "private"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** The host's connectors. The host owns this list, and a feed names one of them. */
export const CONNECTORS = ["inbox", "timer", "rss", "http-poll", "literature-search", "webhook", "mail", "google-drive"] as const;
export type ConnectorId = (typeof CONNECTORS)[number];

/** The Pi tools a team member may list in `tools`. It is today's `MEMBER_TOOLS` in `src/worker/tools.ts`. */
export const MEMBER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_get", "lookup"] as const;
export type MemberTool = (typeof MEMBER_TOOLS)[number];

/** The kind directories, in the order the page lists them. The folder name is the kind. */
export const KIND_DIRS = ["knowledge", "data", "tools", "skills", "feeds", "agents", "evals"] as const;
export type KindDir = (typeof KIND_DIRS)[number];

/**
 * How module code is started, and the entry file of each way. `node` uses Node's own type
 * stripping. The next entry is `python: "index.py"`, started through `uv run`.
 */
export const RUNTIMES = { node: "index.ts" } as const;
export type Runtime = keyof typeof RUNTIMES;

export interface ModuleManifest {
	schema: 1;
	/** Equals the folder name. Also the domain name on tickets (ADR-0009). */
	name: ModuleName;
	/** semver, for the user to read. The digest identifies a version to the host. */
	version: string;
	title?: string;
	/** The Router roster line. */
	description?: string;
	/** Team name. Required exactly when `agents/` has members. */
	team?: string;
}

/** `knowledge/<name>/source.json`, with `*.md` beside it when `license` is `bundled`. */
export interface KnowledgeSource {
	title: string;
	version: string;
	published: string;
	authority: "authoritative" | "reference";
	/** `user-import`: the text is copyrighted, so the user imports it into instance data and the package holds the source only. */
	license: "bundled" | "user-import";
	origin: string;
}

export interface FieldDescriptor {
	type: "text" | "number" | "date" | "blob";
	title: string;
	unit?: string;
	/** The name this field had before a rename. The host carries the stored values over. */
	was?: string;
}

/** `data/<name>/collection.json`. Rows live only in instance data. `seed.json` beside it holds default rows. */
export interface CollectionDescriptor {
	title: string;
	kind: "record" | "series";
	class: DataClass;
	fields: Readonly<Record<string, FieldDescriptor>>;
	/** Makes a series watchable by the host's condition mechanism. Names fields of this collection; `zone` (IANA name) makes alerts show full instants in that zone, otherwise `at` as stored. */
	watch?: { key: string; value: string; at: string; zone?: string };
	/** The name this collection had before a rename. */
	was?: string;
}

/** What a tool reaches outside its own folder. A tool that states none computes from its input and its own files. */
export const TOOL_EFFECTS = ["read", "write"] as const;
export type ToolEffect = "pure" | (typeof TOOL_EFFECTS)[number];

/**
 * `tools/<name>/tool.json`. The folder may hold any other files: more code, data tables,
 * dependencies. The entry is the runtime's entry file, and its default export is the tool.
 */
export interface ToolDescriptor {
	title: string;
	description: string;
	input: Readonly<Record<string, FieldDescriptor>>;
	output: Readonly<Record<string, FieldDescriptor>>;
	/** Where the formula comes from. */
	cites?: string;
	/** `read` looks something up outside. `write` changes something outside, so an inference ticket may not call it. Left out: `pure`, and `cases.json` is required. */
	effect?: (typeof TOOL_EFFECTS)[number];
	/** Names of secrets in the host's secrets file. The host sets each as an environment variable of the tool's process. */
	secrets?: readonly string[];
	runtime?: Runtime;
}

/** One entry of `cases.json`. `tolerance` is absolute, for numbers, default 1e-9. */
export type ToolCase = { name: string; input: Readonly<Record<string, unknown>>; expect: Readonly<Record<string, unknown>>; tolerance?: number };

/**
 * `feeds/<name>/feed.json`. The source name on triggers is `<module>/<name>`.
 * A feed is a connector, a handler, or a connector whose items a handler parses.
 */
export interface FeedDescriptor {
	title: string;
	description?: string;
	/** A host connector: the shared path that needs no code. */
	connector?: ConnectorId;
	/** A code file in this folder. It may use the network directly, so a module reaches a service the host has no connector for. */
	handler?: string;
	/** As for a tool. */
	secrets?: readonly string[];
	/** Poll interval such as `15m` or `1d`. Push connectors need none. */
	every?: string;
	/** How long one call of the handler may run, such as `5m`. At most `10m`. Without it the host's 20 seconds. */
	limit?: string;
	/** Called only while this is true. `us-market-hours`: a trading day from the open to 20 minutes after the close. */
	when?: FeedWhen;
	/** Defaults that are the same for every user. */
	settings?: Readonly<Record<string, unknown>>;
	/** What the user fills in on the modules page. The answers are instance data. */
	ask?: Readonly<Record<string, { title: string; type: string }>>;
	/** The collection of this module that receives the feed's records. */
	into?: string;
	/** Collections of this module whose rows the handler is given, e.g. a watchlist. */
	reads?: readonly string[];
	/** The trigger body for the Router. `{{field}}` is filled from each notice. */
	notice?: string;
	/**
	 * Only on a feed into a private collection: up to three lines over the placeholders of `notice`. Each new
	 * notice is then posted to the user's front ends as written here, and the Router's trigger carries only this text and is not private.
	 */
	line?: string;
	/** Regular expressions. A trigger whose body matches one is dropped before the Router sees it. */
	ignore?: readonly string[];
}

export const FEED_WHEN = ["us-market-hours"] as const;
export type FeedWhen = (typeof FEED_WHEN)[number];

/** `feeds/<name>/fixtures/<case>.json`. `input` replaces the handler's input (settings merge over feed.json's); `responses` answers `fetch` by exact URL. */
export type FeedFixture = { name: string; input: { readonly [key: string]: unknown }; responses: { readonly [url: string]: unknown } };

/** Front matter of `agents/<name>.md`. The body is the member's prompt. */
export interface AgentDescriptor {
	name: string;
	title: string;
	description: string;
	/** Pi tools. Required, and each one is in `MEMBER_TOOLS`. */
	tools: readonly MemberTool[];
	/** Capabilities of this module the member may call. Default: none. */
	uses: readonly CapabilityUse[];
	model?: string;
}

/** `knowledge`, `data/<collection>`, `tools/<tool>` or `watch/<collection>`. */
export type CapabilityUse = string & { readonly __brand: "CapabilityUse" };

/** Front matter of `evals/<name>.md`: the capabilities the answer must have called and the phrases it must contain. The body is the question a dry run asks. */
export type EvalDescriptor = { name: string; uses: readonly CapabilityUse[]; expect: readonly string[] };

export type Component =
	| { kind: "knowledge"; name: ComponentName; source: KnowledgeSource; texts: readonly string[] }
	| { kind: "data"; name: ComponentName; collection: CollectionDescriptor; seeded: boolean }
	| { kind: "tools"; name: ComponentName; tool: ToolDescriptor; cases: readonly ToolCase[] }
	| { kind: "skills"; name: ComponentName; description: string }
	| { kind: "feeds"; name: ComponentName; feed: FeedDescriptor; fixtures: readonly FeedFixture[] }
	| { kind: "agents"; name: ComponentName; agent: AgentDescriptor }
	| { kind: "evals"; name: ComponentName; eval: EvalDescriptor };

/** One `##` section of `rules.md`. `id` is `<module>/<heading>`. */
export type RuleRef = { id: string; sources: readonly string[] };

/** Everything the host knows about a package, derived in one pass. */
export interface PackageScan {
	dir: string;
	manifest: ModuleManifest;
	components: readonly Component[];
	rules: readonly RuleRef[];
	digest: Digest;
	/** What an update does to stored data that the author should know about. Shown by `check` and on the modules page. */
	notes: readonly string[];
}

/** `where` is a path inside the package, e.g. `tools/insulin-sensitivity/cases.json`. */
export type Problem = { where: string; reason: string };

export type ScanResult = { ok: true; scan: PackageScan } | { ok: false; name: string; problems: readonly Problem[] };

export function toolEffect(tool: Pick<ToolDescriptor, "effect">): ToolEffect {
	return tool.effect ?? "pure";
}

/** The class of what a feed brings in: the class of the collection it fills. A feed that stores nothing is `shareable`. */
export function feedClass(feed: Pick<FeedDescriptor, "into">, collections: ReadonlyMap<string, Pick<CollectionDescriptor, "class">>): DataClass {
	return (feed.into === undefined ? undefined : collections.get(feed.into)?.class) ?? "shareable";
}

/** SQLite matches table and column names regardless of case. */
function clash(stored: ReadonlySet<string>, name: string, was: string | undefined): string | undefined {
	const from = was !== undefined && stored.has(was) ? was : undefined;
	if (stored.has(name)) {
		return from === undefined || from === name ? undefined : `"${name}" has "was": "${from}", but "${name}" already holds stored values of its own from an earlier version; pick a new name`;
	}
	const twin = [...stored].find((other) => other !== from && other.toLowerCase() === name.toLowerCase());
	return twin === undefined ? undefined : `"${name}" differs from the stored "${twin}" only in case, and the database treats them as one name; pick another name`;
}

/**
 * What a new version does to data that is already stored.
 *
 * Stored structure only grows. A new collection or field is added. One the package no
 * longer has is hidden, and its values stay. `was` renames one and keeps the old name as an
 * alias for tickets pinned to the old version. All of that is a note. The problems are
 * changes that make stored values mean something else (another type, unit or kind) and
 * names that would land on stored values of another name (a rename onto a hidden name, a
 * name that differs from a stored one only in case).
 * `previous` stands for the stored structure, which the host keeps in the module's `data.db`.
 */
export function structureChanges(previous: readonly Component[], next: readonly Component[]): { problems: Problem[]; notes: string[] } {
	const problems: Problem[] = [];
	const notes: string[] = [];
	const kept = "its stored values are kept and hidden";
	const now = new Map<string, CollectionDescriptor>();
	for (const item of next) if (item.kind === "data") now.set(item.name, item.collection);
	const stored = new Map<string, CollectionDescriptor>();
	for (const item of previous) if (item.kind === "data") stored.set(item.name, item.collection);
	const storedNames = new Set(stored.keys());
	for (const [name, collection] of now) {
		const where = `data/${name}/collection.json`;
		const clashed = clash(storedNames, name, collection.was);
		if (clashed !== undefined) problems.push({ where, reason: clashed });
		const before = stored.get(name) ?? (collection.was === undefined ? undefined : stored.get(collection.was));
		if (before === undefined) continue;
		const storedFields = new Set(Object.keys(before.fields));
		for (const [field, descriptor] of Object.entries(collection.fields)) {
			const fieldClash = clash(storedFields, field, descriptor.was);
			if (fieldClash !== undefined) problems.push({ where, reason: `field ${fieldClash}` });
		}
	}
	for (const item of previous) {
		if (item.kind !== "data") continue;
		const renamedTo = [...now].find(([, collection]) => collection.was === item.name)?.[0];
		const name = now.has(item.name) ? item.name : renamedTo;
		const collection = name === undefined ? undefined : now.get(name);
		if (name === undefined || collection === undefined) {
			notes.push(`data/${item.name}: this collection is no longer in the package; ${kept}. If you renamed it, add "was": "${item.name}" to the new collection.json`);
			continue;
		}
		const where = `data/${name}/collection.json`;
		if (name !== item.name) notes.push(`${where}: renamed from "${item.name}"; the stored rows move with it`);
		if (collection.kind !== item.collection.kind) {
			problems.push({ where, reason: `"kind" changed from ${item.collection.kind} to ${collection.kind}; the stored rows have the old kind` });
		}
		if (item.collection.watch !== undefined && collection.watch === undefined) {
			notes.push(`${where}: "watch" is gone, so the conditions you set on this collection stop being checked`);
		}
		for (const [field, before] of Object.entries(item.collection.fields)) {
			const fieldNow = Object.hasOwn(collection.fields, field) ? field : Object.keys(collection.fields).find((key) => collection.fields[key]?.was === field);
			const after = fieldNow === undefined ? undefined : collection.fields[fieldNow];
			if (fieldNow === undefined || after === undefined) {
				notes.push(`${where}: field "${field}" is no longer in the package; ${kept}. If you renamed it, add "was": "${field}" to the new field`);
				continue;
			}
			if (fieldNow !== field) notes.push(`${where}: field "${fieldNow}" renamed from "${field}"; the stored values move with it`);
			if (after.type !== before.type) {
				problems.push({ where, reason: `field "${fieldNow}" changed type from ${before.type} to ${after.type}; add a new field instead, the stored values have the old type` });
			} else if (after.unit !== before.unit) {
				problems.push({
					where,
					reason: `field "${fieldNow}" changed unit from ${before.unit ?? "none"} to ${after.unit ?? "none"}; the stored numbers would silently mean something else, so add a new field instead`,
				});
			}
		}
	}
	return { problems, notes };
}
