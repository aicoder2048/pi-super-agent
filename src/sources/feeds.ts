import type { SourcePanel } from "../client/protocol.ts";
import type { Clock, HostLinePost, TriggerSubmission } from "../kernel/types.ts";
import { marketFeed } from "./market/source.ts";
import type { RedactedTripwire } from "./market/tripwires.ts";

export type { HostLinePost } from "../kernel/types.ts";

export interface FeedContext {
	clock: Clock;
	submit(trigger: TriggerSubmission): void;
	readCursor(): string | undefined;
	writeCursor(value: string): void;
	readUserData(): string | undefined;
	writeUserData(value: string): void;
	/** Straight to the user's front ends; the Router never sees it. A repeated alert externalId changes nothing. A line the store refuses throws. */
	post(line: HostLinePost): void;
	/** Whether this feed already posted the alert `externalId`. */
	raised(externalId: string): boolean;
	/** The alerts this feed posted at or after `since`, oldest first. */
	alertsSince(since: number): { externalId: string; text: string; at: number }[];
	log(line: string): void;
}

export interface Feed {
	start(): void;
	stop(): void;
	problem(): string | undefined;
	lookup(op: string, args: unknown): Promise<unknown>;
	tripwires(op: string, args: unknown): TripwireReply;
	panel?(): SourcePanel;
}

export interface TripwireReply {
	echo: string;
	tripwires: RedactedTripwire[];
	/** list only: today's alerts, so a helper asked "why no alert" can see what went out. */
	firedToday?: { sentAt: string; text: string }[];
}

export interface FeedSpec {
	source: string;
	/** One line saying whether the feed can run, e.g. why it is off. Never contains a secret. */
	status: string;
	lookupHelp: string;
	tripwireHelp?: string;
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
