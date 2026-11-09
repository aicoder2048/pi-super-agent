import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ConfigError } from "../../config-error.ts";

export const KEY_NAMES = ["STOCK_HEATMAP_API_KEY", "MASSIVE_API_KEY", "POLYGON_API_KEY"] as const;

export function readMarketKey(env: Readonly<NodeJS.ProcessEnv>, secretsFile: string | undefined): { key: string; origin: string } | undefined {
	const fromEnv = KEY_NAMES.find((name) => env[name]);
	const envKey = fromEnv && env[fromEnv];
	let found: { key: string; origin: string } | undefined;
	if (envKey) found = { key: envKey, origin: `环境变量 ${fromEnv}` };
	else if (secretsFile && existsSync(secretsFile)) {
		const file = parseEnv(readFileSync(secretsFile, "utf8"));
		const name = KEY_NAMES.find((n) => file[n]);
		if (name) found = { key: file[name]!, origin: `secretsFile ${secretsFile}` };
	}
	if (found && !/^[\x21-\x7e]+$/.test(found.key)) throw new ConfigError(`行情密钥（${found.origin}）含有空白或非 ASCII 字符，请检查`);
	return found;
}
