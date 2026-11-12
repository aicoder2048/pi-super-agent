import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

/** Saves within this long of each other are one change, so five saves in one second swap once. */
const QUIET_MS = 300;

/** Each module folder that changed, with the files under it that changed, relative to the folder. */
export type Saved = ReadonlyMap<string, ReadonlySet<string>>;

export function watchModules(roots: readonly string[], onSaved: (saved: Saved) => void, log: (line: string) => void): { close(): void } {
	let pending = new Map<string, Set<string>>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		const saved = pending;
		pending = new Map();
		onSaved(saved);
	};
	const watchers = roots.flatMap((root): FSWatcher[] => {
		try {
			return [
				watch(root, { recursive: true }, (_event, filename) => {
					const parts = (filename ?? "").split("/");
					const [folder, ...rest] = parts;
					if (!folder || parts.some((part) => part.startsWith("."))) return;
					const dir = join(root, folder);
					const files = pending.get(dir) ?? new Set();
					if (rest.length > 0) files.add(rest.join("/"));
					pending.set(dir, files);
					clearTimeout(timer);
					timer = setTimeout(flush, QUIET_MS);
				}),
			];
		} catch (error) {
			log(`[modules] 监视不了 ${root}，那里的改动要重启宿主才生效：${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	});
	return {
		close: () => {
			clearTimeout(timer);
			for (const watcher of watchers) watcher.close();
		},
	};
}
