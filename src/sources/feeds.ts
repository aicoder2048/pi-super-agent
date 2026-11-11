import type { Clock, HostLinePost, TriggerSubmission } from "../kernel/types.ts";
import { marketFeed } from "./market/source.ts";
import type { RedactedTripwire } from "./market/tripwires.ts";

export type { HostLinePost } from "../kernel/types.ts";

export interface FeedContext {
	clock: Clock;
	submit(trigger: TriggerSubmission): void;
	readCursor(): string | undefined;
	writeCursor(value: string): void;
	/** The user's data for this source. It survives restarts and NY days, unlike the cursor. */
	readUserData(): string | undefined;
	writeUserData(value: string): void;
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
	/** The one way to change the user's tripwires. The host has already checked who may write (ADR-0017). Throws a message for the helper. */
	tripwires(op: string, args: unknown): TripwireReply;
}

/** What the helper gets back. No cost basis and no share count: it may repeat this to the Router and so to Telegram. */
export interface TripwireReply {
	echo: string;
	tripwires: RedactedTripwire[];
}

export interface FeedSpec {
	source: string;
	lookupHelp: string;
	/** The tripwire tool's help a helper sees; empty for a feed without tripwires. */
	tripwireHelp: string;
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
