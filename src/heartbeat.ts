import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Heartbeat {
	pid: number;
	at: number;
}

export const heartbeatPath = (stateDir: string) => join(stateDir, "heartbeat.json");

export function writeHeartbeat(stateDir: string, beat: Heartbeat): void {
	const file = heartbeatPath(stateDir);
	writeFileSync(`${file}.tmp`, JSON.stringify(beat));
	renameSync(`${file}.tmp`, file);
}

export function readHeartbeat(stateDir: string): Heartbeat | undefined {
	try {
		const beat = JSON.parse(readFileSync(heartbeatPath(stateDir), "utf8")) as Partial<Heartbeat>;
		return typeof beat.pid === "number" && typeof beat.at === "number" ? { pid: beat.pid, at: beat.at } : undefined;
	} catch {
		return undefined;
	}
}
