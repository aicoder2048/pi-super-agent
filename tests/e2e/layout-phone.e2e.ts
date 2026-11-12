import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { fakeAgentEnv, report, worker } from "./fake-model.ts";
import { REPO, closeBrowser, contrastOf, fakeModels, sayInPage, showScreen, startHost, story } from "./harness.ts";
import { DIGEST, FILES, NEWS, SCRIPT, WEATHER, askCity, gotCity, leftCard, renderCost, selectedTab, setUp, tab, weatherRouter } from "./layout-story.ts";

after(closeBrowser);

const SHOTS = process.env.PSA_LD_SHOTS ?? join(REPO, "tests/e2e/.out/ld2");
mkdirSync(SHOTS, { recursive: true });
const PHONE = { width: 390, height: 844 };

const place = (page: Page, which: string) => page.locator(`#bottom button[data-place="${which}"]`);
const screen = (page: Page) => page.evaluate(() => document.body.dataset.screen);
const shot = (page: Page, file: string) => page.screenshot({ path: join(SHOTS, file) });
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("方案 D 手机：底部标签栏待办、对话、概况，概况里四段，任务推进详情和返回，提醒只切分段并带提醒点，深色，宽窄来回，桌面不受影响", async (t) => {
	const alerts = mkdtempSync(join(tmpdir(), "psa-ld2-alerts-"));
	t.after(() => rmSync(alerts, { recursive: true, force: true }));
	await story(
		t,
		SCRIPT(),
		async ({ step, open, host }) => {
			await step("Lane 3. 「对话」屏：对话和输入框占满一屏，说的话出现在对话里，输入框不被底栏挡住", async (page) => {
				await page.setViewportSize(PHONE);
				await setUp(page);
				assert.equal(await screen(page), "chat");
				assert.equal(await page.locator("#left").isVisible(), false);
				await page.locator(".line.user .bubble", { hasText: "查天气" }).waitFor();
				const [form, bar] = await Promise.all([page.locator("#say").boundingBox(), page.locator("#bottom").boundingBox()]);
				assert.ok(form!.y + form!.height <= bar!.y + 1, `输入框底 ${form!.y + form!.height}，底栏顶 ${bar!.y}`);
				assert.ok(await noSideScroll(page));
				await shot(page, "ld2-chat.png");
			});
			await step("Lane 2. 「待办」屏：只有待你处理和进行中，「待办」上的数字等于待你处理数", async (page) => {
				await place(page, "todo").click();
				assert.equal(await screen(page), "todo");
				assert.deepEqual(await page.locator("#left > section > h2").allTextContents(), ["待你处理 · 1", "进行中 · 1"]);
				assert.equal(await place(page, "todo").locator(".badge").textContent(), "1");
				assert.equal(await place(page, "todo").getAttribute("aria-current"), "true");
				assert.equal(await page.locator("main").isVisible(), false);
				assert.ok(await noSideScroll(page));
				await shot(page, "ld2-todo.png");
			});
			await step("Lane 4. 「概况」屏：顶上四段，默认「今天」，切到「来源」「已完成」内容跟着变", async (page) => {
				await place(page, "overview").click();
				assert.equal(await screen(page), "overview");
				assert.equal(await selectedTab(page), "today");
				assert.equal(await page.locator("#tabs .tab:visible").count(), 4);
				await page.locator("#today .box").first().waitFor();
				await shot(page, "ld2-overview.png");
				await tab(page, "sources").click();
				await page.locator('#sources .watch[data-source="e2e-alerts"]').waitFor();
				await tab(page, "done").click();
				await page.locator("#done .card", { hasText: DIGEST.title }).waitFor();
				assert.ok(await noSideScroll(page));
			});
			await step("Lane 5. 「概况 · 模块」：点 stock-ta 的开关两秒内变成开", async (page) => {
				await tab(page, "modules").click();
				await page.locator('#modules .module-row[data-module="stock-ta"] .toggle').click();
				await page.locator('#modules .module-row.ok[data-module="stock-ta"] .toggle[aria-checked="true"]').waitFor({ timeout: 2000 });
				assert.ok(await noSideScroll(page));
				await shot(page, "ld2-modules.png");
			});
			await step("Lane 6. 点任务推进详情：占满一屏，有提问、选项和执行过程，「‹ 待办」回到待办", async (page) => {
				await place(page, "todo").click();
				await leftCard(page, WEATHER.title).click();
				assert.equal(await screen(page), "task");
				assert.equal(await page.locator("#tabs").isVisible(), false);
				await page.locator("#how-title", { hasText: WEATHER.title }).waitFor();
				assert.equal(await page.locator("#how-ask .choices button").count(), 2);
				await page.locator("#steps .step").first().waitFor();
				assert.equal(await page.locator("#back").textContent(), "‹ 待办");
				assert.ok(await noSideScroll(page));
				await shot(page, "ld2-task.png");
				await page.locator("#how-ask .choices button", { hasText: WEATHER.city }).click();
				await page.locator('#how-ask .choices button[aria-pressed="true"]', { hasText: WEATHER.city }).waitFor();
				await page.locator("#back").click();
				assert.equal(await screen(page), "todo");
			});
			await step("Lane 7. 在「对话」屏时来了提醒：还停在对话，「概况」带提醒点；点「概况」看到「今天」里这条高亮，提醒点消失", async (page) => {
				await place(page, "chat").click();
				writeFileSync(join(alerts, "NVDA-day-up-5"), "NVDA 相对昨收涨了 5.3%，超过你设的 5%");
				await place(page, "overview").locator(".dot:not([hidden])").waitFor({ timeout: 2000 });
				assert.equal(await screen(page), "chat");
				await shot(page, "ld2-alert-dot.png");
				await place(page, "overview").click();
				assert.equal(await selectedTab(page), "today");
				await page.locator("#today .alerts li.flash", { hasText: "NVDA 相对昨收涨了 5.3%" }).waitFor();
				assert.equal(await place(page, "overview").locator(".dot").isHidden(), true);
				await shot(page, "ld2-alert.png");
			});
			await step("Lane 8. 深色 390 宽：底栏和分段文字对比度不低于 4.5 比 1，没有横向滚动", async () => {
				const dark = await open(host.url, { context: { colorScheme: "dark", viewport: PHONE } });
				await dark.locator("#left .card").first().waitFor();
				const ratios: Record<string, number> = { todo: await contrastOf(dark, '#bottom button[aria-current="true"]'), chat: await contrastOf(dark, '#bottom button[data-place="chat"]') };
				await place(dark, "overview").click();
				ratios.segment = await contrastOf(dark, '#tabs .tab[aria-selected="true"]');
				ratios.other = await contrastOf(dark, '#tabs .tab[aria-selected="false"]');
				writeFileSync(join(SHOTS, "ld2-dark.json"), `${JSON.stringify(ratios, null, 2)}\n`);
				for (const [which, ratio] of Object.entries(ratios)) assert.ok(ratio >= 4.5, `${which} ${ratio.toFixed(2)}`);
				assert.ok(await noSideScroll(dark));
				await shot(dark, "ld2-dark.png");
				await dark.context().close();
			});
			await step("Lane 9. 宽度在 390 和 1024 之间来回：1024 宽回到三栏，打开着的任务标签还在；回到 390 宽显示任务详情", async (page) => {
				await place(page, "todo").click();
				await leftCard(page, NEWS.title).click();
				await page.setViewportSize({ width: 1024, height: 800 });
				for (const id of ["#left", "main", "#context"]) assert.equal(await page.locator(id).isVisible(), true, id);
				assert.equal(await page.locator("#bottom").isVisible(), false);
				assert.equal(await selectedTab(page), "task");
				await shot(page, "ld2-resize-1024.png");
				await page.setViewportSize(PHONE);
				assert.equal(await screen(page), "task");
				await page.locator("#how-title", { hasText: NEWS.title }).waitFor();
				await shot(page, "ld2-resize.png");
			});
			await step("Lane 10. 1440 宽桌面：没有底栏，三栏和 LD1 一样", async () => {
				const desk = await open(host.url, { context: { viewport: { width: 1440, height: 900 } } });
				await desk.locator("#tab-today .count").waitFor();
				assert.equal(await desk.locator("#bottom").isVisible(), false);
				const inRow = await desk.evaluate(() => {
					const [l, m, c] = ["#left", "main", "#context"].map((s) => document.querySelector(s)!.getBoundingClientRect());
					return l.width > 0 && l.right <= m.left + 1 && m.right <= c.left + 1 && c.width > 0;
				});
				assert.ok(inRow);
				await shot(desk, "ld2-desktop.png");
				await desk.context().close();
			});
		},
		{ files: FILES, imports: ["./tests/e2e/alert-feed-preload.mjs"], env: { PSA_E2E_ALERTS_DIR: alerts } },
	);
});

const parent = process.env.PSA_LD_TRUNK;

test("Lane 1. 和父分支 LD1 比（390 宽）：两边都能在受阻卡片上点选项；head 有底部标签栏且没有横向滚动；重画耗时和切底栏耗时", { skip: !parent && "设 PSA_LD_TRUNK=<LD1 的检出目录> 才跑" }, async (t) => {
	await story(
		t,
		{
			router: [...weatherRouter(), ...weatherRouter()],
			workers: [worker(WEATHER.brief, askCity(), askCity(), gotCity(report("progress", "在查")), gotCity(report("progress", "在查")))],
		},
		async ({ step, fake, open, host }) => {
			const root = mkdtempSync(join(tmpdir(), "psa-ld2-parent-"));
			const stateDir = join(root, "s");
			for (const [name, text] of Object.entries(FILES)) {
				mkdirSync(join(stateDir, name, ".."), { recursive: true });
				writeFileSync(join(stateDir, name), text);
			}
			const alerts = mkdtempSync(join(root, "alerts-"));
			const other = await startHost({ repo: parent, models: fakeModels, stateDir, logFile: join(root, "parent-host.log"), config: { webPort: 0, modulesDirs: [join(stateDir, "modules")] }, env: { ...fakeAgentEnv(fake, join(root, "pi")), PSA_E2E_ALERTS_DIR: alerts }, imports: ["./tests/e2e/alert-feed-preload.mjs"] });
			try {
				await step("两边 390 宽都在受阻卡片上点选项：都显示已选；head 有底栏，父分支没有", async (page) => {
					await page.setViewportSize(PHONE);
					const parentPage = await open(other.url, { context: { viewport: PHONE } });
					for (const p of [parentPage, page]) {
						await sayInPage(p, "查天气");
						await showScreen(p, "todo");
						const card = p.locator("#left .card", { hasText: WEATHER.title });
						await card.locator(".choices button").first().waitFor({ timeout: 15_000 });
						await card.locator(".choices button", { hasText: WEATHER.city }).click();
						await card.locator('.choices button[aria-pressed="true"]', { hasText: WEATHER.city }).waitFor();
					}
					assert.equal(await parentPage.locator("#bottom").count(), 0, "父分支没有底栏");
					assert.equal(await page.locator("#bottom").isVisible(), true);
					assert.ok(await noSideScroll(page));
					await parentPage.screenshot({ path: join(SHOTS, "ld2-regression-parent.png") });
					await page.screenshot({ path: join(SHOTS, "ld2-regression.png") });
				});
				await step("390 宽每次看板推送的重画耗时（父分支和 head 交替 5 轮，每轮切 10 次模块开关），和切一次底栏的耗时", async (page) => {
					const parentPage = await open(other.url, { context: { viewport: PHONE } });
					await parentPage.locator("#left .card").first().waitFor();
					const runs = { parent: [] as number[], head: [] as number[], switchMs: [] as number[] };
					const places = ["chat", "overview", "todo"];
					for (let i = 0; i < 5; i++) {
						runs.parent.push((await renderCost(parentPage, other.url)).msPerPush);
						runs.head.push((await renderCost(page, host.url)).msPerPush);
						for (let k = 0; k < 20; k++)
							runs.switchMs.push(await page.evaluate((which) => {
								const started = performance.now();
								(document.querySelector(`#bottom button[data-place="${which}"]`) as HTMLElement).click();
								void document.body.offsetHeight;
								return performance.now() - started;
							}, places[k % 3]));
					}
					const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
					const result = { ...runs, parentMsMedian: median(runs.parent), headMsMedian: median(runs.head), switchMsMedian: median(runs.switchMs) };
					writeFileSync(join(SHOTS, "ld2-perf.json"), `${JSON.stringify(result, null, 2)}\n`);
					assert.ok(!(result.headMsMedian > result.parentMsMedian * 1.5 && result.headMsMedian - result.parentMsMedian > 2), `每次推送 LD1 ${result.parentMsMedian.toFixed(2)} ms，head ${result.headMsMedian.toFixed(2)} ms`);
					assert.ok(result.switchMsMedian <= 16, `切一次底栏 ${result.switchMsMedian.toFixed(2)} ms`);
				});
			} finally {
				await other.stop();
				rmSync(root, { recursive: true, force: true });
			}
		},
		{ files: FILES, imports: ["./tests/e2e/alert-feed-preload.mjs"], env: { PSA_E2E_ALERTS_DIR: mkdtempSync(join(tmpdir(), "psa-ld2-alerts-")) } },
	);
});

const video = process.env.PSA_LD_VIDEO;

test("评审录像（390 宽）：待办、对话、概况四段，点任务推进详情、点选项再返回，在对话时来提醒", { skip: !video && "设 PSA_LD_VIDEO=<目录> 才录" }, async (t) => {
	const alerts = mkdtempSync(join(tmpdir(), "psa-ld2-alerts-"));
	t.after(() => rmSync(alerts, { recursive: true, force: true }));
	await story(
		t,
		SCRIPT(),
		async ({ step, open, host }) => {
			await step("录一段 30 到 60 秒的操作", async (first) => {
				await first.setViewportSize(PHONE);
				await setUp(first);
				const dir = mkdtempSync(join(tmpdir(), "psa-ld2-video-"));
				const page = await open(host.url, { context: { viewport: PHONE, recordVideo: { dir, size: PHONE } } });
				const pause = (ms: number) => page.waitForTimeout(ms);
				await leftCard(page, WEATHER.title).locator(".choices button").first().waitFor();
				await pause(4000);
				await place(page, "chat").click();
				await pause(4000);
				await place(page, "overview").click();
				await pause(3000);
				await tab(page, "modules").click();
				await pause(3000);
				await page.locator('#modules .module-row[data-module="stock-ta"] .toggle').click();
				await page.locator('#modules .module-row.ok[data-module="stock-ta"]').waitFor({ timeout: 5000 });
				await pause(3000);
				await tab(page, "done").click();
				await pause(3000);
				await place(page, "todo").click();
				await pause(2000);
				await leftCard(page, WEATHER.title).click();
				await pause(4000);
				await page.locator("#how-ask .choices button", { hasText: WEATHER.city }).click();
				await pause(3000);
				await page.locator("#back").click();
				await pause(2000);
				await place(page, "chat").click();
				await pause(2000);
				writeFileSync(join(alerts, "NVDA-day-up-1"), "NVDA 相对昨收涨了 1.3%，超过你设的 1%");
				await place(page, "overview").locator(".dot:not([hidden])").waitFor();
				await pause(4000);
				await place(page, "overview").click();
				await pause(5000);
				await page.context().close();
				const [file] = readdirSync(dir).filter((f) => f.endsWith(".webm"));
				mkdirSync(video!, { recursive: true });
				copyFileSync(join(dir, file!), join(video!, "ld2-review.webm"));
				rmSync(dir, { recursive: true, force: true });
			});
		},
		{ files: FILES, imports: ["./tests/e2e/alert-feed-preload.mjs"], env: { PSA_E2E_ALERTS_DIR: alerts } },
	);
});
