import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../protocol.ts";

/** A file this new may still be being written, so a parse failure waits for the next look. */
const SETTLE_MS = 1_000;

function moveTo(dir: string, sub: "processed" | "rejected", file: string): string {
	mkdirSync(join(dir, sub), { recursive: true });
	const stem = file.replace(/\.json$/, "");
	let target = join(dir, sub, file);
	for (let n = 1; existsSync(target); n++) target = join(dir, sub, `${stem}.${n}.json`);
	renameSync(join(dir, file), target);
	return target;
}

export const processInbox = (dir: string, file: string): void => void moveTo(dir, "processed", file);

export function rejectInbox(dir: string, file: string, reason: string, log: (line: string) => void): void {
	const target = moveTo(dir, "rejected", file);
	writeFileSync(`${target}.error.txt`, `${reason}\n`);
	log(`[feeds] 拒收 ${join(dir, file)}：${reason}`);
}

export function takeInbox(dir: string, log: (line: string) => void): { file: string; item: Json }[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().flatMap((file) => {
		try {
			return [{ file, item: JSON.parse(readFileSync(join(dir, file), "utf8")) as Json }];
		} catch (error) {
			if (Date.now() - statSync(join(dir, file)).mtimeMs >= SETTLE_MS) rejectInbox(dir, file, `不是合法的 JSON：${(error as Error).message}`, log);
			return [];
		}
	});
}
