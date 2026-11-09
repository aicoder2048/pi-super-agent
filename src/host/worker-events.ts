import type { WorkerEvents } from "./workers.ts";

interface PiEvent {
	type: string;
	message?: { role?: string; provider?: string; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; cacheRead?: number } };
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
			if (m.usage) {
				this.#events.usage({
					provider: m.provider ?? this.#defaultProvider,
					tokensIn: (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0),
					tokensOut: m.usage.output ?? 0,
				});
			}
		} else if (event.type === "agent_settled") {
			this.#events.settled(this.#lastError);
		}
	}
}
