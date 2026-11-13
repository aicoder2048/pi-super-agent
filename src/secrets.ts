import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError, readJsonFile } from "./config-error.ts";
import { writeFileAtomic } from "./heartbeat.ts";
import type { SecretLookup } from "./modules/run-code.ts";

const SECRET_CHARS = /^[\x21-\x7e]+$/;

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
	if (found && !SECRET_CHARS.test(found.key)) throw new ConfigError(`${label}（${found.origin}）含有空白或非 ASCII 字符，请检查`);
	return found;
}

export const secretLookup = (secretsFile: string | undefined, env: Readonly<NodeJS.ProcessEnv> = process.env): SecretLookup => (name) => readSecret([name], name, env, secretsFile)?.key;

/** Kept out of loadConfig so `just google-auth` reads it without loading Pi. */
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

/** Other lines that set `name` are dropped, so no duplicate shadows the new value. */
export function writeSecret(file: string, name: string, value: string): void {
	const target = realpathSync(file);
	const text = readFileSync(target, "utf8");
	const line = `${name}=${value}`;
	const setsName = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
	const lines = text.split("\n");
	const at = lines.findIndex((l) => setsName.test(l));
	let next: string;
	if (at === -1) next = `${text === "" || text.endsWith("\n") ? text : `${text}\n`}${line}\n`;
	else next = lines.filter((l, i) => i === at || !setsName.test(l)).map((l, i) => (i === at ? line : l)).join("\n");
	if (!SECRET_CHARS.test(value) || parseEnv(next)[name] !== value) throw new ConfigError(`${name} 的值在 .env 里写不下（会被读成别的值），没有写入`);
	writeFileAtomic(target, next, 0o600);
}
