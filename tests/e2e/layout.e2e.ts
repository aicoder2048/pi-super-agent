import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { fakeAgentEnv, on, openTicket, reply, report, worker, type Script, type ToolCall } from "./fake-model.ts";
import { REPO, closeBrowser, contrastOf, fakeModels, packageFiles, sayInPage, startHost, story } from "./harness.ts";

after(closeBrowser);

const SHOTS = process.env.PSA_LD_SHOTS ?? join(REPO, "tests/e2e/.out/ld1");
mkdirSync(SHOTS, { recursive: true });
const STOCK_TA = join(REPO, "docs/modules/examples/stock-ta");

const FILES = {
	...packageFiles(STOCK_TA, "stock-ta"),
	"modules/alerts/module.json": JSON.stringify({ name: "alerts", sources: [{ name: "e2e-alerts", feed: { kind: "e2e-alerts" } }] }),
};

const WEATHER = { title: "查天气", brief: "查天气任务", city: "上海市浦东新区陆家嘴" };
const DIGEST = { title: "今日新闻摘要", brief: "整理今天的新闻摘要" };
const NEWS = { title: "听证会新闻", brief: "汇总黄仁勋听证会的新闻" };

const handOverTo = (title: string) => (card: string): ToolCall[] => {
	const ticketId = card.match(new RegExp(`(tkt_[\\w-]+)「${title}」`))?.[1];
	return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: card.match(/trg_[\w-]+/)?.[0], ticketId }] } }];
};

const weatherRouter = () => [
	on("Router 开任务查天气", /^\[对话\][\s\S]*使用者：查天气/, (c) => [openTicket(c, WEATHER.title, WEATHER.brief), reply(c, "好的，去查了。")]),
	on("Router 把助手的问题转给使用者", /^\[Worker 提问\][\s\S]*查哪个城市/, (c) => [reply(c, "查哪个城市？")]),
	on("Router 把点选转交给任务", new RegExp(`^\\[对话\\][\\s\\S]*回答任务「查天气」：${WEATHER.city}`), handOverTo(WEATHER.title)),
];
const askCity = () => on("助手问城市", /^\[任务说明\]/, () => [{ name: "report", args: { status: "blocked", summary: "要你定", question: "查哪个城市？", options: ["北京市朝阳区望京街道", WEATHER.city] } }]);
const gotCity = (answer: ToolCall) => on("助手收到回答", new RegExp(`^\\[使用者的话[\\s\\S]*${WEATHER.city}`), () => [answer]);

const SCRIPT = (): Script => ({
	router: [
		on("Router 开摘要任务", /^\[对话\][\s\S]*摘要/, (c) => [openTicket(c, DIGEST.title, DIGEST.brief), reply(c, "已安排")]),
		on("Router 转告摘要", /^\[Worker 汇报\][\s\S]*今天没有大新闻/, (c) => [reply(c, "今天没有大新闻")]),
		on("Router 开听证会任务", /^\[对话\][\s\S]*听证会/, (c) => [openTicket(c, NEWS.title, NEWS.brief), reply(c, "已安排")]),
		...weatherRouter(),
		on("Router 转述天气", /^\[Worker 汇报\][\s\S]*陆家嘴晴/, (c) => [reply(c, "陆家嘴晴，26 度。")]),
	],
	workers: [
		worker(DIGEST.brief, on("摘要做完", /^\[任务说明\]/, () => [report("ready", "今天没有大新闻")])),
		worker(NEWS.brief, on("听证会进展", /^\[任务说明\]/, () => [report("progress", "找到三条新闻")])),
		worker(WEATHER.brief, askCity(), gotCity(report("ready", "陆家嘴晴，26 度。"))),
	],
});

const tab = (page: Page, key: string) => page.locator(`#tab-${key}`);
const selectedTab = (page: Page) => page.locator('.tab[aria-selected="true"]').getAttribute("data-tab");
const tabKeys = (page: Page) => page.locator("#tabs .tab").evaluateAll((tabs) => tabs.map((t) => (t as HTMLElement).dataset.tab));
const count = async (page: Page, key: string) => Number(await tab(page, key).locator(".count").textContent());
const leftCard = (page: Page, title: string) => page.locator("#left .card", { hasText: title });
const shot = (page: Page, file: string) => page.screenshot({ path: join(SHOTS, file) });

async function setUp(page: Page): Promise<void> {
	await sayInPage(page, "整理一份今日新闻摘要");
	await page.locator("#done .card", { hasText: DIGEST.title }).waitFor({ state: "attached", timeout: 15_000 });
	await sayInPage(page, "看下黄仁勋听证会的新闻");
	await leftCard(page, "找到三条新闻").waitFor({ timeout: 15_000 });
	await sayInPage(page, "查天气");
	await leftCard(page, WEATHER.title).locator(".choices button").first().waitFor({ timeout: 15_000 });
}

async function firstFrame(url: URL): Promise<{ text: string; frame: Record<string, unknown> }> {
	const events = new URL("/events", url);
	events.search = url.search;
	const controller = new AbortController();
	const res = await fetch(events, { signal: controller.signal });
	const reader = res.body!.getReader();
	let text = "";
	const frame = () => /^data: (.*)\n\n/m.exec(text)?.[1];
	while (frame() === undefined) text += new TextDecoder().decode((await reader.read()).value);
	controller.abort();
	return { text: frame()!, frame: JSON.parse(frame()!) };
}

const columns = (page: Page) =>
	page.evaluate(() => {
		const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
		const [left, main, context] = [box("#left"), box("main"), box("#context")];
		return { left: left.width, main: main.width, context: context.width, inRow: left.right <= main.left + 1 && main.right <= context.left + 1, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth };
	});

test("方案 D 桌面布局：左栏收件箱，右栏带数字的标签，任务标签开关和留存，提醒自动切到「今天」，选项、模块、来源、已完成，1024 和深色，刷新和键盘", async (t) => {
	const alerts = mkdtempSync(join(tmpdir(), "psa-ld1-alerts-"));
	t.after(() => rmSync(alerts, { recursive: true, force: true }));
	await story(
		t,
		SCRIPT(),
		async ({ step, open, host }) => {
			await step("准备：一个做完的摘要、一个进行中的听证会、一个带选项的受阻天气任务", async (page) => {
				await page.setViewportSize({ width: 1440, height: 900 });
				await setUp(page);
			});
			await step("Lane 2. 1440 宽浅色没选任务：左栏只有两段，右栏停在「今天」，四个标签的数字和看板一致", async (page) => {
				assert.deepEqual(await page.locator("#left > section > h2").allTextContents(), ["待你处理 · 1", "进行中 · 1"]);
				assert.equal(await selectedTab(page), "today");
				assert.deepEqual(await tabKeys(page), ["today", "sources", "modules", "done"]);
				const { frame } = await firstFrame(host.url);
				const today = Object.values((frame.today as { byDisposition: Record<string, number> }).byDisposition).reduce((a, b) => a + b, 0) + (frame.alerts as unknown[]).length;
				const done = (frame.board as { stage: string }[]).filter((r) => r.stage === "closed" || r.stage === "stopped").length;
				assert.deepEqual(
					[await count(page, "today"), await count(page, "sources"), await count(page, "modules"), await count(page, "done")],
					[today, (frame.watching as unknown[]).length, (frame.modules as unknown[]).length, done],
				);
				assert.equal(done, 1);
				await page.locator("#today .box").first().waitFor();
				const cols = await columns(page);
				assert.ok(cols.inRow && cols.scroll <= cols.client, JSON.stringify(cols));
				await shot(page, "ld1-default-light-1440.png");
			});
			await step("Lane 3. 点左栏受阻卡片：任务标签排第一并选中，有标题、提问、选项和执行过程，卡片描边", async (page) => {
				await leftCard(page, WEATHER.title).click();
				assert.equal(await selectedTab(page), "task");
				assert.equal((await tabKeys(page))[0], "task");
				assert.match((await tab(page, "task").textContent()) ?? "", /^任务 #[0-9a-z]{4}$/);
				await page.locator("#how-title", { hasText: WEATHER.title }).waitFor();
				assert.match((await page.locator("#how-ask").textContent()) ?? "", /查哪个城市？/);
				assert.equal(await page.locator("#how-ask .choices button").count(), 2);
				await page.locator("#steps .step").first().waitFor();
				assert.equal(await leftCard(page, WEATHER.title).getAttribute("aria-current"), "true");
				await shot(page, "ld1-task.png");
			});
			await step("Lane 4. 切到「模块」任务标签还在；回到任务标签内容不变；在任务标签上点 × 回到「模块」", async (page) => {
				await tab(page, "modules").click();
				assert.equal(await selectedTab(page), "modules");
				assert.equal(await page.locator("#modules").isVisible(), true);
				assert.equal(await tab(page, "task").count(), 1, "任务标签留着");
				await shot(page, "ld1-task-stays.png");
				await tab(page, "task").click();
				await page.locator("#how-title", { hasText: WEATHER.title }).waitFor();
				await page.locator(".tab-close").click();
				assert.equal(await selectedTab(page), "modules");
				assert.equal(await tab(page, "task").count(), 0);
				assert.equal(await leftCard(page, WEATHER.title).getAttribute("aria-current"), "false");
			});
			await step("Lane 5. 在「来源」时来了一条提醒：两秒内切到「今天」，这条高亮，数字加 1，任务标签还在", async (page) => {
				await leftCard(page, WEATHER.title).click();
				await tab(page, "sources").click();
				const before = await count(page, "today");
				const started = Date.now();
				writeFileSync(join(alerts, "NVDA-day-up-5"), "NVDA 相对昨收涨了 5.3%，超过你设的 5%");
				await page.locator('.tab[aria-selected="true"][data-tab="today"]').waitFor({ timeout: 2000 });
				await page.locator("#today .alerts li.flash", { hasText: "NVDA 相对昨收涨了 5.3%" }).waitFor({ timeout: 2000 });
				const ms = Date.now() - started;
				await page.waitForFunction((n) => Number(document.querySelector("#tab-today .count")?.textContent) === n, before + 1);
				assert.equal(await tab(page, "task").count(), 1);
				writeFileSync(join(SHOTS, "ld1-alert.txt"), `提醒落盘到右栏切到「今天」并高亮：${ms} ms\n`);
				await shot(page, "ld1-alert.png");
			});
			await step("Lane 6. 在任务标签里点选项：任务标签和左栏卡片上同一个选项都显示已选，幕僚长收到回答", async (page) => {
				await tab(page, "task").click();
				await page.locator("#how-ask .choices button", { hasText: WEATHER.city }).click();
				await page.locator('#how-ask .choices button[aria-pressed="true"]', { hasText: WEATHER.city }).waitFor();
				await leftCard(page, WEATHER.title).locator('.choices button[aria-pressed="true"]', { hasText: WEATHER.city }).waitFor();
				await shot(page, "ld1-answer.png");
				await page.locator(".line.user .bubble", { hasText: `回答任务「查天气」：${WEATHER.city}` }).waitFor();
				await page.locator(".line.router .bubble", { hasText: "陆家嘴晴，26 度。" }).waitFor({ timeout: 15_000 });
			});
			await step("Lane 7. 「模块」一行一个带开关；点 stock-ta 的开关两秒内变成开；「详情 ›」里是完整模块卡", async (page) => {
				await tab(page, "modules").click();
				assert.deepEqual(await page.locator("#modules .module-row").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.module)), ["alerts", "stock-ta"]);
				const toggle = page.locator('#modules .module-row[data-module="stock-ta"] .toggle');
				assert.equal(await toggle.getAttribute("aria-checked"), "false");
				const started = Date.now();
				await toggle.click();
				await page.locator('#modules .module-row[data-module="stock-ta"] .toggle[aria-checked="true"]').waitFor({ timeout: 2000 });
				await page.locator('#modules .module-row.ok[data-module="stock-ta"]').waitFor({ timeout: 2000 });
				writeFileSync(join(SHOTS, "ld1-modules.txt"), `stock-ta 开关变成开：${Date.now() - started} ms\n`);
				assert.match((await page.locator("#modules h2").textContent()) ?? "", /^模块 · 2 · 运行中 2$/);
				await shot(page, "ld1-modules.png");
				await page.locator("#modules .more").click();
				await page.locator('#modules .card.module[data-module="stock-ta"] .state', { hasText: /^运行中/ }).waitFor();
				await shot(page, "ld1-modules-details.png");
				await page.locator("#modules .more").click();
				await page.locator("#modules .module-row").first().waitFor();
			});
			await step("Lane 8. 「来源」写今日提醒数；「已完成」点开任务，× 回到「已完成」", async (page) => {
				await tab(page, "sources").click();
				await page.locator('#sources .watch[data-source="e2e-alerts"] .rule', { hasText: "今日提醒 1" }).waitFor();
				await shot(page, "ld1-sources.png");
				await tab(page, "done").click();
				const digest = page.locator("#done .card", { hasText: DIGEST.title });
				await digest.waitFor();
				await shot(page, "ld1-done.png");
				await digest.click();
				await page.locator("#how-title", { hasText: DIGEST.title }).waitFor();
				assert.equal(await selectedTab(page), "task");
				await page.locator(".tab-close").click();
				assert.equal(await selectedTab(page), "done");
			});
			await step("Lane 9. 1024 宽浅色和深色、1440 宽深色：三栏都在，对话区不窄于 400 像素，没有横向滚动，标签文字对比度不低于 4.5 比 1", async () => {
				const report: Record<string, unknown> = {};
				for (const [theme, width] of [["light", 1024], ["dark", 1024], ["dark", 1440]] as const) {
					const p = await open(host.url, { context: { colorScheme: theme, viewport: { width, height: 800 } } });
					await p.locator("#left .card").first().waitFor();
					await p.locator("#tab-today .count").waitFor();
					const cols = await columns(p);
					const ratios = { selected: await contrastOf(p, '.tab[aria-selected="true"]'), other: await contrastOf(p, '.tab[aria-selected="false"]') };
					report[`${theme}-${width}`] = { ...cols, ratios };
					assert.ok(cols.inRow && cols.main >= 400 && cols.scroll <= cols.client, JSON.stringify(cols));
					for (const [which, ratio] of Object.entries(ratios)) assert.ok(ratio >= 4.5, `${theme}-${width} ${which} ${ratio.toFixed(2)}`);
					await shot(p, `ld1-${theme}-${width}.png`);
					await p.context().close();
				}
				writeFileSync(join(SHOTS, "ld1-widths.json"), `${JSON.stringify(report, null, 2)}\n`);
			});
			await step("Lane 10. 刷新后回到「今天」没有任务标签；Tab 走到标签，方向键切换，aria-selected 跟着变", async (page) => {
				await page.reload();
				await page.locator("#tab-today .count").waitFor();
				assert.equal(await selectedTab(page), "today");
				assert.equal(await tab(page, "task").count(), 0);
				await tab(page, "today").focus();
				await page.keyboard.press("ArrowRight");
				assert.equal(await selectedTab(page), "sources");
				assert.equal(await page.evaluate(() => document.activeElement?.id), "tab-sources");
				await page.keyboard.press("ArrowLeft");
				await page.keyboard.press("ArrowLeft");
				assert.equal(await selectedTab(page), "done");
				await shot(page, "ld1-keyboard.png");
			});
		},
		{ files: FILES, imports: ["./tests/e2e/alert-feed-preload.mjs"], env: { PSA_E2E_ALERTS_DIR: alerts } },
	);
});

const trunk = process.env.PSA_LD_TRUNK;

/** Toggles `name` through the page-facing POST and waits for the board frame that shows it settled. */
async function toggleAndCountPushes(url: URL, name: string, times: number): Promise<number> {
	const events = new URL("/events", url);
	events.search = url.search;
	const controller = new AbortController();
	const reader = (await fetch(events, { signal: controller.signal })).body!.getReader();
	let text = "";
	let boards = 0;
	const frames: { type: string; modules?: { name: string; on: boolean; label: string }[] }[] = [];
	const pump = (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				text += new TextDecoder().decode(value);
				for (let i = text.indexOf("\n\n"); i >= 0; i = text.indexOf("\n\n")) {
					const data = /^data: (.*)$/m.exec(text.slice(0, i))?.[1];
					text = text.slice(i + 2);
					if (data) frames.push(JSON.parse(data));
				}
			}
		} catch {}
	})();
	const settled = (on: boolean) => frames.at(-1)?.modules?.find((m) => m.name === name)?.label === (on ? "运行中" : "已停用");
	for (let i = 0; i < times; i++) {
		const on = !frames.findLast((f) => f.modules)?.modules?.find((m) => m.name === name)?.on;
		const start = frames.length;
		const res = await fetch(new URL(`/module${url.search}`, url), { method: "POST", headers: { "content-type": "application/json", origin: url.origin }, body: JSON.stringify({ module: name, on }) });
		assert.equal(res.status, 204);
		for (const begun = Date.now(); !(frames.length > start && settled(on)); await new Promise((r) => setTimeout(r, 20))) if (Date.now() - begun > 10_000) throw new Error(`${name} 没有在 10 秒内变成 ${on}`);
		boards += frames.slice(start).filter((f) => f.type === "board").length;
	}
	controller.abort();
	await pump;
	return boards;
}

async function renderCost(page: Page, url: URL): Promise<{ pushes: number; msPerPush: number }> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Performance.enable");
	const metric = async () => {
		const { metrics } = await cdp.send("Performance.getMetrics");
		const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
		return (get("ScriptDuration") + get("LayoutDuration") + get("RecalcStyleDuration")) * 1000;
	};
	const before = await metric();
	const pushes = await toggleAndCountPushes(url, "stock-ta", 10);
	await page.waitForTimeout(300);
	const spent = (await metric()) - before;
	await cdp.detach();
	return { pushes, msPerPush: spent / pushes };
}

test("Lane 1. 和 trunk 比：两边左栏卡片都能点选项；head 右栏没选任务时不是空的；看板字节数和每次推送的重画耗时", { skip: !trunk && "设 PSA_LD_TRUNK=<trunk 的检出目录> 才跑" }, async (t) => {
	const alerts = mkdtempSync(join(tmpdir(), "psa-ld1-alerts-"));
	t.after(() => rmSync(alerts, { recursive: true, force: true }));
	await story(
		t,
		{
			router: [...weatherRouter(), ...weatherRouter()],
			workers: [worker(WEATHER.brief, askCity(), askCity(), gotCity(report("progress", "在查")), gotCity(report("progress", "在查")))],
		},
		async ({ step, fake, open, host }) => {
			const root = mkdtempSync(join(tmpdir(), "psa-ld1-trunk-"));
			const stateDir = join(root, "s");
			for (const [name, text] of Object.entries(FILES)) {
				mkdirSync(join(stateDir, name, ".."), { recursive: true });
				writeFileSync(join(stateDir, name), text);
			}
			const other = await startHost({ repo: trunk, models: fakeModels, stateDir, logFile: join(root, "trunk-host.log"), config: { webPort: 0, modulesDirs: [join(stateDir, "modules")] }, env: { ...fakeAgentEnv(fake, join(root, "pi")), PSA_E2E_ALERTS_DIR: alerts }, imports: ["./tests/e2e/alert-feed-preload.mjs"] });
			try {
				await step("trunk 和 head 都在左栏卡片上点选项：都显示已选；head 右栏停在「今天」有内容，trunk 右栏只有执行过程的提示", async (page) => {
					await page.setViewportSize({ width: 1440, height: 900 });
					const trunkPage = await open(other.url, { context: { viewport: { width: 1440, height: 900 } } });
					for (const p of [trunkPage, page]) {
						await sayInPage(p, "查天气");
						const card = p.locator("#left .card", { hasText: WEATHER.title });
						await card.locator(".choices button").first().waitFor({ timeout: 15_000 });
						await card.locator(".choices button", { hasText: WEATHER.city }).click();
						await card.locator('.choices button[aria-pressed="true"]', { hasText: WEATHER.city }).waitFor();
						await p.locator("#left .card", { hasText: "在查" }).waitFor({ timeout: 15_000 });
					}
					assert.match((await trunkPage.locator("#how").innerText()).trim(), /^执行过程[\s\S]*选择左侧的任务，查看助手的执行过程。$/);
					assert.equal(await selectedTab(page), "today");
					assert.ok((await page.locator("#today").innerText()).includes("今日暂无提醒"));
					await trunkPage.screenshot({ path: join(SHOTS, "ld1-regression-trunk.png") });
					await page.screenshot({ path: join(SHOTS, "ld1-regression.png") });
				});
				await step("看板推送字节数和每次推送的重画耗时：trunk 和 head 交替各 5 轮，每轮切 10 次模块开关", async (page) => {
					const trunkPage = await open(other.url, { context: { viewport: { width: 1440, height: 900 } } });
					await trunkPage.locator("#left .card").first().waitFor();
					writeFileSync(join(alerts, "perf-alert"), "NVDA 相对昨收涨了 1.3%，超过 1%");
					await page.locator("#today .alerts li").first().waitFor();
					const bytes = async (url: URL) => {
						const { conversation, cleared, board: rows, type, ...rest } = (await firstFrame(url)).frame;
						return { all: Buffer.byteLength(`data: ${JSON.stringify({ type: "board", rows, ...rest })}\n\n`), alerts: (rest.alerts as unknown[] | undefined)?.length ?? 0 };
					};
					const runs = { trunk: [] as number[], head: [] as number[], trunkBytes: [] as number[], headBytes: [] as number[], pushes: [] as number[] };
					for (let i = 0; i < 5; i++) {
						const a = await renderCost(trunkPage, other.url);
						const b = await renderCost(page, host.url);
						runs.trunk.push(a.msPerPush);
						runs.head.push(b.msPerPush);
						runs.pushes.push(a.pushes, b.pushes);
						runs.trunkBytes.push((await bytes(other.url)).all);
						runs.headBytes.push((await bytes(host.url)).all);
					}
					const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
					const alertCount = (await bytes(host.url)).alerts;
					const result = { ...runs, trunkMsMedian: median(runs.trunk), headMsMedian: median(runs.head), trunkBytesMedian: median(runs.trunkBytes), headBytesMedian: median(runs.headBytes), alertsToday: alertCount };
					writeFileSync(join(SHOTS, "ld1-perf.json"), `${JSON.stringify(result, null, 2)}\n`);
					assert.ok(result.headBytesMedian - result.trunkBytesMedian <= alertCount * 200 + 50, `看板多了 ${result.headBytesMedian - result.trunkBytesMedian} 字节`);
					assert.ok(!(result.headMsMedian > result.trunkMsMedian * 1.5 && result.headMsMedian - result.trunkMsMedian > 2), `每次推送 trunk ${result.trunkMsMedian.toFixed(2)} ms，head ${result.headMsMedian.toFixed(2)} ms`);
				});
			} finally {
				await other.stop();
				rmSync(root, { recursive: true, force: true });
			}
		},
		{ files: FILES, imports: ["./tests/e2e/alert-feed-preload.mjs"], env: { PSA_E2E_ALERTS_DIR: alerts } },
	);
});

const video = process.env.PSA_LD_VIDEO;

test("评审录像：点任务开标签，切模块和来源，提醒自动切到「今天」，× 回去，在任务标签里点选项", { skip: !video && "设 PSA_LD_VIDEO=<目录> 才录" }, async (t) => {
	const alerts = mkdtempSync(join(tmpdir(), "psa-ld1-alerts-"));
	t.after(() => rmSync(alerts, { recursive: true, force: true }));
	await story(
		t,
		SCRIPT(),
		async ({ step, open, host }) => {
			await step("录一段 30 到 60 秒的操作", async (first) => {
				await setUp(first);
				const dir = mkdtempSync(join(tmpdir(), "psa-ld1-video-"));
				const page = await open(host.url, { context: { viewport: { width: 1440, height: 900 }, recordVideo: { dir, size: { width: 1440, height: 900 } } } });
				const pause = (ms: number) => page.waitForTimeout(ms);
				await leftCard(page, WEATHER.title).locator(".choices button").first().waitFor();
				await pause(4000);
				await leftCard(page, WEATHER.title).click();
				await pause(5000);
				await tab(page, "modules").click();
				await pause(3000);
				await page.locator('#modules .module-row[data-module="stock-ta"] .toggle').click();
				await page.locator('#modules .module-row.ok[data-module="stock-ta"]').waitFor({ timeout: 5000 });
				await pause(3000);
				await page.locator("#modules .more").click();
				await pause(3000);
				await tab(page, "sources").click();
				await pause(3000);
				writeFileSync(join(alerts, "NVDA-day-up-1"), "NVDA 相对昨收涨了 1.3%，超过你设的 1%");
				await page.locator("#today .alerts li.flash").waitFor();
				await pause(5000);
				await tab(page, "done").click();
				await pause(3000);
				await tab(page, "task").click();
				await pause(3000);
				await page.locator("#how-ask .choices button", { hasText: WEATHER.city }).click();
				await page.locator(".line.router .bubble", { hasText: "陆家嘴晴，26 度。" }).waitFor({ timeout: 15_000 });
				await pause(4000);
				await page.locator(".tab-close").click();
				await pause(3000);
				await page.context().close();
				const [file] = readdirSync(dir).filter((f) => f.endsWith(".webm"));
				mkdirSync(video!, { recursive: true });
				copyFileSync(join(dir, file!), join(video!, "ld1-review.webm"));
				rmSync(dir, { recursive: true, force: true });
			});
		},
		{ files: FILES, imports: ["./tests/e2e/alert-feed-preload.mjs"], env: { PSA_E2E_ALERTS_DIR: alerts } },
	);
});
