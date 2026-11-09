import type { Clock, TriggerSubmission } from "../kernel/types.ts";
import { marketFeed } from "./market/source.ts";

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
