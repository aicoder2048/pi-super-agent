import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import test, { after } from "node:test";
import { FAKE_BOT_TOKEN, FakeTelegram } from "../helpers/fake-telegram.ts";
import { closeBrowser, story } from "./harness.ts";

after(closeBrowser);

const USER = 42;
const SHOTS = process.env.PSA_E2E_NOTIFY_SHOTS;

async function until(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
	for (const start = Date.now(); !predicate(); await new Promise((r) => setTimeout(r, 50))) {
		if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
	}
}

test("just notify：一条通知出现在网页对话里，标着「通知」；手机响一次「通知：」；幕僚长没被叫", async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	await story(
		t,
		{ router: [] },
		async ({ step, cli, fake }) => {
			await step("宿主外跑 just notify：网页出现「通知」那一行，手机收到一条响铃的消息，Router 一次请求都没有", async (page) => {
				tg.userSays(USER, "/start");
				await until(() => tg.sent.some((m) => m.chatId === USER), "Telegram 说明");
				const routerCalls = fake.exchanges.length;
				await cli(["src/cli/say.ts", "notify", "测试"]);
				const line = page.locator(".line.notice");
				await line.waitFor();
				assert.equal(await line.locator(".who").textContent(), "通知");
				assert.equal(await line.locator(".bubble").textContent(), "测试");
				await until(() => tg.sent.some((m) => m.text === "通知：测试"), "通知到达 Telegram");
				assert.deepEqual(tg.sent.filter((m) => m.text.includes("测试")).map((m) => [m.text, m.silent]), [["通知：测试", false]]);
				await page.waitForTimeout(1000);
				assert.equal(fake.exchanges.length, routerCalls, "Router 没被叫");
				if (SHOTS) {
					mkdirSync(SHOTS, { recursive: true });
					await page.screenshot({ path: `${SHOTS}/notify-web.png` });
					writeFileSync(`${SHOTS}/telegram-sent.json`, JSON.stringify(tg.sent, null, 2));
				}
			});
		},
		{
			imports: ["./tests/e2e/telegram-preload.mjs"],
			env: { PSA_E2E_TELEGRAM_URL: tg.url },
			files: { "secrets.env": `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n` },
			config: { secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] } },
		},
	);
});
