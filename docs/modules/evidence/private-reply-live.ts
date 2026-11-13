/** node --import ./src/pi-runtime.mjs docs/modules/evidence/private-reply-live.ts [outDir] */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HEAD = resolve(import.meta.dirname, "../../..");
const USER = 42;
const NOTICE = "个人医疗健康 有新内容，请在网页上查看";
const [outDir = "/tmp/swarm-privreply/owner"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const { fakeModels, startHost } = await import(join(HEAD, "tests/e2e/harness.ts"));
const { FakeModel, fakeAgentEnv, on, openTicket, report, reply, worker } = await import(join(HEAD, "tests/e2e/fake-model.ts"));
const { FAKE_BOT_TOKEN, FakeTelegram } = await import(join(HEAD, "tests/helpers/fake-telegram.ts"));

const state = mkdtempSync(join(tmpdir(), "psa-pr-"));
cpSync(join(HEAD, "docs/modules/architecture/sample/personal-health"), join(state, "modules/personal-health"), { recursive: true });
const just = (args: string[]) => spawnSync("just", args, { cwd: HEAD, env: { ...process.env, PSA_STATE_DIR: state, PSA_SAY_WAIT_MS: "300" }, encoding: "utf8", timeout: 60_000 });
const rows = (sql: string) => {
	const path = join(state, "state.db");
	if (!existsSync(path)) return [];
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return db.prepare(sql).all() as Record<string, unknown>[];
	} finally {
		db.close();
	}
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function within(limitMs: number, ok: () => boolean): Promise<boolean> {
	for (const end = Date.now() + limitMs; Date.now() < end; await sleep(20)) if (ok()) return true;
	return ok();
}

const BRIEF = "记 CEA";
const AGAIN = "再记 CEA";
const answers = (asked: RegExp, text: string) => on(`回 ${text}`, asked, (c: string) => [reply(c, text)]);
const tg = await FakeTelegram.start();
const fake = await FakeModel.start({
	router: [
		answers(/^\[对话\][\s\S]*使用者：早上好/, "早上好，今天没有待办"),
		on("开任务", /^\[对话\][\s\S]*使用者：记 CEA/, (c: string) => {
			const open = openTicket(c, BRIEF);
			return [{ ...open, args: { decisions: (open.args.decisions as object[]).map((d) => ({ ...d, domain: "personal-health" })) } }, reply(c, "好，记 CEA")];
		}),
		on("再开任务", /^\[对话\][\s\S]*使用者：再记 CEA/, (c: string) => {
			const open = openTicket(c, AGAIN);
			return [{ ...open, args: { decisions: (open.args.decisions as object[]).map((d) => ({ ...d, domain: "personal-health" })) } }, reply(c, "好，再记 CEA")];
		}),
		...[1, 2].map(() => on("转述", /^\[Worker 汇报\]/, (c: string) => [reply(c, `转述：${c.split("\n")[1] ?? ""}`)])),
		...[1, 2, 3].map(() => answers(/^\[对话\][\s\S]*使用者：刚才的 CEA 是多少/, "记得：CEA 4.2 ng/mL")),
	],
	workers: [BRIEF, AGAIN].map((brief) =>
		worker(
			brief,
			on("写", /^\[任务说明\]/, () => [{ name: "data", args: { op: "write", collection: "lab-results", rows: [{ item: "CEA", value: 4.2, unit: "ng/mL", reference: "<5", takenAt: "2026-10-01", lab: "协和" }], from: "使用者口述" } }]),
			on("汇报", /^\[模块数据\]/, () => [report("ready", "CEA 4.2 ng/mL，比参考上限低")]),
		),
	),
});
writeFileSync(join(state, "secrets.env"), `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n`);
const host = await startHost({
	models: fakeModels,
	stateDir: state,
	logFile: join(state, "host.log"),
	config: { webPort: 0, secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } },
	env: { ...fakeAgentEnv(fake, join(state, "pi")), PSA_E2E_TELEGRAM_URL: tg.url },
	timeoutMs: 60_000,
	imports: ["./tests/e2e/telegram-preload.mjs"],
});
const phone = () => tg.sent.filter((m: { chatId: number }) => m.chatId === USER).map((m: { text: string }) => m.text as string);
const said = () => rows("SELECT text FROM reply_receipts ORDER BY created_at").map((r) => r.text as string);
const results: string[] = [];
const check = (name: string, pass: boolean, evidence: string) => {
	const file = join(outDir, `${name}.txt`);
	writeFileSync(file, `${pass ? "PASS" : "FAIL"} ${name}\n${evidence}\n`);
	results.push(`${pass ? "PASS" : "FAIL"}  ${name}  ${file}`);
};
try {
	just(["module", "on", "personal-health"]);
	await within(20_000, () => rows("SELECT record FROM module_records WHERE name = 'personal-health'").some((r) => String(r.record).includes('"at":"active"')));
	tg.userSays(USER, "/start");
	await within(10_000, () => phone().length > 0);

	just(["say", "早上好"]);
	await within(20_000, () => phone().includes("早上好，今天没有待办"));
	check("before-private", phone().includes("早上好，今天没有待办"), `Telegram recorder:\n${phone().join("\n")}`);

	just(["say", "记 CEA"]);
	await within(60_000, () => said().some((t) => t.startsWith("转述：CEA 4.2")));
	await within(10_000, () => phone().includes(NOTICE));
	just(["say", "刚才的 CEA 是多少？"]);
	await within(30_000, () => said().includes("记得：CEA 4.2 ng/mL"));
	const asked = () => phone().findIndex((m) => m.includes("刚才的 CEA 是多少"));
	await within(20_000, () => asked() >= 0 && phone().slice(asked()).includes(NOTICE));
	await sleep(1500);
	const touched = rows("SELECT touched_private_at FROM tickets").map((r) => r.touched_private_at);
	check(
		"chat-reply-after-private",
		asked() >= 0 && phone().slice(asked() + 1).join("\n") === NOTICE && !phone().some((m) => m.includes("4.2")) && said().includes("记得：CEA 4.2 ng/mL"),
		`tickets touched_private_at: ${JSON.stringify(touched)}\nTelegram recorder, whole chat:\n${phone().join("\n")}\nRouter replies the web page and TUI show:\n${said().join("\n")}`,
	);

	const sessionDir = join(state, "sessions", "router");
	const sessions = () => (existsSync(sessionDir) ? readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort() : []);
	const before = sessions();
	const cleared = await fetch(new URL(`/clear${host.url.search}`, host.url), { method: "POST", headers: { "content-type": "application/json", origin: host.url.origin }, body: "{}" });
	const mark = phone().length;
	just(["say", "刚才的 CEA 是多少？"]);
	await within(30_000, () => phone().slice(mark).includes("记得：CEA 4.2 ng/mL"));
	await within(10_000, () => sessions().length > before.length);
	const fresh = sessions().filter((f) => !before.includes(f));
	const freshText = fresh.map((f) => readFileSync(join(sessionDir, f), "utf8")).join("\n");
	check(
		"clear-restores-full-reply",
		cleared.status === 204 && phone().slice(mark).includes("记得：CEA 4.2 ng/mL"),
		`POST /clear: ${cleared.status}\nTelegram recorder after the clear:\n${phone().slice(mark).join("\n")}`,
	);
	check(
		"clear-fresh-router-session",
		fresh.length === 1 && !freshText.includes("早上好") && !freshText.includes("转述：CEA") && freshText.includes("刚才的 CEA 是多少"),
		`session files before: ${JSON.stringify(before)}\nnew after the clear: ${JSON.stringify(fresh)}\nnew file holds the old turns 早上好 / 转述：CEA: ${freshText.includes("早上好")} / ${freshText.includes("转述：CEA")}`,
	);

	const again = phone().length;
	just(["say", "再记 CEA"]);
	await within(60_000, () => said().filter((t) => t.startsWith("转述：CEA 4.2")).length === 2);
	await within(10_000, () => phone().slice(again).includes(NOTICE));
	just(["say", "刚才的 CEA 是多少？"]);
	await within(30_000, () => said().filter((t) => t === "记得：CEA 4.2 ng/mL").length === 3);
	const asked2 = () => phone().findLastIndex((m) => m.includes("刚才的 CEA 是多少"));
	await within(20_000, () => asked2() >= again && phone().length > asked2() + 1);
	await sleep(1500);
	check(
		"private-after-clear",
		asked2() >= again && phone().slice(asked2() + 1).join("\n") === NOTICE && !phone().slice(again).some((m) => m.includes("4.2")),
		`Telegram recorder after the second private task:\n${phone().slice(again).join("\n")}`,
	);
} finally {
	cpSync(join(state, "host.log"), join(outDir, "host.log"));
	await host.stop();
	await fake.close();
	await tg.close();
}
console.log(results.join("\n"));
