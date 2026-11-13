import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { on, openTicket, reply, report, worker, type Script, type ToolCall } from "./fake-model.ts";
import { REPO, packageFiles, sayInPage } from "./harness.ts";

const STOCK_TA = join(REPO, "docs/modules/examples/stock-ta");

export const FILES = {
	...packageFiles(STOCK_TA, "stock-ta"),
	"modules/alerts/module.json": JSON.stringify({ name: "alerts", sources: [{ name: "e2e-alerts", feed: { kind: "e2e-alerts" } }] }),
};

export const WEATHER = { title: "查天气", brief: "查天气任务", city: "上海市浦东新区陆家嘴" };
export const DIGEST = { title: "今日新闻摘要", brief: "整理今天的新闻摘要" };
export const NEWS = { title: "听证会新闻", brief: "汇总黄仁勋听证会的新闻" };

const handOverTo = (title: string) => (card: string): ToolCall[] => {
	const ticketId = card.match(new RegExp(`(tkt_[\\w-]+)「${title}」`))?.[1];
	return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: card.match(/trg_[\w-]+/)?.[0], ticketId }] } }];
};

export const weatherRouter = () => [
	on("Router 开任务查天气", /^\[对话\][\s\S]*使用者：查天气/, (c) => [openTicket(c, WEATHER.title, WEATHER.brief), reply(c, "好的，去查了。")]),
	on("Router 把助手的问题转给使用者", /^\[Worker 提问\][\s\S]*查哪个城市/, (c) => [reply(c, "查哪个城市？")]),
	on("Router 把点选转交给任务", new RegExp(`^\\[对话\\][\\s\\S]*回答任务「查天气」：${WEATHER.city}`), handOverTo(WEATHER.title)),
];
export const askCity = () => on("助手问城市", /^\[任务说明\]/, () => [{ name: "report", args: { status: "blocked", summary: "要你定", question: "查哪个城市？", options: ["北京市朝阳区望京街道", WEATHER.city] } }]);
export const gotCity = (answer: ToolCall) => on("助手收到回答", new RegExp(`^\\[使用者的话[\\s\\S]*${WEATHER.city}`), () => [answer]);

export const SCRIPT = (): Script => ({
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

export const tab = (page: Page, key: string) => page.locator(`#tab-${key}`);
export const selectedTab = (page: Page) => page.locator('.tab[aria-selected="true"]').getAttribute("data-tab");
export const tabKeys = (page: Page) => page.locator("#tabs .tab").evaluateAll((tabs) => tabs.map((t) => (t as HTMLElement).dataset.tab));
export const count = async (page: Page, key: string) => Number(await tab(page, key).locator(".count").textContent());
export const leftCard = (page: Page, title: string) => page.locator("#left .card", { hasText: title });
export async function setUp(page: Page): Promise<void> {
	await sayInPage(page, "整理一份今日新闻摘要");
	await page.locator("#done .card", { hasText: DIGEST.title }).waitFor({ state: "attached", timeout: 15_000 });
	await sayInPage(page, "看下黄仁勋听证会的新闻");
	await leftCard(page, "找到三条新闻").waitFor({ state: "attached", timeout: 15_000 });
	await sayInPage(page, "查天气");
	await leftCard(page, WEATHER.title).locator(".choices button").first().waitFor({ state: "attached", timeout: 15_000 });
}

export async function firstFrame(url: URL): Promise<{ text: string; frame: Record<string, unknown> }> {
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

export async function toggleAndCountPushes(url: URL, name: string, times: number): Promise<number> {
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

export async function renderCost(page: Page, url: URL): Promise<{ pushes: number; msPerPush: number }> {
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
