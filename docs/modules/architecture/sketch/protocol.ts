/**
 * The capability protocol: the single way anything a module provides is reached at run time.
 *
 * A capability is a component that can be called: a tool, the knowledge base, a data
 * collection, a collection's watches, a feed. Every call goes through `Gateway.call`,
 * which decides who may call, picks the provider, labels the result with its data class
 * and writes the access log. Callers never talk to a provider, and providers never decide
 * who may call them.
 *
 * Skills and agent files are not capabilities. Pi reads them as files from the ticket's
 * pinned package snapshot.
 */
import { DATA_CLASSES } from "./manifest.ts";
import type { ComponentName, DataClass, DeclaredEffect, Digest, ModuleName } from "./manifest.ts";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

// ---------------------------------------------------------------------------
// Requests: a closed set, one variant per thing a module can serve
// ---------------------------------------------------------------------------

export type Condition =
	| { when: "above"; value: number }
	| { when: "below"; value: number }
	| { when: "rising-streak"; times: number }
	| { when: "falling-streak"; times: number }
	| { when: "change-pct"; atLeast: number; direction: "up" | "down" | "either" }
	/** The market's moving-average cross, as a condition on any series. */
	| { when: "crosses-average"; points: number; direction: "up" | "down" };

export interface Watch {
	id: string;
	/** The value of the collection's watch key, e.g. `CEA` or `NVDA`. */
	key: string;
	condition: Condition;
	note?: string;
}

export interface Query {
	where?: Readonly<Record<string, string | number>>;
	since?: string;
	until?: string;
	limit?: number;
}

/** The original a row was extracted from: a row of a collection that has a `blob` field. */
export interface RowSource {
	collection: ComponentName;
	row: string;
}

/**
 * One stored row, as `data query` returns it. A row a Worker wrote starts with
 * `confirmed: false` and stays so until the user confirms or corrects it on the modules
 * page. A row from a feed or from the user is confirmed from the start.
 */
export interface Row {
	id: string;
	fields: { readonly [field: string]: Json };
	confirmed: boolean;
	from: RowSource | null;
}

export type Request =
	| { kind: "tool"; name: ComponentName; input: Json }
	| { kind: "knowledge"; op: "search"; query: string; limit?: number }
	| { kind: "knowledge"; op: "read"; doc: ComponentName; section: string }
	| { kind: "data"; collection: ComponentName; op: "query"; query: Query }
	/** `from` names the original the Worker read the values from, when there is one. */
	| { kind: "data"; collection: ComponentName; op: "put"; rows: readonly Json[]; from?: RowSource }
	| { kind: "data"; collection: ComponentName; op: "open-blob"; row: string; field: string }
	/** Only the page sends this. `corrected` replaces the row's fields before it is marked confirmed. */
	| { kind: "data"; collection: ComponentName; op: "confirm"; row: string; corrected?: { readonly [field: string]: Json } }
	| { kind: "watch"; collection: ComponentName; op: "list" }
	| { kind: "watch"; collection: ComponentName; op: "set"; watch: Omit<Watch, "id"> & { id?: string } }
	| { kind: "watch"; collection: ComponentName; op: "remove"; id: string }
	/** Only the host scheduler sends this, for a poll and for a connector's push alike. */
	| { kind: "feed"; name: ComponentName; op: "collect"; items: readonly Json[] };

/**
 * What a request may change.
 * - `pure`: a tool with no network. Computes from its input.
 * - `read`: reads instance data or knowledge, or is a network tool that declares `read`.
 * - `write`: adds instance data, or is a tool whose effect is `write`.
 * - `user-authority`: changes what the host will do later on its own (a watch), or speaks
 *   for the user (confirming a row).
 */
export type Effect = "pure" | "read" | "write" | "user-authority";

/** `tool` is `toolEffect(descriptor)` from manifest.ts. It matters only for a `tool` request. */
export function effectOf(request: Request, tool: "pure" | DeclaredEffect): Effect {
	switch (request.kind) {
		case "tool":
			return tool;
		case "knowledge":
			return "read";
		case "data":
			if (request.op === "put") return "write";
			return request.op === "confirm" ? "user-authority" : "read";
		case "watch":
			return request.op === "list" ? "read" : "user-authority";
		case "feed":
			return "write";
	}
}

// ---------------------------------------------------------------------------
// Who may read which class
// ---------------------------------------------------------------------------

/**
 * The user's routing table, `dataRoutes` in `config.json`. For each class, the model
 * providers that may read it. A provider is named by the part of a model reference before
 * the slash: the provider of `openai-codex/gpt-5.2` is `openai-codex`. The host refuses a
 * config that puts a provider that is not on this machine under `local-only`. A class with
 * no entry is readable by no model.
 */
export type DataRoutes = Readonly<Partial<Record<DataClass, readonly string[]>>>;

/**
 * Whoever is about to receive data.
 * `clearance` is the highest class the receiver's own exits allow. The page, a Worker and
 * module code without `network` have `local-only`. Module code with `network` and
 * Telegram have `shareable`, because what they receive can leave the machine.
 * `provider` is the model provider a Worker's process runs on, null for everything that
 * is not a model.
 */
export interface Reader {
	clearance: DataClass;
	provider: string | null;
}

function routed(provider: string, dataClass: DataClass, routes: DataRoutes): boolean {
	return Object.hasOwn(routes, dataClass) && (routes[dataClass] ?? []).includes(provider);
}

/**
 * The one rule. Both halves must hold. Anything the rule does not know is a refusal: a
 * class that is not in `DATA_CLASSES`, a clearance that is not, a class the routes do not list.
 */
export function mayRead(reader: Reader, dataClass: DataClass, routes: DataRoutes): boolean {
	const needs = DATA_CLASSES.indexOf(dataClass);
	const has = DATA_CLASSES.indexOf(reader.clearance);
	if (needs === -1 || has < needs) return false;
	return reader.provider === null || routed(reader.provider, dataClass, routes);
}

/**
 * Whether a session that has already read data of `highest` may go on with `provider`.
 * A model session carries what it has read into every later turn, so moving it to another
 * provider hands that provider everything read so far. The host calls this before any
 * switch, the fallback after a quota or rate-limit error included. `highest` is null for
 * a session that has read no module data.
 */
export function mayContinueOn(highest: DataClass | null, provider: string, routes: DataRoutes): boolean {
	if (highest === null) return true;
	return DATA_CLASSES.includes(highest) && routed(provider, highest, routes);
}

/** What the Router gets in place of a trigger body it may not read. Fixed text, no content of the feed. */
export const WITHHELD_NOTICE = "有新内容，请在本机查看";

/**
 * The body of a trigger for the Router. A trigger has the class of its feed (`feedClass`
 * in manifest.ts), because its thread, its sender and its body all come from the feed's
 * items. A Router whose provider is not routed for that class gets the fixed line.
 */
export function triggerBodyFor(filled: string, feedClass: DataClass, router: Reader, routes: DataRoutes): string {
	return mayRead(router, feedClass, routes) ? filled : WITHHELD_NOTICE;
}

// ---------------------------------------------------------------------------
// Callers and the authority table
// ---------------------------------------------------------------------------

export type Caller =
	| {
			who: "worker";
			ticket: string;
			/** The version the ticket pinned when it opened. Never changes. */
			pin: { module: ModuleName; digest: Digest };
			basis: "request" | "rule" | "inference";
			/** null for the helper, the member's name for a team member. */
			member: string | null;
			/** The provider half of the model this process runs on. */
			provider: string;
			/** True once the ticket has read anything that is not the user's own words. */
			heardOthers: boolean;
	  }
	| { who: "scheduler"; module: ModuleName }
	| { who: "page"; module: ModuleName };

/**
 * The kinds of caller the authority table tells apart. A `request` ticket that has heard
 * nothing but the user is its own kind: it is the only Worker that carries the user's
 * authority (ADR-0003).
 */
export const SENDERS = ["request-user-only", "request", "rule", "inference", "page", "scheduler"] as const;
export type Sender = (typeof SENDERS)[number];

export function senderOf(caller: Caller): Sender {
	if (caller.who !== "worker") return caller.who;
	return caller.basis === "request" && !caller.heardOthers ? "request-user-only" : caller.basis;
}

/** The authority table: for each effect, the kinds of caller that may send it. */
export const AUTHORITY: Readonly<Record<Effect, readonly Sender[]>> = {
	pure: ["request-user-only", "request", "rule", "inference", "page"],
	read: ["request-user-only", "request", "rule", "inference", "page"],
	write: ["request-user-only", "request", "rule", "page"],
	"user-authority": ["request-user-only", "page"],
};

/** Two requests have one sender each, whatever their effect. */
function onlySender(request: Request): Sender | null {
	if (request.kind === "feed") return "scheduler";
	if (request.kind === "data" && request.op === "confirm") return "page";
	return null;
}

/**
 * Whether this caller may send this request. `tool` is as for `effectOf`. The scheduler
 * sends `feed collect` and nothing else, and nobody else sends it. Only the page confirms
 * a row. Every other request is decided by `AUTHORITY`.
 */
export function allowed(caller: Caller, request: Request, tool: "pure" | DeclaredEffect): boolean {
	const sender = senderOf(caller);
	const only = onlySender(request);
	if (only !== null) return sender === only;
	return AUTHORITY[effectOf(request, tool)].includes(sender);
}

export type Refusal =
	| { code: "no-such-capability" }
	| { code: "not-this-module" }
	| { code: "not-granted-to-member"; member: string }
	| { code: "module-disabled" }
	| { code: "provider-not-routed"; class: DataClass; provider: string }
	| { code: "class-exceeds-clearance"; class: DataClass; has: DataClass }
	/** `allowed` said no. `note` says who may send this request. */
	| { code: "not-allowed"; sender: Sender; note: string }
	| { code: "bad-input"; note: string }
	| { code: "over-budget"; retryAfterMs: number }
	| { code: "provider-failed"; note: string };

export interface Passage {
	doc: ComponentName;
	title: string;
	version: string;
	authority: "authoritative" | "reference";
	section: string;
	text: string;
}

export type Reply =
	| {
			ok: true;
			output: Json;
			/** The class of what is in `output`. The session's highest class rises to this. */
			class: DataClass;
			/** Present for knowledge calls. The citation a skill asks the Worker to carry. */
			passages?: readonly Passage[];
	  }
	| { ok: false; refusal: Refusal };

export interface Gateway {
	/**
	 * The only entry point. Order: resolve the capability in the caller's pinned snapshot,
	 * read the module's state from its lifecycle record, check the member's `uses`, ask
	 * `allowed`, ask `mayRead`, take from the budget. Then call the provider, label the
	 * result and append to the module's access log.
	 */
	call(caller: Caller, request: Request): Promise<Reply>;

	/** The tool list a Worker registers at spawn, already narrowed to the caller. */
	catalogue(caller: Extract<Caller, { who: "worker" }>): readonly CatalogueEntry[];
}

export interface CatalogueEntry {
	request: Request["kind"];
	name: string;
	title: string;
	/** Built by the host from the descriptor. Never contains instance data. */
	help: string;
}

// ---------------------------------------------------------------------------
// Providers: who actually does the work
// ---------------------------------------------------------------------------

/**
 * Host-provided default providers serve knowledge, data, watches, connector-only feeds
 * and tools with `servedBy`. Module code serves the other tools and the feed handlers,
 * one fresh process per call. The gateway treats both alike. A provider holds nothing
 * between calls, so there is nothing to stop when a module is disabled.
 */
export interface Provider {
	serve(request: Request, context: ProviderContext): Promise<ProviderResult>;
}

export interface ProviderContext {
	module: ModuleName;
	digest: Digest;
	deadlineMs: number;
}

export type ProviderResult = { ok: true; output: Json } | { ok: false; note: string };

/** What a feed's work produces. The host, not the feed, stores, submits and moves the cursor. */
export interface Collected {
	/** Rows for the feed's `into` collection. `id` makes a repeated row a no-op. */
	records: readonly ({ id: string } & { readonly [field: string]: Json })[];
	/** Values for the placeholders of the feed's `notice`. One trigger per entry, deduped by `id`. */
	notices: readonly { id: string; thread: string; fields: Readonly<Record<string, string>> }[];
	/** The feed's next cursor. The host saves it only after the records and notices are stored. */
	cursor?: string;
}

// ---------------------------------------------------------------------------
// What module code is written against
// ---------------------------------------------------------------------------

/**
 * `tools/<name>/index.ts` default export. `host.fetch` works only for the hosts in the
 * tool's `network`. A tool without `network` reaches nothing.
 */
export type ToolFunction = (input: Json, host: Pick<HostPort, "fetch">) => Json | Promise<Json>;

/** `feeds/<name>/<handler>` default export. */
export type FeedHandler = (input: FeedInput, host: HostPort) => Collected | Promise<Collected>;

export interface FeedInput {
	/** From the connector, or empty for a feed that fetches for itself. Data of the feed's class. */
	items: readonly Json[];
	/** `settings` from feed.json merged with the user's answers to `ask`. */
	settings: Readonly<Record<string, Json>>;
	cursor: string | null;
}

/**
 * Everything module code can reach. Each call is a frame to the host on the process's
 * stdout, answered on its stdin, and the host checks it against the component's own
 * descriptor.
 */
export interface HostPort {
	/** Only hosts in the component's `network`. The host attaches the secret, applies the rate limit, and refuses redirects elsewhere. */
	fetch(url: string, init?: { method?: "GET" | "POST"; headers?: Readonly<Record<string, string>>; body?: string }): Promise<{ status: number; body: string }>;
	/**
	 * Read rows of this module's own collections, e.g. the watchlist. Goes through
	 * `mayRead` with the reader of `moduleCodeReader`, so a handler with `network` gets
	 * `shareable` rows only.
	 */
	query(collection: string, query: Query): Promise<readonly Row[]>;
	/** The keys the user currently watches in a collection, so a feed polls what conditions need. */
	watchedKeys(collection: string): Promise<readonly string[]>;
}

/**
 * Code that can reach a network host could send what it reads there, so it reads
 * `shareable` only. The same reader decides what a handler may be handed: the scan
 * refuses a handler with `network` on a feed whose class is not `shareable`.
 */
export function moduleCodeReader(component: { network?: readonly unknown[] }): Reader {
	return { clearance: (component.network?.length ?? 0) > 0 ? "shareable" : "local-only", provider: null };
}

// ---------------------------------------------------------------------------
// The wire between the host and one call's process. Private to the runner and its launcher.
// How the process is confined is in sandbox.ts.
// ---------------------------------------------------------------------------

/**
 * JSON lines over the child's stdin and stdout. There is no socket and no token to steal.
 * The host sends one `run`, answers each `ask`, and reads one `done`. Then the process
 * exits. The host kills a process that passes its deadline. The process is handed the
 * input and nothing else: a verdict on its output is always reached outside it.
 */
export type HostToRunner =
	| { run: { input: Json } }
	| { id: number; answer: { ok: true; value: Json } | { ok: false; note: string } };

export type RunnerToHost =
	| { id: number; ask: { port: keyof HostPort; args: readonly Json[] } }
	| { done: { ok: true; output: Json } | { ok: false; note: string } };
