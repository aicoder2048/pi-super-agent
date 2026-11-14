import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../heartbeat.ts";

/** A host outage the Watchdog told the user about. Only the Watchdog writes it; the host reads it when it starts. `endedAt` is absent while it lasts. */
export interface Outage {
	since: number;
	endedAt?: number;
}

const outagePath = (stateDir: string) => join(stateDir, "outage.json");

export function readOutage(stateDir: string): Outage | undefined {
	try {
		const raw = JSON.parse(readFileSync(outagePath(stateDir), "utf8")) as Partial<Outage>;
		if (typeof raw.since !== "number") return undefined;
		return typeof raw.endedAt === "number" ? { since: raw.since, endedAt: raw.endedAt } : { since: raw.since };
	} catch {
		return undefined;
	}
}

export function writeOutage(stateDir: string, outage: Outage): void {
	writeFileAtomic(outagePath(stateDir), JSON.stringify(outage));
}
