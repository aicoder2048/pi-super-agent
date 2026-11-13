/**
 * node --import ./src/pi-runtime.mjs docs/modules/evidence/m3-perf.ts <trunk checkout> [outFile]
 * The two hosts run side by side in this process and take the notices in turn.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const [trunk, outFile = "/tmp/swarm-m3/owner/m3-perf.txt"] = process.argv.slice(2);
if (!trunk) throw new Error("用法：m3-perf.ts <trunk 的检出目录> [outFile]");
const ROUNDS = Number(process.env.ROUNDS ?? 20);
const USER = 42;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const query = (path: string, sql: string, ...args: (string | number)[]) => {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(sql).all(...args) as Record<string, unknown>[];
	} finally {
		db.close();
	}
};

async function start(repo: string, label: string) {
	const { Host } = await import(join(repo, "src/host/host.ts"));
	const { BotApi, BotToken } = await import(join(repo, "src/host/telegram/bot-api.ts"));
	const { Modules } = await import(join(repo, "src/modules.ts"));
	const { fauxRouter, FakeSpawner, servedAsHost } = await import(join(repo, "tests/helpers/fakes.ts"));
	const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));
	const root = mkdtempSync(`/tmp/m3s/p-${label}-`);
	const pkg = join(root, "modules/private-line");
	cpSync(join(HEAD, "tests/fixtures/modules/private-line"), pkg, { recursive: true });
	const feed = JSON.parse(readFileSync(join(pkg, "feeds/inbox/feed.json"), "utf8"));
	if (label === "trunk") delete feed.line;
	writeFileSync(join(pkg, "feeds/inbox/feed.json"), JSON.stringify(feed));
	const handler = join(pkg, "feeds/inbox/index.ts");
	writeFileSync(handler, readFileSync(handler, "utf8").replace("=> ({ id, from, subject, snippet, body }))", "=> ({ id, from, subject, snippet, body: `${body} handed:${Date.now()}` }))"));
	const modules = servedAsHost(Modules.load([join(root, "modules")]));
	const tg = await FakeTelegram.start();
	const stateDir = join(root, "state");
	const host = await Host.start({
		stateDir,
		createRouter: fauxRouter(() => []).createRouter,
		createSpawner: () => new FakeSpawner(() => {}),
		log: (line: string) => line.startsWith("[feeds]") && line.includes("失败") && console.error(line),
		domains: { book: () => modules.book, kitFor: () => undefined },
		moduleFeeds: { feeds: () => modules.feeds(), fixtures: false, tickMs: 5 },
		telegram: { api: new BotApi({ token: new BotToken(FAKE_BOT_TOKEN, "测试"), baseUrl: tg.url }), allowedUserIds: new Set([USER]), timing: { pollTimeoutSec: 1, minGapMs: 5 } },
	});
	tg.userSays(USER, "/start");
	for (const end = Date.now() + 10_000; tg.sent.length === 0 && Date.now() < end; ) await sleep(20);
	const inbox = join(stateDir, "inbox/private-line/inbox");
	const measure = async (id: string) => {
		mkdirSync(inbox, { recursive: true });
		writeFileSync(join(inbox, `${id}.json`), JSON.stringify({ id, from: "Ann <ann@example.com>", subject: `第 ${id} 封`, snippet: "开头一句", body: "正文" }));
		const written = () => query(join(stateDir, "state.db"), "SELECT id, received_at FROM triggers WHERE external_id = ?", id)[0];
		for (const end = Date.now() + 15_000; !written() && Date.now() < end; ) await sleep(5);
		await sleep(50);
		const data = join(stateDir, "modules-data/private-line/data.db");
		const table = query(data, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%messages%'")[0]!.name as string;
		const handed = Number(/handed:(\d+)/.exec(String(query(data, `SELECT body FROM "${table}" WHERE subject = ?`, `第 ${id} 封`)[0]?.body))?.[1]);
		const line = query(join(stateDir, "state.db"), "SELECT id FROM host_lines WHERE source = 'private-line/inbox' AND text LIKE ?", `%第 ${id} 封%`)[0];
		const outbox = line && query(join(stateDir, "state.db"), "SELECT created_at FROM telegram_messages WHERE key = ?", `notice:${line.id}`)[0];
		return { trigger: Number(written()!.received_at) - handed, outbox: outbox ? Number(outbox.created_at) - Number(written()!.received_at) : null };
	};
	const stop = async () => {
		await host.stop();
		await tg.close();
		if (!process.env.KEEP) rmSync(root, { recursive: true, force: true });
	};
	return { measure, stop };
}

mkdirSync("/tmp/m3s", { recursive: true });
const sides = { trunk: await start(trunk, "trunk"), head: await start(HEAD, "head") };
const runs: Record<"trunk" | "head", { trigger: number; outbox: number | null }[]> = { trunk: [], head: [] };
try {
	for (let i = 0; i < ROUNDS; i++) for (const label of ["trunk", "head"] as const) runs[label].push(await sides[label].measure(`${label}-${i}`));
} finally {
	await sides.trunk.stop();
	await sides.head.stop();
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const stats = (xs: number[]) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs) });
const trigger = { trunk: stats(runs.trunk.map((r) => r.trigger)), head: stats(runs.head.map((r) => r.trigger)) };
const outbox = runs.head.map((r) => r.outbox ?? Number.POSITIVE_INFINITY);
const pass = trigger.head.median - trigger.trunk.median <= 10 && Math.max(...outbox) <= 50;
const text = `${pass ? "PASS" : "FAIL"} m3-perf
rounds: ${ROUNDS} per side, alternating
handed back -> trigger written (ms): trunk ${JSON.stringify(trigger.trunk)}, head ${JSON.stringify(trigger.head)}
head trigger + host line written -> Telegram outbox row (ms): ${JSON.stringify(stats(outbox))}
rule: head median at most 10 ms slower than trunk, every outbox gap at most 50 ms
raw: ${JSON.stringify(runs)}
`;
writeFileSync(outFile, text);
console.log(text);
