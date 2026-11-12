import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError, readJsonFile } from "./config-error.ts";
import type { SecretLookup } from "./modules/run-code.ts";

export interface LoadedSecret {
	key: string;
	origin: string;
}

/** The first of `names` set in the environment, else in the `secretsFile` .env. `origin` names where it came from and never the value. */
export function readSecret(names: readonly string[], label: string, env: Readonly<NodeJS.ProcessEnv>, secretsFile: string | undefined): LoadedSecret | undefined {
	const fromEnv = names.find((name) => env[name]);
	let found: LoadedSecret | undefined;
	if (fromEnv) found = { key: env[fromEnv]!, origin: `环境变量 ${fromEnv}` };
	else if (secretsFile) {
		const file = parseEnv(readFileSync(secretsFile, "utf8"));
		const name = names.find((n) => file[n]);
		if (name) found = { key: file[name]!, origin: `secretsFile ${secretsFile}` };
	}
	if (found && !/^[\x21-\x7e]+$/.test(found.key)) throw new ConfigError(`${label}（${found.origin}）含有空白或非 ASCII 字符，请检查`);
	return found;
}

export const secretLookup = (secretsFile: string | undefined, env: Readonly<NodeJS.ProcessEnv> = process.env): SecretLookup => (name) => readSecret([name], name, env, secretsFile)?.key;

/** Kept out of loadConfig so `just module check` reads it without loading Pi. */
export const configuredSecretsFile = (stateDir: string): string | undefined => {
	const file = join(stateDir, "config.json");
	return parseSecretsFile(existsSync(file) ? readJsonFile<{ secretsFile?: unknown }>(file).secretsFile : undefined, stateDir, file);
};

export function parseSecretsFile(raw: unknown, stateDir: string, configFile: string): string | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string") throw new ConfigError(`${configFile}：secretsFile（${JSON.stringify(raw)}）必须是 .env 文件的路径字符串`);
	const secretsFile = resolve(stateDir, raw);
	if (!existsSync(secretsFile)) throw new ConfigError(`${configFile}：secretsFile 指向的 ${secretsFile} 不存在`);
	return secretsFile;
}
