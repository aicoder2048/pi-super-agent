import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError } from "../src/config-error.ts";
import { DEFAULT_TEAM } from "../src/kernel/types.ts";
import { BUILTIN_ROOT, Roster, parseMember, parseTeams } from "../src/teams.ts";

const FILE = "/state/teams.yaml";

const NEWS_TEAM = `# 使用者自己的团队
新闻队:
  description: 查新闻、核对报道来源
  members:
    - news-researcher

看盘队:
  description: "盯行情：技术面、新闻和财报"
  members:
  - market-analyst
  - news-researcher
`;

test("teams.yaml：每个团队一个名字、一句说明和成员名单，空行和 # 注释跳过，说明可以带引号", () => {
	assert.deepEqual(parseTeams(FILE, NEWS_TEAM), [
		{ name: "新闻队", description: "查新闻、核对报道来源", members: ["news-researcher"], file: FILE, line: 2 },
		{ name: "看盘队", description: "盯行情：技术面、新闻和财报", members: ["market-analyst", "news-researcher"], file: FILE, line: 7 },
	]);
	assert.deepEqual(parseTeams(FILE, "\n# 还没有团队\n"), []);
});

test("teams.yaml：成员名可以带引号", () => {
	const [team] = parseTeams(FILE, `新闻队:\n  description: d\n  members:\n    - "news-researcher"\n    - 'x'\n`);
	assert.deepEqual(team.members, ["news-researcher", "x"]);
});

test("teams.yaml：冒号可以写成全角的「：」，和 rules.md 一样", () => {
	assert.deepEqual(parseTeams(FILE, "新闻队：\n  description：查新闻：只看来源\n  members：\n    - a\n"), [
		{ name: "新闻队", description: "查新闻：只看来源", members: ["a"], file: FILE, line: 1 },
	]);
});

const MALFORMED: [name: string, text: string, line: number, message: RegExp][] = [
	["顶层不是「团队名:」", "新闻队: 查新闻\n", 1, /团队名/],
	["成员写在团队外面", "- news-researcher\n", 1, /团队名/],
	["团队里有不认识的键", "新闻队:\n  description: d\n  lead: x\n  members:\n    - a\n", 3, /lead/],
	["members 写成一行", "新闻队:\n  description: d\n  members: [a, b]\n", 3, /每行一个/],
	["名单项前面没有 members", "新闻队:\n  description: d\n    - a\n", 3, /members/],
	["说明是空的", "新闻队:\n  description:\n  members:\n    - a\n", 2, /description/],
	["缺说明", "新闻队:\n  members:\n    - a\n", 1, /缺少 description/],
	["缺名单", "新闻队:\n  description: d\n看盘队:\n  description: d\n  members:\n    - a\n", 1, /缺少 members/],
	["名单是空的", "新闻队:\n  description: d\n  members:\n", 1, /缺少 members/],
	["同一个键写了两次", "新闻队:\n  description: d\n  description: e\n  members:\n    - a\n", 3, /description 写了两次/],
	["同一个成员写了两次", "新闻队:\n  description: d\n  members:\n    - a\n    - a\n", 5, /a 写了两次/],
	["同一个文件里团队重名", "新闻队:\n  description: d\n  members:\n    - a\n新闻队:\n  description: d\n  members:\n    - a\n", 5, /新闻队/],
	["说明超过 60 字", `新闻队:\n  description: ${"长".repeat(61)}\n  members:\n    - a\n`, 2, /60 字/],
	["团队名里有空白", "新 闻队:\n  description: d\n  members:\n    - a\n", 1, /空白/],
	["用 Tab 缩进", "新闻队:\n\tdescription: d\n", 2, /Tab/],
	["团队名是空的", '"":\n  description: d\n  members:\n    - a\n', 1, /团队名不能为空/],
	["团队名里有控制字符", "新\u0007闻队:\n  description: d\n  members:\n    - a\n", 1, /控制字符/],
];

for (const [name, text, line, message] of MALFORMED) {
	test(`teams.yaml 格式不对时报出文件和行号：${name}`, () => {
		assert.throws(() => parseTeams(FILE, text), (e: Error) => {
			assert.ok(e instanceof ConfigError, String(e));
			assert.ok(e.message.startsWith(`${FILE}:${line}：`), e.message);
			assert.match(e.message, message);
			return true;
		});
	});
}

function agentsDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-agents-"));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return dir;
}

const ALLOWED = ["openai-codex"];
const member = (frontmatter: string, body = "") => `---\nname: m\ntitle: t\ndescription: d\n${frontmatter}---\n${body}`;
const readMember = (dir: string, name = "m.md", text: string) => parseMember(join(dir, name), text, ALLOWED);
const memberFails = (text: string, message: RegExp) => {
	const dir = agentsDir({ "m.md": text });
	assert.throws(() => readMember(dir, "m.md", text), (e: Error) => {
		assert.ok(e instanceof ConfigError, String(e));
		assert.ok(e.message.startsWith(join(dir, "m.md")), e.message);
		assert.match(e.message, message);
		return true;
	}, text);
};

const NEWS = `---
name: news-researcher
title: 新闻研究员
description: 查新闻、核对报道来源
tools: read, web_get, bash
skills: ./news-skills
model: openai-codex/gpt-6.1-sol
---
你是新闻研究员。每条结论都写出处。
`;

test("成员文件：frontmatter 是 name、title、description、tools、skills、model，正文是系统提示词，技能目录相对成员文件", () => {
	const dir = agentsDir({ "news.md": NEWS });
	mkdirSync(join(dir, "news-skills"));
	assert.deepEqual(readMember(dir, "news.md", NEWS), {
		name: "news-researcher",
		title: "新闻研究员",
		description: "查新闻、核对报道来源",
		tools: ["read", "web_get", "bash"],
		skills: [join(dir, "news-skills")],
		model: { provider: "openai-codex", id: "gpt-6.1-sol" },
		prompt: "你是新闻研究员。每条结论都写出处。",
		file: join(dir, "news.md"),
	});
});

test("成员文件只写必填的三项：工具不另设限，没有技能，模型跟助手的配置", () => {
	const dir = agentsDir({});
	const m = readMember(dir, "m.md", member(""));
	assert.deepEqual([m.tools, m.skills, m.model, m.prompt], [undefined, [], undefined, ""]);
});

test("成员的模型过计费检查：提供方只能是 config.json 里 router 或 worker 已经在用的", () => {
	for (const model of ["deepseek/deepseek-flash", "openrouter/deepseek/deepseek-chat", "openai/gpt-5.1"]) {
		memberFails(member(`model: ${model}\n`), /只能用.*openai-codex/);
	}
});

test("成员的模型过计费检查：anthropic 和任何提供方的 Claude 模型都被拒，即使使用者给幕僚长配了那个提供方", () => {
	memberFails(member("model: openai-codex/claude-sonnet\n"), /Claude/);
	memberFails(member("model: anthropic/claude-x\n"), /anthropic/);
	const dir = agentsDir({});
	assert.throws(() => parseMember(join(dir, "m.md"), member("model: anthropic/some-model\n"), ["anthropic"]), /anthropic/);
});

test("成员文件写错的字段报错并列出可写的字段；consult 不是字段", () => {
	memberFails(member("tool: read\n"), /不认识的字段 tool/);
	memberFails(member("consult: true\n"), /不认识的字段 consult/);
});
test("成员的 tools 里有助手没有的工具时报错并列出可用工具", () => memberFails(member("tools: read, rm\n"), /rm 不是助手的工具/));
test("成员的 tools 写了却是空的：报错，说明去掉这一行或至少写一个工具", () => {
	for (const tools of ["tools:\n", 'tools: ""\n', "tools: []\n"]) memberFails(member(tools), /tools 是空的.*去掉.*至少写一个/);
});
test("成员文件缺 title 报错", () => memberFails("---\nname: m\ndescription: d\n---\n", /缺少 title/));
test("成员的 name 只能是小写英文、数字和连字符", () => memberFails("---\nname: R 1\ntitle: t\ndescription: d\n---\n", /name「R 1」/));
test("成员的技能目录不存在时报错", () => memberFails(member("skills: ./missing\n"), /不存在/));

test("成员的技能目录不能跑出成员文件所在的目录", () => {
	memberFails(member("skills: ../\n"), /技能目录必须在 .* 里面/);
	memberFails(member("skills: /etc\n"), /技能目录必须在/);
});

test("成员的技能目录经符号链接指到外面也不行：按真实路径算", () => {
	const outside = mkdtempSync(join(tmpdir(), "psa-outside-"));
	mkdirSync(join(outside, "sk"));
	const dir = agentsDir({});
	symlinkSync(outside, join(dir, "link"));
	assert.throws(() => readMember(dir, "m.md", member("skills: link/sk\n")), /技能目录必须在/);
});

test("成员的提示词和说明有长度上限，超了在启动时报错", () => {
	memberFails(member("", "长".repeat(20_001)), /正文.*20000/);
	memberFails(`---\nname: m\ntitle: t\ndescription: ${"长".repeat(301)}\n---\n`, /description.*300/);
});

function root(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-root-"));
	mkdirSync(join(dir, "agents"));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return dir;
}
const person = (name: string, title: string) => `---\nname: ${name}\ntitle: ${title}\ndescription: ${title}的说明\n---\n你是${title}。\n`;
const team = (name: string, ...members: string[]) => `${name}:\n  description: ${name}的说明\n  members:\n${members.map((m) => `    - ${m}\n`).join("")}`;
const loadRoster = (...roots: string[]) => Roster.load([BUILTIN_ROOT, ...roots], ALLOWED);
const oneLine = (fn: () => unknown, ...parts: (string | RegExp)[]) =>
	assert.throws(fn, (e: Error) => {
		assert.ok(e instanceof ConfigError, String(e));
		assert.ok(!e.message.includes("\n"), e.message);
		for (const part of parts) typeof part === "string" ? assert.ok(e.message.includes(part), e.message) : assert.match(e.message, part);
		return true;
	});

test("内置只有成员「通用助手」和只含它的默认团队；不存在的目录跳过", () => {
	const roster = loadRoster(join(tmpdir(), "psa-no-such-root"));
	const builtin = roster.team(DEFAULT_TEAM)!;
	assert.deepEqual(builtin.members.map((m) => [m.name, m.title]), [["general", "通用助手"]]);
	assert.deepEqual(builtin.crew, []);
	assert.deepEqual([...roster.teamBook([]).kinds], [[DEFAULT_TEAM, "solo"]]);
	assert.equal(roster.team("新闻队"), undefined);
});

test("成员和团队来自内置、模块、状态目录三处：团队可以用别处定义的成员，成员解析成完整的定义", () => {
	const module = root({ "agents/analyst.md": person("market-analyst", "行情分析师"), "teams.yaml": team("看盘队", "market-analyst", "general") });
	const state = root({ "agents/news.md": person("news-researcher", "新闻研究员"), "teams.yaml": team("新闻队", "news-researcher") + team("研究队", "news-researcher", "market-analyst") });
	const roster = loadRoster(module, state);
	assert.deepEqual(roster.team("看盘队")!.members.map((m) => m.title), ["行情分析师", "通用助手"]);
	assert.deepEqual(roster.team("看盘队")!.crew.map((m) => m.name), ["market-analyst"]);
	assert.deepEqual(roster.team("研究队")!.crew.map((m) => m.prompt), ["你是新闻研究员。", "你是行情分析师。"]);
	assert.equal(roster.team("新闻队")!.description, "新闻队的说明");
});

test("两处定义了同名成员：启动报一行错，写出两个文件；和内置的通用助手同名也一样", () => {
	const a = root({ "agents/x.md": person("analyst", "甲") });
	const b = root({ "agents/y.md": person("analyst", "乙") });
	oneLine(() => loadRoster(a, b), join(a, "agents/x.md"), join(b, "agents/y.md"), /成员重名：analyst/);
	const mine = root({ "agents/general.md": person("general", "我的通用") });
	oneLine(() => loadRoster(mine), join(BUILTIN_ROOT, "agents/general.md"), join(mine, "agents/general.md"));
});

test("两处定义了同名团队：启动报一行错，写出两个文件和行号；不能重新定义默认团队", () => {
	const a = root({ "teams.yaml": team("新闻队", "general") });
	const b = root({ "teams.yaml": `# 我的\n${team("新闻队", "general")}` });
	oneLine(() => loadRoster(a, b), `${join(a, "teams.yaml")}:1`, `${join(b, "teams.yaml")}:2`, /团队重名：新闻队/);
	oneLine(() => loadRoster(root({ "teams.yaml": team(DEFAULT_TEAM, "general") })), /团队重名：默认/, "内置");
});

test("团队名单里有不存在的成员：启动报错，写出文件、行号、团队和成员名", () => {
	const dir = root({ "teams.yaml": team("新闻队", "news-researcher") });
	oneLine(() => loadRoster(dir), `${join(dir, "teams.yaml")}:1`, /团队 新闻队 的成员 news-researcher 不存在/);
});

test("成员文件有错时，加载名册就报出那个文件", () => {
	const dir = root({ "agents/bad.md": person("bad", "坏").replace("---\n你", "model: deepseek/deepseek-flash\n---\n你") });
	oneLine(() => loadRoster(dir), join(dir, "agents/bad.md"), /只能用/);
});

test("给幕僚长的名册只有团队名和说明，没有成员；默认团队不列", () => {
	const dir = root({ "agents/news.md": person("news-researcher", "新闻研究员"), "teams.yaml": team("新闻队", "news-researcher") + team("杂务队", "general") });
	assert.equal(loadRoster(dir).routerPrompt(), "- 新闻队：新闻队的说明\n- 杂务队：杂务队的说明");
	assert.equal(loadRoster().routerPrompt(), "");
});

test("给内核的团队簿：除通用助手外还有成员的是成队，只有通用助手的是单人；规则钉死的团队按规则 id 记下", () => {
	const dir = root({ "agents/news.md": person("news-researcher", "新闻研究员"), "teams.yaml": team("新闻队", "news-researcher") + team("杂务队", "general") });
	const book = loadRoster(dir).teamBook([{ id: "user/news", team: "新闻队" }, { id: "user/ci" }]);
	assert.deepEqual([...book.kinds], [[DEFAULT_TEAM, "solo"], ["新闻队", "crew"], ["杂务队", "solo"]]);
	assert.deepEqual([...book.pinned], [["user/news", "新闻队"]]);
});

test("规则写的团队不存在：启动报一行错，写出规则、团队名和现有的团队", () => {
	const dir = root({ "teams.yaml": team("杂务队", "general") });
	oneLine(() => loadRoster(dir).teamBook([{ id: "user/news", team: "新闻队" }]), /规则 user\/news/, /新闻队/, /默认、杂务队/);
});

test("成员文件的 frontmatter 不是合法的 YAML：报一行错，以文件名开头", () => {
	for (const frontmatter of ["name: m\ntitle: t\ndescription: 注意: 只看新闻\n", "name: m\nname: n\ntitle: t\ndescription: d\n"]) {
		const dir = root({ "agents/bad.md": `---\n${frontmatter}---\n` });
		assert.throws(() => loadRoster(dir), (e: Error) => {
			assert.ok(e instanceof ConfigError, String(e));
			assert.ok(e.message.startsWith(join(dir, "agents/bad.md")), e.message);
			assert.ok(!e.message.includes("\n"), e.message);
			assert.match(e.message, /YAML/);
			return true;
		});
	}
});

test("agents 下的符号链接指向不存在的文件：报一行错，以那个链接的路径开头", () => {
	const dir = root({});
	symlinkSync(join(dir, "gone.md"), join(dir, "agents/news.md"));
	assert.throws(() => loadRoster(dir), (e: Error) => {
		assert.ok(e instanceof ConfigError, String(e));
		assert.ok(e.message.startsWith(join(dir, "agents/news.md")), e.message);
		assert.ok(!e.message.includes("\n"), e.message);
		return true;
	});
});

test("teams.yaml 是个目录：报一行错，以它的路径开头", () => {
	const dir = root({});
	mkdirSync(join(dir, "teams.yaml"));
	assert.throws(() => loadRoster(dir), (e: Error) => {
		assert.ok(e instanceof ConfigError, String(e));
		assert.ok(e.message.startsWith(join(dir, "teams.yaml")), e.message);
		assert.ok(!e.message.includes("\n"), e.message);
		return true;
	});
});
