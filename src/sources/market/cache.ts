import type { Clock } from "../../kernel/types.ts";

export type Via = "cache" | "shared" | "fetch";

export interface Cached<T> {
	value: T;
	via: Via;
	ageMs: number;
}

interface Entry {
	value: unknown;
	at: number;
}

// TTL + LRU cache that also coalesces concurrent loads of the same key, so identical lookups cost one upstream request.
export class LookupCache {
	readonly #clock: Clock;
	readonly #max: number;
	readonly #entries = new Map<string, Entry>();
	readonly #inFlight = new Map<string, Promise<Entry>>();

	constructor(clock: Clock, max = 200) {
		this.#clock = clock;
		this.#max = max;
	}

	get size(): number {
		return this.#entries.size;
	}

	async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<Cached<T>> {
		const now = this.#clock.now();
		const hit = this.#entries.get(key);
		if (hit && now - hit.at < ttlMs) {
			this.#entries.delete(key);
			this.#entries.set(key, hit);
			return { value: hit.value as T, via: "cache", ageMs: now - hit.at };
		}
		const pending = this.#inFlight.get(key);
		if (pending) {
			const entry = await pending;
			return { value: entry.value as T, via: "shared", ageMs: this.#clock.now() - entry.at };
		}
		const run = load().then((value) => {
			const entry = { value, at: this.#clock.now() };
			this.#entries.delete(key);
			this.#entries.set(key, entry);
			if (this.#entries.size > this.#max) this.#entries.delete(this.#entries.keys().next().value!);
			return entry;
		});
		this.#inFlight.set(key, run);
		try {
			return { value: (await run).value as T, via: "fetch", ageMs: 0 };
		} finally {
			this.#inFlight.delete(key);
		}
	}
}
