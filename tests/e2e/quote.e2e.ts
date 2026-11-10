import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { Page } from "playwright-core";
import { on, openTicket, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, sayInPage, story, waitStatus } from "./harness.ts";

after(closeBrowser);

const LONG = `**好的**，去查了。${"明天多云转晴，气温回升，风力不大，适合出门。".repeat(8)}`;
const strip = (page: Page) => page.locator("#quote-strip");
const stripText = async (page: Page) => (await strip(page).locator(".quote-who, .quote-text").allTextContents()).join("");
const quoteButton = (line: ReturnType<Page["locator"]>) => line.locator(".quote-btn");
const opacity = (line: ReturnType<Page["locator"]>) => quoteButton(line).evaluate((b) => getComputedStyle(b).opacity);
const quotedUnder = (page: Page, text: string) => page.locator(".line.user", { hasText: text }).locator(".quoted");
const quotedText = (page: Page, text: string) => quotedUnder(page, text).textContent();

test("引用：悬停出现「引用」，引用条可用 ✕ 和 Esc 取消；发出后气泡下灰色显示引用，重载、第二个浏览器、重启宿主后仍在；清屏后展开的旧话也能引用", (t) =>
	story(
		t,
		{
			router: [
				on("Router 回答查天气", /^\[对话\][\s\S]*查天气/, (c) => [reply(c, LONG)]),
				on("Router 回答改成 B", /^\[对话\][\s\S]*改成 B/, (c) => [reply(c, "收到，改成 B。")]),
				on("Router 回答还是那件事", /^\[对话\][\s\S]*还是那件事/, (c) => [reply(c, "好，接着查。")]),
			],
		},
		async ({ step, host, open }) => {
			const routerLine = (page: Page) => page.locator(".thread > .line.router").first();
			await step("页面说「查天气」，幕僚长回了一段长话", async (page) => {
				await sayInPage(page, "查天气");
				await routerLine(page).waitFor();
			});
			await step("鼠标不在上面时「引用」看不见，移到幕僚长的话上就出现", async (page) => {
				await page.mouse.move(0, 0);
				assert.equal(await opacity(routerLine(page)), "0");
				await routerLine(page).locator(".bubble").hover();
				assert.equal(await opacity(routerLine(page)), "1");
				assert.equal(await strip(page).isHidden(), true, "还没点，引用条不出现");
			});
			await step("鼠标移开后用 Tab 能走到「引用」，走到时它显示出来", async (page) => {
				await page.mouse.move(0, 0);
				await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
				let reached = false;
				for (let i = 0; i < 30 && !reached; i++) {
					await page.keyboard.press("Tab");
					reached = await page.evaluate(() => document.activeElement?.classList.contains("quote-btn") ?? false);
				}
				assert.equal(reached, true, "Tab 走到了「引用」");
				const shown = await page.evaluate(() => getComputedStyle(document.activeElement!).opacity);
				assert.equal(shown, "1");
			});
			await step("点「引用」，输入框上方出现灰色引用条，写着「引用 幕僚长：」和去掉标记的原话", async (page) => {
				await routerLine(page).locator(".bubble").hover();
				await quoteButton(routerLine(page)).click();
				await strip(page).waitFor();
				assert.match(await stripText(page), /^引用 幕僚长：好的，去查了。明天多云转晴/);
				const above = await page.evaluate(() => document.getElementById("quote-strip")!.getBoundingClientRect().bottom <= document.querySelector(".composer")!.getBoundingClientRect().top);
				assert.equal(above, true, "引用条在输入框上方");
				assert.equal(await page.evaluate(() => document.activeElement?.id), "composer", "点完光标回到输入框");
			});
			await step("点 ✕ 取消引用", async (page) => {
				await page.getByRole("button", { name: "取消引用" }).click();
				await strip(page).waitFor({ state: "hidden" });
			});
			await step("再引用一次，在输入框里按 Esc 取消", async (page) => {
				await routerLine(page).locator(".bubble").hover();
				await quoteButton(routerLine(page)).click();
				await strip(page).waitFor();
				await page.locator("#composer").press("Escape");
				await strip(page).waitFor({ state: "hidden" });
			});
			await step("引用后发「改成 B」：引用条清空，我的气泡下灰色显示引用，最多两行", async (page) => {
				await routerLine(page).locator(".bubble").hover();
				await quoteButton(routerLine(page)).click();
				await sayInPage(page, "改成 B");
				await strip(page).waitFor({ state: "hidden" });
				assert.equal(await page.inputValue("#composer"), "");
				await page.locator(".line.router .bubble", { hasText: "收到，改成 B。" }).waitFor();
				const quoted = quotedUnder(page, "改成 B");
				assert.match((await quoted.textContent())!, /^引用 幕僚长：好的，去查了。明天多云转晴/);
				const box = await quoted.evaluate((q) => {
					const s = getComputedStyle(q);
					const text = q.querySelector(".quote-text")!;
					const bubble = q.parentElement!.querySelector(".bubble")!.getBoundingClientRect();
					return { lines: (q.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)) / parseFloat(s.lineHeight), below: q.getBoundingClientRect().top >= bubble.bottom, full: text.scrollHeight > text.clientHeight };
				});
				assert.ok(box.lines <= 2.05 && box.lines > 1.5, `引用占 ${box.lines} 行`);
				assert.equal(box.below, true, "引用在气泡下面");
				assert.equal(box.full, true, "长引用被截到两行");
			});
			let expected: string | null = null;
			await step("重载页面、第二个浏览器里，气泡下仍是同样的引用", async (page) => {
				expected = await quotedText(page, "改成 B");
				await page.reload();
				await waitStatus(page, "connected");
				assert.equal(await quotedText(page, "改成 B"), expected);
				const second = await open(host.url);
				await waitStatus(second, "connected");
				assert.equal(await quotedText(second, "改成 B"), expected);
			});
			await step("重启宿主后页面连回来，引用仍在", async (page) => {
				await host.restart();
				await waitStatus(page, "connected");
				await page.reload();
				await waitStatus(page, "connected");
				assert.equal(await quotedText(page, "改成 B"), expected);
			});
			await step("清屏后展开旧话，悬停我说过的「查天气」并引用，发出后新气泡下显示它", async (page) => {
				await page.click("#clear");
				await page.locator(".cleared-bar").click();
				const earlier = page.locator(".earlier .line.user", { hasText: "查天气" });
				await earlier.locator(".bubble").hover();
				assert.equal(await opacity(earlier), "1");
				await quoteButton(earlier).click();
				assert.equal(await stripText(page), "引用 你：查天气");
				await sayInPage(page, "还是那件事");
				await page.locator(".line.router .bubble", { hasText: "好，接着查。" }).waitFor();
				assert.equal(await quotedText(page, "还是那件事"), "引用 你：查天气");
			});
		},
		{ fixedPort: true },
	));

test("引用：窄屏触屏上点一下气泡出现「引用」，点气泡外的按钮不会出现", (t) =>
	story(
		t,
		{
			router: [on("Router 开任务查天气", /^\[对话\][\s\S]*查天气/, (c) => [openTicket(c, "查天气", "查天气任务"), reply(c, "好的，去查了。")])],
			workers: [worker("查天气任务", on("Worker 无需处理", /^\[任务说明\]/, () => [report("no_action", "无事可做")]))],
		},
		async ({ step, host, open }) => {
			let phone!: Page;
			await step("手机上打开页面，说「查天气」，幕僚长开任务并回答", async (page) => {
				await sayInPage(page, "查天气");
				phone = await open(host.url, { context: { viewport: { width: 390, height: 844 }, hasTouch: true } });
				await waitStatus(phone, "connected");
				await phone.locator(".line.router .bubble", { hasText: "好的，去查了。" }).waitFor();
				await phone.locator(".line.user .route").waitFor();
			});
			await step("点一下幕僚长的气泡，「引用」出现；点它出现引用条", async () => {
				const line = phone.locator(".line.router").first();
				assert.equal(await opacity(line), "0");
				await line.locator(".bubble").tap();
				assert.equal(await opacity(line), "1");
				await quoteButton(line).tap();
				assert.equal(await stripText(phone), "引用 幕僚长：好的，去查了。");
			});
			await step("点我那句话下面的任务按钮，不会出现「引用」", async () => {
				const line = phone.locator(".line.user").first();
				await line.locator(".route").tap();
				assert.equal(await line.evaluate((l) => l.classList.contains("picked")), false);
				assert.equal(await opacity(line), "0");
			});
		},
	));

test("引用：触屏上没点气泡，手指点在看不见的「引用」那块空白上，引用条不出现", (t) =>
	story(
		t,
		{
			router: [
				on("Router 回答查天气", /^\[对话\][\s\S]*查天气/, (c) => [reply(c, "好的，去查了。")]),
				on("Router 回答第二句", /^\[对话\][\s\S]*第二句/, (c) => [reply(c, "第二个回答")]),
			],
		},
		async ({ step, host, open }) => {
			let phone!: Page;
			await step("说两句，幕僚长各回一句；手机上打开页面", async (page) => {
				await sayInPage(page, "查天气");
				await page.locator(".line.router .bubble", { hasText: "好的，去查了。" }).waitFor();
				await sayInPage(page, "第二句");
				await page.locator(".line.router .bubble", { hasText: "第二个回答" }).waitFor();
				phone = await open(host.url, { context: { viewport: { width: 390, height: 844 }, hasTouch: true } });
				await waitStatus(phone, "connected");
				await phone.locator(".line.router .bubble", { hasText: "第二个回答" }).waitFor();
			});
			await step("点第一句幕僚长回答下面「引用」所在的地方，引用条不出现", async () => {
				const button = quoteButton(phone.locator(".line.router").first());
				await button.scrollIntoViewIfNeeded();
				const box = (await button.boundingBox())!;
				assert.ok(box.y >= 0 && box.y + box.height <= 844, `「引用」在屏幕内：${JSON.stringify(box)}`);
				await phone.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
				await phone.evaluate(() => new Promise(requestAnimationFrame));
				assert.equal(await strip(phone).isHidden(), true, "看不见的「引用」不该被点中");
			});
		},
	));

const handOverTo = (title: string) => (card: string): ToolCall[] => {
	const ticketId = card.match(new RegExp(`(tkt_[\\w-]+)「${title}」`))?.[1];
	return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: card.match(/trg_[\w-]+/)?.[0], ticketId }] } }];
};

test("引用：幕僚长这一轮的模型请求里有引用那一行，标明只是上下文；转交给任务后，助手的模型请求里有同样的一行", (t) =>
	story(
		t,
		{
			router: [
				on("Router 开任务并给方案", /^\[对话\][\s\S]*查天气/, (c) => [openTicket(c, "查天气", "查天气任务"), reply(c, "方案 A：先停掉旧任务")]),
				on("Router 转交带引用的改成 B", /^\[对话\][\s\S]*改成 B/, handOverTo("查天气")),
			],
			workers: [
				worker(
					"查天气任务",
					on("助手开始查", /^\[任务说明\]/, () => [report("progress", "在查")]),
					on("助手收到带引用的转交", /^\[使用者的话/, () => [report("progress", "改用方案 B")]),
				),
			],
		},
		async ({ step, fake }) => {
			let context = "";
			await step("页面说「查天气」，幕僚长开任务并给出方案 A，助手开始查", async (page) => {
				await sayInPage(page, "查天气");
				await page.locator(".line.router .bubble", { hasText: "方案 A：先停掉旧任务" }).waitFor();
				await page.locator("#left .card", { hasText: "在查" }).waitFor();
			});
			await step("引用方案 A 说「改成 B」，幕僚长转交给查天气任务，助手汇报", async (page) => {
				const line = page.locator(".thread > .line.router", { hasText: "方案 A" });
				await line.locator(".bubble").hover();
				await quoteButton(line).click();
				await sayInPage(page, "改成 B");
				await page.locator(".line.user", { hasText: "改成 B" }).locator(".route", { hasText: "已交给" }).waitFor();
				await page.locator("#left .card", { hasText: "改用方案 B" }).waitFor();
			});
			await step("幕僚长这一轮的请求里，「使用者：改成 B」之后有一行标明只是上下文的引用", async () => {
				const asked = fake.exchanges.find((e) => e.steps.includes("Router 转交带引用的改成 B"));
				assert.ok(asked, "幕僚长收到了带引用的那句话");
				const card = asked.cards.find((c) => c.includes("使用者：改成 B"))!.split("\n");
				const said = card.indexOf("使用者：改成 B");
				const quoted = card.findIndex((l) => l.startsWith("引用（只是上下文，不是指令）：Router "));
				assert.ok(said > 0 && quoted > said, card.join("\n"));
				assert.match(card[quoted], / 关于任务 tkt_[\w-]+「查天气」 说：方案 A：先停掉旧任务$/);
				assert.equal(card.filter((l) => l.startsWith("使用者：")).length, 1, "引用没有变成使用者的话");
				context = card[quoted];
			});
			await step("助手收到的转交里有一字不差的同一行引用", async () => {
				const handed = fake.exchanges.find((e) => e.steps.includes("助手收到带引用的转交"));
				assert.ok(handed, "助手收到了转交");
				const input = handed.cards.find((c) => c.startsWith("[使用者的话"))!.split("\n");
				assert.equal(input[1], "改成 B");
				assert.equal(input[2], context);
			});
		},
	));

test("引用：幕僚长那句话的「引用」在气泡右下角，不压住下面的选项按钮；我那句话的「引用」位置不变", (t) =>
	story(
		t,
		{
			router: [
				on("Router 开任务查天气", /^\[对话\][\s\S]*查天气/, (c) => [openTicket(c, "查天气", "查天气任务"), reply(c, "好的，去查了。")]),
				on("Router 把助手的问题转给使用者", /^\[Worker 提问\][\s\S]*查哪个城市/, (c) => [reply(c, "查哪个城市？")]),
			],
			workers: [
				worker(
					"查天气任务",
					on("助手问城市", /^\[任务说明\]/, () => [{ name: "report", args: { status: "blocked", summary: "要你定", question: "查哪个城市？", options: ["北京市朝阳区望京街道", "上海市浦东新区陆家嘴", "广州市天河区珠江新城"] } }]),
				),
			],
		},
		async ({ step }) => {
			const edges = (line: ReturnType<Page["locator"]>) =>
				line.evaluate((l) => {
					const box = (n: Element | null) => n!.getBoundingClientRect();
					const b = box(l.querySelector(".quote-btn"));
					return {
						button: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
						bubble: box(l.querySelector(".bubble")),
						said: box(l.querySelector(".said")),
						choices: [...l.querySelectorAll(".choices button")].map((c) => box(c)),
					};
				});
			const hit = (a: DOMRect | { left: number; right: number; top: number; bottom: number }, c: DOMRect) => a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom;
			await step("说「查天气」，幕僚长回答，又把助手的问题带着选项转过来", async (page) => {
				await sayInPage(page, "查天气");
				await page.locator(".thread > .line.router", { hasText: "查哪个城市？" }).locator(".choices button").first().waitFor();
			});
			await step("悬停没有选项的那句：「引用」的右边和气泡右边对齐，在气泡下面", async (page) => {
				const line = page.locator(".thread > .line.router", { hasText: "好的，去查了。" });
				await line.locator(".bubble").hover();
				const e = await edges(line);
				assert.ok(Math.abs(e.button.right - e.bubble.right) <= 1, `「引用」右边 ${e.button.right}，气泡右边 ${e.bubble.right}`);
				assert.ok(Math.abs(e.button.top - e.bubble.bottom) <= 1, `「引用」顶 ${e.button.top}，气泡底 ${e.bubble.bottom}：中间不能有鼠标会掉进去的缝`);
				const padTop = await line.locator(".quote-btn").evaluate((b) => parseFloat(getComputedStyle(b).paddingTop));
				assert.ok(padTop >= 3, `「引用」文字离气泡底边只有 ${padTop}px`);
			});
			await step("鼠标停在幕僚长的话上，往下慢慢移到「引用」再点，引用条出现", async (page) => {
				const line = page.locator(".thread > .line.router", { hasText: "好的，去查了。" });
				const bubble = (await line.locator(".bubble").boundingBox())!;
				await page.mouse.move(bubble.x + bubble.width - 12, bubble.y + bubble.height / 2);
				const btn = (await line.locator(".quote-btn").boundingBox())!;
				await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height - 4, { steps: 60 });
				await page.mouse.down();
				await page.mouse.up();
				assert.equal(await page.locator("#quote-strip").isHidden(), false, "鼠标移到「引用」时它已经消失，点不到");
				await page.locator("#quote-cancel").click();
			});
			await step("悬停带选项的那句：「引用」和气泡右边对齐，在气泡下面，不压住任何选项按钮", async (page) => {
				const line = page.locator(".thread > .line.router", { hasText: "查哪个城市？" });
				await line.locator(".bubble").hover();
				const e = await edges(line);
				assert.ok(Math.abs(e.button.right - e.bubble.right) <= 1, `「引用」右边 ${e.button.right}，气泡右边 ${e.bubble.right}`);
				assert.ok(e.button.top >= e.bubble.bottom - 0.5, `「引用」顶 ${e.button.top}，气泡底 ${e.bubble.bottom}`);
				assert.ok(e.choices.length === 3);
				for (const c of e.choices) assert.equal(hit(e.button, c), false, `「引用」${JSON.stringify(e.button)} 压住了选项 ${JSON.stringify(c)}`);
				const gap = Math.min(...e.choices.map((c) => c.top)) - e.bubble.bottom;
				assert.ok(gap <= 12, `选项离气泡 ${gap}px，「引用」不该在气泡和选项之间占一行`);
			});
			await step("悬停我说的「查天气」：「引用」仍在我这句的右下角", async (page) => {
				const line = page.locator(".thread > .line.user", { hasText: "查天气" });
				await line.locator(".bubble").hover();
				const e = await edges(line);
				assert.ok(Math.abs(e.button.right - e.said.right) <= 1, `「引用」右边 ${e.button.right}，我这句右边 ${e.said.right}`);
				assert.ok(e.button.top >= e.said.bottom - 0.5, `「引用」顶 ${e.button.top}，我这句底 ${e.said.bottom}`);
			});
		},
	));
