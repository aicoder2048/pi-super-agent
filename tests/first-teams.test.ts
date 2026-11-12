import assert from "node:assert/strict";
import { cpSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig, memberProviders } from "../src/host/config.ts";
import { Modules } from "../src/modules.ts";
import { memberTools } from "../src/worker/tools.ts";
import { piPackageRoot } from "../src/pi-runtime.mjs";
import { tempStateDir } from "./helpers/fakes.ts";

const REPO_MODULES = fileURLToPath(new URL("../modules", import.meta.url));
const defaultProviders = memberProviders(loadConfig(tempStateDir()));
const load = (dir = REPO_MODULES) => Modules.load([dir], { allowedProviders: defaultProviders, switches: { values: { "toy-market": true }, file: "config.json" } });

const WATCHERS = { "earnings-reader": "财报解读", "market-analyst": "行情分析师", "news-researcher": "新闻研究员", "technical-analyst": "技术分析师" };
const PI_EXPERTS = ["agent-expert", "cli-expert", "config-expert", "ext-expert", "keybinding-expert", "prompt-expert", "skill-expert", "theme-expert", "tui-expert"];
const teamOf = (modules: Modules, name: string) => modules.modules.find((m) => m.name === name)?.team;

test("仓库自带的两支队伍用默认配置的提供方都能加载：us-market 是美股看盘队的四位，pi-pi 是 Pi施工队的九位", () => {
	const modules = load();
	assert.deepEqual([...modules.book], [["pi-pi", { team: "Pi施工队", onRoster: true }], ["toy-market", { team: null, onRoster: true }], ["us-market", { team: "美股看盘队", onRoster: true }]]);
	assert.deepEqual(Object.fromEntries(teamOf(modules, "us-market")!.members.map((m) => [m.name, m.title])), WATCHERS);
	const experts = teamOf(modules, "pi-pi")!.members;
	assert.deepEqual(experts.map((m) => m.name), PI_EXPERTS);
	for (const m of experts) assert.match(m.title, /\p{Script=Han}/u, `${m.name} 有中文职称`);
});

test("幕僚长的名册里有这两个领域：行情、个股、财报、相关新闻和盯盘提醒归 us-market，Pi 的扩展、主题、技能、配置、提示模板和界面组件归 pi-pi", () => {
	const roster = load().rosterPrompt().split("\n");
	const line = (name: string) => roster.find((l) => l.startsWith(`- ${name}（`)) ?? "";
	for (const word of ["行情", "个股", "财报", "新闻", "盯盘提醒"]) assert.ok(line("us-market").includes(word), `us-market 的说明提到${word}：${line("us-market")}`);
	for (const word of ["Pi", "扩展", "主题", "技能", "配置", "提示模板", "界面组件"]) assert.ok(line("pi-pi").includes(word), `pi-pi 的说明提到${word}：${line("pi-pi")}`);
});

test("美股看盘队每位成员只列它用得上的只读工具；九位 Pi 专家都是读文件和读网页", () => {
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

test("Pi 专家的回复先写不超过 1500 字的摘要，再写完整内容：助手直接看到前 2000 字，更长的全文由宿主存成文件交给助手", () => {
	const experts = load().kitFor("pi-pi")!.crew;
	assert.equal(experts.length, 9);
	for (const member of experts) {
		assert.doesNotMatch(member.prompt, /under 1800 characters/, member.name);
		assert.match(member.prompt, /Start with a summary of at most 1500 characters/, member.name);
		assert.match(member.prompt, /the host saves a longer reply to a file/, member.name);
	}
});

test("Pi 专家只在一项任务里第一次被派活时读文档：同一任务里读过的还在上文里，再派给它时不从头重读", () => {
	for (const member of load().kitFor("pi-pi")!.crew) {
		assert.ok(!/Before answering ANY question, you MUST read/.test(member.prompt), `${member.name} 还要求每次回答前都读文档`);
		assert.match(member.prompt, /The first time you are dispatched in a task, read/, member.name);
		assert.match(member.prompt, /do not read those files again/, member.name);
	}
});

test("Pi 模块的派活技能写明是给助手的，成员不用读", () => {
	const skill = readFileSync(join(REPO_MODULES, "pi-pi/skills/pi-pi-desk/SKILL.md"), "utf8");
	const description = skill.split("\n").find((l) => l.startsWith("description:")) ?? "";
	assert.match(description, /成员不用读/);
});

test("Pi 模块的派活技能：写代码的任务由助手自己读文档、自己写，只把拿不准的具体疑点派给专家，一位专家一次问全", () => {
	const skill = readFileSync(join(REPO_MODULES, "pi-pi/skills/pi-pi-desk/SKILL.md"), "utf8");
	assert.match(skill, /代码由你写/);
	assert.doesNotMatch(skill, /答复也短/, "长回复现在有文件出路，不能再说专家的答复短");
	assert.match(skill, /一位专家一次问全/);
});

const PI_EXTENSION_SKILL = join(REPO_MODULES, "pi-pi/skills/pi-extension-basics/SKILL.md");

/** The members of one `export interface` in Pi's extension types, read from the installed Pi. */
function piInterface(name: string): Set<string> {
	const types = readFileSync(join(piPackageRoot(), "dist/core/extensions/types.d.ts"), "utf8").split("\n");
	const start = types.findIndex((l) => l.startsWith(`export interface ${name} `));
	assert.ok(start >= 0, `Pi 的类型定义里没有 ${name}`);
	const end = types.findIndex((l, i) => i > start && l === "}");
	return new Set(types.slice(start + 1, end).flatMap((l) => /^ {4}(?:readonly )?([a-zA-Z]+)[?<(:]/.exec(l)?.[1] ?? []));
}

test("Pi 扩展的常用知识提炼成 pi-pi 的技能：助手和九位专家都拿得到，写明依据哪个 Pi 版本的哪份文档", () => {
	const skill = readFileSync(PI_EXTENSION_SKILL, "utf8");
	assert.match(skill, /^---\nname: pi-extension-basics\ndescription: .+\n---\n/);
	assert.match(skill, /pi-coding-agent 1\.\d+\.\d+/);
	assert.match(skill, /docs\/extensions\.md/);
	const kit = load().kitFor("pi-pi")!;
	assert.ok(PI_EXTENSION_SKILL.startsWith(kit.skillsDir!));
	for (const member of kit.crew) assert.ok(member.skills.includes(kit.skillsDir!), member.name);
});

test("Pi 扩展技能里写到的每个 pi.*、ctx.* 和 ctx.ui.* 接口，本机安装的 Pi 的类型定义里都有", () => {
	const skill = readFileSync(PI_EXTENSION_SKILL, "utf8");
	const named = (pattern: RegExp) => new Set([...skill.matchAll(pattern)].map((m) => m[1]));
	const api = piInterface("ExtensionAPI");
	const ctx = new Set([...piInterface("ExtensionContext"), ...piInterface("ExtensionCommandContext"), ...piInterface("ExtensionToolContext")]);
	const ui = piInterface("ExtensionUIContext");
	const piNames = named(/\bpi\.([a-zA-Z]+)\b/g);
	assert.ok(piNames.size >= 10, `技能只写到 ${piNames.size} 个 pi.* 接口`);
	for (const name of piNames) assert.ok(api.has(name), `pi.${name} 不在 ExtensionAPI 里`);
	for (const name of named(/\bctx\.(?!ui\.)([a-zA-Z]+)\b/g)) assert.ok(ctx.has(name), `ctx.${name} 不在 ExtensionContext 里`);
	for (const name of named(/\bctx\.ui\.([a-zA-Z]+)\b/g)) assert.ok(ui.has(name), `ctx.ui.${name} 不在 ExtensionUIContext 里`);
});

test("Pi 扩展技能的原文索引：每一项都是本机 extensions.md 里的标题；教的 grep 写法用 ripgrep 的正则，真能找到标题", () => {
	const skill = readFileSync(PI_EXTENSION_SKILL, "utf8");
	const doc = readFileSync(join(piPackageRoot(), "docs/extensions.md"), "utf8").split("\n");
	const headings = doc.flatMap((l) => /^#{2,4} (.+)$/.exec(l)?.[1] ?? []);
	const index = skill.slice(skill.indexOf("\n下面每一项都是"));
	const items = [...index.matchAll(/^- [^：]+：(.+)$/gm)].flatMap((m) => [...m[1].split("（")[0].matchAll(/`([^`]+)`/g)].map((x) => x[1]));
	assert.ok(items.length >= 50, `索引只有 ${items.length} 项`);
	for (const item of items) {
		const found = /^(pi|ctx)\./.test(item) ? headings.some((h) => h.startsWith(item)) : headings.includes(item);
		assert.ok(found, `extensions.md 里没有标题「${item}」`);
	}
	assert.ok(!skill.includes("\\|"), "ripgrep 里 \\| 是字面的竖线，不是「或」");
	const example = /`(\^#\{2,4\} \([^`]+\))`/.exec(skill)?.[1];
	assert.ok(example, "技能里有一次找几个标题的例子");
	const hits = doc.filter((l) => new RegExp(example).test(l));
	assert.ok(hits.length >= 2, `例子 ${example} 只找到 ${hits.length} 个标题`);
});

test("写扩展和界面的两位专家、派活技能都先指向扩展技能，不够时再读原文", () => {
	const crew = load().kitFor("pi-pi")!.crew;
	for (const name of ["ext-expert", "tui-expert"]) assert.match(crew.find((m) => m.name === name)!.prompt, /pi-extension-basics/, name);
	assert.match(readFileSync(join(REPO_MODULES, "pi-pi/skills/pi-pi-desk/SKILL.md"), "utf8"), /pi-extension-basics/);
});

test("看盘技能不说小时线一定看得到开盘：收盘后查到的小时线可能从中午才开始", () => {
	const skill = readFileSync(join(REPO_MODULES, "us-market/skills/us-market-desk/SKILL.md"), "utf8");
	assert.ok(!skill.includes("看得到开盘"));
	assert.match(skill, /开盘价.*`day`/);
});

test("看盘技能有一节盯盘条件：领队自己用 tripwire 不派活，改之前不读网页，中文名换成代码，请使用者看网页上「盯盘条件（只在本机）」那一行或左栏关注的来源，写明默认值，汇报不复述成本价和股数，被拒照实转告", () => {
	const skill = readFileSync(join(REPO_MODULES, "us-market/skills/us-market-desk/SKILL.md"), "utf8");
	const section = skill.split(/\n(?=## )/).find((s) => s.startsWith("## 盯盘条件")) ?? "";
	for (const pattern of [/`tripwire`/, /不派/, /代码/, /盯盘条件（只在本机）/, /关注的来源/, /either/, /5 和 20/, /不复述成本价和股数/, /拒绝/, /web_get/]) assert.match(section, pattern);
	assert.doesNotMatch(skill, /收据/);
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

test("美股看盘队每位成员的汇报格式是三行要填的标题：结论、证据、来源和时间", () => {
	for (const member of teamOf(load(), "us-market")!.members) {
		const format = member.prompt.slice(member.prompt.indexOf("汇报格式"));
		for (const heading of ["结论：", "证据：", "来源和时间："]) assert.ok(format.split("\n").some((line) => line.startsWith(heading)), `${member.name} 的汇报格式有一行以「${heading}」开头`);
	}
});

test("美股看盘队每位成员的汇报格式写了全文不超过 600 字，链接不计", () => {
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

test("大波动规则不写「团队：」，它开的任务属于 us-market 领域，也就归美股看盘队", () => {
	const modules = load();
	assert.ok(modules.ruleAllows("us-market/big-move", "us-market"));
	assert.equal(modules.book.get("us-market")?.team, "美股看盘队");
});

test("拿掉 us-market 模块：加载不报错，它的领域、队伍和成员一起消失，pi-pi 不受影响", () => {
	const dir = join(tempStateDir(), "modules");
	cpSync(REPO_MODULES, dir, { recursive: true });
	rmSync(join(dir, "us-market"), { recursive: true });
	const modules = load(dir);
	assert.deepEqual([...modules.book], [["pi-pi", { team: "Pi施工队", onRoster: true }], ["toy-market", { team: null, onRoster: true }]]);
	assert.equal(modules.kitFor("us-market"), undefined);
	assert.ok(!modules.rosterPrompt().includes("us-market"));
	assert.deepEqual(modules.rulesFor("us-market"), []);
	assert.equal(modules.kitFor("pi-pi")!.crew.length, 9);
});

test("只有 us-market 的 module.json 开了 lookup 和 tripwire：美股看盘队的助手和四位成员都能查数据，助手能改盯盘条件，pi-pi 和 toy-market 的都不能", () => {
	const modules = load();
	const kit = modules.kitFor("us-market")!;
	assert.deepEqual(kit.granted, ["lookup", "tripwire"]);
	for (const member of kit.crew) assert.ok(memberTools("request", member.tools).includes("lookup"), member.name);
	for (const domain of ["pi-pi", "toy-market"]) {
		const other = modules.kitFor(domain)!;
		assert.deepEqual(other.granted, [], domain);
		for (const member of other.crew) assert.ok(!memberTools("request", member.tools).includes("lookup"), member.name);
	}
});
