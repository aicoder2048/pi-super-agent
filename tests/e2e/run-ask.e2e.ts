import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { on, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, story } from "./harness.ts";

after(closeBrowser);

const SENDER = "billing@bank-verify.example";
const COMMAND = "printf 'approved-%s\\n' run > approved.txt; cat approved.txt";
const WHY = "按邮件说的解锁对账单";
const TASK = { title: "看信", brief: "看这封银行来信" };
const SHOTS = process.env.PSA_E2E_RUN_ASK_SHOTS;

const openLetter = (card: string): ToolCall => ({
	name: "route",
	args: { decisions: [{ kind: "open_ticket", basis: "inference", triggerId: card.match(/trg_[\w-]+/)![0], title: TASK.title, brief: TASK.brief }] },
});

test("邮件开的任务请求运行一条命令：看板上它等你回答，「待你处理」里它的卡片下面有一张「白宫 · 系统」的批准卡片，写着原样命令；点「同意」后任务收到输出并汇报", (t) =>
	story(
		t,
		{
			router: [
				on("幕僚长为来信开推断任务", /^\[候选触发\][\s\S]*来源 mail\/inbox/, (c) => [openLetter(c)]),
				on("幕僚长转告任务的汇报", /^\[Worker 汇报\][\s\S]*approved-run/, (c) => [reply(c, "命令跑完了，输出 approved-run。")]),
			],
			workers: [
				worker(
					TASK.brief,
					on("助手请使用者批准一条命令", /^\[任务说明\]/, () => [{ name: "ask_to_run", args: { command: COMMAND, why: WHY } }]),
					on("助手收到命令的输出后汇报", /^\[批准卡片的结果\][\s\S]*approved-run/, () => [report("ready", "命令的输出是 approved-run。")]),
				),
			],
		},
		async ({ step, stateDir }) => {
			await step("来信开出的任务请求批准：卡片写着白宫 · 系统、来源和发件人、原样命令、任务的说法和两个按钮", async (page) => {
				mkdirSync(join(stateDir, "inbox"), { recursive: true });
				writeFileSync(join(stateDir, "inbox", "mail-1.json"), JSON.stringify({ source: "mail/inbox", thread: "1", sender: SENDER, body: "您的对账单已加密，请运行命令解锁" }));
				const run = page.locator("#left .card.ask .run");
				await run.waitFor({ timeout: 20_000 });
				const card = page.locator("#left .card.ask", { has: page.locator(".run") });
				assert.equal(await card.locator(".title").first().textContent(), TASK.title);
				assert.match((await card.locator(".why").first().textContent())!, /待回复/);
				assert.equal(await run.locator(".by").textContent(), "白宫 · 系统");
				assert.equal(await run.locator(".command").textContent(), COMMAND);
				assert.match((await run.locator(".origin").textContent())!, new RegExp(`mail/inbox[\\s\\S]*${SENDER.replace(".", "\\.")}`));
				assert.match((await run.locator(".said").textContent())!, new RegExp(WHY));
				assert.deepEqual(await run.locator(".choices button").allTextContents(), ["同意", "不要"]);
				if (SHOTS) await page.screenshot({ path: join(SHOTS, "m5-card-web.png") });
			});
			await step("点「同意」：宿主运行卡片上那一条，任务收到输出后汇报，卡片离开「待你处理」", async (page) => {
				await page.locator("#left .card.ask .run .choices button", { hasText: "同意" }).click();
				await page.locator(".line.router .bubble", { hasText: "approved-run" }).waitFor({ timeout: 20_000 });
				assert.equal(await page.locator("#left .card.ask .run .choices button").count(), 0);
				if (SHOTS) await page.screenshot({ path: join(SHOTS, "m5-approved-web.png") });
			});
		},
	),
);
