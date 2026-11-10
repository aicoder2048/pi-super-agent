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

/** `pid` leads the member's own process group. */
export function recordMember(sessionDir: string, pid: number): void {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, LEDGER), JSON.stringify({ pid }));
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

function commandLine(pid: number): string | undefined {
	try {
		return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

async function gone(pid: number, withinMs: number): Promise<boolean> {
	for (let waited = 0; alive(pid) && waited < withinMs; waited += 20) await sleep(20);
	return !alive(pid);
}

/**
 * Ends every member process a dead host left behind and resolves once they are gone. A recorded pid is
 * signalled only while its command line still carries that member's session dir: after the member has
 * exited, the system may have given its pid to another process.
 */
export async function endLeftoverMembers(stateDir: string, log: (line: string) => void, killAfterMs = 800): Promise<void> {
	await Promise.all(memberSessionDirs(stateDir).map(async (sessionDir) => {
		const file = join(sessionDir, LEDGER);
		if (!existsSync(file)) return;
		const { pid } = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
		if (typeof pid === "number" && Number.isInteger(pid) && pid > 1 && `${commandLine(pid)} `.includes(`--session-dir ${sessionDir} `)) {
			signalGroup(pid, "SIGTERM");
			if (!(await gone(pid, killAfterMs))) signalGroup(pid, "SIGKILL");
			if (!(await gone(pid, GONE_WITHIN_MS))) throw new Error(`停不掉上一个宿主留下的成员进程 ${pid}（${sessionDir}）`);
			signalGroup(pid, "SIGKILL");
			log(`[host] 结束了上一个宿主留下的成员进程：任务 ${basename(dirname(dirname(sessionDir)))} 的 ${basename(sessionDir)}（pid ${pid}）`);
		}
		clearMember(sessionDir);
	}));
}
