import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ConfigError } from "./config-error.ts";

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
