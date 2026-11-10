import assert from "node:assert/strict";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig, memberProviders } from "../src/host/config.ts";
import { Modules } from "../src/modules.ts";
import { memberTools } from "../src/worker/tools.ts";
import { tempStateDir } from "./helpers/fakes.ts";

const REPO_MODULES = fileURLToPath(new URL("../modules", import.meta.url));
const defaultProviders = memberProviders(loadConfig(tempStateDir()));
const load = (dir = REPO_MODULES) => Modules.load([dir], { allowedProviders: defaultProviders });

const WATCHERS = { "earnings-reader": "财报解读", "market-analyst": "行情分析师", "news-researcher": "新闻研究员", "technical-analyst": "技术分析师" };
const PI_EXPERTS = ["agent-expert", "cli-expert", "config-expert", "ext-expert", "keybinding-expert", "prompt-expert", "skill-expert", "theme-expert", "tui-expert"];
const teamOf = (modules: Modules, name: string) => modules.modules.find((m) => m.name === name)?.team;

test("仓库自带的两支队伍用默认配置的提供方都能加载：us-market 是看盘队的四位，pi-pi 是 Pi专家队的九位", () => {
	const modules = load();
	assert.deepEqual([...modules.book], [["pi-pi", { team: "Pi专家队", onRoster: true }], ["toy-market", { team: null, onRoster: true }], ["us-market", { team: "看盘队", onRoster: true }]]);
	assert.deepEqual(Object.fromEntries(teamOf(modules, "us-market")!.members.map((m) => [m.name, m.title])), WATCHERS);
	const experts = teamOf(modules, "pi-pi")!.members;
	assert.deepEqual(experts.map((m) => m.name), PI_EXPERTS);
	for (const m of experts) assert.match(m.title, /\p{Script=Han}/u, `${m.name} 有中文职称`);
});

test("幕僚长的名册里有这两个领域：行情、个股、财报和相关新闻归 us-market，Pi 的扩展、主题、技能、配置、提示模板和界面组件归 pi-pi", () => {
	const roster = load().rosterPrompt().split("\n");
	const line = (name: string) => roster.find((l) => l.startsWith(`- ${name}（`)) ?? "";
	for (const word of ["行情", "个股", "财报", "新闻"]) assert.ok(line("us-market").includes(word), `us-market 的说明提到${word}：${line("us-market")}`);
	for (const word of ["Pi", "扩展", "主题", "技能", "配置", "提示模板", "界面组件"]) assert.ok(line("pi-pi").includes(word), `pi-pi 的说明提到${word}：${line("pi-pi")}`);
});

test("看盘队每位成员只列它用得上的只读工具；九位 Pi 专家都是读文件和读网页", () => {
	const tools = (module: string) => Object.fromEntries(teamOf(load(), module)!.members.map((m) => [m.name, m.tools]));
	assert.deepEqual(tools("us-market"), {
		"earnings-reader": ["read", "lookup", "web_get"],
		"market-analyst": ["read", "lookup", "web_get"],
		"news-researcher": ["read", "lookup", "web_get"],
		"technical-analyst": ["read", "lookup"],
	});
	assert.deepEqual(tools("pi-pi"), Object.fromEntries(PI_EXPERTS.map((name) => [name, ["read", "grep", "find", "ls", "web_get"]])));
});

const shipped = () => load().modules.flatMap((m) => m.team?.members ?? []);

test("仓库自带的十三位成员都写了工具清单，没有一位能执行命令、写文件或改文件", () => {
	const all = shipped();
	assert.equal(all.length, 13);
	for (const member of all) {
		assert.ok(member.tools, `${member.file} 写了 tools`);
		assert.deepEqual(memberTools("request", member.tools).filter((t) => ["bash", "write", "edit"].includes(t)), [], member.file);
	}
});

test("仓库自带的成员提示词不让成员跑 firecrawl 或 curl", () => {
	for (const member of shipped()) {
		for (const word of ["firecrawl", "curl "]) assert.ok(!member.prompt.includes(word), `${member.file} 的正文里有「${word.trim()}」`);
	}
});

test("看盘模块的经验放在它的技能里：us-market 的任务，助手拿到这份技能，每位成员也拿到，而且都有读它的工具", () => {
	const kit = load().kitFor("us-market")!;
	assert.equal(kit.skillsDir, join(REPO_MODULES, "us-market/skills"));
	assert.ok(existsSync(join(kit.skillsDir, "us-market-desk/SKILL.md")));
	assert.equal(kit.crew.length, 4);
	for (const member of kit.crew) {
		assert.deepEqual(member.skills, [kit.skillsDir], member.name);
		assert.ok(memberTools("inference", member.tools).includes("read"), `${member.name} 没有 read 就读不到技能，Pi 也不会把技能写进它的提示词`);
	}
});

test("Pi 模块的经验放在它的技能里：pi-pi 的任务，助手拿到这份技能，九位专家也拿到，而且都有读它的工具", () => {
	const kit = load().kitFor("pi-pi")!;
	assert.equal(kit.skillsDir, join(REPO_MODULES, "pi-pi/skills"));
	assert.ok(existsSync(join(REPO_MODULES, "pi-pi/skills/pi-pi-desk/SKILL.md")));
	assert.equal(kit.crew.length, 9);
	for (const member of kit.crew) {
		assert.deepEqual(member.skills, [kit.skillsDir], member.name);
		assert.ok(memberTools("inference", member.tools).includes("read"), member.name);
	}
});

test("看盘队每位成员的汇报格式是三行要填的标题：结论、证据、来源和时间", () => {
	for (const member of teamOf(load(), "us-market")!.members) {
		const format = member.prompt.slice(member.prompt.indexOf("汇报格式"));
		for (const heading of ["结论：", "证据：", "来源和时间："]) assert.ok(format.split("\n").some((line) => line.startsWith(heading)), `${member.name} 的汇报格式有一行以「${heading}」开头`);
	}
});

test("看盘队每位成员的汇报格式写了全文不超过 600 字，链接不计", () => {
	for (const member of teamOf(load(), "us-market")!.members) {
		const format = member.prompt.slice(member.prompt.indexOf("汇报格式"));
		assert.match(format, /全文不超过 600 字，链接不计/, member.name);
	}
});

test("大波动规则要任务说明照抄触发里的代码、涨跌幅、档位、现价和报价时间，并写明现在的报价和触发是否一致", () => {
	const rule = load().allRules().find((r) => r.id === "us-market/big-move")!.text;
	for (const field of ["代码", "涨跌幅", "档位", "现价", "报价时间"]) assert.ok(rule.includes(field), `任务说明要带触发的${field}`);
	assert.match(rule, /照抄/);
	assert.match(rule, /是否一致/);
});

test("大波动规则不写「团队：」，它开的任务属于 us-market 领域，也就归看盘队", () => {
	const modules = load();
	assert.ok(modules.ruleAllows("us-market/big-move", "us-market"));
	assert.equal(modules.book.get("us-market")?.team, "看盘队");
});

test("拿掉 us-market 模块：加载不报错，它的领域、队伍和成员一起消失，pi-pi 不受影响", () => {
	const dir = join(tempStateDir(), "modules");
	cpSync(REPO_MODULES, dir, { recursive: true });
	rmSync(join(dir, "us-market"), { recursive: true });
	const modules = load(dir);
	assert.deepEqual([...modules.book], [["pi-pi", { team: "Pi专家队", onRoster: true }], ["toy-market", { team: null, onRoster: true }]]);
	assert.equal(modules.kitFor("us-market"), undefined);
	assert.ok(!modules.rosterPrompt().includes("us-market"));
	assert.deepEqual(modules.rulesFor("us-market"), []);
	assert.equal(modules.kitFor("pi-pi")!.crew.length, 9);
});
