import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ConfigError } from "../../config-error.ts";

export const KEY_NAMES = ["STOCK_HEATMAP_API_KEY", "MASSIVE_API_KEY", "POLYGON_API_KEY"] as const;
export const FINNHUB_KEY_NAMES = ["FINNHUB_API_KEY"] as const;

export interface LoadedKey {
	key: string;
	origin: string;
}

function readKey(names: readonly string[], label: string, env: Readonly<NodeJS.ProcessEnv>, secretsFile: string | undefined): LoadedKey | undefined {
	const fromEnv = names.find((name) => env[name]);
	let found: LoadedKey | undefined;
	if (fromEnv) found = { key: env[fromEnv]!, origin: `环境变量 ${fromEnv}` };
	else if (secretsFile) {
		const file = parseEnv(readFileSync(secretsFile, "utf8"));
		const name = names.find((n) => file[n]);
		if (name) found = { key: file[name]!, origin: `secretsFile ${secretsFile}` };
	}
	if (found && !/^[\x21-\x7e]+$/.test(found.key)) throw new ConfigError(`${label}（${found.origin}）含有空白或非 ASCII 字符，请检查`);
	return found;
}

export const readMarketKey = (env: Readonly<NodeJS.ProcessEnv>, secretsFile: string | undefined) => readKey(KEY_NAMES, "行情密钥", env, secretsFile);
export const readFinnhubKey = (env: Readonly<NodeJS.ProcessEnv>, secretsFile: string | undefined) => readKey(FINNHUB_KEY_NAMES, "Finnhub 密钥", env, secretsFile);
