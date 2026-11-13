export type Settings = { baseUrl: string; tokenUrl: string };

export const AUTH_TEXT = "Gmail 授权失效了，在笔记本上重跑 just google-auth read，再把那一行复制到这台机器";

/** Undefined when Google answers `invalid_grant`: the refresh token is dead until the user authorizes again. */
export async function accessToken(settings: Settings): Promise<string | undefined> {
	const form = new URLSearchParams({
		client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
		client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
		refresh_token: process.env.GMAIL_READ_REFRESH_TOKEN ?? "",
		grant_type: "refresh_token",
	});
	if (form.get("refresh_token") === "") throw new Error("没有设置 GMAIL_READ_REFRESH_TOKEN：在笔记本上跑 just google-auth read，见 docs/modules/mail.md");
	const reply = await fetch(settings.tokenUrl, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "error" });
	const body = await reply.json().catch(() => ({}));
	if (body?.error === "invalid_grant") return undefined;
	if (typeof body?.access_token !== "string") throw new Error(`Google 的 token 接口返回 HTTP ${reply.status}${typeof body?.error === "string" ? ` ${body.error}` : ""}`);
	return body.access_token;
}

export type Gmail = (path: string, query: Record<string, string>, signal?: AbortSignal) => Promise<{ status: number; body: any }>;

// Fixtures replay every body with status 200, and Gmail's error bodies carry the code too.
export const gmailClient = (baseUrl: string, token: string): Gmail => async (path, query, signal) => {
	const reply = await fetch(`${baseUrl}/gmail/v1/users/me${path}?${new URLSearchParams(query)}`, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, redirect: "error", ...(signal && { signal }) });
	const body = await reply.json().catch((error) => {
		if (signal?.aborted) throw error;
		return {};
	});
	return { status: typeof body?.error?.code === "number" ? body.error.code : reply.status, body };
};
