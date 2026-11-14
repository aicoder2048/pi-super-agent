import type { Clock } from "./kernel/types.ts";
import type { ModelRef } from "./models.ts";
import { assertAllowed } from "./models.ts";

export const QUOTA_ERROR = /\b429\b|rate.?limit|quota|usage.?limit|too many requests/i;

export function isQuotaError(message: string): boolean {
	return QUOTA_ERROR.test(message);
}

export interface ModelSelectorOptions {
	primary: ModelRef;
	fallback: ModelRef;
	probeEveryMs: number;
	clock: Clock;
}

type Mode = "primary" | "fallback" | "probing";

export class ModelSelector {
	readonly #o: ModelSelectorOptions;
	#mode: Mode = "primary";
	#lastSwitchOrProbe = 0;

	constructor(options: ModelSelectorOptions) {
		assertAllowed(options.primary);
		assertAllowed(options.fallback);
		this.#o = options;
	}

	get fallback(): ModelRef {
		return this.#o.fallback;
	}

	current(): { model: ModelRef; fellBack: boolean } {
		return this.#mode === "fallback" ? { model: this.#o.fallback, fellBack: true } : { model: this.#o.primary, fellBack: false };
	}

	/** For a side task such as a dispatched member, which reports no outcome here: the fallback unless the primary is settled. Never starts a probe. */
	steady(): { model: ModelRef; fellBack: boolean } {
		return this.#mode === "primary" ? { model: this.#o.primary, fellBack: false } : { model: this.#o.fallback, fellBack: true };
	}

	forTurn(): { model: ModelRef; fellBack: boolean; probing: boolean } {
		if (this.#mode === "fallback" && this.#o.clock.now() - this.#lastSwitchOrProbe >= this.#o.probeEveryMs) {
			this.#mode = "probing";
			this.#lastSwitchOrProbe = this.#o.clock.now();
		}
		return { ...this.current(), probing: this.#mode === "probing" };
	}

	onSuccess(): void {
		if (this.#mode === "probing") this.#mode = "primary";
	}

	onError(message: string): { switched: false } | { switched: true } {
		if (!isQuotaError(message) || this.#mode === "fallback") return { switched: false };
		if (this.#mode === "probing") {
			this.#mode = "fallback";
			return { switched: true };
		}
		this.#mode = "fallback";
		this.#lastSwitchOrProbe = this.#o.clock.now();
		return { switched: true };
	}
}
