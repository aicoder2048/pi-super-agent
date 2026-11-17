import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Modules } from "../../src/modules.ts";
import { gmailAccount } from "../../src/modules/connectors/gmail.ts";
import { MailConnector } from "../../src/modules/connectors/mail.ts";
import type { FeedNotice, FeedPorts, FeedProblem } from "../../src/modules/feed-runner.ts";
import { instanceData } from "../../src/modules/instance-data.ts";
import { release } from "../../src/modules/release.ts";
import { servedAsHost } from "../helpers/fakes.ts";

const PKG = join(import.meta.dirname, "../../docs/modules/examples/mail");
const GOLDEN = join(import.meta.dirname, "../fixtures/mail-parity");
const NOW = Date.parse("2026-11-16T12:00:00.000Z");

type Golden = {
	given: { input: { cursor: string | null; rows: { senders: { fields: Record<string, unknown> }[] } }; responses: Record<string, unknown> };
	expected: { records: Record<string, unknown>[]; notices: { id: string; thread: string; fields: Record<string, string> }[]; problem: FeedProblem | null; historyId: string | null };
};

/** Answers by exact URL with status 200, the way the fixtures were replayed to the handler on main. */
const replay = (responses: Record<string, unknown>): typeof fetch =>
	(async (url: string | URL | Request) => {
		const key = String(url instanceof Request ? url.url : url);
		if (!Object.hasOwn(responses, key)) throw new Error(`the fixture has no response for ${key}`);
		return new Response(JSON.stringify(responses[key]), { headers: { "content-type": "application/json" } });
	}) as typeof fetch;

for (const file of readdirSync(GOLDEN).filter((f) => f.endsWith(".json"))) {
	test(`和 main 上的 inbox handler 逐条一致：${file}`, async (t) => {
		const { given, expected } = JSON.parse(readFileSync(join(GOLDEN, file), "utf8")) as Golden;
		const root = mkdtempSync(join(tmpdir(), "psa-parity-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		cpSync(PKG, join(root, "modules", "mail"), { recursive: true });
		const entry = servedAsHost(Modules.load([join(root, "modules")])).feeds().find((e) => e.source === "mail/inbox")!;
		const data = instanceData(join(root, "state"));
		const senders = given.input.rows.senders.map(({ fields }) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null)));
		if (senders.length > 0) data.write("mail", entry.components, "senders", senders, "使用者口述", "test");
		if (given.input.cursor !== null) data.saveFeedState("mail", "mail/inbox", { connectorCursor: given.input.cursor });
		const stored: Record<string, unknown>[] = [];
		const notices: FeedNotice[] = [];
		const problems: (FeedProblem | undefined)[] = [];
		const connectorProblems: (FeedProblem | undefined)[] = [];
		const ports: FeedPorts = {
			data: { ...data, write: (...args: Parameters<typeof data.write>) => (stored.push(...(args[3] as Record<string, unknown>[])), data.write(...args)) },
			submit: (n) => void notices.push(n),
			alert: () => true,
			badge: () => {},
			problem: (_, p) => void problems.push(p),
			connectorProblem: (_, __, p) => void connectorProblems.push(p),
			secret: () => undefined,
			now: () => NOW,
		};
		const mail = new MailConnector({ account: gmailAccount({ secret: () => "fixture", oauthUrl: undefined, fetch: replay(given.responses) }), rejectedDir: () => join(root, "rejected"), rejected: () => {} });
		const run = await mail.beat(entry, ports);
		assert.equal(run.ok, true, JSON.stringify(run));
		assert.deepEqual(stored, expected.records, "存的行一样");
		assert.deepEqual(notices.map((n) => ({ id: n.id, thread: n.thread, body: n.body })), expected.notices.map((n) => ({ id: n.id, thread: n.thread, body: release(entry.feed.line!, n.fields) })), "通知、线程、三行摘要一样");
		const problem = [problems.at(-1), connectorProblems.at(-1)].find((p) => p !== undefined) ?? null;
		assert.deepEqual(problem, expected.problem, "问题提示一样");
		const cursor = data.feedState("mail", "mail/inbox").connectorCursor;
		assert.equal(expected.historyId === null ? cursor === given.input.cursor : JSON.parse(cursor!).historyId === expected.historyId, true, `连接器进度 ${cursor}`);
	});
}
