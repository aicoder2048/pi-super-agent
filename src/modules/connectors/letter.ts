/**
 * A Gmail message as the mail connector hands it to a feed's handler: headers, plain-text body, the HTML as sent and the attachment list.
 * The mail module's tools still decode attachments and parse addresses themselves (module code cannot import the host's),
 * so parseFrom, decodeEntities and htmlToText repeat docs/modules/examples/mail/feeds/inbox/message.ts; tests/unit/mail-senders.test.ts holds the copies to the same answers.
 */
import { Buffer } from "node:buffer";

export type Attachment = { partId: string; filename: string; mimeType: string; size: number };

export type Mailbox = { name: string; address: string };

/**
 * `id` is Gmail's message id. `body` is at most 64 KB of text, cut with a note; `date` is Gmail's receipt time as ISO, or empty.
 * `html` is the letter's own first text/html part as sent, decoded by its charset, at most 256 KB, cut before an open tag or table row with a note;
 * absent when that part is missing or Gmail keeps it apart. A forwarded letter's HTML is never this letter's.
 */
export type Letter = { id: string; threadId: string; messageIdHeader: string; from: Mailbox; replyTo: string; subject: string; date: string; snippet: string; body: string; html?: string; attachments: Attachment[] };

export type Part = { partId?: string; mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
export type GmailMessage = { id: string; threadId?: string; snippet?: string; internalDate?: string; payload?: Part };

const BODY = { bytes: 64 * 1024, cut: "\n\n[正文超过 64 KB，后面截掉了，全文在 Gmail 里看]" };
const HTML = { bytes: 256 * 1024, cut: "\n\n[HTML 超过 256 KB，后面截掉了，全文在 Gmail 里看]" };
const UNKNOWN_CHARSET = (charset: string) => `\n\n[正文的字符集 ${charset} 认不出，按 UTF-8 显示，可能有乱码，原文在 Gmail 里看]`;
const NOT_FETCHED = "[正文太大，Gmail 单独存放，这里没取，全文在 Gmail 里看]";

export const header = (message: GmailMessage, name: string): string =>
	message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const ATOM = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const ADDRESS = new RegExp(`^${ATOM}(?:\\.${ATOM})*@${LABEL}(?:\\.${LABEL})+$`);

/**
 * The sender list trusts this, so anything but one RFC 5322 mailbox with a dot-atom address is off-list: a list or group
 * can put a listed address beside an unlisted sender, and a second `@` can end an unlisted address in a listed domain.
 * Quoted names and comments may hold `,` `@` `<`, hence a scan instead of a pattern.
 */
export function parseFrom(from: string): Mailbox | undefined {
	let name = "";
	let address = "";
	let state: "name" | "angle" | "after" = "name";
	let quoted = false;
	for (let i = 0; i < from.length; i++) {
		const ch = from[i]!;
		if (ch === "(" && state !== "angle") {
			for (let depth = 1; depth > 0; ) {
				const next = from[++i];
				if (next === undefined) return undefined;
				if (next === "\\") i++;
				else if (next === "(") depth++;
				else if (next === ")") depth--;
			}
			name += " ";
		} else if (state === "name" && ch === '"') {
			quoted = true;
			for (let next = from[++i]; next !== '"'; next = from[++i]) {
				if (next === undefined) return undefined;
				name += next === "\\" ? (from[++i] ?? "") : next;
			}
		} else if (state === "name" && ch === "<") state = "angle";
		else if (state === "angle" && ch === ">") state = "after";
		else if (state === "angle") address += ch;
		else if (state === "name" && !",;:<>".includes(ch)) name += ch;
		else if (state === "after" && /\s/.test(ch)) continue;
		else return undefined;
	}
	if (state === "angle") return undefined;
	if (state === "name") [name, address] = quoted ? ["", ""] : ["", name];
	address = address.trim().toLowerCase();
	return ADDRESS.test(address) ? { name: name.replace(/\s+/g, " ").trim(), address } : undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export const decodeEntities = (text: string): string =>
	text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
		if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
		const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	});

export function htmlToText(html: string): string {
	const text = html
		.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
		.replace(/<[^>]*>/g, "");
	return decodeEntities(text)
		.replace(/[ \t ]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function clipBytes(text: string, limit: { bytes: number; cut: string }): string {
	if (Buffer.byteLength(text, "utf8") <= limit.bytes) return text;
	const room = limit.bytes - Buffer.byteLength(limit.cut, "utf8");
	let kept = "";
	let bytes = 0;
	for (const ch of text) {
		bytes += Buffer.byteLength(ch, "utf8");
		if (bytes > room) break;
		kept += ch;
	}
	return kept + limit.cut;
}

export const partsOf = (part: Part | undefined): Part[] => (part === undefined ? [] : [part, ...(part.parts ?? []).flatMap(partsOf)]);

const ownParts = (part: Part | undefined): Part[] => (part === undefined ? [] : [part, ...(part.mimeType === "message/rfc822" ? [] : (part.parts ?? []).flatMap(ownParts))]);

/** Gmail hands over a part's bytes as sent, in the charset its Content-Type names (GBK, Big5, Shift_JIS, ISO-8859-x). */
function decodeText(bytes: Buffer, part: Part): string {
	const contentType = part.headers?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
	const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
	const utf8 = () => new TextDecoder("utf-8").decode(bytes);
	if (charset === undefined) return utf8();
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return `${utf8()}${UNKNOWN_CHARSET(charset.slice(0, 40))}`;
	}
}

const decode = (part: Part) => decodeText(Buffer.from(part.body?.data ?? "", "base64url"), part);

const inline = (parts: readonly Part[], mimeType: string) => parts.find((p) => !p.filename && p.body?.data && p.mimeType === mimeType);

/** An open row longer than this is a layout table wrapping the whole letter, not a data row. */
const ROW_BACKTRACK = 4 * 1024;

/**
 * A cut that leaves half a tag or half a table row would hand a parser a row with a cell missing.
 * Known gaps: a `>` inside an attribute value hides a half tag, and a cut inside an entity such as `&amp;` keeps its first half.
 */
function clipHtml(html: string): string {
	const clipped = clipBytes(html, HTML);
	if (clipped === html) return html;
	const kept = clipped.slice(0, -HTML.cut.length);
	const lower = kept.replace(/[A-Z]/g, (c) => c.toLowerCase());
	let end = kept.length;
	if (lower.lastIndexOf("<") > lower.lastIndexOf(">")) end = lower.lastIndexOf("<");
	const row = lower.lastIndexOf("<tr", end - 1);
	if (row > lower.lastIndexOf("</tr>", end - 1) && end - row <= ROW_BACKTRACK) end = row;
	return kept.slice(0, end) + HTML.cut;
}

function htmlOf(message: GmailMessage): string | undefined {
	const own = ownParts(message.payload).find((p) => !p.filename && p.mimeType === "text/html");
	return own?.body?.data ? clipHtml(decode(own)) : undefined;
}

function bodyText(parts: readonly Part[]): string {
	const plain = inline(parts, "text/plain");
	if (plain) return decode(plain);
	const html = inline(parts, "text/html");
	if (html) return htmlToText(decode(html));
	return parts.some((p) => !p.filename && p.mimeType?.startsWith("text/") && p.body?.attachmentId) ? NOT_FETCHED : "";
}

export function letterOf(message: GmailMessage, from: Mailbox): Letter {
	const parts = partsOf(message.payload);
	const attachments: Attachment[] = parts
		.filter((p) => p.filename && p.body?.attachmentId)
		.map((p) => ({ partId: p.partId ?? "", filename: p.filename!, mimeType: p.mimeType ?? "", size: p.body?.size ?? 0 }));
	const html = htmlOf(message);
	const at = Number(message.internalDate);
	return {
		id: message.id,
		threadId: message.threadId ?? "",
		messageIdHeader: header(message, "Message-ID"),
		from,
		replyTo: header(message, "Reply-To"),
		subject: header(message, "Subject"),
		date: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : "",
		snippet: decodeEntities(message.snippet ?? ""),
		body: clipBytes(bodyText(parts), BODY),
		...(html !== undefined && { html }),
		attachments,
	};
}
