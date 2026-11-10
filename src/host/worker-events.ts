import type { WorkerEvents } from "./workers.ts";

interface PiEvent {
	type: string;
	message?: { role?: string; provider?: string; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; cacheRead?: number } };
}

export interface Usage {
	provider: string;
	/** New input plus cache reads. Cache writes are not counted. */
	tokensIn: number;
	/** The part of `tokensIn` read from the provider's prompt cache. Absent: none reported. */
	tokensCached?: number;
	tokensOut: number;
}

export function usageOf(message: PiEvent["message"], defaultProvider: string): Usage | undefined {
	if (!message?.usage) return undefined;
	return {
		provider: message.provider ?? defaultProvider,
		tokensIn: (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0),
		tokensCached: message.usage.cacheRead ?? 0,
		tokensOut: message.usage.output ?? 0,
	};
}

export class WorkerEventTranslator {
	readonly #events: WorkerEvents;
	readonly #defaultProvider: string;
	#lastError: string | undefined;

	constructor(events: WorkerEvents, defaultProvider: string) {
		this.#events = events;
		this.#defaultProvider = defaultProvider;
	}

	feed(event: PiEvent): void {
		if (event.type === "agent_start") {
			this.#lastError = undefined;
			this.#events.turnStarted();
		} else if (event.type === "tool_execution_start") {
			this.#events.toolCalled();
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			const m = event.message;
			this.#lastError = m.stopReason === "error" ? String(m.errorMessage ?? "error") : undefined;
			const usage = usageOf(m, this.#defaultProvider);
			if (usage) this.#events.usage(usage);
		} else if (event.type === "agent_settled") {
			this.#events.settled(this.#lastError);
		}
	}
}
