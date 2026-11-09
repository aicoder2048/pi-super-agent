import { readFileSync } from "node:fs";

export class ConfigError extends Error {
	override name = "ConfigError";
}

export function readJsonFile<T>(path: string): T {
	const text = readFileSync(path, "utf8");
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new ConfigError(`${path} 不是合法的 JSON：${(error as Error).message}`);
	}
}

export function exitOnConfigError(error: unknown): never {
	if (!(error instanceof ConfigError)) throw error;
	console.error(error.message);
	process.exit(1);
}
