import { join } from "node:path";
import { processInbox, rejectInbox, takeInbox } from "./connectors/inbox.ts";
import { timerDue, timerItem } from "./connectors/timer.ts";
import type { FeedEntry, FeedRun } from "./feed-runner.ts";
import type { FeedStates } from "./instance-data.ts";
import type { FeedFixture, FeedWhen } from "./manifest.ts";
import type { Json } from "./protocol.ts";

const RUNNING = ["timer", "inbox"];
/** A handler can fail on a network blip, so an inbox file gets this many tries in a row before it is rejected. */
const INBOX_TRIES = 3;

export interface SchedulerOptions {
	feeds(): readonly FeedEntry[];
	run(entry: FeedEntry, items: readonly Json[], fixture?: FeedFixture): Promise<FeedRun>;
	state: FeedStates;
	inboxDir: string;
	now(): number;
	when: Readonly<Record<FeedWhen, (now: number) => boolean>>;
	/** `just module try`: each feed runs its fixtures once, and no connector runs. */
	fixtures: boolean;
	log(line: string): void;
}

export interface Scheduler {
	tick(): Promise<void>;
	start(everyMs: number): void;
	stop(): void;
}

export function createScheduler(o: SchedulerOptions): Scheduler {
	const lastRun = new Map<string, number | null>();
	const running = new Set<string>();
	const rehearsed = new Set<string>();
	const waiting = new Set<string>();
	const failures = new Map<string, number>();
	let timer: ReturnType<typeof setInterval> | undefined;

	const call = async (entry: FeedEntry, items: readonly Json[], fixture?: FeedFixture): Promise<FeedRun> => {
		const run = await o.run(entry, items, fixture);
		o.log(run.ok ? `[feeds] ${entry.source}${fixture ? ` 样例 ${fixture.name}` : ""}：${run.records} 行，${run.notices} 条触发` : `[feeds] ${entry.source} 这一次失败：${run.note}`);
		return run;
	};
	const lastRunOf = (entry: FeedEntry) => {
		if (!lastRun.has(entry.source)) lastRun.set(entry.source, o.state.feedState(entry.module, entry.source).lastRunAt);
		return lastRun.get(entry.source)!;
	};
	const work = (entry: FeedEntry, now: number): Promise<unknown> | undefined => {
		const { feed, source } = entry;
		if (o.fixtures) {
			const key = `${source}@${entry.dir}`;
			if (rehearsed.has(key)) return undefined;
			rehearsed.add(key);
			return (async () => {
				for (const fixture of entry.fixtures) await call(entry, [], fixture);
			})();
		}
		if (feed.connector !== undefined && !RUNNING.includes(feed.connector)) {
			if (!waiting.has(source)) o.log(`[feeds] ${source} 用的连接器 ${feed.connector} 宿主还没有，先不运行`);
			waiting.add(source);
			return undefined;
		}
		const open = () => feed.when === undefined || o.when[feed.when](now);
		if (feed.connector === "inbox") {
			if (!open()) return undefined;
			const dir = join(o.inboxDir, entry.module, entry.name);
			const taken = takeInbox(dir, o.log);
			if (taken.length === 0) return undefined;
			const mayBeNetwork = feed.handler !== undefined;
			return (async () => {
				for (const { file, item } of taken) {
					const run = await call(entry, [item]);
					const key = join(dir, file);
					const tries = run.ok ? 0 : (failures.get(key) ?? 0) + 1;
					if (!run.ok && mayBeNetwork && tries < INBOX_TRIES) {
						failures.set(key, tries);
						continue;
					}
					failures.delete(key);
					if (run.ok) processInbox(dir, file);
					else rejectInbox(dir, file, run.note, o.log);
				}
			})();
		}
		if (feed.every === undefined || !timerDue(feed.every, lastRunOf(entry), now) || !open()) return undefined;
		lastRun.set(source, now);
		o.state.saveFeedState(entry.module, source, { lastRunAt: now });
		return call(entry, feed.connector === "timer" ? [timerItem(feed.every, now)] : []);
	};
	const tick = async () => {
		const now = o.now();
		const calls: Promise<unknown>[] = [];
		for (const entry of o.feeds()) {
			if (running.has(entry.source)) continue;
			try {
				const started = work(entry, now);
				if (started === undefined) continue;
				running.add(entry.source);
				calls.push(started.catch((error) => o.log(`[feeds] ${entry.source} 出错：${String(error)}`)).finally(() => running.delete(entry.source)));
			} catch (error) {
				o.log(`[feeds] ${entry.source} 出错：${String(error)}`);
			}
		}
		await Promise.all(calls);
	};
	return {
		tick,
		start(everyMs) {
			timer = setInterval(() => void tick().catch((error) => o.log(`[feeds] 调度出错：${String(error)}`)), everyMs);
			timer.unref();
		},
		stop: () => clearInterval(timer),
	};
}
