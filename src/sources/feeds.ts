import type { Clock, TriggerSubmission } from "../kernel/types.ts";
import { marketFeed } from "./market/source.ts";

/** What the host gives a source it runs: kernel submit, its own row in source_cursors, the clock and the log. */
export interface FeedContext {
	clock: Clock;
	submit(trigger: TriggerSubmission): void;
	readCursor(): string | undefined;
	writeCursor(value: string): void;
	log(line: string): void;
}

export interface Feed {
	start(): void;
	stop(): void;
	/** A short line for the page's watched list when the source cannot watch; undefined when healthy. */
	problem(): string | undefined;
	/** A read-only query a Worker runs through the host. */
	lookup(op: string, args: unknown): Promise<unknown>;
}

/** A host-run source, built at startup (settings parsed, credentials read) and started by the host. */
export interface FeedSpec {
	source: string;
	/** Appended to the Worker `lookup` tool description. */
	lookupHelp: string;
	create(ctx: FeedContext): Feed;
}

export interface FeedInput {
	source: string;
	title: string;
	settings: unknown;
	override: unknown;
	where: string;
	secretsFile: string | undefined;
	env: NodeJS.ProcessEnv;
	log(line: string): void;
}

export const FEEDS: Record<string, (input: FeedInput) => FeedSpec> = {
	"massive-stocks": marketFeed,
};
