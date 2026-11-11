import assert from "node:assert/strict";
import test, { after } from "node:test";
import { on, openTicket, report, reply, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, sayInPage, story, tailnetProxy, waitStatus } from "./harness.ts";

after(closeBrowser);

const NAME = "psa-home.example.ts.net";
const CITY = "上海市浦东新区陆家嘴";
const handOverTo = (title: string) => (card: string): ToolCall[] => {
	const ticketId = card.match(new RegExp(`(tkt_[\\w-]+)「${title}」`))?.[1];
	return [{ name: "route", args: { decisions: [{ kind: "hand_over", triggerId: card.match(/trg_[\w-]+/)?.[0], ticketId }] } }];
};

test("经 tailnet 名字打开：手机宽度的页面连上、能发话、能点选项回答；错 token 401，没列入的名字 403", (t) =>
	story(
		t,
		{
			router: [
				on("Router 开任务查天气", /^\[对话\][\s\S]*查天气/, (c) => [openTicket(c, "查天气", "查天气任务"), reply(c, "好的，去查了。")]),
				on("Router 把助手的问题转给使用者", /^\[Worker 提问\][\s\S]*查哪个城市/, (c) => [reply(c, "查哪个城市？")]),
				on("Router 把回答转交给任务", new RegExp(`^\\[对话\\][\\s\\S]*回答任务「查天气」：${CITY}`), handOverTo("查天气")),
				on("Router 转述结果", /^\[Worker 汇报\][\s\S]*陆家嘴晴/, (c) => [reply(c, "陆家嘴晴，26 度。")]),
			],
			workers: [
				worker(
					"查天气任务",
					on("助手问城市", /^\[任务说明\]/, () => [{ name: "report", args: { status: "blocked", summary: "要你定", question: "查哪个城市？", options: ["北京市朝阳区望京街道", CITY] } }]),
					on("助手收到回答后汇报", new RegExp(`^\\[使用者的话[\\s\\S]*${CITY}`), () => [report("ready", "陆家嘴晴，26 度。")]),
				),
			],
		},
		async ({ step, host, open }) => {
			const token = host.url.searchParams.get("token")!;
			const listed = await tailnetProxy(host.url, NAME);
			const unlisted = await tailnetProxy(host.url, "other.example.ts.net");
			t.after(() => Promise.all([listed.close(), unlisted.close()]));
			let phone!: Awaited<ReturnType<typeof open>>;
			await step("390 像素宽经代理打开，连上，没有横向滚动", async () => {
				phone = await open(listed.url(`/?token=${token}`), { context: { viewport: { width: 390, height: 844 } } });
				await waitStatus(phone, "connected");
				assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
			});
			await step("经代理说「查天气」，幕僚长的回复从事件流到达", async () => {
				await sayInPage(phone, "查天气");
				await phone.locator(".line.router .bubble", { hasText: "好的，去查了。" }).waitFor();
			});
			await step("经代理点选项回答，回答进对话，助手汇报后幕僚长转述", async () => {
				await phone.locator(".thread > .line.router", { hasText: "查哪个城市？" }).locator(".choices button", { hasText: CITY }).click();
				await phone.locator(".line.user .bubble", { hasText: `回答任务「查天气」：${CITY}` }).waitFor();
				await phone.locator(".line.router .bubble", { hasText: "陆家嘴晴，26 度。" }).waitFor({ timeout: 15_000 });
			});
			await step("经代理用错的 token 或不带 token：页面和事件流都 401", async () => {
				for (const path of ["/?token=" + "0".repeat(64), "/", "/events?token=bad"]) {
					assert.equal((await phone.request.get(listed.url(path).href)).status(), 401, path);
				}
			});
			await step("没列入的名字：带对的 token 也 403，页面拿不到数据", async () => {
				for (const path of [`/?token=${token}`, `/events?token=${token}`, "/app.mjs"]) {
					const res = await phone.request.get(unlisted.url(path).href);
					assert.equal(res.status(), 403, path);
					assert.doesNotMatch(await res.text(), new RegExp(token));
				}
			});
		},
		{ fixedPort: true, config: { webHosts: [NAME] } },
	));
