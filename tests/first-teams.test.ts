import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig, memberProviders } from "../src/host/config.ts";
import { Modules } from "../src/modules.ts";
import { memberTools } from "../src/worker/tools.ts";
import { piPackageRoot } from "../src/pi-runtime.mjs";
import { servedAsHost, tempStateDir } from "./helpers/fakes.ts";

const REPO_MODULES = fileURLToPath(new URL("../modules", import.meta.url));
const RETIRED_MODULES = fileURLToPath(new URL("./fixtures/retired", import.meta.url));
const defaultProviders = memberProviders(loadConfig(tempStateDir()));
const load = (...dirs: string[]) => servedAsHost(Modules.load(dirs.length ? dirs : [REPO_MODULES], { allowedProviders: defaultProviders }));

const PI_EXPERTS = ["agent-expert", "cli-expert", "config-expert", "ext-expert", "keybinding-expert", "prompt-expert", "skill-expert", "theme-expert", "tui-expert"];
const teamOf = (modules: Modules, name: string) => modules.modules.find((m) => m.name === name)?.team;

test("仓库自带的队伍用默认配置的提供方都能加载：pi-pi 是 Pi施工队的九位", () => {
	const modules = load();
	assert.deepEqual(Object.fromEntries([...modules.book].map(([name, { team, onRoster }]) => [name, { team, onRoster }])), { "module-builder": { team: "模块工坊", onRoster: true }, "pi-pi": { team: "Pi施工队", onRoster: true } });
	const experts = teamOf(modules, "pi-pi")!.members;
	assert.deepEqual(experts.map((m) => m.name), PI_EXPERTS);
	for (const m of experts) assert.match(m.title, /\p{Script=Han}/u, `${m.name} 有中文职称`);
});

test("幕僚长的名册里有 pi-pi：Pi 的扩展、主题、技能、配置、提示模板和界面组件归 pi-pi", () => {
	const roster = load().rosterPrompt().split("\n");
	const line = (name: string) => roster.find((l) => l.startsWith(`- ${name}（`)) ?? "";
	for (const word of ["Pi", "扩展", "主题", "技能", "配置", "提示模板", "界面组件"]) assert.ok(line("pi-pi").includes(word), `pi-pi 的说明提到${word}：${line("pi-pi")}`);
});

test("九位 Pi 专家只列读文件和读网页", () => {
	const tools = (module: string) => Object.fromEntries(teamOf(load(), module)!.members.map((m) => [m.name, m.tools]));
	assert.deepEqual(tools("pi-pi"), Object.fromEntries(PI_EXPERTS.map((name) => [name, ["read", "grep", "find", "ls", "web_get"]])));
});

const readOnlyCrews = () => load().modules.filter((m) => m.name !== "module-builder").flatMap((m) => m.team?.members ?? []);

test("仓库自带的施工队九位成员都写了工具清单，没有一位能执行命令、写文件或改文件", () => {
	const all = readOnlyCrews();
	assert.equal(all.length, 9);
	for (const member of all) {
		assert.ok(member.tools, `${member.file} 写了 tools`);
		assert.deepEqual(memberTools("request", member.tools).filter((t) => ["bash", "write", "edit"].includes(t)), [], member.file);
	}
});

test("仓库自带的成员提示词不让成员跑 firecrawl 或 curl", () => {
	for (const member of readOnlyCrews()) {
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

test("仓库不再带 us-market：加载不报错，没有它的领域、队伍和成员，pi-pi 不受影响", () => {
	const modules = load();
	assert.deepEqual(Object.fromEntries([...modules.book].map(([name, { team, onRoster }]) => [name, { team, onRoster }])), { "module-builder": { team: "模块工坊", onRoster: true }, "pi-pi": { team: "Pi施工队", onRoster: true } });
	assert.equal(modules.kitFor("us-market"), undefined);
	assert.ok(!modules.rosterPrompt().includes("us-market"));
	assert.deepEqual(modules.rulesFor("us-market"), []);
	assert.equal(modules.kitFor("pi-pi")!.crew.length, 9);
});

test("只有 us-market 的 module.json 开了 lookup 和 tripwire：美股看盘队的助手和四位成员都能查数据，助手能改盯盘条件，pi-pi 的不能", () => {
	const modules = load(REPO_MODULES, RETIRED_MODULES);
	const kit = modules.kitFor("us-market")!;
	assert.deepEqual(kit.granted, ["lookup", "tripwire"]);
	for (const member of kit.crew) assert.ok(memberTools("request", member.tools).includes("lookup"), member.name);
	const pipi = modules.kitFor("pi-pi")!;
	assert.deepEqual(pipi.granted, []);
	for (const member of pipi.crew) assert.ok(!memberTools("request", member.tools).includes("lookup"), member.name);
});

test("pi-pi 是新布局包：module.json 写了 schema 1 和 version，检查通过，九位成员", () => {
	const pipi = Modules.load([REPO_MODULES]).packages.find((p) => p.name === "pi-pi");
	assert.ok(pipi?.scan.ok, JSON.stringify(pipi?.scan));
	assert.equal(pipi.scan.scan.manifest.version, "1.0.0");
	assert.deepEqual(pipi.scan.scan.components.filter((c) => c.kind === "agents").map((c) => c.name).sort(), PI_EXPERTS);
});
