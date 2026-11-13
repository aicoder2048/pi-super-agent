/** Module code cannot import the host's, so the cleaning repeats src/modules/release.ts; the host cleans the released fields again at its edge. */

export type Attachment = { partId: string; filename: string; mimeType: string; size: number };

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

export type Part = { partId?: string; mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
export type GmailMessage = { id: string; threadId?: string; snippet?: string; internalDate?: string; payload?: Part };

const BODY_BYTES = 64 * 1024;
const CUT = "\n\n[正文超过 64 KB，后面截掉了，全文在 Gmail 里看]";
const UNKNOWN_CHARSET = (what: string, charset: string) => `\n\n[${what}的字符集 ${charset} 认不出，按 UTF-8 显示，可能有乱码，原文在 Gmail 里看]`;
const NOT_FETCHED = "[正文太大，Gmail 单独存放，这里没取，全文在 Gmail 里看]";
const LIMITS = { name: 80, subject: 120, snippet: 100, line: 160 } as const;

export const header = (message: GmailMessage, name: string): string =>
	message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

type Mailbox = { name: string; address: string };

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

export const partsOf = (part: Part | undefined): Part[] => (part === undefined ? [] : [part, ...(part.parts ?? []).flatMap(partsOf)]);

/** Gmail hands over a part's bytes as sent, in the charset its Content-Type names (GBK, Big5, Shift_JIS, ISO-8859-x). */
export function decodeText(bytes: Buffer, part: Part, what: "正文" | "附件"): string {
	const contentType = part.headers?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
	const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1];
	const utf8 = () => new TextDecoder("utf-8").decode(bytes);
	if (charset === undefined) return utf8();
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return `${utf8()}${UNKNOWN_CHARSET(what, charset.slice(0, 40))}`;
	}
}

const decode = (part: Part) => decodeText(Buffer.from(part.body?.data ?? "", "base64url"), part, "正文");

function bodyText(parts: readonly Part[]): string {
	const inline = parts.filter((p) => !p.filename && p.body?.data);
	const plain = inline.find((p) => p.mimeType === "text/plain");
	if (plain) return decode(plain);
	const html = inline.find((p) => p.mimeType === "text/html");
	if (html) return htmlToText(decode(html));
	return parts.some((p) => !p.filename && p.mimeType?.startsWith("text/") && p.body?.attachmentId) ? NOT_FETCHED : "";
}

export function messageRow(message: GmailMessage): MessageRow {
	const parts = partsOf(message.payload);
	const from = parseFrom(header(message, "From")) ?? { name: "", address: "" };
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
