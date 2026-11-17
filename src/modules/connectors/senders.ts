/**
 * Which senders a mail feed receives. `settings.senders` in feed.json is a list of addresses and `@domain`s, or the name of one
 * of the module's collections whose rows are the list (field `address`, optional `addedAt` and `removedAt`). The list rules repeat
 * the mail module's (docs/modules/examples/mail/senders.ts, which its draft-reply tool uses); tests hold both to the same answers.
 */
import { READ_LIMIT, type FeedProblem } from "../feed-runner.ts";
import { parseFrom } from "./letter.ts";

type SenderRow = { fields: { readonly [field: string]: unknown } };

export type MailFilter = { kind: "list"; senders: readonly string[] } | { kind: "collection"; collection: string };

/** Undefined when `settings.senders` is neither a non-empty list of texts nor a collection name; the package check says why. */
export function mailFilter(settings: Readonly<Record<string, unknown>> | undefined): MailFilter | undefined {
	const senders = settings?.["senders"];
	if (typeof senders === "string" && senders !== "") return { kind: "collection", collection: senders };
	if (Array.isArray(senders) && senders.length > 0 && senders.every((s) => typeof s === "string")) return { kind: "list", senders };
	return undefined;
}

/** The entries of a written list that receive nothing: a wildcard, or text that is neither an address nor an `@domain`. */
export const badSenders = (senders: readonly string[]): string[] => senders.filter((s) => senderKey(rowText(s)) === undefined);

/** The host reads at most this many rows of a collection (READ_LIMIT in feed-runner.ts). */
export const LIST_LIMIT = READ_LIMIT;

/** `blocked`: receive nothing this beat and say why. `open`: receive what `accepts` says, and still say `problem` when there is one. */
export type Gate = { kind: "blocked"; problem: FeedProblem } | { kind: "open"; accepts(address: string): boolean; problem?: FeedProblem };

/** `title` names the list in the problem texts: the collection's title, e.g. 邮件名单. */
export function senderGate(rows: readonly SenderRow[], now: number, title: string): Gate {
	if (rows.length >= LIST_LIMIT) return { kind: "blocked", problem: { id: "too-many", text: `${title}到了 ${LIST_LIMIT} 行，宿主一次只读 ${LIST_LIMIT} 行，划掉的地址可能读不到，所以先不收信。见 docs/modules/mail.md 的「名单太长」` } };
	const senders = senderList(rows, now);
	const wildcard = (texts: readonly string[]): FeedProblem => ({
		id: "wildcard",
		text: `${title}不认通配符，${texts.join("、")} 什么都不收。要收整个域名，写 ${texts[0]!.slice(texts[0]!.lastIndexOf("@"))} 这样的写法；请在对话里改那一行`,
	});
	if (![...senders.list.values()].includes(true)) {
		return { kind: "blocked", problem: senders.wildcards.length > 0 ? wildcard(senders.wildcards) : { id: "no-senders", text: `${title}是空的，什么都不收。在对话里说「把 a@example.com 加进${title}」` } };
	}
	// A removal row still unreadable wins over a wildcard: it holds letters back.
	const problem: FeedProblem | undefined =
		senders.unreadable.length > 0
			? { id: "removal-unreadable", text: `${title}里有一行划掉的地址读不出来，像它的发件人一律不收。请在对话里把那一行的地址改成 a@example.com 或 @example.com 这样的写法` }
			: senders.wildcards.length > 0
				? wildcard(senders.wildcards)
				: undefined;
	return { kind: "open", accepts: (address) => listed(senders, address), ...(problem && { problem }) };
}

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

