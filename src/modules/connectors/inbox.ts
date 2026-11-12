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

/** `<stateDir>/inbox/<module>/<feed>/*.json`, one item per file. A file that is not JSON goes to `rejected/` with the reason beside it. */
export function takeInbox(dir: string, log: (line: string) => void): { items: Json[]; files: string[] } {
	if (!existsSync(dir)) return { items: [], files: [] };
	const items: Json[] = [];
	const files: string[] = [];
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
		try {
			items.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as Json);
			files.push(file);
		} catch (error) {
			if (Date.now() - statSync(join(dir, file)).mtimeMs < SETTLE_MS) continue;
			const target = moveTo(dir, "rejected", file);
			writeFileSync(`${target}.error.txt`, `${(error as Error).message}\n`);
			log(`[feeds] 拒收 ${join(dir, file)}：不是合法的 JSON`);
		}
	}
	return { items, files };
}

/** After the call: `processed/` once stored, `rejected/` when the call failed, so a bad file is not retried every tick. */
export function settleInbox(dir: string, files: readonly string[], ok: boolean): void {
	for (const file of files) moveTo(dir, ok ? "processed" : "rejected", file);
}
