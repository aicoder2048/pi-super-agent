import { join } from "node:path";
import { ConfigError } from "../../config-error.ts";
import { readSecret } from "../../secrets.ts";
import type { HostConfig } from "../config.ts";
import { BotApi, BotToken } from "./bot-api.ts";
import type { TelegramOptions } from "./client.ts";

/** Kept apart from wiring.ts so the Watchdog reads the same token and allowlist without loading the host. */
export function telegramOptions(config: Pick<HostConfig, "stateDir" | "secretsFile" | "telegram">, env: Readonly<NodeJS.ProcessEnv>, log: (line: string) => void): TelegramOptions | undefined {
	if (!config.telegram) return undefined;
	const found = readSecret(["TELEGRAM_BOT_TOKEN"], "TELEGRAM_BOT_TOKEN", env, config.secretsFile);
	if (!found) throw new ConfigError(`${join(config.stateDir, "config.json")}：写了 telegram 段，但环境变量和 secretsFile 里都没有 TELEGRAM_BOT_TOKEN`);
	const token = new BotToken(found.key, found.origin);
	log(`[telegram] bot token 来自${found.origin}`);
	return { api: new BotApi({ token }), allowedUserIds: new Set(config.telegram.allowedUserIds) };
}
