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
