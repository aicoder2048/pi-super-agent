import { existsSync } from "node:fs";
import { join } from "node:path";
import { Kernel } from "../kernel/kernel.ts";
import { openStore } from "../kernel/store.ts";
import type { Clock, KernelConfig, Stall, SystemProblem } from "../kernel/types.ts";
import { readHeartbeat } from "../heartbeat.ts";
import { dropTrigger } from "../sources/generic.ts";

export const WATCHDOG_SOURCE = "watchdog";

export interface WatchdogConfig {
	heartbeatStaleMs: number;
	restartGraceMs: number;
}

export interface WatchdogInput {
	now: number;
	heartbeatAt: number | undefined;
	tickets: { id: string; title: string; stall: Stall | null }[];
	problems: SystemProblem[];
}

export interface WatchdogNotice {
	id: string;
	thread: string;
	body: string;
}

export function checkWatchdog(input: WatchdogInput, config: WatchdogConfig): { restartHost: boolean; notices: WatchdogNotice[] } {
	const restartHost = input.heartbeatAt === undefined || input.now - input.heartbeatAt > config.heartbeatStaleMs;
	const notices: WatchdogNotice[] = [];
	for (const t of input.tickets) {
		if (!t.stall) continue;
		notices.push({
			id: `stuck:${t.id}:${t.stall.since}`,
			thread: `stuck-${t.id}`,
			body: `[Watchdog] 任务 ${t.id}「${t.title}」已经 ${t.stall.minutes} 分钟没有进展，可能卡住了。请告诉使用者。`,
		});
	}
	for (const p of input.problems) {
		notices.push({
			id: `problem:${p.kind}:${p.since}`,
			thread: `problem-${p.kind}`,
			body: `[Watchdog] 系统问题：${p.kind} 类动作连续失败，最近的错误是「${p.lastError}」。请告诉使用者。`,
		});
	}
	return { restartHost, notices };
}

export interface WatchdogOptions {
	stateDir: string;
	clock: Clock;
	config: WatchdogConfig;
	kernel?: Partial<KernelConfig>;
	startHost(): void;
	log?: (line: string) => void;
}

export class Watchdog {
	readonly #o: WatchdogOptions;
	#kernel: Kernel | undefined;
	#lastRestartAt = Number.NEGATIVE_INFINITY;
	readonly #dropped = new Set<string>();

	constructor(options: WatchdogOptions) {
		this.#o = options;
	}

	#readKernel(): Kernel | undefined {
		if (this.#kernel) return this.#kernel;
		const db = join(this.#o.stateDir, "state.db");
		if (!existsSync(db)) return undefined;
		this.#kernel = new Kernel({ db: openStore(db), clock: this.#o.clock, sourcePolicy: () => "candidate", config: this.#o.kernel });
		return this.#kernel;
	}

	checkOnce(): void {
		const now = this.#o.clock.now();
		const kernel = this.#readKernel();
		const tickets = kernel?.listTickets() ?? [];
		const problems = kernel?.systemProblems() ?? [];
		const result = checkWatchdog(
			{ now, heartbeatAt: readHeartbeat(this.#o.stateDir)?.at, tickets, problems },
			this.#o.config,
		);
		if (result.restartHost && now - this.#lastRestartAt >= this.#o.config.restartGraceMs) {
			this.#lastRestartAt = now;
			this.#o.log?.("[watchdog] 宿主没有心跳，正在拉起");
			this.#o.startHost();
		}
		const current = new Set(result.notices.map((n) => n.id));
		for (const id of this.#dropped) if (!current.has(id)) this.#dropped.delete(id);
		for (const n of result.notices) {
			if (this.#dropped.has(n.id)) continue;
			this.#dropped.add(n.id);
			dropTrigger(join(this.#o.stateDir, "inbox"), { source: WATCHDOG_SOURCE, id: n.id, thread: n.thread, sender: WATCHDOG_SOURCE, body: n.body });
		}
	}
}
