/** Secrets that stand for the user (their accounts and authorizations). They belong to the host and reach modules only through a connector (ADR-0031). */
export const IDENTITY_SECRETS: ReadonlySet<string> = new Set([
	"GOOGLE_OAUTH_CLIENT_ID",
	"GOOGLE_OAUTH_CLIENT_SECRET",
	"GMAIL_READ_REFRESH_TOKEN",
	"GMAIL_DRAFT_REFRESH_TOKEN",
	"TELEGRAM_BOT_TOKEN",
	"DEEPSEEK_API_KEY",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GITHUB_TOKEN",
]);

export const identityNote = (secret: string): string | undefined =>
	IDENTITY_SECRETS.has(secret) ? `${secret} 是代表你本人的身份类密钥，应该走宿主的连接器；模块只能从自己的 .env 读到它` : undefined;
