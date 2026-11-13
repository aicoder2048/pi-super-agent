import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Heartbeat {
	pid: number;
	at: number;
}

export const heartbeatPath = (stateDir: string) => join(stateDir, "heartbeat.json");

/** `mode` applies only when a file is created, so a leftover tmp is removed and `wx` refuses a racing one. */
export function writeFileAtomic(path: string, text: string, mode?: number): void {
	const tmp = `${path}.tmp`;
	if (mode === undefined) writeFileSync(tmp, text);
	else {
		rmSync(tmp, { force: true });
		writeFileSync(tmp, text, { mode, flag: "wx" });
	}
	renameSync(tmp, path);
}

export function writeHeartbeat(stateDir: string, beat: Heartbeat): void {
	writeFileAtomic(heartbeatPath(stateDir), JSON.stringify(beat));
}

export function readHeartbeat(stateDir: string): Heartbeat | undefined {
	try {
		const beat = JSON.parse(readFileSync(heartbeatPath(stateDir), "utf8")) as Partial<Heartbeat>;
		return typeof beat.pid === "number" && typeof beat.at === "number" ? { pid: beat.pid, at: beat.at } : undefined;
	} catch {
		return undefined;
	}
}

export const HOST_ENTRY = "src/host/main.ts";

function commandOf(pid: number): string | undefined {
	try {
		return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

/**
 * The heartbeat only while its writer still runs: a host that stopped cleanly leaves its last heartbeat behind, and its
 * pid may since have been reused by an unrelated process.
 */
export function liveHeartbeat(stateDir: string, self = process.pid): Heartbeat | undefined {
	const beat = readHeartbeat(stateDir);
	return beat && beat.pid !== self && commandOf(beat.pid)?.includes(HOST_ENTRY) ? beat : undefined;
}

export const hostPid = (stateDir: string, self = process.pid): number | undefined => liveHeartbeat(stateDir, self)?.pid;
