import type { TriggerSubmission } from "../kernel/types.ts";
import { ConfigError } from "../config-error.ts";
import { threadId } from "./generic.ts";

export interface TimerEntry {
	id: string;
	everyMinutes: number;
	thread: string;
	body: string;
	source?: string;
}

export interface TimerSourceOptions {
	entries: TimerEntry[];
	submit(trigger: TriggerSubmission): void;
	now(): number;
	readCursor(): number | undefined;
	writeCursor(at: number): void;
}

const MAX_CATCH_UP = 1;

export class TimerSource {
	readonly #o: TimerSourceOptions;
	#timer: NodeJS.Timeout | undefined;

	constructor(options: TimerSourceOptions) {
		for (const e of options.entries) {
			if (!(e.everyMinutes > 0)) throw new ConfigError(`定时器 ${e.id} 的 everyMinutes 必须大于 0`);
		}
		this.#o = options;
	}

	// Slots are aligned to the epoch so the externalId of a slot is stable across restarts; after downtime
	// only the latest missed slot fires, not one trigger per missed interval.
	tick(): void {
		const now = this.#o.now();
		const since = this.#o.readCursor() ?? now;
		for (const entry of this.#o.entries) {
			const period = entry.everyMinutes * 60_000;
			const slots: number[] = [];
			for (let slot = Math.floor(now / period) * period; slot > since && slots.length < MAX_CATCH_UP; slot -= period) {
				slots.push(slot);
			}
			for (const slot of slots) {
				const source = entry.source ?? "timer";
				this.#o.submit({
					source,
					externalId: `${entry.id}@${slot}`,
					threads: [{ id: threadId(source, entry.thread), title: entry.thread }],
					sender: `timer:${entry.id}`,
					body: entry.body,
					occurredAt: slot,
				});
			}
		}
		this.#o.writeCursor(now);
	}

	start(intervalMs = 30_000): void {
		this.tick();
		this.#timer = setInterval(() => this.tick(), intervalMs);
		this.#timer.unref();
	}

	stop(): void {
		clearInterval(this.#timer);
	}
}
