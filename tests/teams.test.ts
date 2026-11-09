import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError } from "../src/config-error.ts";
import { parseMember, parseTeams } from "../src/teams.ts";

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
	["团队名里有空白", "新 闻队:\n  description: d\n  members:\n    - a\n", 1, /空白/],
	["用 Tab 缩进", "新闻队:\n\tdescription: d\n", 2, /Tab/],
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
