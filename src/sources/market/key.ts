import { readSecret } from "../../secrets.ts";

export const KEY_NAMES = ["STOCK_HEATMAP_API_KEY", "MASSIVE_API_KEY", "POLYGON_API_KEY"] as const;
export const FINNHUB_KEY_NAMES = ["FINNHUB_API_KEY"] as const;

export const readMarketKey = (env: Readonly<NodeJS.ProcessEnv>, secretsFile: string | undefined) => readSecret(KEY_NAMES, "行情密钥", env, secretsFile);
export const readFinnhubKey = (env: Readonly<NodeJS.ProcessEnv>, secretsFile: string | undefined) => readSecret(FINNHUB_KEY_NAMES, "Finnhub 密钥", env, secretsFile);
