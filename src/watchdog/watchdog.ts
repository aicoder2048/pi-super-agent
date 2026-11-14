import { existsSync } from "node:fs";
import { join } from "node:path";
import { Kernel } from "../kernel/kernel.ts";
import { openStore } from "../kernel/store.ts";
import type { Clock, KernelConfig, Stall, SystemProblem } from "../kernel/types.ts";
import { liveHeartbeat, readHeartbeat } from "../heartbeat.ts";
import { scrub } from "../host/health.ts";
import { dropTrigger } from "../sources/generic.ts";
import { readOutage, writeOutage } from "./outage.ts";

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
	/** Straight to the user's phone, not through the host: the host is what is down. Returns at once and never throws. */
	tell?: (text: string, silent: boolean) => void;
	/** The last error line the host wrote since the latest start, keys taken out. */
	lastError?: () => string | undefined;
}

/** Starts that never brought a heartbeat, in a row, before a host that was never seen up counts as down. */
const FAILED_STARTS_BEFORE_ALARM = 3;

/**
 * What the Watchdog knows of the host. `unseen` is before its first check. `down` lasts from the check that found no
 * heartbeat until one finds it again; `told` says the user got its ⚠️, `starts` counts the restarts made during it.
 */
type HostWatch =
	| { kind: "unseen" }
	| { kind: "up" }
	| { kind: "down"; since: number; told: boolean; starts: number; startedAt: number | undefined };

const minutes = (ms: number) => (ms < 60_000 ? "不到 1 分钟" : `${Math.round(ms / 60_000)} 分钟`);

const hostDownText = (lastBeatAgoMs: number | undefined) =>
	`⚠️ 宿主停了${lastBeatAgoMs === undefined ? "" : `（最后一次心跳${lastBeatAgoMs < 60_000 ? "" : " "}${minutes(lastBeatAgoMs)}前）`}，看门狗正在重启`;

const hostFailingText = (starts: number, error: string | undefined) =>
	`⚠️ 宿主连续 ${starts} 次启动失败${error ? `：${error.replace(/[。.]$/, "")}` : ""}。看门狗会接着重试，详情见状态目录里的 host.log`;

const hostBackText = (downMs: number) => `✅ 宿主恢复了，停了${downMs < 60_000 ? "" : "约 "}${minutes(downMs)}`;

/** The line that says why the host stopped: the last one naming an error, else the last line, such as a config error. */
export function errorLine(log: string): string | undefined {
	const lines = log.split("\n").map((l) => l.trim()).filter(Boolean);
	const line = lines.findLast((l) => /error|错误|失败/i.test(l)) ?? lines.at(-1);
	return line === undefined ? undefined : scrub(line);
}

export class Watchdog {
	readonly #o: WatchdogOptions;
	#kernel: Kernel | undefined;
	#lastRestartAt = Number.NEGATIVE_INFINITY;
	readonly #dropped = new Set<string>();
	#host: HostWatch;

	constructor(options: WatchdogOptions) {
		this.#o = options;
		const open = readOutage(options.stateDir);
		this.#host = open && open.endedAt === undefined ? { kind: "down", since: open.since, told: true, starts: 0, startedAt: undefined } : { kind: "unseen" };
	}

	#tell(text: string, silent: boolean): void {
		this.#o.log?.(`[watchdog] ${text}`);
		this.#o.tell?.(text, silent);
	}

	/** One ⚠️ per outage and one ✅ when it ends, and only for an outage the user was told about. */
	#watchHost(now: number, beating: boolean): void {
		const host = this.#host;
		if (beating) {
			if (host.kind === "down" && host.told) {
				const endedAt = host.startedAt ?? now;
				writeOutage(this.#o.stateDir, { since: host.since, endedAt });
				this.#tell(hostBackText(endedAt - host.since), true);
			}
			this.#host = { kind: "up" };
			return;
		}
		if (host.kind === "down") return;
		if (host.kind === "unseen") {
			this.#host = { kind: "down", since: now, told: false, starts: 0, startedAt: undefined };
			return;
		}
		const lastBeat = readHeartbeat(this.#o.stateDir)?.at;
		const since = lastBeat ?? now;
		this.#host = { kind: "down", since, told: true, starts: 0, startedAt: undefined };
		writeOutage(this.#o.stateDir, { since });
		this.#tell(hostDownText(lastBeat === undefined ? undefined : now - lastBeat), false);
	}

	/** Called only once the previous start had its whole grace period: still no heartbeat means it failed. */
	#restarting(now: number): void {
		const host = this.#host;
		if (host.kind !== "down") return;
		if (!host.told && host.starts >= FAILED_STARTS_BEFORE_ALARM) {
			host.told = true;
			writeOutage(this.#o.stateDir, { since: host.since });
			this.#tell(hostFailingText(host.starts, this.#o.lastError?.()), false);
		}
		host.starts++;
		host.startedAt = now;
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
			{ now, heartbeatAt: liveHeartbeat(this.#o.stateDir)?.at, tickets, problems },
			this.#o.config,
		);
		this.#watchHost(now, !result.restartHost);
		if (result.restartHost && now - this.#lastRestartAt >= this.#o.config.restartGraceMs) {
			this.#lastRestartAt = now;
			this.#restarting(now);
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
