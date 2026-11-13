/** Decides only which module code a secret may reach; the host reads its own secrets without this table (ADR-0019). */
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

/** `__` ends the prefix: `MAIL_X_TOKEN` could belong to a module `mail-x`, `MAIL__X_TOKEN` only to `mail` (ADR-0019). */
export const prefixOf = (module: string): string => `${module.toUpperCase().replaceAll("-", "_")}__`;

export function secretRefusal(module: string, secret: string): string | undefined {
	const owner = SECRET_OWNERS[secret];
	if (owner === "host") return `${secret} 属于宿主，模块不能用`;
	if (owner !== undefined) return owner === module ? undefined : `${secret} 属于模块 ${owner}，别的模块不能用`;
	return secret.startsWith(prefixOf(module)) ? undefined : `${secret} 不在密钥归属表里，本模块自己的密钥要以 ${prefixOf(module)} 开头`;
}
