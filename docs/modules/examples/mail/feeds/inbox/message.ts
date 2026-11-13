/** Module code cannot import the host's, so the cleaning repeats src/modules/release.ts; the host cleans the released fields again at its edge. */

type Attachment = { partId: string; filename: string; mimeType: string; size: number };

export type MessageRow = {
	id: string;
	gmailId: string;
	threadId: string;
	messageIdHeader: string;
	fromName: string;
	fromAddress: string;
	replyTo: string;
	subject: string;
	date: string;
	snippet: string;
	body: string;
	attachments: string;
};

type Released = { from: string; subject: string; snippet: string };

type Part = { partId?: string; mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
export type GmailMessage = { id: string; threadId?: string; snippet?: string; internalDate?: string; payload?: Part };

const BODY_BYTES = 64 * 1024;
const CUT = "\n\n[正文超过 64 KB，后面截掉了，全文在 Gmail 里看]";
const LIMITS = { name: 80, subject: 120, snippet: 100, line: 160 } as const;

export const header = (message: GmailMessage, name: string): string =>
	message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

export function parseFrom(from: string): { name: string; address: string } {
	const angle = /^(.*?)\s*<([^<>]+)>\s*$/.exec(from.trim());
	if (angle === null) return { name: "", address: from.trim().toLowerCase() };
	return { name: angle[1]!.trim().replace(/^"(.*)"$/, "$1"), address: angle[2]!.trim().toLowerCase() };
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

function clipBytes(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= BODY_BYTES) return text;
	const room = BODY_BYTES - Buffer.byteLength(CUT, "utf8");
	let kept = "";
	let bytes = 0;
	for (const ch of text) {
		bytes += Buffer.byteLength(ch, "utf8");
		if (bytes > room) break;
		kept += ch;
	}
	return kept + CUT;
}

const partsOf = (part: Part | undefined): Part[] => (part === undefined ? [] : [part, ...(part.parts ?? []).flatMap(partsOf)]);
const decode = (data: string | undefined) => Buffer.from(data ?? "", "base64url").toString("utf8");

function bodyText(parts: readonly Part[]): string {
	const inline = parts.filter((p) => !p.filename && p.body?.data);
	const plain = inline.find((p) => p.mimeType === "text/plain");
	if (plain) return decode(plain.body!.data);
	const html = inline.find((p) => p.mimeType === "text/html");
	return html ? htmlToText(decode(html.body!.data)) : "";
}

export function messageRow(message: GmailMessage): MessageRow {
	const parts = partsOf(message.payload);
	const from = parseFrom(header(message, "From"));
	const attachments: Attachment[] = parts
		.filter((p) => p.filename && p.body?.attachmentId)
		.map((p) => ({ partId: p.partId ?? "", filename: p.filename!, mimeType: p.mimeType ?? "", size: p.body?.size ?? 0 }));
	const at = Number(message.internalDate);
	return {
		id: message.id,
		gmailId: message.id,
		threadId: message.threadId ?? "",
		messageIdHeader: header(message, "Message-ID"),
		fromName: from.name,
		fromAddress: from.address,
		replyTo: header(message, "Reply-To"),
		subject: header(message, "Subject"),
		date: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : "",
		snippet: decodeEntities(message.snippet ?? ""),
		body: clipBytes(bodyText(parts)),
		attachments: JSON.stringify(attachments),
	};
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const clean = (text: string) =>
	text
		.replace(/\p{Cf}/gu, "")
		.replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
		.trim();

function clip(text: string, graphemes: number): string {
	const all = [...segmenter.segment(text)].map((s) => s.segment);
	return all.length <= graphemes ? text : `${all.slice(0, Math.max(graphemes - 1, 0)).join("")}…`;
}

/** The address is always whole on the phone, so a display name such as 「白宫 · 系统」 cannot hide who sent it. */
export function released(row: MessageRow): Released {
	const address = clean(row.fromAddress);
	const room = Math.min(LIMITS.name, LIMITS.line - [...segmenter.segment(address)].length - 3);
	const name = room > 0 ? clip(clean(row.fromName), room) : "";
	return {
		from: name === "" ? address : `${name} <${address}>`,
		subject: clip(clean(row.subject), LIMITS.subject),
		snippet: clip(clean(row.snippet), LIMITS.snippet),
	};
}
