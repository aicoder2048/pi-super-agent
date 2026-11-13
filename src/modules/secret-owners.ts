/**
 * Who may name a secret in a package's `secrets` (ADR-0019). The host reads its own secrets
 * without this table; it only decides which module code a value may reach.
 * Secret name → the module that owns it, or "host".
 */
export const SECRET_OWNERS: Readonly<Record<string, string>> = {
	GOOGLE_OAUTH_CLIENT_ID: "mail",
	GOOGLE_OAUTH_CLIENT_SECRET: "mail",
	GMAIL_READ_REFRESH_TOKEN: "mail",
	POLYGON_API_KEY: "stock-ta",
	GMAIL_DRAFT_REFRESH_TOKEN: "host",
	TELEGRAM_BOT_TOKEN: "host",
	MASSIVE_API_KEY: "host",
	STOCK_HEATMAP_API_KEY: "host",
	FINNHUB_API_KEY: "host",
};

/** `stock-ta` → `STOCK_TA_`: a name outside the table is the module's own when it starts with this. */
export const prefixOf = (module: string): string => `${module.toUpperCase().replaceAll("-", "_")}_`;

/** Why `module` may not name `secret`, or undefined when it may. */
export function secretRefusal(module: string, secret: string): string | undefined {
	const owner = SECRET_OWNERS[secret];
	if (owner === "host") return `${secret} 属于宿主，模块不能用`;
	if (owner !== undefined) return owner === module ? undefined : `${secret} 属于模块 ${owner}，别的模块不能用`;
	return secret.startsWith(prefixOf(module)) ? undefined : `${secret} 不在密钥归属表里，本模块自己的密钥要以 ${prefixOf(module)} 开头`;
}
