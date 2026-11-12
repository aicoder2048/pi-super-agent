import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { fakeAgentEnv, on, openTicket, report, reply, worker, type ToolCall } from "./fake-model.ts";
import { REPO, closeBrowser, contrastOf, fakeModels, packageFiles, sayInPage, startHost, story } from "./harness.ts";

after(closeBrowser);

const SHOTS = process.env.PSA_F2C_SHOTS ?? join(REPO, "tests/e2e/.out/f2c");
mkdirSync(SHOTS, { recursive: true });
const SAMPLE = join(REPO, "docs/modules/architecture/sample");
const STOCK_TA = join(REPO, "docs/modules/examples/stock-ta");

const FILES = {
	...packageFiles(join(SAMPLE, "personal-tax"), "personal-tax"),
	...packageFiles(join(SAMPLE, "personal-health"), "personal-health"),
	...packageFiles(join(SAMPLE, "broken/unknown-key"), "unknown-key"),
	...packageFiles(STOCK_TA, "stock-ta"),
};

const TAX = { title: "估算今年的税", brief: "按今年的成交估算税额" };
const inDomain = (call: ToolCall, domain: string): ToolCall => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain })) } });

const card = (page: Page, name: string) => page.locator(`#modules .card.module[data-module="${name}"]`);
const modulesSection = (page: Page) => page.locator("#modules");
/** The full cards sit behind 「详情 ›」 in the 模块 tab. */
async function openModules(page: Page): Promise<void> {
	await page.locator("#tab-modules").click();
	const more = page.locator("#modules .more");
	if ((await more.getAttribute("aria-expanded")) === "false") await more.click();
}
const shoot = (page: Page, file: string) => modulesSection(page).screenshot({ path: join(SHOTS, file) });

async function within2s(page: Page, name: string, label: string): Promise<number> {
	const started = Date.now();
	await card(page, name).locator(".state", { hasText: new RegExp(`^${label}`) }).waitFor({ timeout: 2000 });
	return Date.now() - started;
}

test("模块栏：每个模块一张卡，开关两秒内生效，无效写出哪个文件哪一处，没导入的知识带命令，钉着旧版本的任务有数；窄屏、深色、没有 token", (t) =>
	story(
		t,
		{
			router: [
				on("Router 把算税交给 personal-tax", /^\[对话\][\s\S]*算税/, (c) => [inDomain(openTicket(c, TAX.title, TAX.brief), "personal-tax"), reply(c, "已交给报税")]),
			],
			workers: [worker(TAX.brief, on("报税助手汇报", /^\[任务说明\]/, () => [report("progress", "正在汇总成交")]))],
		},
		async ({ step, stateDir, host, open }) => {
			await step("Lane 2. 模块栏每个模块一张卡，状态正确", async (page) => {
				// Tall enough to screenshot the whole section without scrolling.
				await page.setViewportSize({ width: 1280, height: 1800 });
				await page.locator("#tab-modules .count", { hasText: "4" }).waitFor();
				await openModules(page);
				await card(page, "unknown-key").waitFor();
				assert.deepEqual(await page.locator("#modules .card.module").evaluateAll((cards) => cards.map((c) => (c as HTMLElement).dataset.module)), ["personal-health", "personal-tax", "stock-ta", "unknown-key"]);
				for (const name of ["personal-health", "personal-tax", "stock-ta", "unknown-key"]) assert.match((await card(page, name).locator(".state").textContent()) ?? "", /^已停用/, name);
				assert.match((await card(page, "personal-tax").textContent()) ?? "", /版本 0\.1\.0 · [0-9a-f]{12}.*密钥 EXAMPLE_BROKER_TOKEN/);
				assert.match((await card(page, "stock-ta").textContent()) ?? "", /股票技术分析 · stock-ta.*版本 0\.1\.0 · [0-9a-f]{12}.*密钥 TA_ROOT/);
				assert.equal(await card(page, "stock-ta").locator("button.switch").textContent(), "打开");
				await shoot(page, "f2c-list.png");
			});
			await step("Lane 3. 点 stock-ta 的「打开」，两秒内卡片变成运行中", async (page) => {
				await card(page, "stock-ta").locator("button.switch").click();
				const ms = await within2s(page, "stock-ta", "运行中");
				writeFileSync(join(SHOTS, "f2c-on.txt"), `运行中用了 ${ms} ms\n`);
				assert.equal(await card(page, "stock-ta").locator("button.switch").textContent(), "关掉");
				await shoot(page, "f2c-on.png");
			});
			await step("Lane 4. 点「关掉」，两秒内卡片变成已停用", async (page) => {
				await card(page, "stock-ta").locator("button.switch").click();
				const ms = await within2s(page, "stock-ta", "已停用");
				writeFileSync(join(SHOTS, "f2c-off.txt"), `已停用用了 ${ms} ms\n`);
				await shoot(page, "f2c-off.png");
			});
			await step("Lane 5. 打开无效的模块：卡片写无效，列出 module.json 哪一处", async (page) => {
				await card(page, "unknown-key").locator("button.switch").click();
				await within2s(page, "unknown-key", "无效");
				assert.match((await card(page, "unknown-key").locator(".problems").textContent()) ?? "", /module\.json：unknown key "descripton"/);
				await shoot(page, "f2c-invalid.png");
			});
			await step("Lane 6. 还没导入的知识：卡片列出知识名和 just module import 命令", async (page) => {
				const imports = card(page, "stock-ta").locator(".imports");
				await imports.locator("summary").click();
				assert.match((await imports.locator("summary").textContent()) ?? "", /还没导入的知识 18 份/);
				assert.match((await imports.textContent()) ?? "", /ta02-macdjust module import stock-ta ta02-macd <文件或目录>/);
				await card(page, "stock-ta").scrollIntoViewIfNeeded();
				await shoot(page, "f2c-import.png");
			});
			await step("Lane 7. 任务开着时改了模块：卡片写有 1 个任务还在用旧版本", async (page) => {
				await card(page, "personal-tax").locator("button.switch").click();
				await within2s(page, "personal-tax", "运行中");
				await sayInPage(page, "帮我算税");
				await page.locator("#left .card", { hasText: "正在汇总成交" }).waitFor();
				const manifest = join(stateDir, "modules/personal-tax/module.json");
				writeFileSync(manifest, readFileSync(manifest, "utf8").replace('"version": "0.1.0"', '"version": "0.1.1"'));
				await card(page, "personal-tax").locator(".meta", { hasText: "1 个任务还在用旧版本" }).waitFor({ timeout: 15_000 });
				assert.match((await card(page, "personal-tax").textContent()) ?? "", /版本 0\.1\.1/);
				await shoot(page, "f2c-pinned.png");
			});
			await step("Lane 8. 390 像素宽：没有横向滚动", async () => {
				const narrow = await open(host.url, { context: { viewport: { width: 390, height: 844 } } });
				await narrow.locator("#tab-modules .count", { hasText: "4" }).waitFor();
				await openModules(narrow);
				await card(narrow, "personal-tax").waitFor();
				const widths = await narrow.evaluate(() => ({
					scroll: document.documentElement.scrollWidth,
					client: document.documentElement.clientWidth,
					rightmost: Math.max(...[...document.querySelectorAll("#modules .card.module *")].map((n) => n.getBoundingClientRect().right)),
				}));
				assert.ok(widths.scroll <= widths.client && widths.rightmost <= widths.client, JSON.stringify(widths));
				// The page scrolls inside its columns, so a full-page shot stops at the viewport; a tall viewport shows the whole section.
				await narrow.setViewportSize({ width: 390, height: 2400 });
				await narrow.screenshot({ path: join(SHOTS, "f2c-narrow.png") });
			});
			await step("Lane 9. 深色主题：模块卡上的字对比度不低于 4.5 比 1", async () => {
				const dark = await open(host.url, { context: { colorScheme: "dark", viewport: { width: 1280, height: 1800 } } });
				await dark.locator("#tab-modules .count", { hasText: "4" }).waitFor();
				await openModules(dark);
				await card(dark, "personal-tax").waitFor();
				const ratios: Record<string, number> = {};
				for (const selector of [".card.module .title", ".card.module .state", ".card.module .meta", ".card.module .problems li", ".card.module .imports code", ".card.module button.switch"]) ratios[selector] = await contrastOf(dark, selector);
				writeFileSync(join(SHOTS, "f2c-dark.txt"), `${JSON.stringify(ratios, null, 2)}\n`);
				for (const [selector, ratio] of Object.entries(ratios)) assert.ok(ratio >= 4.5, `${selector} ${ratio.toFixed(2)}`);
				await modulesSection(dark).screenshot({ path: join(SHOTS, "f2c-dark.png") });
			});
			await step("Lane 10. 不带 token 的 POST /module 回 401，开关没变", async (page) => {
				const res = await fetch(new URL("/module", host.url), { method: "POST", headers: { "content-type": "application/json", origin: host.url.origin }, body: JSON.stringify({ module: "personal-tax", on: false }) });
				const body = await res.text();
				writeFileSync(join(SHOTS, "f2c-token.txt"), `POST /module（没有 token）→ ${res.status}\n${body}\n`);
				assert.equal(res.status, 401);
				assert.match((await card(page, "personal-tax").locator(".state").textContent()) ?? "", /^运行中/);
			});
		},
		{ files: FILES },
	));

/** The bytes of one board push, rebuilt from the snapshot that opens the event stream: the same fields, framed as `board`. */
async function boardBytes(url: URL): Promise<{ bytes: number; cards: Record<string, number> }> {
	const events = new URL("/events", url);
	events.search = url.search;
	const controller = new AbortController();
	const res = await fetch(events, { signal: controller.signal });
	const reader = res.body!.getReader();
	let text = "";
	const frame = () => /^data: (.*)\n\n/m.exec(text)?.[1];
	while (frame() === undefined) text += new TextDecoder().decode((await reader.read()).value);
	controller.abort();
	const { type, conversation, cleared, board: rows, ...rest } = JSON.parse(frame()!);
	return { bytes: Buffer.byteLength(`data: ${JSON.stringify({ type: "board", rows, ...rest })}\n\n`), cards: Object.fromEntries(((rest.modules ?? []) as { name: string }[]).map((c) => [c.name, Buffer.byteLength(JSON.stringify(c))])) };
}

const trunk = process.env.PSA_F2C_TRUNK;

test("Lane 1. 和 trunk 比：其余各栏一样；看板推送字节数", { skip: !trunk && "设 PSA_F2C_TRUNK=<trunk 的检出目录> 才跑" }, (t) =>
	story(
		t,
		{ router: [] },
		async ({ step, fake, open, host }) => {
			const root = mkdtempSync(join(tmpdir(), "psa-f2c-trunk-"));
			const stateDir = join(root, "s");
			for (const [name, text] of Object.entries(FILES)) {
				mkdirSync(join(stateDir, name, ".."), { recursive: true });
				writeFileSync(join(stateDir, name), text);
			}
			const other = await startHost({ repo: trunk, models: fakeModels, stateDir, logFile: join(root, "trunk-host.log"), config: { webPort: 0, modulesDirs: [join(stateDir, "modules")] }, env: fakeAgentEnv(fake, join(root, "pi")) });
			try {
				await step("trunk 和 head 的页面除了模块栏都一样", async (page) => {
					const trunkPage = await open(other.url);
					const others = (p: Page) =>
						p.evaluate(() => [...document.querySelectorAll("#left > section")].slice(0, 2).map((n) => (n as HTMLElement).innerText));
					await openModules(page);
					await card(page, "personal-tax").waitFor();
					await trunkPage.locator("#left section").nth(1).waitFor();
					assert.deepEqual(await others(page), await others(trunkPage));
					await trunkPage.screenshot({ path: join(SHOTS, "f2c-regression-trunk.png"), fullPage: true });
					await page.screenshot({ path: join(SHOTS, "f2c-regression.png"), fullPage: true });
				});
				await step("看板推送字节数：trunk 和 head 各取 5 次", async () => {
					const runs = { trunk: [] as number[], head: [] as number[] };
					let cards: Record<string, number> = {};
					for (let i = 0; i < 5; i++) {
						runs.trunk.push((await boardBytes(other.url)).bytes);
						const head = await boardBytes(host.url);
						runs.head.push(head.bytes);
						cards = head.cards;
					}
					const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[2]!;
					const perModule = (median(runs.head) - median(runs.trunk)) / 4;
					writeFileSync(join(SHOTS, "f2c-perf.txt"), `${JSON.stringify({ ...runs, trunkMedian: median(runs.trunk), headMedian: median(runs.head), modules: 4, extraBytesPerModule: perModule, cardBytes: cards }, null, 2)}\n`);
					assert.ok(perModule <= 1024, `每个模块多 ${perModule} 字节`);
					for (const [name, bytes] of Object.entries(cards)) assert.ok(bytes <= 1024, `${name} 的卡 ${bytes} 字节`);
				});
			} finally {
				await other.stop();
				rmSync(root, { recursive: true, force: true });
			}
		},
		{ files: FILES },
	));

const video = process.env.PSA_F2C_VIDEO;

test("评审录像：打开模块栏，开关 stock-ta，看无效模块和没导入的知识", { skip: !video && "设 PSA_F2C_VIDEO=<目录> 才录" }, (t) =>
	story(
		t,
		{ router: [] },
		async ({ step, open, host }) => {
			await step("录一段 30 到 60 秒的操作", async () => {
				const dir = mkdtempSync(join(tmpdir(), "psa-f2c-video-"));
				const page = await open(host.url, { context: { viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } } });
				const pause = (ms: number) => page.waitForTimeout(ms);
				await page.locator("#tab-modules .count", { hasText: "4" }).waitFor();
				await openModules(page);
				await card(page, "personal-tax").waitFor();
				await pause(3000);
				await modulesSection(page).scrollIntoViewIfNeeded();
				await pause(5000);
				await card(page, "stock-ta").locator("button.switch").click();
				await within2s(page, "stock-ta", "运行中");
				await pause(6000);
				await card(page, "unknown-key").locator("button.switch").click();
				await within2s(page, "unknown-key", "无效");
				await pause(6000);
				await card(page, "stock-ta").locator(".imports summary").click();
				await card(page, "stock-ta").locator(".imports").scrollIntoViewIfNeeded();
				await pause(6000);
				await card(page, "stock-ta").locator("button.switch").click();
				await within2s(page, "stock-ta", "已停用");
				await pause(5000);
				await page.context().close();
				const [file] = readdirSync(dir).filter((f) => f.endsWith(".webm"));
				mkdirSync(video!, { recursive: true });
				copyFileSync(join(dir, file!), join(video!, "f2c-review.webm"));
				rmSync(dir, { recursive: true, force: true });
			});
		},
		{ files: FILES },
	));
