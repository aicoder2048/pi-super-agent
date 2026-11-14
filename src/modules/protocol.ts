/**
 * The gateway: the single way a Worker or the page reaches anything a module provides.
 *
 * A capability is a component that can be called: a tool, the knowledge base, a data
 * collection, a collection's conditions. Every call goes through `Gateway.call`. It
 * resolves the capability in the module and version the ticket pinned, so a ticket never
 * reaches another module. It narrows by the member's `uses`, asks `allowed`, calls the
 * provider and writes the access log.
 *
 * Skills and agent files are not capabilities. Pi reads them as files from the ticket's
 * pinned copy. Feeds are not either: only the host's scheduler runs them.
 */
import type { ComponentName, Digest, ModuleName, ToolEffect } from "./manifest.ts";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export type Condition =
	| { when: "above"; value: number }
	| { when: "below"; value: number }
	| { when: "rising-streak"; times: number }
	| { when: "falling-streak"; times: number }
	/** Against `basis` when given, else against the row before. */
	| { when: "change-pct"; atLeast: number; direction: "up" | "down" | "either"; basis?: number }
	/** The market's moving-average cross, as a condition on any series. */
	| { when: "crosses-average"; points: number; direction: "up" | "down" }
	/** Against the row's own previous close (`watch.prevClose`), once per day in the watch's zone, direction and threshold. */
	| { when: "day-move"; atLeast: number; direction: "up" | "down" | "either" };

/** One condition the user set. `key` is a value of the collection's watch key, e.g. `CEA` or `NVDA`. */
export type Watch = { id: string; key: string; condition: Condition; note?: string };

/** `externalId` is the condition's id and the row's time, so a row never alerts twice. */
export type Alert = { externalId: string; text: string; at: string };

export type Side = "up" | "down";
export type DayMoveFold = { key: string; side: Side; clause: string };
export type FeedAlert = { id: string; text: string; at: string; fold?: { key: string; side: Side } };

export type Query = { where?: Readonly<Record<string, string | number>>; since?: string; until?: string; limit?: number };

/**
 * One stored row. `from` names where it came from (an original's path, a feed, 「使用者口述」), so the user can check an extracted value.
 * `sources` names the fields a later update took from somewhere else, each with that source.
 */
export interface Row {
	id: string;
	fields: { readonly [field: string]: Json };
	from: string;
	sources?: { readonly [field: string]: string };
}

/** A closed set: one variant per thing a module can serve to a caller. */
export type Request =
	| { kind: "tool"; name: ComponentName; input: Json }
	| { kind: "knowledge"; op: "search"; query: string; limit?: number }
	| { kind: "knowledge"; op: "read"; doc: ComponentName; section: string }
	| { kind: "data"; collection: ComponentName; op: "query"; query: Query }
	/** A row with `id` updates that row of a `record` collection. A row without one is added. */
	| { kind: "data"; collection: ComponentName; op: "write"; rows: readonly Json[]; from: string }
	| { kind: "data"; collection: ComponentName; op: "open-blob"; row: string; field: string }
	| { kind: "watch"; collection: ComponentName; op: "list" }
	| { kind: "watch"; collection: ComponentName; op: "set"; watch: Omit<Watch, "id"> & { id?: string } }
	| { kind: "watch"; collection: ComponentName; op: "remove"; id: string };

/**
 * What a request may change. `read`: nothing, which covers a `pure` tool and a `read` tool.
 * `write`: adds instance data, or is a tool whose effect is `write`.
 * `user-authority`: changes what the host will do later on its own (a condition).
 */
export type Effect = "read" | "write" | "user-authority";

/** `tool` is `toolEffect(descriptor)` from manifest.ts. It matters only for a `tool` request. */
export function effectOf(request: Request, tool: ToolEffect): Effect {
	if (request.kind === "tool") return tool === "write" ? "write" : "read";
	if (request.kind === "data") return request.op === "write" ? "write" : "read";
	if (request.kind === "watch") return request.op === "list" ? "read" : "user-authority";
	return "read";
}

export interface WorkerCaller {
	who: "worker";
	ticket: string;
	/** The version the ticket pinned when it opened. Never changes. */
	pin: { module: ModuleName; digest: Digest };
	basis: "request" | "rule" | "inference";
	/** null for the helper, the member's name for a team member. */
	member: string | null;
	/** True once the ticket has read anything that is not the user's own words. */
	heardOthers: boolean;
}

/** A Worker, or the modules page. A click on the page is the user. */
export type Caller = WorkerCaller | { who: "page"; module: ModuleName };

/**
 * The kinds of caller the authority table tells apart. A `request` ticket that has heard
 * nothing but the user is its own kind: it is the only Worker that carries the user's
 * authority (ADR-0003).
 */
export const SENDERS = ["request-user-only", "request", "rule", "inference", "page"] as const;
export type Sender = (typeof SENDERS)[number];

export function senderOf(caller: Caller): Sender {
	if (caller.who === "page") return "page";
	return caller.basis === "request" && !caller.heardOthers ? "request-user-only" : caller.basis;
}

/**
 * ADR-0003 as a table. Content from feeds, mail, files and models is data, never
 * authority: an inference ticket only reads, and a condition changes only for the user.
 */
export const AUTHORITY: Readonly<Record<Effect, readonly Sender[]>> = {
	read: ["request-user-only", "request", "rule", "inference", "page"],
	write: ["request-user-only", "request", "rule", "page"],
	"user-authority": ["request-user-only", "page"],
};

export function allowed(caller: Caller, request: Request, tool: ToolEffect): boolean {
	return AUTHORITY[effectOf(request, tool)].includes(senderOf(caller));
}

export type Refusal =
	| { code: "no-such-capability" }
	| { code: "not-in-uses"; member: string }
	| { code: "module-disabled" }
	/** `allowed` said no. `note` says who may send this request. */
	| { code: "not-allowed"; sender: Sender; note: string }
	| { code: "bad-input"; note: string }
	| { code: "provider-failed"; note: string };

/** One hit of a knowledge search, with the citation a skill asks the Worker to carry. */
export type Passage = { doc: ComponentName; title: string; version: string; authority: "authoritative" | "reference"; section: string; text: string };

/** `receipt`: a line the host shows only on this machine. */
export type Reply = { ok: true; output: Json; passages?: readonly Passage[]; alerts?: readonly Alert[]; receipt?: string } | { ok: false; refusal: Refusal };

export interface Gateway {
	/**
	 * The only entry point. Order: resolve the capability in the caller's pinned version,
	 * read the module's state from its lifecycle record, check the member's `uses`, ask
	 * `allowed`. Then call the provider and append to the module's access log.
	 */
	call(caller: Caller, request: Request): Promise<Reply>;
	/** The tool list a Worker registers at spawn, already narrowed to the caller. `help` is built from the descriptor. */
	catalogue(caller: WorkerCaller): readonly { request: Request["kind"]; name: string; title: string; help: string }[];
}

/**
 * What module code is written against. Each call is one fresh process (`runModuleCodeAsync` in
 * run-code.ts), and the runner turns it into a call of the entry file's default export, so
 * the author writes a plain function. This one is `tools/<name>/index.ts`.
 */
export type ToolFunction = (input: Json) => Json | Promise<Json>;

/** A feed handler's default export. The host calls it on the feed's schedule, or when its connector has items. */
export type FeedHandler = (input: FeedInput) => Collected | Promise<Collected>;

export interface FeedInput {
	/** From the connector, or empty for a feed that fetches for itself. */
	items: readonly Json[];
	/** `settings` from feed.json. Answers to `ask` are not stored yet, so they are not merged in. */
	settings: Readonly<Record<string, Json>>;
	cursor: string | null;
	/** The rows of each collection the feed lists in `reads`. */
	rows: Readonly<Record<string, readonly Row[]>>;
	/** The keys the user watches in the `into` collection, so the feed fetches what the conditions need. */
	watchedKeys: readonly string[];
	/** The host's clock as an ISO time. A handler judges freshness against it, so a fake clock replays a day. */
	now: string;
}

/** What a feed's work produces. The host, not the feed, stores, submits and moves the cursor. */
export interface Collected {
	/** Rows for the feed's `into` collection. `id` makes a repeated row a no-op. */
	records?: readonly ({ id: string } & { readonly [field: string]: Json })[];
	/** Values for the placeholders of the feed's `notice`. One trigger per entry, deduped by `id`. */
	notices?: readonly { id: string; thread?: string; fields: Readonly<Record<string, string>> }[];
	/**
	 * Lines the host posts to the user before any trigger, with no Router in between (ADR-0017), deduped by `id`. A `day-move`
	 * condition on `fold.key` that fires the same beat in the same direction joins this line, so one move reads as one line.
	 */
	alerts?: readonly FeedAlert[];
	/** The feed's next cursor. The host saves it only after the records and notices are stored. */
	cursor?: string;
	/**
	 * Something the user should fix, such as an expired authorization. The host tells the user the first beat an `id` is reported, and
	 * again only after a beat without it. `text` is written in the module's code: it never carries collection data (ADR-0020).
	 */
	problem?: { id: string; text: string };
}
