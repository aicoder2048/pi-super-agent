import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { writeFileAtomic } from "../heartbeat.ts";
import { join, sep } from "node:path";

const SESSION_DIRS = [join("sessions", "router"), join("sessions", "workers")];

// Pi finds a session by the working directory recorded in its header, so after the state directory
// moves (say, copied to another machine) every session would silently start over without this.
export function relocateState(stateDir: string): boolean {
	const here = realpathSync(stateDir);
	const marker = join(here, "location.json");
	const previous = existsSync(marker) ? (JSON.parse(readFileSync(marker, "utf8")) as { path?: string }).path : undefined;
	if (previous === here) return false;
	if (previous) for (const dir of SESSION_DIRS) rewriteHeaders(join(here, dir), previous, here);
	writeFileAtomic(marker, JSON.stringify({ path: here }));
	return previous !== undefined;
}

function rewriteHeaders(dir: string, from: string, to: string): void {
	if (!existsSync(dir)) return;
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
		const path = join(dir, file);
		const text = readFileSync(path, "utf8");
		const newline = text.indexOf("\n");
		const head = JSON.parse(newline < 0 ? text : text.slice(0, newline)) as { cwd?: string };
		if (!head.cwd || !(head.cwd === from || head.cwd.startsWith(from + sep))) continue;
		head.cwd = to + head.cwd.slice(from.length);
		writeFileAtomic(path, JSON.stringify(head) + (newline < 0 ? "" : text.slice(newline)));
	}
}
