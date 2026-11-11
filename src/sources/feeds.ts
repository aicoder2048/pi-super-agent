import type { Clock, HostLinePost, TriggerSubmission } from "../kernel/types.ts";
import { marketFeed } from "./market/source.ts";

export type { HostLinePost } from "../kernel/types.ts";

export interface FeedContext {
	clock: Clock;
	submit(trigger: TriggerSubmission): void;
	readCursor(): string | undefined;
	writeCursor(value: string): void;
	/** Straight to the user's front ends; the Router never sees it. A repeated alert externalId changes nothing. A line the store refuses throws. */
	post(line: HostLinePost): void;
	/** Whether this feed already posted the alert `externalId`. */
	raised(externalId: string): boolean;
	log(line: string): void;
}

export interface Feed {
	start(): void;
	stop(): void;
	problem(): string | undefined;
	lookup(op: string, args: unknown): Promise<unknown>;
}

export interface FeedSpec {
	source: string;
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
