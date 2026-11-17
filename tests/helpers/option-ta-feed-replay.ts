/** Runs an option-ta feed handler in this process on one of its fixtures, the way `module check` does, with `fetch` replaying the fixture. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { feedInput, nothingHeld } from "../../src/modules/feed-runner.ts";
import type { FeedDescriptor, FeedFixture } from "../../src/modules/manifest.ts";

export const PACKAGE = join(import.meta.dirname, "../../docs/modules/examples/option-ta");

type Reply = { status: number; headers?: Record<string, string>; body?: unknown };
const isReplay = (r: unknown): r is Reply => typeof r === "object" && r !== null && !Array.isArray(r) && typeof (r as Reply).status === "number" && Object.keys(r).every((k) => ["status", "headers", "body"].includes(k));

export type Replayed = { output: any; fetched: string[] };

export function fixtureOf(feed: string, name: string): { input: Record<string, unknown>; responses?: Record<string, unknown> } {
	return JSON.parse(readFileSync(join(PACKAGE, "feeds", feed, "fixtures", `${name}.json`), "utf8"));
}

/** `secrets` default to the check's: every named secret is "fixture". `change` edits the fixture's input, `respond` its responses, before the run. */
export async function replay(feed: string, name: string, { secrets, change, respond }: { secrets?: Record<string, string>; change?: (input: Record<string, any>) => void; respond?: (responses: Record<string, any>) => void } = {}): Promise<Replayed> {
	const descriptor = JSON.parse(readFileSync(join(PACKAGE, "feeds", feed, "feed.json"), "utf8")) as FeedDescriptor;
	const fixture = fixtureOf(feed, name);
	change?.(fixture.input);
	fixture.responses ??= {};
	respond?.(fixture.responses);
	const input = feedInput(descriptor, [], nothingHeld(Date.now()), { name, input: fixture.input, responses: fixture.responses ?? {} } as unknown as FeedFixture);
	const named = descriptor.secrets ?? [];
	const env = secrets ?? Object.fromEntries(named.map((s) => [s, "fixture"]));
	const saved = { fetch: globalThis.fetch, env: Object.fromEntries(named.map((s) => [s, process.env[s]])) };
	const fetched: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request) => {
		const key = String((url as Request)?.url ?? url);
		fetched.push(key);
		if (!Object.hasOwn(fixture.responses ?? {}, key)) throw new Error(`the fixture has no response for ${key}`);
		const reply = fixture.responses![key];
		const { status, headers = {}, body } = isReplay(reply) ? reply : { status: 200, headers: {}, body: reply };
		return new Response([204, 205, 304].includes(status) ? null : typeof body === "string" ? body : JSON.stringify(body ?? null), { status, headers: { "content-type": "application/json", ...headers } });
	}) as typeof fetch;
	for (const s of named) {
		if (env[s] === undefined) delete process.env[s];
		else process.env[s] = env[s];
	}
	try {
		const handler = (await import(join(PACKAGE, "feeds", feed, descriptor.handler!))).default;
		return { output: await handler(input), fetched };
	} finally {
		globalThis.fetch = saved.fetch;
		for (const [s, v] of Object.entries(saved.env)) {
			if (v === undefined) delete process.env[s];
			else process.env[s] = v;
		}
	}
}
