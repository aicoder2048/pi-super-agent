import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ConfigError } from "./config-error.ts";
import { parseModelRef, type ModelRef } from "./models.ts";
import { MEMBER_TOOLS, WORKER_TOOLS } from "./worker/tools.ts";

/** One person on a module's team, from a `.pi/agents`-style Markdown file in its `agents/`. */
export interface Member {
	name: string;
	title: string;
	description: string;
	/** Undefined: no limit beyond the ticket's basis. */
	tools: readonly string[] | undefined;
	skills: readonly string[];
	model: ModelRef | undefined;
	prompt: string;
	file: string;
}

const MEMBER_FIELDS = ["name", "title", "description", "tools", "skills", "model"];
const MEMBER_NAME = /^[a-z][a-z0-9-]*$/;
const PROMPT_MAX_CHARS = 20_000;
const DESCRIPTION_MAX_CHARS = 300;

const inside = (dir: string, path: string) => {
	const rel = relative(dir, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function list(value: unknown, file: string, field: string): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value.split(/[,，\s]+/).filter(Boolean);
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
	throw new ConfigError(`${file}：${field} 应写成逗号分隔的字符串或字符串列表`);
}

function text(value: unknown, file: string, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new ConfigError(`${file}：缺少 ${field}`);
	return value.trim();
}

function frontmatterOf(file: string, content: string) {
	try {
		return parseFrontmatter(content);
	} catch (error) {
		throw new ConfigError(`${file}：frontmatter 不是合法的 YAML：${(error as Error).message.split("\n")[0]}`);
	}
}

/** allowedProviders: the providers the user already runs the router or the worker on; a member may only use these. */
export function parseMember(file: string, content: string, allowedProviders: readonly string[]): Member {
	const { frontmatter: fm, body } = frontmatterOf(file, content);
	const unknown = Object.keys(fm).find((k) => !MEMBER_FIELDS.includes(k));
	if (unknown) throw new ConfigError(`${file}：不认识的字段 ${unknown}，可写：${MEMBER_FIELDS.join("、")}`);
	const name = text(fm.name, file, "name");
	if (!MEMBER_NAME.test(name)) throw new ConfigError(`${file}：name「${name}」只能用小写英文字母、数字和连字符，以字母开头`);
	const tools = list(fm.tools, file, "tools");
	if ("tools" in fm && !tools?.length) throw new ConfigError(`${file}：tools 是空的；不想另设限就去掉这一行，要限制就至少写一个工具`);
	const badTool = tools?.find((t) => !MEMBER_TOOLS.includes(t));
	if (badTool) {
		const why = (WORKER_TOOLS as readonly string[]).includes(badTool) ? "只有助手能用，成员不能汇报、交回、读任务记录、跑后台命令或再往下派" : "不是成员能用的工具";
		throw new ConfigError(`${file}：tools 里的 ${badTool} ${why}，可用：${MEMBER_TOOLS.join("、")}`);
	}
	const skills = (list(fm.skills, file, "skills") ?? []).map((s) => resolve(dirname(file), s));
	const missing = skills.find((s) => !existsSync(s));
	if (missing) throw new ConfigError(`${file}：skills 指向的 ${missing} 不存在`);
	const outside = skills.find((s) => !inside(realpathSync(dirname(file)), realpathSync(s)));
	if (outside) throw new ConfigError(`${file}：skills 的 ${outside} 不行，技能目录必须在 ${dirname(file)} 里面（符号链接按实际位置算）`);
	let model: ModelRef | undefined;
	if (fm.model !== undefined) {
		model = parseModelRef(text(fm.model, file, "model"), `${file}：model`);
		if (!allowedProviders.includes(model.provider)) {
			throw new ConfigError(`${file}：model：拒绝使用 ${model.provider}/${model.id}，成员只能用 config.json 里 router 或 worker 已经在用的提供方${allowedProviders.length ? `：${allowedProviders.join("、")}` : "，而这次加载没有交代任何提供方"}`);
		}
	}
	const description = text(fm.description, file, "description");
	if ([...description].length > DESCRIPTION_MAX_CHARS) throw new ConfigError(`${file}：description 超过 ${DESCRIPTION_MAX_CHARS} 字，名册里每位成员只写一句`);
	const prompt = body.trim();
	if ([...prompt].length > PROMPT_MAX_CHARS) throw new ConfigError(`${file}：正文（系统提示词）超过 ${PROMPT_MAX_CHARS} 字`);
	return { name, title: text(fm.title, file, "title"), description, tools, skills, model, prompt, file };
}

/** A module's team: every member in its `agents/`, under the name its module.json gives. A module without members has no team. */
export interface Team {
	name: string;
	members: readonly [Member, ...Member[]];
}

const isDirectory = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

function readText(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		throw new ConfigError(`${file}：读不了：${(error as Error).message}`);
	}
}

function loadMembers(agentsDir: string, allowedProviders: readonly string[]): Member[] {
	const members: Member[] = [];
	for (const entry of isDirectory(agentsDir) ? readdirSync(agentsDir).sort() : []) {
		const file = join(agentsDir, entry);
		if (!entry.endsWith(".md") || isDirectory(file)) continue;
		const member = parseMember(file, readText(file), allowedProviders);
		const other = members.find((m) => m.name === member.name);
		if (other) throw new ConfigError(`${other.file}：成员重名：${member.name} 也定义在 ${file}。给其中一位改 name，或删掉一个文件`);
		members.push(member);
	}
	return members;
}

export function loadTeam(moduleDir: string, manifestPath: string, manifestTeam: unknown, allowedProviders: readonly string[]): Team | undefined {
	const [first, ...rest] = loadMembers(join(moduleDir, "agents"), allowedProviders);
	if (!first) {
		if (manifestTeam !== undefined) throw new ConfigError(`${manifestPath}：写了 team「${String(manifestTeam)}」，但 agents/ 里没有成员；加上成员，或去掉 team`);
		return undefined;
	}
	if (manifestTeam === undefined) throw new ConfigError(`${manifestPath}：agents/ 里有成员，要写 team（队名，例如「看盘队」）`);
	if (typeof manifestTeam !== "string" || !manifestTeam || /\s|\p{Cc}/u.test(manifestTeam)) throw new ConfigError(`${manifestPath}：team（${JSON.stringify(manifestTeam)}）要写成一个队名，不能为空，中间不能有空白或控制字符`);
	return { name: manifestTeam, members: [first, ...rest] };
}
