import assert from "node:assert/strict";
import test, { after } from "node:test";
import { dispatch, on, openTicket, reply, report, worker, type ToolCall } from "./fake-model.ts";
import { closeBrowser, sayInPage, story } from "./harness.ts";

after(closeBrowser);

const NEWS = { title: "听证会新闻", brief: "汇总黄仁勋听证会的新闻" };
const MAIL = { title: "回邮件", brief: "回一下房东的邮件" };
const WEATHER = { title: "查天气", brief: "查明天的天气" };
const FEED = { title: "核对新报道", brief: "核对刚进来的听证会报道" };
const MEMBER_TASK = "查这条报道的出处";
const NEWS_SKILL = "核对新闻出处的步骤（端到端新闻技能）";
const MAIL_SKILL = "回信的格式（端到端邮件技能）";
const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const STATE_FILES = {
	"modules/news/module.json": JSON.stringify({ name: "news", title: "新闻", description: "查新闻、核对报道来源", team: "新闻队", sources: [{ name: "rss" }] }),
	"modules/news/rules.md": "## hearing\n来源: rss\n有听证会的新报道就开任务核对。\n",
	"modules/news/skills/verify-news/SKILL.md": skill("verify-news", NEWS_SKILL),
	"modules/news/agents/news.md": "---\nname: news-researcher\ntitle: 新闻研究员\ndescription: 查新闻、核对报道来源\n---\n你是新闻研究员。\n",
	"modules/mail/module.json": JSON.stringify({ name: "mail", title: "邮件", description: "收发和整理邮件" }),
	"modules/mail/skills/reply-mail/SKILL.md": skill("reply-mail", MAIL_SKILL),
};

const inDomain = (call: ToolCall, domain: string): ToolCall => ({ ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain })) } });
const openByRule = (card: string): ToolCall => ({
	name: "route",
	args: { decisions: [{ kind: "open_ticket", basis: "rule", ruleId: "news/hearing", triggerId: card.match(/trg_[\w-]+/)?.[0], title: FEED.title, brief: FEED.brief, threads: ["thr_rss:hearing"] }] },
});

test("任务属于哪个领域，助手和成员就带哪个模块的技能；模块规则开的任务不写「团队：」也归这个模块；没有成员的领域是带技能的单个助手；没有领域就是普通助手", (t) =>
	story(
		t,
		{
			router: [
				on("Router 把新闻交给新闻领域", /^\[对话\][\s\S]*听证会/, (c) => [inDomain(openTicket(c, NEWS.title, NEWS.brief), "news"), reply(c, "已交给新闻队")]),
				on("Router 把邮件交给邮件领域", /^\[对话\][\s\S]*邮件/, (c) => [inDomain(openTicket(c, MAIL.title, MAIL.brief), "mail"), reply(c, "已安排")]),
				on("Router 开天气任务，不填领域", /^\[对话\][\s\S]*天气/, (c) => [openTicket(c, WEATHER.title, WEATHER.brief), reply(c, "已安排")]),
				on("Router 按新闻模块的规则开任务，不填领域", /^\[候选触发\]/, (c) => [openByRule(c)]),
			],
			workers: [
				worker(
					NEWS.brief,
					on("新闻助手派给新闻研究员", /^\[任务说明\]/, () => [dispatch("news-researcher", MEMBER_TASK)]),
					on("新闻助手收到回复后汇报", /^\[成员回复\]/, () => [report("progress", "出处是国会直播")]),
				),
				worker(MEMBER_TASK, on("新闻研究员回复", /^\[派活\] 新闻研究员\n/, () => "出处是国会直播。")),
				worker(MAIL.brief, on("邮件任务汇报", /^\[任务说明\]/, () => [report("progress", "正在写回信")])),
				worker(WEATHER.brief, on("天气任务汇报", /^\[任务说明\]/, () => [report("progress", "正在查")])),
				worker(FEED.brief, on("规则任务汇报", /^\[任务说明\]/, () => [report("progress", "正在核对")])),
			],
		},
		async ({ step, fake, cli }) => {
			await step("页面说三件事，各有一枚小卡", async (page) => {
				await sayInPage(page, "看下黄仁勋听证会的新闻");
				await sayInPage(page, "回一下房东的邮件");
				await sayInPage(page, "查一下天气");
				await page.waitForFunction(() => document.querySelectorAll("#helpers .helper-chip").length === 3);
				await page.locator("#left .card", { hasText: "出处是国会直播" }).waitFor();
				await page.locator("#left .card", { hasText: "正在写回信" }).waitFor();
				await page.locator("#left .card", { hasText: "正在查" }).waitFor();
			});
			await step("对话里开的新闻任务：助手的提示词里有新闻模块的技能，它派的成员也有；都没有邮件模块的", () => {
				for (const conversation of [NEWS.brief, MEMBER_TASK]) {
					assert.ok(fake.systemPromptOf(conversation).includes(NEWS_SKILL), conversation);
					assert.ok(!fake.systemPromptOf(conversation).includes(MAIL_SKILL), conversation);
				}
			});
			await step("新闻领域有成员：小卡是四字名加模块的队名「新闻队 #1」", async (page) => {
				const name = (await page.locator("#helpers .helper-chip", { hasText: "新闻队 #1" }).locator(".name").textContent()) ?? "";
				assert.equal([...name].length, 4, name);
			});
			await step("邮件领域没有成员：两字名的对话助手，带着邮件模块的技能，没有派活工具", async (page) => {
				const name = (await page.locator("#left .card", { hasText: MAIL.title }).locator(".by").textContent()) ?? "";
				assert.match(name, /^.. · 对话助手 #\d$/u);
				assert.ok(fake.systemPromptOf(MAIL.brief).includes(MAIL_SKILL));
				assert.ok(!fake.exchanges.find((e) => e.conversation === MAIL.brief)!.tools.includes("dispatch_agent"));
			});
			await step("没有领域的天气任务：普通的对话助手，哪个模块的技能都不带", async (page) => {
				assert.match((await page.locator("#left .card", { hasText: WEATHER.title }).locator(".by").textContent()) ?? "", /^.. · 对话助手 #\d$/u);
				assert.ok(!fake.systemPromptOf(WEATHER.brief).includes(NEWS_SKILL) && !fake.systemPromptOf(WEATHER.brief).includes(MAIL_SKILL));
			});
			await step("rss 来了一条报道，幕僚长按新闻模块的规则开任务、没填领域：任务归新闻领域，是「新闻队 #2」，助手带着新闻技能", async (page) => {
				await cli(["src/cli/drop.ts", "rss", "hearing", "黄仁勋听证会有新报道"]);
				const card = page.locator("#left .card", { hasText: FEED.title });
				await card.locator(".by", { hasText: "新闻队 #2" }).waitFor();
				await page.locator("#left .card", { hasText: "正在核对" }).waitFor();
				assert.ok(fake.systemPromptOf(FEED.brief).includes(NEWS_SKILL));
				assert.ok(fake.exchanges.find((e) => e.conversation === FEED.brief)!.tools.includes("dispatch_agent"));
			});
		},
		{ files: STATE_FILES, config: { dispatchTimeoutSeconds: 30 } },
	));
