import { accessToken, AUTH_TEXT, gmailClient, type Gmail, type Settings } from "../../google.ts";
import { header, messageRow, parseFrom, released, type GmailMessage, type MessageRow } from "./message.ts";

export type SenderRow = { id: string; fields: { address?: unknown; addedAt?: unknown; removedAt?: unknown } };

interface Input {
	settings: Settings;
	cursor: string | null;
	now: string;
	rows: { senders?: SenderRow[] };
}

/** `at` is when the last beat succeeded, so a host that was off for a day can say so. */
type Cursor = { historyId: string; at: string };

/** `once`: the next beat no longer reports it, so it is a notice, not an alarm. */
type Problem = { id: "auth" | "gap" | "no-senders" | "too-many" | "removal-unreadable"; text: string; once?: true };

type Reply = { records: MessageRow[]; notices?: { id: string; thread: string; fields: Record<string, string> }[]; cursor?: string; problem?: Problem };

const DAY_MS = 24 * 3_600_000;
const AUTH: Problem = { id: "auth", text: AUTH_TEXT };
const NO_SENDERS: Problem = { id: "no-senders", text: "邮件名单是空的，什么都不收。在对话里说「把 a@example.com 加进邮件名单」" };
const TOO_MANY: Problem = { id: "too-many", text: "邮件名单到了 500 行，宿主一次只读 500 行，划掉的地址可能读不到，所以先不收信。见 docs/modules/mail.md 的「名单太长」" };
const REMOVAL_UNREADABLE: Problem = { id: "removal-unreadable", text: "邮件名单里有一行划掉的地址读不出来，像它的发件人一律不收。请在对话里把那一行的地址改成 a@example.com 或 @example.com 这样的写法" };
const gap = (hours: number): Problem => ({ id: "gap", text: `有 ${hours} 小时没查，一天以前的信没补，请在 Gmail 里看一下`, once: true });

/** The host reads at most this many rows of a collection (READ_LIMIT in src/modules/feed-runner.ts); a test keeps the two equal. */
const READ_LIMIT = 500;

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

/** `unreadable` keeps the text of removal rows whose address does not parse, so a letter that looks like one is held back. */
type Senders = { list: Map<string, boolean>; unreadable: string[] };

/**
 * Rows carry no write time, so a duplicate row cannot be told from a later re-add by its id. A removal on any row of an
 * address takes it off; only an unmarked row whose `addedAt` is after the latest removal puts it back. The answer per key
 * is listed or removed, and a removed address stays off even when its domain is listed.
 */
export function senderList(rows: readonly SenderRow[], now: number): Senders {
	const removed = new Map<string, number>();
	const added = new Map<string, number>();
	const unreadable: string[] = [];
	for (const row of rows) {
		const key = senderKey(row.fields.address);
		if (key === undefined && row.fields.removedAt) unreadable.push(String(row.fields.address ?? "").trim().toLowerCase());
		if (key === undefined) continue;
		const [into, at] = row.fields.removedAt ? [removed, removedUntil(row.fields.removedAt)] : [added, addedAt(row.fields.addedAt, now)];
		into.set(key, Math.max(into.get(key) ?? -Infinity, at));
	}
	const list = new Map([...removed.keys()].map((key) => [key, false]));
	for (const [key, at] of added) list.set(key, !removed.has(key) || at > removed.get(key)!);
	return { list, unreadable };
}

export function listed({ list, unreadable }: Senders, address: string): boolean {
	const domain = address.slice(address.lastIndexOf("@"));
	if (unreadable.some((text) => text.includes(address) || text.includes(domain.slice(1)))) return false;
	return list.get(address) ?? list.get(domain) ?? false;
}

function parseCursor(text: string | null): Cursor | undefined {
	if (text === null) return undefined;
	const value = JSON.parse(text);
	return typeof value?.historyId === "string" && typeof value?.at === "string" ? value : undefined;
}

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
	const now = Date.parse(input.now);
	const rows = input.rows.senders ?? [];
	if (rows.length >= READ_LIMIT) return { records: [], problem: TOO_MANY };
	const senders = senderList(rows, now);
	if (![...senders.list.values()].includes(true)) return { records: [], problem: NO_SENDERS };
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
		// A gap is said once and wins this beat; a removal row still unreadable is said again on the next one.
		...(senders.unreadable.length > 0 && { problem: REMOVAL_UNREADABLE }),
		...(away > DAY_MS && { problem: gap(Math.floor(away / 3_600_000)) }),
	};
}
