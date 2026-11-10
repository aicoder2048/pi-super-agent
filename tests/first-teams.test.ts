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

test("看盘队每位成员只列它用得上的只读工具", () => {
	const tools = Object.fromEntries(teamOf(load(), "us-market")!.members.map((m) => [m.name, m.tools]));
	assert.deepEqual(tools, {
		"earnings-reader": ["read", "lookup", "web_get"],
		"market-analyst": ["read", "lookup", "web_get"],
		"news-researcher": ["read", "lookup", "web_get"],
		"technical-analyst": ["read", "lookup"],
	});
});

test("仓库自带的成员都写了工具清单，没有一位能写文件或改文件；看盘队的成员也不能执行命令", () => {
	const modules = load();
	const all = modules.modules.flatMap((m) => (m.team?.members ?? []).map((member) => ({ module: m.name, member })));
	assert.equal(all.length, 13);
	for (const { module, member } of all) {
		assert.ok(member.tools, `${member.file} 写了 tools`);
		const usable = memberTools("request", member.tools);
		assert.deepEqual(usable.filter((t) => t === "write" || t === "edit" || (module === "us-market" && t === "bash")), [], member.file);
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

test("看盘队每位成员的提示词都写了汇报格式：结论、证据、来源和时间", () => {
	for (const member of teamOf(load(), "us-market")!.members) {
		for (const part of ["结论", "证据", "来源和时间"]) assert.ok(member.prompt.includes(part), `${member.name} 的汇报格式有「${part}」`);
	}
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
