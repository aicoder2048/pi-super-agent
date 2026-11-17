/**
 * The host's mail connector: reads the user's Gmail inbox with the host's own authorization and hands each feed only the letters
 * its sender filter lets through, one letter per handler call. Each feed keeps two cursors (ADR-0029): `connectorCursor`, Gmail's
 * history position, which the handler never sees, and the handler's own `cursor`. The connector cursor moves only once every
 * letter of the batch was handled or rejected, so a failed or timed-out handler sees the same letters again on the next beat.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectFeed, type FeedEntry, type FeedPorts, type FeedProblem, type FeedRun } from "../feed-runner.ts";
import type { Row } from "../protocol.ts";
import { AUTH_TEXT, type Gmail, type GmailAccount } from "./gmail.ts";
import { header, letterOf, parseFrom, type GmailMessage, type Letter } from "./letter.ts";
import type { ModuleRows } from "../instance-data.ts";
import type { CollectionDescriptor, FeedDescriptor } from "../manifest.ts";
import { badSenders, LIST_LIMIT, mailFilter, senderGate, type Gate } from "./senders.ts";

/** `at` is when the last beat succeeded, so a host that was off for a day can say so. */
export type MailCursor = { historyId: string; at: string };

const DAY_MS = 24 * 3_600_000;
const TRIES = 3;
const FETCH_MS = 60_000;
const AUTH: FeedProblem = { id: "auth", text: AUTH_TEXT };
const gap = (hours: number): FeedProblem => ({ id: "gap", text: `有 ${hours} 小时没查，一天以前的信没补，请在 Gmail 里看一下`, once: true });

function parseCursor(text: string | null): MailCursor | undefined {
	if (text === null) return undefined;
	const value = JSON.parse(text);
	return typeof value?.historyId === "string" && typeof value?.at === "string" ? value : undefined;
}

/** A letter deleted after history.list named it answers 404; it is gone for good, so the beat skips it rather than retrying forever. */
async function stillThere(gmail: Gmail, path: string, query: Record<string, string>, signal?: AbortSignal): Promise<any | undefined> {
	const { status, body } = await gmail(path, query, signal);
	if (status === 404) return undefined;
	if (status !== 200) throw new Error(`Gmail ${path} 返回 HTTP ${status}`);
	return body;
}

async function ok(gmail: Gmail, path: string, query: Record<string, string>, signal?: AbortSignal): Promise<any> {
	const body = await stillThere(gmail, path, query, signal);
	if (body === undefined) throw new Error(`Gmail ${path} 返回 HTTP 404`);
	return body;
}

async function sinceCursor(gmail: Gmail, start: string, signal?: AbortSignal): Promise<{ ids: string[]; historyId: string } | undefined> {
	const ids: string[] = [];
	let pageToken = "";
	for (;;) {
		const { status, body } = await gmail("/history", { startHistoryId: start, historyTypes: "messageAdded", labelId: "INBOX", ...(pageToken && { pageToken }) }, signal);
		if (status === 404) return undefined;
		if (status !== 200) throw new Error(`Gmail /history 返回 HTTP ${status}`);
		for (const h of body.history ?? []) for (const added of h.messagesAdded ?? []) ids.push(added.message.id);
		if (!body.nextPageToken) return { ids, historyId: String(body.historyId) };
		pageToken = body.nextPageToken;
	}
}

/** The profile's historyId is read first, so mail arriving during the list shows up in the next beat's history. */
async function lastDay(gmail: Gmail, signal?: AbortSignal): Promise<{ ids: string[]; historyId: string }> {
	const historyId = String((await ok(gmail, "/profile", {}, signal)).historyId);
	const ids: string[] = [];
	let pageToken = "";
	for (;;) {
		const body = await ok(gmail, "/messages", { q: "newer_than:1d", labelIds: "INBOX", ...(pageToken && { pageToken }) }, signal);
		for (const m of body.messages ?? []) ids.push(m.id);
		if (!body.nextPageToken) return { ids, historyId };
		pageToken = body.nextPageToken;
	}
}

/** Letters from a sender the gate refuses are read as metadata only: their body never leaves Gmail. */
export async function fetchLetters(gmail: Gmail, held: MailCursor | undefined, now: number, accepts: (address: string) => boolean, signal?: AbortSignal): Promise<{ letters: Letter[]; next: MailCursor; awayHours?: number }> {
	const away = held === undefined ? 0 : now - Date.parse(held.at);
	const recent = held !== undefined && away <= DAY_MS ? await sinceCursor(gmail, held.historyId, signal) : undefined;
	const found = recent ?? (await lastDay(gmail, signal));
	const letters: Letter[] = [];
	for (const id of new Set(found.ids)) {
		const path = `/messages/${encodeURIComponent(id)}`;
		const meta: GmailMessage | undefined = await stillThere(gmail, path, { format: "metadata", metadataHeaders: "From" }, signal);
		const from = meta === undefined ? undefined : parseFrom(header(meta, "From"));
		if (from === undefined || !accepts(from.address)) continue;
		const full: GmailMessage | undefined = await stillThere(gmail, path, { format: "full" }, signal);
		if (full !== undefined) letters.push(letterOf(full, from));
	}
	return { letters, next: { historyId: found.historyId, at: new Date(now).toISOString() }, ...(away > DAY_MS && { awayHours: Math.floor(away / 3_600_000) }) };
}

/**
 * What the package check says about a feed on this connector. The handler builds the triggers (threads, sender, clipping), the
 * scheduler runs a feed only on its `every`, and a letter is the user's private mail, so its rows go only into a private collection.
 */
export function mailFeedProblems(feed: FeedDescriptor, collections: ReadonlyMap<string, CollectionDescriptor>): string[] {
	const problems: string[] = [];
	if (feed.handler === undefined) problems.push(`a feed on the mail connector needs "handler": it turns each letter into rows and triggers`);
	if (feed.every === undefined) problems.push(`a feed on the mail connector needs "every", e.g. "5m": without it the feed never runs`);
	if (feed.into === undefined || collections.get(feed.into)?.class !== "private") problems.push(`a feed on the mail connector must write into a private collection: letters are the user's private mail`);
	const filter = mailFilter(feed.settings);
	if (filter === undefined) problems.push(`a feed on the mail connector needs "settings.senders": a non-empty list of addresses and @domains, or the name of a collection of this module that holds the list`);
	else if (filter.kind === "list" && badSenders(filter.senders).length > 0) problems.push(`settings.senders: ${badSenders(filter.senders).join("、")} receive nothing; write an address such as a@example.com or a domain such as @example.com, no wildcards`);
	else if (filter.kind === "collection" && !collections.has(filter.collection)) problems.push(`settings.senders names collection "${filter.collection}", but there is no data/${filter.collection}`);
	else if (filter.kind === "collection" && collections.get(filter.collection)!.fields["address"]?.type !== "text") problems.push(`settings.senders names collection "${filter.collection}", which needs a text field "address" (optional date fields "addedAt" and "removedAt")`);
	return problems;
}

/** Who a feed receives now: its `settings.senders`, a written list or the rows of one of its module's collections. */
export function gateOf({ module, feed, components, source }: Pick<FeedEntry, "module" | "feed" | "components" | "source">, rows: Pick<ModuleRows, "query">, now: number): Gate {
	const filter = mailFilter(feed.settings);
	if (filter === undefined) return { kind: "blocked", problem: { id: "no-senders", text: "feed.json 的 settings.senders 没写对，什么都不收" } };
	if (filter.kind === "list") return senderGate(filter.senders.map((address) => ({ fields: { address } })), now, "发件人名单");
	const read = rows.query(module, components, filter.collection, { limit: LIST_LIMIT }, source);
	const named = components.find((c) => c.kind === "data" && c.name === filter.collection);
	return senderGate(read.rows as readonly Row[], now, named?.kind === "data" ? named.collection.title : filter.collection);
}

/** What one feed's batch has gone through since its connector cursor last moved. Lost on a restart, like the inbox connector's tries. */
type Batch = { tries: Map<string, number>; done: Set<string> };

export type MailOptions = {
	account: GmailAccount;
	/** Where a rejected letter's record goes: its ids, sender, subject and the handler's error, which may quote the letter, so it stays local. */
	rejectedDir(entry: FeedEntry): string;
	/** Gets no error text, so what it posts cannot quote the letter. */
	rejected(entry: FeedEntry, gmailId: string, tries: number): void;
	/** How long the connector waits for Gmail in one beat, before any handler runs. Default one minute. */
	fetchMs?: number;
};

export class MailConnector {
	readonly #o: MailOptions;
	readonly #batches = new Map<string, Batch>();

	constructor(options: MailOptions) {
		this.#o = options;
	}

	#reject(entry: FeedEntry, letter: Letter, note: string, tries: number): void {
		const dir = this.#o.rejectedDir(entry);
		mkdirSync(dir, { recursive: true });
		const record = { gmailId: letter.id, threadId: letter.threadId, from: letter.from.address, subject: letter.subject, note, tries };
		writeFileSync(join(dir, `${encodeURIComponent(letter.id)}.json`), `${JSON.stringify(record, null, 2)}\n`);
		this.#o.rejected(entry, letter.id, tries);
	}

	async beat(entry: FeedEntry, ports: FeedPorts, signal?: AbortSignal): Promise<FeedRun> {
		const { module, source } = entry;
		try {
			const now = ports.now();
			const gate = gateOf(entry, ports.data, now);
			if (gate.kind === "blocked") {
				ports.problem(source, gate.problem);
				return { ok: true, records: 0, notices: 0 };
			}
			const limit = AbortSignal.timeout(this.#o.fetchMs ?? FETCH_MS);
			const fetching = signal === undefined ? limit : AbortSignal.any([signal, limit]);
			const gmail = await this.#o.account.open(fetching);
			if (gmail === undefined) {
				ports.connectorProblem?.("mail", source, AUTH);
				ports.problem(source, gate.problem);
				return { ok: true, records: 0, notices: 0 };
			}
			ports.connectorProblem?.("mail", source, undefined);
			const held = parseCursor(ports.data.feedState(module, source).connectorCursor);
			const { letters, next, awayHours } = await fetchLetters(gmail, held, now, gate.accepts, fetching);
			if (awayHours !== undefined) ports.connectorProblem?.("mail", source, gap(awayHours));
			const batch = this.#batches.get(source) ?? { tries: new Map(), done: new Set() };
			this.#batches.set(source, batch);
			let failed: string | undefined;
			let problem = gate.problem;
			let records = 0;
			let notices = 0;
			for (const letter of letters) {
				if (batch.done.has(letter.id)) continue;
				const { run, problem: reported } = await collectFeed(entry, [letter], ports, undefined, signal);
				if (signal?.aborted) return { ok: false, note: "宿主停下了这一拍" };
				if (run.ok) {
					batch.done.add(letter.id);
					records += run.records;
					notices += run.notices;
					problem ??= reported;
					continue;
				}
				const tries = (batch.tries.get(letter.id) ?? 0) + 1;
				batch.tries.set(letter.id, tries);
				if (tries < TRIES) failed ??= run.note;
				else {
					batch.done.add(letter.id);
					this.#reject(entry, letter, run.note, tries);
				}
			}
			if (failed !== undefined) return { ok: false, note: failed };
			ports.data.saveFeedState(module, source, { connectorCursor: JSON.stringify(next) });
			this.#batches.delete(source);
			ports.problem(source, problem);
			return { ok: true, records, notices };
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError") return { ok: false, note: `Gmail ${(this.#o.fetchMs ?? FETCH_MS) / 1000} 秒内没回完话，下一拍重取` };
			return { ok: false, note: error instanceof Error ? error.message : String(error) };
		}
	}
}
