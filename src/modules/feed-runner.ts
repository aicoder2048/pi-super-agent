/** Saves the cursor last: a crash before the end repeats the call, and the ids make the repeat a no-op. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { everyMs } from "./connectors/timer.ts";
import type { FeedStates, ModuleRows } from "./instance-data.ts";
import type { CollectionDescriptor, Component, ComponentName, FeedDescriptor, FeedFixture, ModuleName } from "./manifest.ts";
import type { InstanceData } from "./registry.ts";
import type { Alert, Collected, FeedInput, Json, Row } from "./protocol.ts";
import { fill, release } from "./release.ts";
import { fixtureSecrets, LIMIT_MS, runModuleCodeAsync, secretsFor } from "./run-code.ts";

export type FeedEntry = { source: string; module: ModuleName; dir: string; name: ComponentName; feed: FeedDescriptor; fixtures: readonly FeedFixture[]; components: readonly Component[]; private: boolean };

/** `released`: `body` is the private feed's filled `line`, which the host also posts to the user and hands the Router as data that is not private. */
export type FeedNotice = { source: string; id: string; thread: string; body: string; at: number; reach: "shareable" | "private" | "released" };

export type FeedProblem = NonNullable<Collected["problem"]>;

export interface FeedPorts {
	data: ModuleRows & FeedStates & Pick<InstanceData, "dir">;
	submit(notice: FeedNotice): void;
	alert(module: ModuleName, alert: Alert): void;
	/** Every beat that ran, with what it reported, so the host can tell a new problem from one still standing. */
	problem(source: string, problem: FeedProblem | undefined): void;
	secret(name: string): string | undefined;
	now(): number;
	limitMs?: number;
}

export type FeedRun = { ok: true; records: number; notices: number } | { ok: false; note: string };

const READ_LIMIT = 500;

type JsonObject = { readonly [key: string]: Json };
const isObject = (value: Json | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const failed = (error: unknown) => (error instanceof Error ? error.message : String(error));

const itemId = (item: JsonObject) => (typeof item["id"] === "string" && item["id"] !== "" ? item["id"] : createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 16));

function fromItems(items: readonly Json[]): Collected | string {
	const objects = items.filter(isObject);
	if (objects.length !== items.length) return "每一项要是一个 JSON 对象";
	const records = objects.map((item) => ({ ...item, id: itemId(item) }));
	const notices = records.map(({ id, ...fields }) => ({ id, fields: Object.fromEntries(Object.entries(fields).flatMap(([k, v]) => (typeof v === "string" || typeof v === "number" ? [[k, String(v)]] : []))) }));
	return { records, notices };
}

export function parseCollected(output: Json, into?: CollectionDescriptor): Collected | string {
	if (!isObject(output)) return `要交回一个对象 { records, notices, cursor }，收到 ${JSON.stringify(output)}`;
	const { records = [], notices = [], cursor } = output;
	if (!Array.isArray(records) || !records.every((r) => isObject(r) && typeof r["id"] === "string")) return `records 要是一列带文字 id 的对象`;
	if (!Array.isArray(notices) || !notices.every((n) => isObject(n) && typeof n["id"] === "string" && isObject(n["fields"]) && Object.values(n["fields"]).every((v) => typeof v === "string") && (n["thread"] === undefined || typeof n["thread"] === "string"))) {
		return `notices 要是一列 { id, fields }，fields 的值都是文字`;
	}
	if (cursor !== undefined && typeof cursor !== "string") return `cursor 要是文字，收到 ${JSON.stringify(cursor)}`;
	const { problem } = output;
	if (problem !== undefined && !(isObject(problem) && typeof problem["id"] === "string" && typeof problem["text"] === "string")) return `problem 要是 { id, text }，两个都是文字`;
	if (into !== undefined) {
		const unknown = (records as JsonObject[]).flatMap((r) => Object.keys(r)).find((key) => key !== "id" && !Object.hasOwn(into.fields, key));
		if (unknown !== undefined) return `records 里的字段 "${unknown}" 不是 ${into.title} 的字段（有：${Object.keys(into.fields).join("、")}）`;
	}
	return output as Collected;
}

export const intoOf = (feed: Pick<FeedDescriptor, "into">, components: readonly Component[]): CollectionDescriptor | undefined =>
	components.find((c): c is Extract<Component, { kind: "data" }> => c.kind === "data" && c.name === feed.into)?.collection;

export type Held = { cursor: string | null; rows(collection: string): readonly Row[]; watchedKeys: readonly string[] };
export const NOTHING_HELD: Held = { cursor: null, rows: () => [], watchedKeys: [] };

export function feedInput(feed: FeedDescriptor, items: readonly Json[], held: Held, fixture?: FeedFixture): FeedInput {
	const given = fixture?.input ?? {};
	return {
		items,
		cursor: held.cursor,
		watchedKeys: held.watchedKeys,
		...given,
		settings: { ...feed.settings, ...(given["settings"] as object | undefined) },
		rows: { ...Object.fromEntries((feed.reads ?? []).map((c) => [c, held.rows(c)])), ...(given["rows"] as object | undefined) },
	} as FeedInput;
}

async function fromHandler({ module, source, feed, name, dir, components }: FeedEntry, handler: string, items: readonly Json[], ports: FeedPorts, fixture: FeedFixture | undefined, signal: AbortSignal | undefined): Promise<Collected | string> {
	const { data } = ports;
	const into = intoOf(feed, components);
	const watched = into?.watch === undefined ? [] : data.watch(module, components, { kind: "watch", collection: feed.into as ComponentName, op: "list" }, source).output;
	const input = feedInput(feed, items, {
		cursor: data.feedState(module, source).cursor,
		rows: (c) => data.query(module, components, c, { limit: READ_LIMIT }, source).rows,
		watchedKeys: "conditions" in watched ? [...new Set(watched.conditions.map((c) => c.key))] : [],
	}, fixture);
	const site = { packageDir: dir, component: join("feeds", name), dataDir: data.dir(module) };
	const limitMs = feed.limit === undefined ? (ports.limitMs ?? LIMIT_MS) : everyMs(feed.limit);
	const reply = await runModuleCodeAsync(site, handler, input, fixture ? fixtureSecrets(feed.secrets ?? []) : secretsFor(feed.secrets ?? [], ports.secret), { limitMs, ...(fixture && { responses: fixture.responses }), ...(signal && { signal }) });
	return reply.ok ? parseCollected(reply.output, into) : reply.note;
}

export async function runFeed(entry: FeedEntry, items: readonly Json[], ports: FeedPorts, fixture?: FeedFixture, signal?: AbortSignal): Promise<FeedRun> {
	const { module, source, feed, components } = entry;
	try {
		const collected = feed.handler === undefined ? fromItems((fixture?.input["items"] as Json[] | undefined) ?? items) : await fromHandler(entry, feed.handler, items, ports, fixture, signal);
		if (typeof collected === "string") return { ok: false, note: collected };
		const records = collected.records ?? [];
		let stored = 0;
		if (records.length > 0 && feed.into !== undefined) {
			const written = ports.data.write(module, components, feed.into, records, source, source, true);
			stored = written.rows.length;
			for (const alert of written.alerts) ports.alert(module, alert);
		}
		const template = feed.notice;
		const line = entry.private ? feed.line : undefined;
		const reach = line !== undefined ? "released" : entry.private ? "private" : "shareable";
		const notices = template === undefined ? [] : (collected.notices ?? []).map((n) => ({ ...n, body: line !== undefined ? release(line, n.fields) : fill(template, n.fields) }));
		for (const n of notices) ports.submit({ source, id: n.id, thread: n.thread ?? entry.name, body: n.body, at: ports.now(), reach });
		ports.problem(source, collected.problem);
		if (collected.cursor !== undefined) ports.data.saveFeedState(module, source, { cursor: collected.cursor });
		return { ok: true, records: stored, notices: notices.length };
	} catch (error) {
		return { ok: false, note: failed(error) };
	}
}
