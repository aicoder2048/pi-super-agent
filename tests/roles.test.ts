import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError } from "../src/config-error.ts";
import { BUILTIN_ROLES_DIR, Roster } from "../src/roles.ts";

function rolesDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-roles-"));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return dir;
}

const ALLOWED = ["openai-codex"];
const load = (...dirs: string[]) => Roster.load(ALLOWED, [BUILTIN_ROLES_DIR, ...dirs]);
const role = (frontmatter: string, body = "") => `---\nname: r\ntitle: t\ndescription: d\n${frontmatter}---\n${body}`;
const fails = (text: string, message: RegExp, files: Record<string, string> = {}) => {
	const dir = rolesDir({ "r.md": text, ...files });
	assert.throws(() => load(dir), (e: Error) => {
		assert.ok(e instanceof ConfigError, String(e));
		assert.ok(e.message.includes(join(dir, "r.md")), e.message);
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

test("内置名册有通用助手和副幕僚长：副幕僚长是牵头角色，通用助手是专家", () => {
	const roster = Roster.load(ALLOWED, [BUILTIN_ROLES_DIR]);
	assert.deepEqual(roster.names(), ["deputy", "general"]);
	assert.equal(roster.get("deputy")?.title, "副幕僚长");
	assert.deepEqual(roster.names("lead"), ["deputy"]);
	assert.deepEqual(roster.names("expert"), ["general"]);
	assert.equal(roster.get("general")?.tools, undefined);
});

test("consult: true 的角色是牵头角色，其余是专家", () => {
	const dir = rolesDir({ "a.md": "---\nname: market-lead\ntitle: 行情主管\ndescription: d\nconsult: true\n---\n", "b.md": NEWS.replace(/skills:.*\n/, "") });
	const roster = Roster.load(ALLOWED, [BUILTIN_ROLES_DIR, dir]);
	assert.deepEqual(roster.names("lead"), ["deputy", "market-lead"]);
	assert.deepEqual(roster.names("expert"), ["general", "news-researcher"]);
	assert.equal(roster.get("market-lead")?.kind, "lead");
});

test("角色文件：frontmatter 是字段，正文是提示词，技能目录相对角色文件", () => {
	const dir = rolesDir({ "news.md": NEWS });
	mkdirSync(join(dir, "news-skills"));
	const role = Roster.load(ALLOWED, [BUILTIN_ROLES_DIR, dir]).get("news-researcher")!;
	assert.equal(role.title, "新闻研究员");
	assert.equal(role.description, "查新闻、核对报道来源");
	assert.deepEqual(role.tools, ["read", "web_get", "bash"]);
	assert.deepEqual(role.skills, [join(dir, "news-skills")]);
	assert.deepEqual(role.model, { provider: "openai-codex", id: "gpt-6.1-sol" });
	assert.equal(role.prompt, "你是新闻研究员。每条结论都写出处。");
});

test("不存在的目录跳过，没有自定义角色时名册只有内置的两个", () => {
	assert.deepEqual(Roster.load(ALLOWED, [BUILTIN_ROLES_DIR, join(tmpdir(), "psa-no-such-roles")]).names(), ["deputy", "general"]);
});

test("两处同名：启动报一行错，写出两个文件", () => {
	const a = rolesDir({ "x.md": "---\nname: analyst\ntitle: 甲\ndescription: d\n---\n" });
	const b = rolesDir({ "y.md": "---\nname: analyst\ntitle: 乙\ndescription: d\n---\n" });
	assert.throws(() => Roster.load(ALLOWED, [a, b]), (e: Error) => {
		assert.ok(e instanceof ConfigError);
		assert.ok(!e.message.includes("\n"));
		assert.ok(e.message.includes(join(a, "x.md")) && e.message.includes(join(b, "y.md")), e.message);
		return true;
	});
});

test("和内置角色同名也报错，不覆盖", () => {
	const dir = rolesDir({ "general.md": "---\nname: general\ntitle: 我的通用\ndescription: d\n---\n" });
	assert.throws(() => Roster.load(ALLOWED, [BUILTIN_ROLES_DIR, dir]), ConfigError);
});

test("计费检查用白名单：角色的模型只能用 config.json 里 router 或 worker 已经在用的提供方", () => {
	for (const model of ["deepseek/deepseek-flash", "openrouter/deepseek/deepseek-chat", "openai/gpt-5.1"]) {
		fails(role(`model: ${model}\n`), /只能用.*openai-codex/);
	}
	assert.deepEqual(load(rolesDir({ "r.md": role("model: openai-codex/gpt-6.1-terra\n") })).get("r")?.model, { provider: "openai-codex", id: "gpt-6.1-terra" });
});

test("计费检查：任何提供方的 Claude 模型都被拒", () => {
	fails(role("model: openai-codex/claude-sonnet\n"), /Claude/);
	fails(role("model: anthropic/claude-x\n"), /anthropic/);
});

test("写错的字段报错并列出可写的字段", () => fails(role("tool: read\n"), /不认识的字段 tool/));
test("未知工具报错并列出可用工具", () => fails(role("tools: read, rm\n"), /rm 不是 Worker 的工具/));
test("缺 title 报错", () => fails("---\nname: r\ndescription: d\n---\n", /缺少 title/));
test("name 不合规报错", () => fails("---\nname: R 1\ntitle: t\ndescription: d\n---\n", /name「R 1」/));
test("找不到的技能目录报错", () => fails(role("skills: ./missing\n"), /不存在/));
test("consult 只能是布尔值", () => fails(role("consult: yes please\n"), /consult 只能写 true 或 false/));

test("技能目录不能跑出角色文件所在的目录", () => {
	const dir = rolesDir({ "r.md": role("skills: ../\n") });
	assert.throws(() => load(dir), /技能目录必须在 .* 里面/);
	fails(role("skills: /etc\n"), /技能目录必须在/);
});

test("技能目录经符号链接指到角色目录外面也不行", () => {
	const outside = mkdtempSync(join(tmpdir(), "psa-outside-"));
	mkdirSync(join(outside, "sk"));
	const dir = rolesDir({ "r.md": role("skills: link/sk\n") });
	symlinkSync(outside, join(dir, "link"));
	assert.throws(() => load(dir), /技能目录必须在/);
});

test("提示词和描述有长度上限，超了在启动时报错而不是起 Worker 时失败", () => {
	fails(role("", "长".repeat(20_001)), /正文.*20000/);
	fails(`---\nname: r\ntitle: t\ndescription: ${"长".repeat(301)}\n---\n`, /description.*300/);
});

test("名册分两份：牵头角色给幕僚长，专家给牵头角色；都只有 name、title、description", () => {
	const dir = rolesDir({ "news.md": NEWS.replace("skills: ./news-skills\n", "") });
	const roster = Roster.load(ALLOWED, [BUILTIN_ROLES_DIR, dir]);
	const experts = roster.rosterPrompt("expert");
	assert.match(experts, /news-researcher（新闻研究员）：查新闻、核对报道来源/);
	assert.match(experts, /general（通用助手）/);
	assert.doesNotMatch(experts, /deputy|你是新闻研究员|gpt-6\.1-sol|web_get/);
	assert.match(roster.rosterPrompt("lead"), /^- deputy（副幕僚长）：[^\n]+$/);
});

test("内置的通用助手和副幕僚长缺一不可", () => {
	const lone = rolesDir({ "general.md": "---\nname: general\ntitle: 通用助手\ndescription: d\n---\n" });
	assert.throws(() => Roster.load(ALLOWED, [lone]), /deputy/);
});
