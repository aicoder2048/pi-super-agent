/**
 * `fetch: mail.attachment` (ADR-0029): the host downloads one attachment before the tool's code runs, so the tool reads a local
 * file and never holds the Gmail authorization. Only a letter whose sender one of the module's mail feeds receives now is read:
 * the same rule as the feed, so a module never reaches mail its own feeds would not take in.
 */
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleRows } from "../instance-data.ts";
import type { Component, ModuleName } from "../manifest.ts";
import type { Json } from "../protocol.ts";
import { AUTH_TEXT, type Gmail, type GmailAccount } from "./gmail.ts";
import { header, parseFrom, partsOf, type GmailMessage } from "./letter.ts";
import { gateOf } from "./mail.ts";

/** What the tool finds in `input.fetched`. `file` is in the call's temporary folder, which the host deletes after the call; `contentType` is the part's header, with its charset. */
export type Fetched = { file: string; filename: string; mimeType: string; contentType: string; size: number };

export const FETCH_LIMITS = { maxBytes: 10 * 1024 * 1024, downloadMs: 10_000 };

export type FetchLimits = typeof FETCH_LIMITS;

type Ids = { messageId: string; partId: string };

function idsOf(input: Json): Ids | string {
	const { messageId, partId } = (input ?? {}) as Record<string, unknown>;
	if (typeof messageId !== "string" || messageId === "" || typeof partId !== "string" || partId === "") return "要给 messageId 和 partId 两个文字：信的 gmailId 和它附件清单里一项的 partId";
	return { messageId, partId };
}

export type AttachmentFetch = {
	account: GmailAccount;
	rows: Pick<ModuleRows, "query">;
	now(): number;
	limits?: FetchLimits;
};

/** A string is the refusal the caller sees. */
export async function fetchAttachment({ account, rows, now, limits = FETCH_LIMITS }: AttachmentFetch, module: ModuleName, components: readonly Component[], input: Json, dir: string): Promise<Fetched | string> {
	const ids = idsOf(input);
	if (typeof ids === "string") return ids;
	const gates = components.flatMap((c) => (c.kind === "feeds" && c.feed.connector === "mail" ? [gateOf({ module, feed: c.feed, components, source: `${module}/${c.name}` }, rows, now())] : []));
	const lookup = AbortSignal.timeout(limits.downloadMs);
	try {
		const gmail = await account.open(lookup);
		if (gmail === undefined) return AUTH_TEXT;
		const path = `/messages/${encodeURIComponent(ids.messageId)}`;
		const notOurs = `这封信不在 ${module} 收的信里：没有 gmailId 为 ${ids.messageId} 的信`;
		const meta = await gmail(path, { format: "metadata", metadataHeaders: "From" }, lookup);
		if (meta.status === 404) return notOurs;
		if (meta.status !== 200) return `Gmail ${path} 返回 HTTP ${meta.status}`;
		const from = parseFrom(header(meta.body as GmailMessage, "From"));
		if (from === undefined || !gates.some((gate) => gate.kind === "open" && gate.accepts(from.address))) return notOurs;
		const message = await gmail(path, { format: "full" }, lookup);
		if (message.status === 404) return notOurs;
		if (message.status !== 200) return `Gmail ${path} 返回 HTTP ${message.status}`;
		return await download(gmail, path, message.body as GmailMessage, ids.partId, limits, dir);
	} catch (error) {
		if ((error as Error).name === "TimeoutError") return "Gmail 没有及时回话，没取到这封信";
		throw error;
	}
}

async function download(gmail: Gmail, path: string, letter: GmailMessage, partId: string, limits: FetchLimits, dir: string): Promise<Fetched | string> {
	const attached = partsOf(letter.payload).filter((p) => p.filename && p.body?.attachmentId);
	const part = attached.find((p) => p.partId === partId);
	if (part === undefined) return `这封信没有 partId 为 ${partId} 的附件，它的附件 partId 有：${attached.map((p) => p.partId).join("、") || "（没有附件）"}`;
	const size = part.body?.size ?? 0;
	if (size > limits.maxBytes) return `附件有 ${(size / 1024 / 1024).toFixed(1)} MB，超过 ${limits.maxBytes / 1024 / 1024} MB，不下载`;
	try {
		const got = await gmail(`${path}/attachments/${encodeURIComponent(part.body!.attachmentId!)}`, {}, AbortSignal.timeout(limits.downloadMs));
		if (got.status !== 200 || typeof got.body?.data !== "string") return `Gmail 的附件接口返回 HTTP ${got.status}`;
		const bytes = Buffer.from(got.body.data, "base64url");
		const file = join(dir, "attachment");
		writeFileSync(file, bytes);
		const contentType = part.headers?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? part.mimeType ?? "";
		return { file, filename: part.filename ?? "", mimeType: part.mimeType ?? "", contentType, size: bytes.length };
	} catch (error) {
		if ((error as Error).name === "TimeoutError") return "附件下载超时";
		throw error;
	}
}
