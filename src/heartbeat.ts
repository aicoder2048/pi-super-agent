import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Heartbeat {
	pid: number;
	at: number;
}

export const heartbeatPath = (stateDir: string) => join(stateDir, "heartbeat.json");

export function writeFileAtomic(path: string, text: string): void {
	writeFileSync(`${path}.tmp`, text);
	renameSync(`${path}.tmp`, path);
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

// The pid in heartbeat.json may have been reused by an unrelated process since the host died.
export function hostPid(stateDir: string, self = process.pid): number | undefined {
	const pid = readHeartbeat(stateDir)?.pid;
	return pid && pid !== self && commandOf(pid)?.includes(HOST_ENTRY) ? pid : undefined;
}
