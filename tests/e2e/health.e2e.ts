import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { FAKE_BOT_TOKEN, FakeTelegram } from "../helpers/fake-telegram.ts";
import { on, reply } from "./fake-model.ts";
import { closeBrowser, OUT, sayInPage, story, type StoryOptions } from "./harness.ts";

after(closeBrowser);

const USER = 42;
const RETRY_NOTICES = /^\[通知\] (上一轮没有处理完|刚才的一轮因模型错误中断|上面还有未处理的消息)/;
const SHOTS = join(OUT, "health-shots");
const routerLine = (page: Page, text: string) => page.locator(".line.router .bubble", { hasText: text });
const alarm = (page: Page, subject: string) => page.locator("#health .alarm", { has: page.locator(".subject", { hasText: subject }) });

async function until(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
	for (const start = Date.now(); !predicate(); await new Promise((r) => setTimeout(r, 100))) {
		if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
	}
}

async function shot(page: Page, name: string): Promise<void> {
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function phoneStory(tg: FakeTelegram): StoryOptions {
	return {
		imports: ["./tests/e2e/telegram-preload.mjs"],
		env: { PSA_E2E_TELEGRAM_URL: tg.url },
		files: { "secrets.env": `TELEGRAM_BOT_TOKEN=${FAKE_BOT_TOKEN}\n` },
		config: { secretsFile: "secrets.env", telegram: { allowedUserIds: [USER] }, retryAttempts: 0 },
	};
}

test("模型断了要看得见：幕僚长的模型 500、401、429 时，网页顶上的横幅和 Telegram 都说清楚；恢复后各说一次", { timeout: 180_000 }, async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const phone = () => tg.sent.filter((m) => m.chatId === USER).map((m) => m.text);
	await story(
		t,
		{
			router: [
				on("回答手机上的第一句", /^\[对话\][\s\S]*使用者：在吗/, (c) => [reply(c, "在。")]),
				on("恢复后回答断的时候说的话", /^\[对话\][\s\S]*使用者：断了吗/, (c) => [reply(c, "刚才断了一会儿。")]),
				on("恢复后回答", /^\[对话\][\s\S]*使用者：现在呢/, (c) => [reply(c, "恢复了。")]),
				on("换了密钥后回答", /^\[对话\][\s\S]*使用者：换了密钥/, (c) => [reply(c, "密钥好了。")]),
				on("回退模型回答", /^\[对话\][\s\S]*使用者：限流时/, (c) => [reply(c, "回退模型接上了。")]),
			],
			ignore: RETRY_NOTICES,
		},
		async ({ step, fake, host }) => {
			await step("手机上先说一句：Telegram 的聊天开了，网页上没有横幅", async (page) => {
				tg.userSays(USER, "在吗");
				await routerLine(page, "在。").waitFor();
				assert.equal(await page.locator("#health").isHidden(), true);
			});
			await step("幕僚长的模型一直回 500：第二次失败后横幅亮起，写着幕僚长模型、500 和怎么办；Telegram 收到一条 ⚠️", async (page) => {
				fake.fail("router", 500, "Internal Server Error: upstream exploded");
				await sayInPage(page, "断了吗");
				await alarm(page, "幕僚长模型").waitFor({ timeout: 30_000 });
				const text = await alarm(page, "幕僚长模型").innerText();
				assert.match(text, /500/);
				assert.match(text, /怎么办：/);
				assert.ok((fake.failed.get("router") ?? 0) >= 2, "横幅在第二次失败之后才亮");
				await until(() => phone().some((m) => m.startsWith("⚠️ 幕僚长模型")), "Telegram 的 ⚠️");
				await shot(page, "1-router-500");
			});
			await step("模型恢复：再说一句，幕僚长回答两句话，横幅变成「都恢复了」；Telegram 收到一条 ✅，⚠️ 没有重复", async (page) => {
				fake.heal("router");
				await sayInPage(page, "现在呢");
				await routerLine(page, "恢复了。").waitFor({ timeout: 30_000 });
				await routerLine(page, "刚才断了一会儿。").waitFor();
				await page.locator('#health[data-tone="ok"]').waitFor();
				assert.match(await page.locator("#health").innerText(), /幕僚长模型.*恢复/);
				await until(() => phone().some((m) => m.startsWith("✅ 幕僚长模型恢复了")), "Telegram 的 ✅");
				assert.equal(phone().filter((m) => m.startsWith("⚠️")).length, 1);
				await shot(page, "2-recovered");
			});
			await step("模型回 401：第一次失败就亮，怎么办里写着登录或密钥；修好后自动重试，回答到了", async (page) => {
				const before = fake.failed.get("router") ?? 0;
				fake.fail("router", 401, "Incorrect API key provided");
				await sayInPage(page, "换了密钥");
				await alarm(page, "幕僚长模型").waitFor({ timeout: 15_000 });
				assert.equal(fake.failed.get("router"), before + 1, "401 一次就亮");
				assert.match(await alarm(page, "幕僚长模型").innerText(), /登录|密钥/);
				await shot(page, "3-router-401");
				fake.heal("router");
				await routerLine(page, "密钥好了。").waitFor({ timeout: 30_000 });
				await until(() => phone().filter((m) => m.startsWith("✅ 幕僚长模型恢复了")).length === 2, "第二条 ✅");
			});
			await step("主模型回 429：切到回退模型，横幅写「主模型限流」和回退模型的名字，回退模型照常回答", async (page) => {
				fake.fail("router", 429, "Rate limit reached for requests");
				await sayInPage(page, "限流时");
				await routerLine(page, "回退模型接上了。").waitFor({ timeout: 30_000 });
				const text = await alarm(page, "主模型限流").innerText();
				assert.match(text, /psa-fake\/fallback/);
				await until(() => phone().some((m) => m.startsWith("⚠️ 幕僚长模型（主模型限流）")), "限流的 ⚠️");
				await shot(page, "4-router-429-fallback");
				assert.ok(!host.log().includes(FAKE_BOT_TOKEN.split(":")[1]), "日志里没有 bot token");
			});
		},
		phoneStory(tg),
	);
});

/** A data provider the probe feed polls: answers each GET with the status set now, or refuses connections once closed. */
async function fakeProvider() {
	let status = 200;
	let server: Server = createServer();
	const listen = (port: number) =>
		new Promise<number>((ready) => {
			server = createServer((_req, res) => res.writeHead(status, { "content-type": "application/json" }).end(status === 200 ? '{"price":1}' : `{"error":"status ${status}"}`));
			server.listen(port, "127.0.0.1", () => ready((server.address() as { port: number }).port));
		});
	const port = await listen(0);
	return {
		url: `http://127.0.0.1:${port}`,
		answer: (next: number) => void (status = next),
		down: () => new Promise<void>((done) => (server.closeAllConnections(), server.close(() => done()))),
		up: () => listen(port),
	};
}

const probeModule = (baseUrl: string): Record<string, string> => ({
	"modules/probe/module.json": JSON.stringify({ schema: 1, name: "probe", version: "0.1.0", title: "行情探针", description: "测试用：每两秒取一次假的行情接口" }),
	"modules/probe/data/ticks/collection.json": JSON.stringify({ title: "报价", kind: "record", class: "shareable", fields: { price: { type: "number", title: "价格" } } }),
	"modules/probe/feeds/quotes/feed.json": JSON.stringify({ title: "报价", handler: "index.ts", every: "2s", settings: { baseUrl }, into: "ticks" }),
	"modules/probe/feeds/quotes/index.ts": [
		"export default async function quotes(input: { settings: { baseUrl: string } }) {",
		"\tconst res = await fetch(`${input.settings.baseUrl}/v2/last`);",
		"\tif (!res.ok) throw new Error(`行情接口返回 HTTP ${res.status}`);",
		"\tconst body = (await res.json()) as { price: number };",
		"\treturn { records: [{ id: String(Date.now()), price: body.price }] };",
		"}",
		"",
	].join("\n"),
});

test("数据断了要看得见：来源的接口 503、401、连不上时横幅和 Telegram 都说；模型和数据都连不上时说本机可能断网", { timeout: 180_000 }, async (t) => {
	const tg = await FakeTelegram.start();
	t.after(() => tg.close());
	const provider = await fakeProvider();
	t.after(() => provider.down().catch(() => {}));
	const phone = () => tg.sent.filter((m) => m.chatId === USER).map((m) => m.text);
	const options = phoneStory(tg);
	await story(
		t,
		{
			router: [
				on("回答手机上的第一句", /^\[对话\][\s\S]*使用者：在吗/, (c) => [reply(c, "在。")]),
				on("断网恢复后回答", /^\[对话\][\s\S]*使用者：网好了吗/, (c) => [reply(c, "网好了。")]),
			],
			ignore: RETRY_NOTICES,
		},
		async ({ step, fake }) => {
			await step("手机上先说一句；探针取到报价，没有横幅", async (page) => {
				tg.userSays(USER, "在吗");
				await routerLine(page, "在。").waitFor();
				await page.waitForTimeout(2_500);
				assert.equal(await page.locator("#health").isHidden(), true);
			});
			await step("行情接口一直回 503：第三拍失败后横幅亮起，写着「行情探针 报价」和 503；Telegram 收到一条 ⚠️", async (page) => {
				provider.answer(503);
				await alarm(page, "行情探针 报价").waitFor({ timeout: 20_000 });
				const text = await alarm(page, "行情探针 报价").innerText();
				assert.match(text, /HTTP 503/);
				assert.match(text, /连着 3 次/);
				await until(() => phone().some((m) => m.startsWith("⚠️ 行情探针 报价")), "Telegram 的 ⚠️");
				await shot(page, "5-feed-503");
			});
			await step("接口恢复：下一拍成功，横幅变成「都恢复了」；Telegram 收到一条 ✅", async (page) => {
				provider.answer(200);
				await page.locator('#health[data-tone="ok"]').waitFor({ timeout: 10_000 });
				await until(() => phone().some((m) => m.startsWith("✅ 行情探针 报价恢复了")), "Telegram 的 ✅");
				await shot(page, "6-feed-recovered");
			});
			await step("接口回 401：第一拍就亮，怎么办里写着密钥", async (page) => {
				provider.answer(401);
				await alarm(page, "行情探针 报价").waitFor({ timeout: 10_000 });
				assert.match(await alarm(page, "行情探针 报价").innerText(), /连着 1 次[\s\S]*密钥/);
				await shot(page, "7-feed-401");
				provider.answer(200);
				await page.locator('#health[data-tone="ok"]').waitFor({ timeout: 10_000 });
			});
			await step("模型和接口都连不上：横幅上两处都亮，并说本机可能断网了；都恢复后横幅变绿", async (page) => {
				await provider.down();
				fake.fail("router", 503, "Connection error: connect ECONNREFUSED");
				await sayInPage(page, "网好了吗");
				await alarm(page, "行情探针 报价").waitFor({ timeout: 20_000 });
				await alarm(page, "幕僚长模型").waitFor({ timeout: 30_000 });
				assert.match(await page.locator("#health .offline").innerText(), /本机可能断网/);
				await shot(page, "8-offline");
				await provider.up();
				fake.heal("router");
				await routerLine(page, "网好了。").waitFor({ timeout: 40_000 });
				await page.locator('#health[data-tone="ok"]').waitFor({ timeout: 10_000 });
			});
		},
		{ ...options, files: { ...options.files, ...probeModule(provider.url) }, config: { ...options.config, modules: { probe: true } } },
	);
});
