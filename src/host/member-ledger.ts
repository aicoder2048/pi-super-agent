import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileAtomic } from "../heartbeat.ts";
import { memberSessionDirs } from "./dispatch.ts";

const LEDGER = "running.json";
const GONE_WITHIN_MS = 5000;

interface Running {
	pgid: number;
	startedAt: string;
}

// Pi replaces its command line with its name, so the start time is what identifies the process.
function startTime(pid: number): string | undefined {
	try {
		return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim() || undefined;
	} catch {
		return undefined;
	}
}

export function recordMember(sessionDir: string, pgid: number): void {
	const startedAt = startTime(pgid);
	if (!startedAt) return;
	const file = join(sessionDir, LEDGER);
	try {
		mkdirSync(sessionDir, { recursive: true });
		writeFileAtomic(file, JSON.stringify({ pgid, startedAt } satisfies Running));
	} catch (error) {
		throw new Error(`写不了成员进程记录 ${file}：${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

function readRunning(file: string): Running | undefined {
	try {
		const { pgid, startedAt } = JSON.parse(readFileSync(file, "utf8")) as Partial<Running>;
		if (typeof pgid === "number" && Number.isInteger(pgid) && pgid > 1 && typeof startedAt === "string") return { pgid, startedAt };
	} catch {}
	return undefined;
}

export const isRecorded = (sessionDir: string) => existsSync(join(sessionDir, LEDGER));

export function clearMember(sessionDir: string): void {
	rmSync(join(sessionDir, LEDGER), { force: true });
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
	try {
		process.kill(-pgid, signal);
	} catch {}
};

async function gone(pid: number, withinMs: number): Promise<boolean> {
	for (let waited = 0; alive(pid) && waited < withinMs; waited += 20) await sleep(20);
	return !alive(pid);
}

/**
 * Ends every member process a dead host left behind and resolves once they are gone. A recorded pid is
 * signalled only while the process with that pid still has the recorded start time: after the member
 * has exited, the system may have given its pid to another process.
 */
export async function endLeftoverMembers(stateDir: string, log: (line: string) => void, killAfterMs = 800): Promise<void> {
	await Promise.all(memberSessionDirs(stateDir).filter(isRecorded).map(async (sessionDir) => {
		const running = readRunning(join(sessionDir, LEDGER));
		if (!running) log(`[host] 成员进程记录 ${join(sessionDir, LEDGER)} 读不出来，认不出它记的是哪个进程，已清掉`);
		else if (startTime(running.pgid) === running.startedAt) {
			const { pgid } = running;
			signalGroup(pgid, "SIGTERM");
			if (!(await gone(pgid, killAfterMs))) signalGroup(pgid, "SIGKILL");
			if (!(await gone(pgid, GONE_WITHIN_MS))) throw new Error(`停不掉上一个宿主留下的成员进程 ${pgid}（${sessionDir}）`);
			signalGroup(pgid, "SIGKILL");
			log(`[host] 结束了上一个宿主留下的成员进程：任务 ${basename(dirname(dirname(sessionDir)))} 的 ${basename(sessionDir)}（pid ${pgid}）`);
		}
		clearMember(sessionDir);
	}));
}
