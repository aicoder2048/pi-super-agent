import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type ResolveReadPath = (path: string, cwd: string) => string;

/**
 * Pi's own `resolveReadPath`, so a path is checked exactly as Pi's read tool will open it (a leading `@`,
 * `~`, macOS name variants). Pi's package `exports` hides the file, hence the import by file path.
 */
export async function piReadResolver(piCli: string): Promise<ResolveReadPath> {
	const utils = await import(pathToFileURL(join(dirname(piCli), "core", "tools", "path-utils.js")).href);
	if (typeof utils.resolveReadPath !== "function") throw new Error("Pi 的 path-utils.js 没有 resolveReadPath");
	return utils.resolveReadPath;
}

export const within = (parent: string, child: string) => {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export function realRoots(paths: readonly string[]): string[] {
	const roots: string[] = [];
	for (const path of paths) {
		let real: string;
		try {
			real = realpathSync(path);
		} catch {
			continue;
		}
		if (!roots.includes(real)) roots.push(real);
	}
	return roots;
}

/** One line for "outside" and "cannot resolve" alike, without the path, so a refusal does not tell whether a file outside exists. */
const REFUSAL = "这项任务只能读自己的工作目录和所属模块带的 knowledge/、skills/，这个路径不在里面或读不到。";

export function rootRefusal(path: string, cwd: string, roots: readonly string[], resolve: ResolveReadPath): string | undefined {
	let real: string;
	try {
		real = realpathSync(resolve(path, cwd));
	} catch {
		return REFUSAL;
	}
	return roots.some((root) => within(root, real)) ? undefined : REFUSAL;
}
