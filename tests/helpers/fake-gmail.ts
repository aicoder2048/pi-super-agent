import type { RouteReply } from "./fake-google.ts";

export type Letter = {
	id: string;
	from: string;
	subject?: string;
	snippet?: string;
	text?: string;
	html?: string;
	/** The text/plain part as raw bytes in this charset, named in the part's Content-Type the way Gmail serves it. */
	encoded?: { charset: string; bytes: Uint8Array };
	/** A text/html part Gmail serves only by attachmentId, the way it does for a large body. */
	htmlByAttachment?: boolean;
	attachments?: readonly { filename: string; mimeType: string; size: number }[];
	replyTo?: string;
	at?: number;
};

const GMAIL = "/gmail/v1/users/me";
const b64 = (data: string | Uint8Array) => (typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)).toString("base64url");

function headers(letter: Letter) {
	return [
		{ name: "From", value: letter.from },
		{ name: "Subject", value: letter.subject ?? "(no subject)" },
		{ name: "Message-ID", value: `<${letter.id}@mail.example.com>` },
		...(letter.replyTo === undefined ? [] : [{ name: "Reply-To", value: letter.replyTo }]),
	];
}

export function gmailMessage(letter: Letter, format: "full" | "metadata" = "full") {
	const top = { id: letter.id, threadId: `t-${letter.id}`, labelIds: ["INBOX", "UNREAD"], snippet: letter.snippet ?? "", internalDate: String(letter.at ?? Date.now()) };
	if (format === "metadata") return { ...top, payload: { mimeType: "multipart/mixed", headers: headers(letter) } };
	type Body = { partId: string; mimeType: string; filename: string; headers: { name: string; value: string }[]; body: { size: number; data?: string; attachmentId?: string } };
	const bodies: Body[] = [
		...(letter.text === undefined ? [] : [{ mimeType: "text/plain", text: letter.text }]),
		...(letter.html === undefined ? [] : [{ mimeType: "text/html", text: letter.html }]),
	].map(({ mimeType, text }, i) => ({ partId: `0.${i}`, mimeType, filename: "", headers: [], body: { size: Buffer.byteLength(text), data: b64(text) } }));
	if (letter.encoded !== undefined) {
		const { charset, bytes } = letter.encoded;
		bodies.push({ partId: `0.${bodies.length}`, mimeType: "text/plain", filename: "", headers: [{ name: "Content-Type", value: `text/plain; charset="${charset}"` }], body: { size: bytes.length, data: b64(bytes) } });
	}
	if (letter.htmlByAttachment) bodies.push({ partId: `0.${bodies.length}`, mimeType: "text/html", filename: "", headers: [], body: { size: 900_000, attachmentId: `att-${letter.id}-html` } });
	const files = (letter.attachments ?? []).map((a, i) => ({ partId: String(i + 1), mimeType: a.mimeType, filename: a.filename, headers: [], body: { attachmentId: `att-${letter.id}-${i + 1}`, size: a.size } }));
	return {
		...top,
		payload: {
			partId: "",
			mimeType: "multipart/mixed",
			headers: headers(letter),
			body: { size: 0 },
			parts: [{ partId: "0", mimeType: "multipart/alternative", filename: "", headers: [], body: { size: 0 }, parts: bodies }, ...files],
		},
	};
}

/**
 * A Gmail inbox served through the fake Google server's `routes`: `deliver` adds letters as one history record,
 * `forget` makes every history id handed out so far answer 404, the way Gmail does once a cursor is too old.
 */
export class FakeInbox {
	readonly routes: Record<string, unknown> = {};
	readonly letters = new Map<string, Letter>();
	#history: { id: number; added: string[] }[] = [];
	#historyId = 1000;
	#oldest = 0;
	/** History records or list ids per page. */
	pageSize = 50;

	readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
		this.routes[`GET ${GMAIL}/profile`] = () => this.#ok({ emailAddress: "me@example.com", messagesTotal: this.letters.size, historyId: String(this.#historyId) });
		this.routes[`GET ${GMAIL}/history`] = (url: URL) => this.#historyPage(url);
		this.routes[`GET ${GMAIL}/messages`] = (url: URL) => this.#listPage(url);
	}

	get historyId(): string {
		return String(this.#historyId);
	}

	deliver(...letters: Letter[]): void {
		this.#historyId += 1;
		for (const letter of letters) {
			const at = letter.at ?? this.now();
			this.letters.set(letter.id, { ...letter, at });
			this.routes[`GET ${GMAIL}/messages/${letter.id}`] = (url: URL) => this.#ok(gmailMessage(this.letters.get(letter.id)!, url.searchParams.get("format") === "metadata" ? "metadata" : "full"));
		}
		this.#history.push({ id: this.#historyId, added: letters.map((l) => l.id) });
	}

	/** The letter is deleted in Gmail: every messages.get for it answers 404 from now on. */
	vanish(id: string): void {
		this.routes[`GET ${GMAIL}/messages/${id}`] = () => ({ status: 404, body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } } });
	}

	forget(): void {
		this.#oldest = this.#historyId + 1;
	}

	#ok = (body: unknown): RouteReply => ({ status: 200, body });

	#page<T>(items: readonly T[], url: URL): { items: T[]; next?: string } {
		const start = Number(url.searchParams.get("pageToken") ?? 0);
		const end = start + this.pageSize;
		return { items: items.slice(start, end), ...(end < items.length && { next: String(end) }) };
	}

	#historyPage(url: URL): RouteReply {
		const start = Number(url.searchParams.get("startHistoryId"));
		if (!(start >= this.#oldest)) return { status: 404, body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } } };
		const { items, next } = this.#page(this.#history.filter((h) => h.id > start), url);
		const history = items.map((h) => ({ id: String(h.id), messagesAdded: h.added.map((id) => ({ message: { id, threadId: `t-${id}`, labelIds: ["INBOX", "UNREAD"] } })) }));
		return this.#ok({ ...(history.length > 0 && { history }), historyId: String(this.#historyId), ...(next && { nextPageToken: next }) });
	}

	#listPage(url: URL): RouteReply {
		const days = Number(/newer_than:(\d+)d/.exec(url.searchParams.get("q") ?? "")?.[1] ?? Infinity);
		const recent = [...this.letters.values()].filter((l) => this.now() - l.at! <= days * 86_400_000).sort((a, b) => b.at! - a.at!);
		const { items, next } = this.#page(recent, url);
		return this.#ok({ ...(items.length > 0 && { messages: items.map((l) => ({ id: l.id, threadId: `t-${l.id}` })) }), resultSizeEstimate: items.length, ...(next && { nextPageToken: next }) });
	}
}
