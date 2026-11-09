import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
	const roster = Roster.load([BUILTIN_ROLES_DIR]);
	assert.deepEqual(roster.names(), ["deputy", "general"]);
	assert.equal(roster.get("deputy")?.title, "副幕僚长");
	assert.deepEqual(roster.names("lead"), ["deputy"]);
	assert.deepEqual(roster.names("expert"), ["general"]);
	assert.equal(roster.get("general")?.tools, undefined);
});

test("consult: true 的角色是牵头角色，其余是专家", () => {
	const dir = rolesDir({ "a.md": "---\nname: market-lead\ntitle: 行情主管\ndescription: d\nconsult: true\n---\n", "b.md": NEWS.replace(/skills:.*\n/, "") });
	const roster = Roster.load([BUILTIN_ROLES_DIR, dir]);
	assert.deepEqual(roster.names("lead"), ["deputy", "market-lead"]);
	assert.deepEqual(roster.names("expert"), ["general", "news-researcher"]);
	assert.equal(roster.get("market-lead")?.kind, "lead");
});

test("角色文件：frontmatter 是字段，正文是提示词，技能目录相对角色文件", () => {
	const dir = rolesDir({ "news.md": NEWS });
	mkdirSync(join(dir, "news-skills"));
	const role = Roster.load([BUILTIN_ROLES_DIR, dir]).get("news-researcher")!;
	assert.equal(role.title, "新闻研究员");
	assert.equal(role.description, "查新闻、核对报道来源");
	assert.deepEqual(role.tools, ["read", "web_get", "bash"]);
	assert.deepEqual(role.skills, [join(dir, "news-skills")]);
	assert.deepEqual(role.model, { provider: "openai-codex", id: "gpt-6.1-sol" });
	assert.equal(role.prompt, "你是新闻研究员。每条结论都写出处。");
});

test("不存在的目录跳过，没有自定义角色时名册只有内置的两个", () => {
	assert.deepEqual(Roster.load([BUILTIN_ROLES_DIR, join(tmpdir(), "psa-no-such-roles")]).names(), ["deputy", "general"]);
});

test("两处同名：启动报一行错，写出两个文件", () => {
	const a = rolesDir({ "x.md": "---\nname: analyst\ntitle: 甲\ndescription: d\n---\n" });
	const b = rolesDir({ "y.md": "---\nname: analyst\ntitle: 乙\ndescription: d\n---\n" });
	assert.throws(() => Roster.load([a, b]), (e: Error) => {
		assert.ok(e instanceof ConfigError);
		assert.ok(!e.message.includes("\n"));
		assert.ok(e.message.includes(join(a, "x.md")) && e.message.includes(join(b, "y.md")), e.message);
		return true;
	});
});

test("和内置角色同名也报错，不覆盖", () => {
	const dir = rolesDir({ "general.md": "---\nname: general\ntitle: 我的通用\ndescription: d\n---\n" });
	assert.throws(() => Roster.load([BUILTIN_ROLES_DIR, dir]), ConfigError);
});

test("计费检查：anthropic、deepseek 和 Claude 模型都被拒，报错写出文件", () => {
	for (const model of ["deepseek/deepseek-flash", "anthropic/claude-x", "openrouter/claude-sonnet"]) {
		const dir = rolesDir({ "r.md": `---\nname: r\ntitle: t\ndescription: d\nmodel: ${model}\n---\n` });
		assert.throws(() => Roster.load([dir]), (e: Error) => e instanceof ConfigError && e.message.includes(join(dir, "r.md")), model);
	}
});

test("写错的字段、未知工具、缺字段、找不到的技能目录都在启动时报错", () => {
	const bad = [
		"---\nname: r\ntitle: t\ndescription: d\ntool: read\n---\n",
		"---\nname: r\ntitle: t\ndescription: d\ntools: read, rm\n---\n",
		"---\nname: r\ndescription: d\n---\n",
		"---\nname: R 1\ntitle: t\ndescription: d\n---\n",
		"---\nname: r\ntitle: t\ndescription: d\nskills: ./missing\n---\n",
		"---\nname: r\ntitle: t\ndescription: d\nconsult: yes please\n---\n",
	];
	for (const text of bad) assert.throws(() => Roster.load([rolesDir({ "r.md": text })]), ConfigError, text);
});

test("名册给幕僚长看的只有 name、title、description", () => {
	const dir = rolesDir({ "news.md": NEWS.replace("skills: ./news-skills\n", "") });
	const prompt = Roster.load([BUILTIN_ROLES_DIR, dir]).rosterPrompt();
	assert.match(prompt, /news-researcher（新闻研究员）：查新闻、核对报道来源/);
	assert.match(prompt, /general（通用助手）/);
	assert.doesNotMatch(prompt, /你是新闻研究员|gpt-6\.1-sol|web_get/);
});
