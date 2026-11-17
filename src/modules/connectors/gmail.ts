/** The host's read access to the user's Gmail. The refresh token is the user's identity, so it stays in the host's secrets file and never reaches module code. */
export const AUTH_TEXT = "Gmail 授权失效了，在笔记本上重跑 just google-auth read，再把那一行复制到这台机器";

export type Gmail = (path: string, query: Record<string, string>, signal?: AbortSignal) => Promise<{ status: number; body: any }>;

export interface GmailAccount {
	/** Undefined when Google answers `invalid_grant`: the refresh token is dead until the user authorizes again. */
	open(signal?: AbortSignal): Promise<Gmail | undefined>;
}

type AccountOptions = { secret: (name: string) => string | undefined; oauthUrl: string | undefined; fetch?: typeof fetch };

export function gmailAccount({ secret, oauthUrl, fetch: get = fetch }: AccountOptions): GmailAccount {
	const tokenUrl = oauthUrl === undefined ? "https://oauth2.googleapis.com/token" : `${oauthUrl}/token`;
	const baseUrl = oauthUrl ?? "https://gmail.googleapis.com";
	return {
		async open(signal) {
			const form = new URLSearchParams({ client_id: secret("GOOGLE_OAUTH_CLIENT_ID") ?? "", client_secret: secret("GOOGLE_OAUTH_CLIENT_SECRET") ?? "", refresh_token: secret("GMAIL_READ_REFRESH_TOKEN") ?? "", grant_type: "refresh_token" });
			if (form.get("refresh_token") === "") throw new Error("没有设置 GMAIL_READ_REFRESH_TOKEN：在笔记本上跑 just google-auth read，见 docs/modules/mail.md");
			const reply = await get(tokenUrl, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "error", ...(signal && { signal }) });
			const body: any = await reply.json().catch(() => ({}));
			if (body?.error === "invalid_grant") return undefined;
			if (typeof body?.access_token !== "string") throw new Error(`Google 的 token 接口返回 HTTP ${reply.status}${typeof body?.error === "string" ? ` ${body.error}` : ""}`);
			return client(get, baseUrl, body.access_token);
		},
	};
}

// Fixtures replay every body with status 200, and Gmail's error bodies carry the code too.
const client = (get: typeof fetch, baseUrl: string, token: string): Gmail => async (path, query, signal) => {
	const reply = await get(`${baseUrl}/gmail/v1/users/me${path}?${new URLSearchParams(query)}`, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, redirect: "error", ...(signal && { signal }) });
	const body: any = await reply.json().catch((error) => {
		if (signal?.aborted) throw error;
		return {};
	});
	return { status: typeof body?.error?.code === "number" ? body.error.code : reply.status, body };
};
