/**
 * The host's only write to Google (ADR-0022). The draft token never reaches module code: a
 * `gmail.createDraft` tool returns the message it wrote, and the host checks it and issues one
 * `POST .../users/me/drafts`. Nothing here can send.
 */
import { Buffer } from "node:buffer";
import type { Json } from "./protocol.ts";

export interface GooglePort {
	createDraft(raw: string, threadId: string): Promise<string>;
}

type DraftMade = { draftId: string; threadId: string; to: string; subject: string; note: string };

const DRAFTS_LINK = "https://mail.google.com/mail/u/0/#drafts";
const MAX_RAW_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const AGAIN = "在笔记本上跑 just google-auth draft，再把那一行复制到跑宿主的机器，见 docs/deploy/gmail.md";

function headers(raw: string): { name: string; value: string }[] {
	const block = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
	return block
		.replace(/\r?\n[ \t]+/g, " ")
		.split(/\r?\n/)
		.flatMap((line) => {
			const colon = line.indexOf(":");
			return colon > 0 ? [{ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() }] : [];
		});
}

const decodeWords = (value: string) => value.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=\s*/gi, (_, text: string) => Buffer.from(text, "base64").toString("utf8"));

export const headerOf = (raw: string, name: string): string => decodeWords(headers(raw).find((h) => h.name === name)?.value ?? "");

export async function writeDraft(port: GooglePort, output: Json): Promise<{ output: DraftMade; receipt: string } | string> {
	const reply = output as { draft?: { raw?: unknown; threadId?: unknown }; note?: unknown } | null;
	const raw = reply?.draft?.raw;
	const threadId = reply?.draft?.threadId;
	if (typeof raw !== "string" || typeof threadId !== "string" || threadId === "") return "工具要回 { draft: { raw, threadId } }";
	if (Buffer.byteLength(raw) > MAX_RAW_BYTES) return "草稿超过 1 MB";
	const found = headers(raw);
	const value = (name: string) => found.find((h) => h.name === name)?.value;
	if (value("bcc") !== undefined || value("cc") !== undefined) return "草稿不许带抄送或密送";
	const to = value("to");
	if (to === undefined) return "草稿没有收件人";
	const toolNote = typeof reply?.note === "string" && reply.note !== "" ? reply.note : null;
	const draftId = await port.createDraft(raw, threadId);
	const subject = decodeWords(value("subject") ?? "");
	const made = { draftId, threadId, to: decodeWords(to), subject, note: ["草稿在 Gmail 的草稿箱里，看过后自己发送", toolNote].filter(Boolean).join("。") };
	const receipt = ["已写好回信草稿，没有发送", `收件人：${made.to}`, `主题：${subject}`, DRAFTS_LINK, ...(toolNote === null ? [] : [toolNote])].join("\n");
	return { output: made, receipt };
}

type GooglePortOptions = { secret: (name: string) => string | undefined; oauthUrl: string | undefined; fixtures: boolean };

export function googlePort({ secret, oauthUrl, fixtures }: GooglePortOptions): GooglePort {
	const token = oauthUrl === undefined ? "https://oauth2.googleapis.com/token" : `${oauthUrl}/token`;
	const drafts = `${oauthUrl ?? "https://gmail.googleapis.com"}/gmail/v1/users/me/drafts`;
	return {
		async createDraft(raw, threadId) {
			if (fixtures && oauthUrl === undefined) throw new Error("这台宿主在用 fixtures 预演，不建真草稿");
			const refresh = secret("GMAIL_DRAFT_REFRESH_TOKEN");
			if (!refresh) throw new Error(`还没授权写草稿：${AGAIN}`);
			const form = new URLSearchParams({ client_id: secret("GOOGLE_OAUTH_CLIENT_ID") ?? "", client_secret: secret("GOOGLE_OAUTH_CLIENT_SECRET") ?? "", refresh_token: refresh, grant_type: "refresh_token" });
			const exchanged = await fetch(token, { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
			const grant = (await exchanged.json().catch(() => ({}))) as { access_token?: unknown; error?: unknown };
			if (grant.error === "invalid_grant") throw new Error(`写草稿的授权失效了：${AGAIN}`);
			if (typeof grant.access_token !== "string") throw new Error(`Google 的 token 接口返回 HTTP ${exchanged.status}`);
			const created = await fetch(drafts, {
				method: "POST",
				headers: { Authorization: `Bearer ${grant.access_token}`, "content-type": "application/json" },
				body: JSON.stringify({ message: { raw: Buffer.from(raw, "utf8").toString("base64url"), threadId } }),
				redirect: "error",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			const draft = (await created.json().catch(() => ({}))) as { id?: unknown };
			if (!created.ok || typeof draft.id !== "string") throw new Error(`Gmail 建草稿返回 HTTP ${created.status}`);
			return draft.id;
		},
	};
}
