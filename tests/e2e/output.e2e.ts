import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { bash, dispatch, newApp, on, openTicket, reply, report, worker, write, type ToolCall } from "./fake-model.ts";
import { closeBrowser, sayInPage, story, waitStatus } from "./harness.ts";

after(closeBrowser);

const JOKE = { title: "做笑话扩展", brief: "做一个讲笑话的 Pi 扩展" };
const WEATHER = { title: "做天气扩展", brief: "做一个查天气的 Pi 扩展" };
const MEMBER_TASK = "在下面的应用目录里写 extensions/joke.ts";
const READY = "笑话扩展做好了";
const ROUTER_SAYS = "笑话扩展做好了。另外有文件写到了成品目录之外：stray.md；可能还有 stray-bash.md。";

const STATE_FILES = {
	"modules/dev/module.json": JSON.stringify({ name: "dev", title: "开发", description: "写 Pi 扩展和小工具", team: "开发队" }),
	"modules/dev/agents/ext.md": "---\nname: ext-expert\ntitle: 扩展专家\ndescription: 写 Pi 扩展\ntools: read, write, bash\n---\n你是扩展专家。\n",
};

const openInDev = (card: string, task: { title: string; brief: string }): ToolCall => {
	const call = openTicket(card, task.title, task.brief);
	return { ...call, args: { decisions: (call.args.decisions as object[]).map((d) => ({ ...d, domain: "dev" })) } };
};
const appDir = (card: string) => (JSON.parse(card.slice(card.indexOf("{"))) as { dir: string }).dir;
const dirInTask = (card: string) => card.match(/目录：(\S+)/)![1];

test("助手用 new_app 开应用、把目录派给成员；成员和助手写到成品目录之外的地方，汇报卡片和看板都告诉使用者；删掉应用目录再重启，编号也不复用", (t) => {
	let jokeDir = "";
	return story(
		t,
		{
			router: [
				on("Router 开做笑话扩展的任务", /^\[对话\][\s\S]*讲笑话/, (c) => [openInDev(c, JOKE), reply(c, "已交给开发队")]),
				on("Router 收到带宿主检查的汇报，一句话告诉使用者", /^\[Worker 汇报\][\s\S]*宿主检查/, (c) => [reply(c, ROUTER_SAYS)]),
				on("Router 开做天气扩展的任务", /^\[对话\][\s\S]*天气扩展/, (c) => [openInDev(c, WEATHER), reply(c, "已交给开发队")]),
				on("Router 转告天气扩展做好了", /^\[Worker 汇报\][\s\S]*天气扩展做好了/, (c) => [reply(c, "天气扩展做好了")]),
			],
			workers: [
				worker(
					JOKE.brief,
					on("领队开应用", /^\[任务说明\]/, () => [newApp("joke")]),
					on("领队把目录写进任务派给成员", /^\[应用目录\]/, (c) => {
						jokeDir = appDir(c);
						return [dispatch("ext-expert", `${MEMBER_TASK}\n目录：${jokeDir}`)];
					}),
					on("领队收到成员回复，用 bash 往状态目录里写了一份，再汇报", /^\[成员回复\]/, () => [bash("echo note > ../../stray-bash.md"), report("ready", `${READY}，在 ${jokeDir}/extensions/joke.ts`)]),
				),
				worker(MEMBER_TASK, on("成员在应用里写扩展，也往状态目录里写了一份", /^\[派活\] 扩展专家/, (c) => [write(`${dirInTask(c)}/extensions/joke.ts`, "export default () => {};\n"), write("../../stray.md", "写错地方了\n")])),
				worker(
					WEATHER.brief,
					on("第二个任务的领队开应用", /^\[任务说明\]/, () => [newApp("weather")]),
					on("第二个任务的领队汇报", /^\[应用目录\]/, (c) => [report("ready", `天气扩展做好了，在 ${appDir(c)}`)]),
				),
			],
		},
		async ({ step, fake, stateDir, host }) => {
			const output = join(stateDir, "output");
			await step("宿主启动时按分类表写好成品目录的 README", async () => {
				const readme = readFileSync(join(output, "README.md"), "utf8");
				for (const dir of ["apps/", "docs/analysis/", "docs/reports/", "data/", "scripts/", "media/", "misc/"]) assert.ok(readme.includes(dir), dir);
			});
			await step("页面要一个笑话扩展，幕僚长转告做好了，也说了写到成品目录之外的文件", async (page) => {
				await sayInPage(page, "做一个讲笑话的扩展");
				await page.locator(".line.router .bubble", { hasText: "写到了成品目录之外" }).waitFor({ timeout: 20_000 });
			});
			await step("成员把扩展写进了 app-001-joke，写错地方的两份也真的落在状态目录里", async () => {
				assert.equal(jokeDir, join(output, "apps", "app-001-joke"));
				assert.ok(existsSync(join(jokeDir, "extensions", "joke.ts")));
				assert.ok(existsSync(join(stateDir, "stray.md")) && existsSync(join(stateDir, "stray-bash.md")));
			});
			await step("Router 收到的汇报卡片有「宿主检查」一段：成员的 write 和领队的 bash 都在，应用里的那份不在", async () => {
				const card = fake.exchanges.filter((e) => e.conversation === "router").flatMap((e) => e.cards).find((c) => c.startsWith("[Worker 汇报]") && c.includes("宿主检查"))!;
				assert.match(card, /宿主检查（只告知，没有拦下）：这次汇报之前，有 1 处写到了成品目录和任务目录之外，另有 1 处可能写到了那里（从命令推测）$/m);
				assert.match(card, /^- 写入 \S+\/stray\.md（成员 ext-expert · write）$/m);
				assert.match(card, /^- 可能写入 \S+\/stray-bash\.md（助手 · bash：echo note > \.\.\/\.\.\/stray-bash\.md）$/m);
				assert.doesNotMatch(card, /extensions\/joke\.ts（/);
			});
			await step("页面的任务卡片写着「写到成品目录之外 1 处，另有 1 处可能」：bash 推测的不算成确切写入", async (page) => {
				const line = page.locator("#left .card, #done .card", { hasText: JOKE.title }).locator(".outside");
				const text = (await line.textContent()) ?? "";
				assert.match(text, /^写到成品目录之外 1 处，另有 1 处可能：\S+、\S+$/);
				assert.ok(text.includes("/stray.md") && text.includes("/stray-bash.md"), text);
			});
			await step("领队和成员的系统提示词里有成品目录的绝对路径：领队的有 new_app，成员的是请领队给目录", async () => {
				const helper = fake.systemPromptOf(JOKE.brief);
				const member = fake.systemPromptOf(MEMBER_TASK);
				assert.ok(helper.includes(`${output}/apps/`) && member.includes(`${output}/apps/`));
				assert.match(helper, /用 new_app 要目录/);
				assert.match(member, /请领队给/);
				assert.doesNotMatch(member, /new_app/);
			});
			await step("删掉 app-001-joke 再重启宿主，页面连回来", async (page) => {
				rmSync(jokeDir, { recursive: true });
				await host.restart();
				await waitStatus(page, "connected");
			});
			await step("新任务开应用拿到 app-002-weather：编号不复用；没有外写的任务卡片没有那一行", async (page) => {
				await sayInPage(page, "再做一个天气扩展");
				await page.locator(".line.router .bubble", { hasText: "天气扩展做好了" }).waitFor({ timeout: 20_000 });
				assert.ok(existsSync(join(output, "apps", "app-002-weather")));
				assert.ok(!existsSync(join(output, "apps", "app-001-weather")));
				assert.equal(await page.locator("#left .card, #done .card", { hasText: WEATHER.title }).locator(".outside").count(), 0);
			});
		},
		{ files: STATE_FILES, fixedPort: true },
	);
});
