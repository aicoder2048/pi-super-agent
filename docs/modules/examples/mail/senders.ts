/**
 * The mail list's rules, for the draft-reply tool: it replies only to a sender still on the list. The host's mail connector applies
 * the same rules when it filters letters (src/modules/connectors/senders.ts); module code cannot import the host's, and tests hold the two copies to the same answers.
 */
import { parseFrom } from "./feeds/inbox/message.ts";

export type SenderRow = { id: string; fields: { address?: unknown; addedAt?: unknown; removedAt?: unknown } };

const DOMAIN = /^@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const ISO = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** An address pasted from a chat can carry full-width forms or invisible characters that no From header has. */
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;
const rowText = (value: unknown) => String(value ?? "").normalize("NFKC").replace(ZERO_WIDTH, "").trim().toLowerCase();

/**
 * A row's address goes through the same parser as From, so `Ann <ann@example.com>` names ann; anything else is no row.
 * `*` is legal in an address but means a wildcard here, which the list does not support, so it is no row either.
 */
function senderKey(text: string): string | undefined {
	if (text.includes("*")) return undefined;
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
 * `unreadable` keeps the text of removal rows whose address does not parse, so a letter that looks like one is held back.
 * `wildcards` keeps the text of added rows written with `*`, so the beat can say why they receive nothing.
 */
type Senders = { list: Map<string, boolean>; unreadable: string[]; wildcards: string[] };

/**
 * Rows carry no write time, so a duplicate row cannot be told from a later re-add by its id. A removal on any row of an
 * address takes it off; only an unmarked row whose `addedAt` is after the latest removal puts it back. The answer per key
 * is listed or removed, and a removed address stays off even when its domain is listed.
 */
export function senderList(rows: readonly SenderRow[], now: number): Senders {
	const removed = new Map<string, number>();
	const added = new Map<string, number>();
	const unreadable: string[] = [];
	const wildcards: string[] = [];
	for (const row of rows) {
		const text = rowText(row.fields.address);
		const key = senderKey(text);
		if (key === undefined && row.fields.removedAt) unreadable.push(text);
		else if (key === undefined && text.includes("*")) wildcards.push(text);
		if (key === undefined) continue;
		const [into, at] = row.fields.removedAt ? [removed, removedUntil(row.fields.removedAt)] : [added, addedAt(row.fields.addedAt, now)];
		into.set(key, Math.max(into.get(key) ?? -Infinity, at));
	}
	const list = new Map([...removed.keys()].map((key) => [key, false]));
	for (const [key, at] of added) list.set(key, !removed.has(key) || at > removed.get(key)!);
	return { list, unreadable, wildcards };
}

export function listed({ list, unreadable }: Senders, address: string): boolean {
	const domain = address.slice(address.lastIndexOf("@"));
	if (unreadable.some((text) => text.includes(address) || text.includes(domain.slice(1)))) return false;
	return list.get(address) ?? list.get(domain) ?? false;
}

