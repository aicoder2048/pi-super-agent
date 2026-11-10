import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { memberSessionDirs } from "./dispatch.ts";

/**
 * The ledger of running members: one `running.json` in a member's session dir, written when the host
 * starts that member's process and removed when the process is gone. A member in a ticket runs one
 * process at a time, so one file is enough. A file still there at host start names a process that a
 * dead host left behind.
 */
const LEDGER = "running.json";
const GONE_WITHIN_MS = 5000;

/** `pid` leads the member's own process group. `startedAt` tells that process from a later one given the same pid. */
interface Running {
	pid: number;
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

export function recordMember(sessionDir: string, pid: number): void {
	const startedAt = startTime(pid);
	if (!startedAt) return;
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, LEDGER), JSON.stringify({ pid, startedAt } satisfies Running));
}

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

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
	try {
		process.kill(-pid, signal);
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
	await Promise.all(memberSessionDirs(stateDir).map(async (sessionDir) => {
		const file = join(sessionDir, LEDGER);
		if (!existsSync(file)) return;
		const { pid, startedAt } = JSON.parse(readFileSync(file, "utf8")) as Partial<Running>;
		if (typeof pid === "number" && Number.isInteger(pid) && pid > 1 && typeof startedAt === "string" && startTime(pid) === startedAt) {
			signalGroup(pid, "SIGTERM");
			if (!(await gone(pid, killAfterMs))) signalGroup(pid, "SIGKILL");
			if (!(await gone(pid, GONE_WITHIN_MS))) throw new Error(`停不掉上一个宿主留下的成员进程 ${pid}（${sessionDir}）`);
			signalGroup(pid, "SIGKILL");
			log(`[host] 结束了上一个宿主留下的成员进程：任务 ${basename(dirname(dirname(sessionDir)))} 的 ${basename(sessionDir)}（pid ${pid}）`);
		}
		clearMember(sessionDir);
	}));
}
