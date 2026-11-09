import type { Kernel } from "../kernel/kernel.ts";
import type { Action, PendingAction } from "../kernel/types.ts";

type Handlers = { [K in Action["kind"]]: (payload: Extract<Action, { kind: K }>["payload"]) => Promise<void> | void };

export interface DispatcherOptions {
	kernel: Kernel;
	handlers: Handlers;
	retryPollMs?: number;
	onError?: (action: PendingAction, error: unknown) => void;
}

export class Dispatcher {
	readonly #kernel: Kernel;
	readonly #handlers: Handlers;
	readonly #onError: (action: PendingAction, error: unknown) => void;
	readonly #inFlight = new Set<string>();
	readonly #idleWaiters: Array<() => void> = [];
	#scheduled = false;
	#timer: NodeJS.Timeout | undefined;

	constructor({ kernel, handlers, retryPollMs = 1000, onError }: DispatcherOptions) {
		this.#kernel = kernel;
		this.#handlers = handlers;
		this.#onError = onError ?? ((action, error) => console.error(`[dispatcher] ${action.kind} ${action.id}:`, error));
		this.#timer = setInterval(() => this.kick(), retryPollMs);
		this.#timer.unref();
	}

	kick = (): void => {
		if (this.#scheduled) return;
		this.#scheduled = true;
		setImmediate(() => {
			this.#scheduled = false;
			this.#drain();
		});
	};

	#drain(): void {
		for (const action of this.#kernel.dueActions()) {
			if (this.#inFlight.has(action.id)) continue;
			this.#inFlight.add(action.id);
			void this.#run(action);
		}
		this.#notifyIdle();
	}

	async #run(action: PendingAction): Promise<void> {
		try {
			await (this.#handlers[action.kind] as (p: unknown) => Promise<void> | void)(action.payload);
			this.#kernel.completeAction(action.id);
		} catch (error) {
			this.#kernel.failAction(action.id, error instanceof Error ? error.message : String(error));
			this.#onError(action, error);
		} finally {
			this.#inFlight.delete(action.id);
			this.kick();
		}
	}

	#notifyIdle(): void {
		if (this.#inFlight.size > 0 || this.#scheduled) return;
		if (this.#kernel.dueActions(1).length > 0) return;
		for (const resolve of this.#idleWaiters.splice(0)) resolve();
	}

	settled(): Promise<void> {
		return new Promise((resolve) => {
			this.#idleWaiters.push(resolve);
			this.kick();
		});
	}

	stop(): void {
		clearInterval(this.#timer);
	}
}
