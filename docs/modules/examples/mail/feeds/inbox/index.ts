import { header, messageRow, parseFrom, released, type GmailMessage, type MessageRow } from "./message.ts";

type SenderRow = { id: string; fields: { address?: unknown; addedAt?: unknown; removedAt?: unknown } };

interface Input {
	settings: { baseUrl: string; tokenUrl: string };
	cursor: string | null;
	rows: { senders?: SenderRow[] };
}

/** `at` is when the last beat succeeded, so a host that was off for a day can say so. */
type Cursor = { historyId: string; at: string };

type Problem = { id: "auth" | "gap" | "no-senders"; text: string };

type Reply = { records: MessageRow[]; notices?: { id: string; thread: string; fields: Record<string, string> }[]; cursor?: string; problem?: Problem };

const DAY_MS = 24 * 3_600_000;
const GMAIL = "/gmail/v1/users/me";
const AUTH: Problem = { id: "auth", text: "Gmail 授权失效了，在笔记本上重跑 just google-auth read，再把那一行复制到这台机器" };
const NO_SENDERS: Problem = { id: "no-senders", text: "邮件名单是空的，什么都不收。在对话里说「把 a@example.com 加进邮件名单」" };
const gap = (hours: number): Problem => ({ id: "gap", text: `有 ${hours} 小时没查，一天以前的信没补，请在 Gmail 里看一下` });

const DOMAIN = /^@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const ISO = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** A row's address goes through the same parser as From, so `Ann <ann@example.com>` names ann; anything else is no row. */
function senderKey(value: unknown): string | undefined {
	const text = String(value ?? "").trim().toLowerCase();
	return DOMAIN.test(text) ? text : parseFrom(text)?.address;
}

/**
 * The latest instant a removal could mean, so a doubtful removal is never undone by a re-add: a date alone ends once that
 * day is over everywhere (UTC-12), a time without a zone once it has passed everywhere (UTC-14), and an unreadable one never.
 */
function removedUntil(value: unknown): number {
	const [, date, clock, zone] = ISO.exec(String(value).trim()) ?? [];
	const at = Date.parse(clock === undefined ? `${date}T00:00:00Z` : `${date}${clock}${zone ?? "Z"}`);
	if (date === undefined || Number.isNaN(at)) return Infinity;
	return at + (clock === undefined ? 36 * 3_600_000 : zone === undefined ? 14 * 3_600_000 : 0);
}

/** Only an exact past instant counts as a re-add; a date alone, a missing zone or a time ahead of the clock does not. */
function addedAt(value: unknown, now: number): number {
	const [, date, clock, zone] = ISO.exec(String(value ?? "").trim()) ?? [];
	const at = date && clock && zone ? Date.parse(`${date}${clock}${zone}`) : NaN;
	return Number.isNaN(at) || at > now ? -Infinity : at;
}

/**
 * Rows carry no write time, so a duplicate row cannot be told from a later re-add by its id. A removal on any row of an
 * address takes it off; only an unmarked row whose `addedAt` is after the latest removal puts it back. The answer per key
 * is listed or removed, and a removed address stays off even when its domain is listed.
 */
function senderList(rows: readonly SenderRow[], now: number): Map<string, boolean> {
	const removed = new Map<string, number>();
	const added = new Map<string, number>();
	for (const row of rows) {
		const key = senderKey(row.fields.address);
		if (key === undefined) continue;
		const [into, at] = row.fields.removedAt ? [removed, removedUntil(row.fields.removedAt)] : [added, addedAt(row.fields.addedAt, now)];
		into.set(key, Math.max(into.get(key) ?? -Infinity, at));
	}
	const list = new Map([...removed.keys()].map((key) => [key, false]));
	for (const [key, at] of added) list.set(key, !removed.has(key) || at > removed.get(key)!);
	return list;
}

const listed = (senders: ReadonlyMap<string, boolean>, address: string) => senders.get(address) ?? senders.get(address.slice(address.lastIndexOf("@"))) ?? false;

function parseCursor(text: string | null): Cursor | undefined {
	if (text === null) return undefined;
	const value = JSON.parse(text);
	return typeof value?.historyId === "string" && typeof value?.at === "string" ? value : undefined;
}

async function accessToken(settings: Input["settings"]): Promise<string | undefined> {
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

type Gmail = (path: string, query: Record<string, string>) => Promise<{ status: number; body: any }>;

// Fixtures replay every body with status 200, and Gmail's error bodies carry the code too.
const gmailClient = (baseUrl: string, token: string): Gmail => async (path, query) => {
	const reply = await fetch(`${baseUrl}${GMAIL}${path}?${new URLSearchParams(query)}`, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, redirect: "error" });
	const body = await reply.json().catch(() => ({}));
	return { status: typeof body?.error?.code === "number" ? body.error.code : reply.status, body };
};

/** A letter deleted after history.list named it answers 404; it is gone for good, so the beat skips it rather than retrying forever. */
async function stillThere(gmail: Gmail, path: string, query: Record<string, string>): Promise<any | undefined> {
	const { status, body } = await gmail(path, query);
	if (status === 404) return undefined;
	if (status !== 200) throw new Error(`Gmail ${path} 返回 HTTP ${status}`);
	return body;
}

async function ok(gmail: Gmail, path: string, query: Record<string, string>): Promise<any> {
	const body = await stillThere(gmail, path, query);
	if (body === undefined) throw new Error(`Gmail ${path} 返回 HTTP 404`);
	return body;
}

async function sinceCursor(gmail: Gmail, start: string): Promise<{ ids: string[]; historyId: string } | undefined> {
	const ids: string[] = [];
	let pageToken = "";
	for (;;) {
		const { status, body } = await gmail("/history", { startHistoryId: start, historyTypes: "messageAdded", labelId: "INBOX", ...(pageToken && { pageToken }) });
		if (status === 404) return undefined;
		if (status !== 200) throw new Error(`Gmail /history 返回 HTTP ${status}`);
		for (const h of body.history ?? []) for (const added of h.messagesAdded ?? []) ids.push(added.message.id);
		if (!body.nextPageToken) return { ids, historyId: String(body.historyId) };
		pageToken = body.nextPageToken;
	}
}

/** The profile's historyId is read first, so mail arriving during the list shows up in the next beat's history. */
async function lastDay(gmail: Gmail): Promise<{ ids: string[]; historyId: string }> {
	const historyId = String((await ok(gmail, "/profile", {})).historyId);
	const ids: string[] = [];
	let pageToken = "";
	for (;;) {
		const body = await ok(gmail, "/messages", { q: "newer_than:1d", labelIds: "INBOX", ...(pageToken && { pageToken }) });
		for (const m of body.messages ?? []) ids.push(m.id);
		if (!body.nextPageToken) return { ids, historyId };
		pageToken = body.nextPageToken;
	}
}

export default async function inbox(input: Input): Promise<Reply> {
	const now = Date.now();
	const senders = senderList(input.rows.senders ?? [], now);
	if (![...senders.values()].includes(true)) return { records: [], problem: NO_SENDERS };
	const token = await accessToken(input.settings);
	if (token === undefined) return { records: [], problem: AUTH };
	const gmail = gmailClient(input.settings.baseUrl, token);
	const held = parseCursor(input.cursor);
	const away = held === undefined ? 0 : now - Date.parse(held.at);
	const recent = held !== undefined && away <= DAY_MS ? await sinceCursor(gmail, held.historyId) : undefined;
	const found = recent ?? (await lastDay(gmail));
	const records: MessageRow[] = [];
	for (const id of new Set(found.ids)) {
		const path = `/messages/${encodeURIComponent(id)}`;
		const meta: GmailMessage | undefined = await stillThere(gmail, path, { format: "metadata", metadataHeaders: "From" });
		const from = meta === undefined ? undefined : parseFrom(header(meta, "From"));
		if (from === undefined || !listed(senders, from.address)) continue;
		const full: GmailMessage | undefined = await stillThere(gmail, path, { format: "full" });
		if (full !== undefined) records.push(messageRow(full));
	}
	return {
		records,
		notices: records.map((row) => ({ id: row.id, thread: row.threadId || row.id, fields: released(row) })),
		cursor: JSON.stringify({ historyId: found.historyId, at: new Date(now).toISOString() } satisfies Cursor),
		...(away > DAY_MS && { problem: gap(Math.floor(away / 3_600_000)) }),
	};
}
