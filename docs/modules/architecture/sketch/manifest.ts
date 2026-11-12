/**
 * What a module package is, as the host sees it.
 *
 * `module.json` holds identity and version, nothing else. The component list is never
 * declared. It is derived by scanning the package: a folder under a kind directory is a
 * component, and its descriptor file says what it is and what it uses. The permission set
 * the user confirms is derived from those descriptors by `derivePermissions`. Nobody
 * writes it by hand.
 */

export type ModuleName = string & { readonly __brand: "ModuleName" };
export type ComponentName = string & { readonly __brand: "ComponentName" };
/** sha256 hex. Only `scanPackage` makes one. */
export type Digest = string & { readonly __brand: "Digest" };

/**
 * Ordered from least to most restricted. A module states the class of its data and
 * nothing more. Where a class may go is the user's `dataRoutes` (see protocol.ts).
 */
export const DATA_CLASSES = ["shareable", "private", "local-only"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** Host powers. A module gets one only because a component descriptor uses it. */
export const HOST_POWERS = ["trigger", "alert", "authoring"] as const;
export type HostPower = (typeof HOST_POWERS)[number];

/**
 * The host powers that serve a tool, each with the effect of a call. The host fixes the
 * effect. A module cannot state it, so a package cannot label a writing tool `read`.
 */
export const SERVED_EFFECTS = { authoring: "write" } as const satisfies Partial<Record<HostPower, DeclaredEffect>>;
export type ServedBy = keyof typeof SERVED_EFFECTS;

/** The host's connectors. The host owns this list, and a feed names one of them. */
export const CONNECTORS = ["inbox", "timer", "rss", "http-poll", "literature-search", "webhook", "mail", "google-drive"] as const;
export type ConnectorId = (typeof CONNECTORS)[number];

/**
 * The Pi tools a team member may list in `tools`. The host owns this list. It is today's
 * `MEMBER_TOOLS` in `src/worker/tools.ts`.
 */
export const MEMBER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_get", "lookup"] as const;
export type MemberTool = (typeof MEMBER_TOOLS)[number];
/** The member tools that can change files or run programs. A member that lists one makes the package ask for a card. */
export const CHANGING_TOOLS: readonly MemberTool[] = ["bash", "write", "edit"];

/** The kind directories, in the order the page lists them. The folder name is the kind. */
export const KIND_DIRS = ["knowledge", "data", "tools", "skills", "feeds", "agents", "evals"] as const;
export type KindDir = (typeof KIND_DIRS)[number];

/** Files allowed beside the kind directories. Anything else at the top level is rejected. */
export const TOP_FILES = ["module.json", "README.md", "NOTICE.md", "rules.md"] as const;

// ---------------------------------------------------------------------------
// module.json: identity and version
// ---------------------------------------------------------------------------

export interface ModuleManifest {
	schema: 1;
	/** Equals the folder name. Also the domain name on tickets (ADR-0009). */
	name: ModuleName;
	/** semver. Shown to the user. The digest, not this string, identifies a version to the host. */
	version: string;
	title?: string;
	/** The Router roster line. Without it the module owns tickets only through its own rules. */
	description?: string;
	/** Team name. Required exactly when `agents/` has members. */
	team?: string;
}

/** One network host a tool or a feed handler reaches through the host's fetch proxy. */
export interface NetworkUse {
	/** One exact host name, lower case, with no trailing dot. The scan normalizes it before any comparison. */
	host: string;
	/** The module's budget for this host. Every component that names the host states the same number. */
	perMinute: number;
	/**
	 * Name of a secret the host attaches to requests for this host. Module code never
	 * receives the value, so a secret cannot be sent anywhere else.
	 */
	secret?: string;
}

/**
 * What the grant card shows and the host enforces. Always the output of
 * `derivePermissions`, so it is exactly what the components use.
 */
export interface Permissions {
	connectors: readonly ConnectorId[];
	/** One entry per host. */
	network: readonly NetworkUse[];
	host: readonly HostPower[];
	/** The class of every collection the module keeps. */
	data: readonly { collection: ComponentName; class: DataClass }[];
	/** The class of every feed, from `feedClass`. */
	feeds: readonly { feed: ComponentName; class: DataClass }[];
	/** Every member that lists a tool of `CHANGING_TOOLS`, with those tools. */
	members: readonly { member: ComponentName; tools: readonly MemberTool[] }[];
}

// ---------------------------------------------------------------------------
// Descriptors: one per component, inside the component's own folder
// ---------------------------------------------------------------------------

/** `knowledge/<name>/source.json`, with `*.md` beside it when `license` is `bundled`. */
export interface KnowledgeSource {
	title: string;
	version: string;
	published: string;
	authority: "authoritative" | "reference";
	/** `user-import`: the text is copyrighted, lives in instance data, and must not be in the package. */
	license: "bundled" | "user-import";
	/** Where it came from, or how the user obtains it. */
	origin: string;
}

/** `data/<name>/collection.json`. Rows live only in instance data. */
export interface CollectionDescriptor {
	title: string;
	kind: "record" | "series";
	/** The only thing a module says about where its data may go. The user's `dataRoutes` decides the rest. */
	class: DataClass;
	/** A later version may add a field. It may never remove one, rename one, or change its type or unit. */
	fields: Readonly<Record<string, FieldDescriptor>>;
	/** Makes a series watchable by the host's condition mechanism. Names fields of this collection. */
	watch?: { key: string; value: string; at: string };
}

export interface FieldDescriptor {
	type: "text" | "number" | "date" | "blob";
	title: string;
	unit?: string;
}

/** What a tool with a declared effect may do. A tool that declares none is `pure`. */
export const DECLARED_EFFECTS = ["read", "write"] as const;
export type DeclaredEffect = (typeof DECLARED_EFFECTS)[number];

/**
 * `tools/<name>/tool.json`. Module code serves the tool from `index.ts` (default export),
 * with `cases.json` beside it. A tool with `servedBy` has neither file: the host serves it.
 */
export interface ToolDescriptor {
	title: string;
	description: string;
	input: Readonly<Record<string, FieldDescriptor>>;
	output: Readonly<Record<string, FieldDescriptor>>;
	/** Where the formula comes from. */
	cites?: string;
	/** Hosts the tool fetches through the host. A tool without this reaches nothing at all. */
	network?: readonly NetworkUse[];
	/**
	 * Required exactly when the tool has `network`. `read` promises that a call changes
	 * nothing outside, and the fetch proxy holds the tool to GET. A tool without `network`
	 * does not state an effect: it is `pure`, or the host fixes it (`servedBy`).
	 */
	effect?: DeclaredEffect;
	/** The host power that serves this tool. The module builder's draft tool is the only one today. */
	servedBy?: ServedBy;
}

export interface ToolCase {
	name: string;
	input: Readonly<Record<string, unknown>>;
	expect: Readonly<Record<string, unknown>>;
	/** Absolute tolerance for numbers. Default 1e-9. */
	tolerance?: number;
	/** Canned responses for a tool with `network`. The check never touches the real network. */
	replay?: readonly { url: string; status: number; body: string }[];
}

/**
 * `feeds/<name>/feed.json`. The source name on triggers is `<module>/<name>`.
 * A feed is a connector, a handler, or a connector whose items a handler parses.
 */
export interface FeedDescriptor {
	title: string;
	description?: string;
	/** A host connector. */
	connector?: ConnectorId;
	/** The one code file in this folder. Each call runs it in a fresh sandboxed process. */
	handler?: string;
	/** Hosts the handler fetches through the host. Allowed only when the feed's class is `shareable`. */
	network?: readonly NetworkUse[];
	/** Poll interval such as `15m` or `1d`. Push connectors need none. */
	every?: string;
	/** Shareable defaults. */
	settings?: Readonly<Record<string, unknown>>;
	/** What the user must fill in at enable time. The answers are instance data. */
	ask?: Readonly<Record<string, { title: string; type: string }>>;
	/** A collection of this module that receives the feed's records. It also sets the feed's class. */
	into?: string;
	/** The trigger body for the Router. Uses the `trigger` host power. May hold `{{field}}` only when the feed's class is `shareable`. */
	notice?: string;
	/** Regular expressions. A trigger whose body matches one is dropped before the Router sees it. */
	ignore?: readonly string[];
}

/** Front matter of `agents/<name>.md`. The body is the member's prompt. The front matter is what gives the member its reach. */
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

/** Front matter of `skills/<name>/SKILL.md`. */
export interface SkillDescriptor {
	name: string;
	description: string;
}

/** Front matter of `evals/<name>.md`. The body is the question a dry run asks. */
export interface EvalDescriptor {
	name: string;
	/** Capabilities the answer must have called. */
	uses: readonly CapabilityUse[];
	/** Phrases the answer must contain. */
	expect: readonly string[];
}

// ---------------------------------------------------------------------------
// The scan: everything the host knows about a package, derived in one pass
// ---------------------------------------------------------------------------

export type Component =
	| { kind: "knowledge"; name: ComponentName; source: KnowledgeSource; texts: readonly string[] }
	| { kind: "data"; name: ComponentName; collection: CollectionDescriptor; seeded: boolean }
	| { kind: "tools"; name: ComponentName; tool: ToolDescriptor; cases: readonly ToolCase[] }
	| { kind: "skills"; name: ComponentName; skill: SkillDescriptor }
	| { kind: "feeds"; name: ComponentName; feed: FeedDescriptor }
	| { kind: "agents"; name: ComponentName; agent: AgentDescriptor }
	| { kind: "evals"; name: ComponentName; eval: EvalDescriptor };

export interface RuleRef {
	/** `<module>/<heading>` */
	id: string;
	sources: readonly string[];
}

export interface PackageScan {
	dir: string;
	manifest: ModuleManifest;
	components: readonly Component[];
	rules: readonly RuleRef[];
	/** Derived from the components. */
	permissions: Permissions;
	/** Every code file in the package: the tool entries and the feed handlers. The scan rejects any other. */
	code: readonly string[];
	/** Every file. Identifies the version a ticket pins. */
	digest: Digest;
	/**
	 * What the user's click covers, one hash per entry. Every file of the package is here
	 * except Markdown bodies and test material (see `grantParts` in validate.ts). The host
	 * stores this with the grant, so the next card can name what changed (`grantChanges`).
	 */
	granted: Readonly<Record<string, Digest>>;
	/** The hash of `granted`. A new card is needed exactly when this changes. */
	grantKey: Digest;
	/** False only for a package that `needsCard` clears. The switch alone enables that one. */
	asks: boolean;
}

export type ScanResult = { ok: true; scan: PackageScan } | { ok: false; name: string; problems: readonly Problem[] };

export interface Problem {
	/** Path inside the package, e.g. `tools/insulin-sensitivity/cases.json`. */
	where: string;
	reason: string;
}

// ---------------------------------------------------------------------------
// Derived from the components. Pure.
// ---------------------------------------------------------------------------

/** What a call of this tool may change. `pure` for a tool with no network that the module serves. */
export function toolEffect(tool: Pick<ToolDescriptor, "effect" | "servedBy">): "pure" | DeclaredEffect {
	if (tool.servedBy !== undefined) return SERVED_EFFECTS[tool.servedBy];
	return tool.effect ?? "pure";
}

/**
 * The class of a feed: the class of the collection it fills. A feed with no `into` keeps
 * nothing, so nothing says its content may leave the machine, and it is `local-only`.
 * Everything a feed touches has this class: the connector's items, the handler's input
 * and the triggers it sends.
 */
export function feedClass(feed: Pick<FeedDescriptor, "into">, collections: ReadonlyMap<string, Pick<CollectionDescriptor, "class">>): DataClass {
	if (feed.into === undefined) return "local-only";
	return collections.get(feed.into)?.class ?? "local-only";
}

function collectionsOf(components: readonly Component[]): Map<string, CollectionDescriptor> {
	const collections = new Map<string, CollectionDescriptor>();
	for (const item of components) if (item.kind === "data") collections.set(item.name, item.collection);
	return collections;
}

/**
 * The permission set of a package. A feed's `connector` asks for that connector, its
 * `notice` for `trigger`. A watchable collection asks for `alert`. `network` on a tool or
 * a feed asks for those hosts. A tool's `servedBy` asks for that host power. A member that
 * lists a changing tool is named. The scan has already rejected two components that give
 * one host different budgets or secrets.
 */
export function derivePermissions(components: readonly Component[]): Permissions {
	const connectors = new Set<ConnectorId>();
	const powers = new Set<HostPower>();
	const hosts = new Map<string, NetworkUse>();
	const collections = collectionsOf(components);
	const data: Permissions["data"][number][] = [];
	const feeds: Permissions["feeds"][number][] = [];
	const members: Permissions["members"][number][] = [];
	const reach = (uses: readonly NetworkUse[] | undefined): void => {
		for (const use of uses ?? []) if (!hosts.has(use.host)) hosts.set(use.host, use);
	};
	for (const item of components) {
		if (item.kind === "feeds") {
			if (item.feed.connector !== undefined) connectors.add(item.feed.connector);
			if (item.feed.notice !== undefined) powers.add("trigger");
			reach(item.feed.network);
			feeds.push({ feed: item.name, class: feedClass(item.feed, collections) });
		}
		if (item.kind === "tools") {
			reach(item.tool.network);
			if (item.tool.servedBy !== undefined) powers.add(item.tool.servedBy);
		}
		if (item.kind === "data") {
			data.push({ collection: item.name, class: item.collection.class });
			if (item.collection.watch !== undefined) powers.add("alert");
		}
		if (item.kind === "agents") {
			const changing = CHANGING_TOOLS.filter((tool) => item.agent.tools.includes(tool));
			if (changing.length > 0) members.push({ member: item.name, tools: changing });
		}
	}
	return {
		connectors: CONNECTORS.filter((id) => connectors.has(id)),
		network: [...hosts.values()].sort((left, right) => (left.host < right.host ? -1 : 1)),
		host: HOST_POWERS.filter((power) => powers.has(power)),
		data: data.sort((left, right) => (left.collection < right.collection ? -1 : 1)),
		feeds: feeds.sort((left, right) => (left.feed < right.feed ? -1 : 1)),
		members: members.sort((left, right) => (left.member < right.member ? -1 : 1)),
	};
}

/**
 * Whether enabling the package needs the user's click on a card. The only package that
 * does not is one that cannot do more than today's defaults: no `rules.md`, no code, no
 * descriptor except `module.json` and knowledge `source.json`, and no member that lists
 * a changing tool or any `uses`. Such a package is skills, knowledge and read-only members.
 */
export function needsCard(scan: { rules: boolean; code: readonly string[]; components: readonly Component[] }): boolean {
	if (scan.rules || scan.code.length > 0) return true;
	return scan.components.some((item) => {
		if (item.kind === "data" || item.kind === "tools" || item.kind === "feeds") return true;
		return item.kind === "agents" && (item.agent.uses.length > 0 || CHANGING_TOOLS.some((tool) => item.agent.tools.includes(tool)));
	});
}

/** What changed between the hashes of the last grant and the hashes of a new version. The card lists these paths. */
export function grantChanges(
	before: Readonly<Record<string, Digest>>,
	after: Readonly<Record<string, Digest>>,
): { added: string[]; changed: string[]; removed: string[] } {
	const added = Object.keys(after).filter((path) => !Object.hasOwn(before, path)).sort();
	const removed = Object.keys(before).filter((path) => !Object.hasOwn(after, path)).sort();
	const changed = Object.keys(after).filter((path) => Object.hasOwn(before, path) && before[path] !== after[path]).sort();
	return { added, changed, removed };
}

/**
 * What a new version may not do to the structure of instance data. Data is unversioned:
 * a ticket pinned to an old version reads the current structure, which is safe only if
 * every collection and field the old version knew is still there with the same type and
 * unit. The user's conditions are instance data too, so a collection also keeps its `watch`.
 */
export function structureProblems(previous: readonly Component[], next: readonly Component[]): Problem[] {
	const problems: Problem[] = [];
	const rule = "a new version may add collections and fields, never remove or rename one";
	const current = collectionsOf(next);
	for (const item of previous) {
		if (item.kind !== "data") continue;
		const now = current.get(item.name);
		if (now === undefined) {
			problems.push({ where: `data/${item.name}`, reason: `collection "${item.name}" was removed; ${rule}` });
			continue;
		}
		const where = `data/${item.name}/collection.json`;
		if (now.kind !== item.collection.kind) {
			problems.push({ where, reason: `"kind" changed from ${item.collection.kind} to ${now.kind}; a collection keeps its kind` });
		}
		const watched = item.collection.watch;
		if (watched !== undefined && (now.watch?.key !== watched.key || now.watch.value !== watched.value || now.watch.at !== watched.at)) {
			problems.push({ where, reason: `"watch" was removed or points at other fields; the user's conditions on this collection depend on it` });
		}
		for (const [field, before] of Object.entries(item.collection.fields)) {
			const after = Object.hasOwn(now.fields, field) ? now.fields[field] : undefined;
			if (after === undefined) problems.push({ where, reason: `field "${field}" was removed; ${rule}` });
			else if (after.type !== before.type) {
				problems.push({ where, reason: `field "${field}" changed type from ${before.type} to ${after.type}; a field keeps its type` });
			} else if (after.unit !== before.unit) {
				problems.push({
					where,
					reason: `field "${field}" changed unit from ${before.unit ?? "none"} to ${after.unit ?? "none"}; the stored numbers would silently mean something else, so a field keeps its unit`,
				});
			}
		}
	}
	return problems;
}
