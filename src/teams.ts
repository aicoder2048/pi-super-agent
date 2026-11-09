import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "./config-error.ts";
import { DEFAULT_TEAM, type TeamBook } from "./kernel/types.ts";
import { parseModelRef, type ModelRef } from "./models.ts";
import { WORKER_TOOLS } from "./worker/tools.ts";

/** One person on a team, from a `.pi/agents`-style Markdown file. */
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

export interface TeamDecl {
	name: string;
	description: string;
	members: readonly string[];
	file: string;
	line: number;
}

const TEAM_DESCRIPTION_MAX_CHARS = 60;

const unquote = (value: string) => (value.match(/^"(.*)"$|^'(.*)'$/)?.slice(1).find((v) => v !== undefined) ?? value).trim();

/**
 * Reads the one shape teams.yaml has: a top-level `团队名:`, under it `description: 一句话` and `members:` with one `- 名字` per line.
 * Anything else is an error with the file and line, so no YAML library is needed.
 */
export function parseTeams(file: string, text: string): TeamDecl[] {
	const teams: TeamDecl[] = [];
	let draft: { name: string; line: number; description?: string; members?: string[] } | undefined;
	let inMembers = false;
	const fail = (line: number, message: string): never => {
		throw new ConfigError(`${file}:${line}：${message}`);
	};
	const finish = () => {
		if (!draft) return;
		if (draft.description === undefined) fail(draft.line, `团队 ${draft.name} 缺少 description`);
		if (!draft.members?.length) fail(draft.line, `团队 ${draft.name} 缺少 members`);
		teams.push({ name: draft.name, description: draft.description!, members: draft.members!, file, line: draft.line });
	};
	text.split("\n").forEach((raw, index) => {
		const line = index + 1;
		const body = raw.trim();
		if (!body || body.startsWith("#")) return;
		if (/^ *\t/.test(raw)) fail(line, "缩进请用空格，不要用 Tab");
		if (!raw.startsWith(" ")) {
			const header = body.startsWith("-") ? null : body.match(/^(.+?)\s*:$/);
			if (!header) fail(line, `顶层每行应是「团队名:」，这一行是「${body}」`);
			finish();
			const name = unquote(header![1]);
			if (/\s/.test(name)) fail(line, `团队名「${name}」里不能有空白`);
			if (teams.some((t) => t.name === name)) fail(line, `团队 ${name} 在这个文件里写了两次`);
			draft = { name, line };
			inMembers = false;
			return;
		}
		if (!draft) return fail(line, "先写「团队名:」，再缩进写它的 description 和 members");
		if (body.startsWith("-")) {
			if (!inMembers) fail(line, "「- 名字」只能写在 members: 下面");
			const member = unquote(body.slice(1).trim());
			if (!member) fail(line, "「-」后面要写成员的名字");
			if (draft.members!.includes(member)) fail(line, `成员 ${member} 写了两次`);
			draft.members!.push(member);
			return;
		}
		const [, key, value] = body.match(/^([^:\s]+)\s*:\s*(.*)$/) ?? fail(line, `看不懂这一行「${body}」，团队里只能写 description 和 members`);
		if (key !== "description" && key !== "members") fail(line, `不认识的键 ${key}，团队里只能写 description 和 members`);
		if (draft[key as "description" | "members"] !== undefined) fail(line, `${key} 写了两次`);
		inMembers = key === "members";
		if (key === "members") {
			if (value) fail(line, "members 要写成每行一个「- 名字」");
			draft.members = [];
		} else {
			draft.description = unquote(value) || fail(line, "description 不能为空，写一句给幕僚长看的说明");
			if ([...draft.description].length > TEAM_DESCRIPTION_MAX_CHARS) fail(line, `description 超过 ${TEAM_DESCRIPTION_MAX_CHARS} 字，只写一句给幕僚长看的说明`);
		}
	});
	finish();
	return teams;
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
	const badTool = tools?.find((t) => !(WORKER_TOOLS as readonly string[]).includes(t));
	if (badTool) throw new ConfigError(`${file}：tools 里的 ${badTool} 不是助手的工具，可用：${WORKER_TOOLS.join("、")}`);
	const skills = (list(fm.skills, file, "skills") ?? []).map((s) => resolve(dirname(file), s));
	const missing = skills.find((s) => !existsSync(s));
	if (missing) throw new ConfigError(`${file}：skills 指向的 ${missing} 不存在`);
	const outside = skills.find((s) => !inside(realpathSync(dirname(file)), realpathSync(s)));
	if (outside) throw new ConfigError(`${file}：skills 的 ${outside} 不行，技能目录必须在 ${dirname(file)} 里面（符号链接按实际位置算）`);
	let model: ModelRef | undefined;
	if (fm.model !== undefined) {
		model = parseModelRef(text(fm.model, file, "model"), `${file}：model`);
		if (!allowedProviders.includes(model.provider)) {
			throw new ConfigError(`${file}：model：拒绝使用 ${model.provider}/${model.id}，成员只能用 config.json 里 router 或 worker 已经在用的提供方：${allowedProviders.join("、")}`);
		}
	}
	const description = text(fm.description, file, "description");
	if ([...description].length > DESCRIPTION_MAX_CHARS) throw new ConfigError(`${file}：description 超过 ${DESCRIPTION_MAX_CHARS} 字，名册里每位成员只写一句`);
	const prompt = body.trim();
	if ([...prompt].length > PROMPT_MAX_CHARS) throw new ConfigError(`${file}：正文（系统提示词）超过 ${PROMPT_MAX_CHARS} 字`);
	return { name, title: text(fm.title, file, "title"), description, tools, skills, model, prompt, file };
}

export const BUILTIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const GENERAL_MEMBER = "general";

export interface Team {
	name: string;
	description: string;
	members: readonly Member[];
	/** The members besides 通用助手. Empty means the ticket is one helper. */
	crew: readonly Member[];
	/** 内置, or the file and line of the teams.yaml entry. */
	where: string;
}

const isDirectory = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

function readText(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		throw new ConfigError(`${file}：读不了：${(error as Error).message}`);
	}
}

export class Roster {
	readonly members: readonly Member[];
	readonly #teams: ReadonlyMap<string, Team>;

	private constructor(members: readonly Member[], teams: ReadonlyMap<string, Team>) {
		this.members = members;
		this.#teams = teams;
	}

	/** A root is a directory that may hold `agents/*.md` and `teams.yaml`. A missing root, folder or file is skipped. */
	static load(roots: readonly string[], allowedProviders: readonly string[]): Roster {
		const members = new Map<string, Member>();
		const decls: TeamDecl[] = [];
		for (const root of roots) {
			const agents = join(root, "agents");
			for (const entry of isDirectory(agents) ? readdirSync(agents).sort() : []) {
				const file = join(agents, entry);
				if (!entry.endsWith(".md") || isDirectory(file)) continue;
				const member = parseMember(file, readText(file), allowedProviders);
				const other = members.get(member.name);
				if (other) throw new ConfigError(`成员重名：${member.name} 同时定义在 ${other.file} 和 ${file}`);
				members.set(member.name, member);
			}
			const teamsFile = join(root, "teams.yaml");
			if (existsSync(teamsFile)) decls.push(...parseTeams(teamsFile, readText(teamsFile)));
		}
		const general = members.get(GENERAL_MEMBER);
		if (!general) throw new ConfigError(`没有内置成员 ${GENERAL_MEMBER}（${join(BUILTIN_ROOT, "agents", "general.md")}）`);
		const teams = new Map<string, Team>([[DEFAULT_TEAM, { name: DEFAULT_TEAM, description: general.description, members: [general], crew: [], where: "内置" }]]);
		for (const decl of decls) {
			const where = `${decl.file}:${decl.line}`;
			const other = teams.get(decl.name);
			if (other) throw new ConfigError(`团队重名：${decl.name} 同时定义在 ${other.where} 和 ${where}`);
			const resolved = decl.members.map((name) => {
				const member = members.get(name);
				if (!member) throw new ConfigError(`${where}：团队 ${decl.name} 的成员 ${name} 不存在，现有成员：${[...members.keys()].join("、")}`);
				return member;
			});
			teams.set(decl.name, { name: decl.name, description: decl.description, members: resolved, crew: resolved.filter((m) => m.name !== GENERAL_MEMBER), where });
		}
		return new Roster([...members.values()], teams);
	}

	team(name: string): Team | undefined {
		return this.#teams.get(name);
	}

	/** One line per team the Router may pick besides the default: name and description, never a member. */
	routerPrompt(): string {
		return [...this.#teams.values()].filter((t) => t.name !== DEFAULT_TEAM).map((t) => `- ${t.name}：${t.description}`).join("\n");
	}

	teamBook(rules: readonly { id: string; team?: string }[]): TeamBook {
		const pinned = new Map<string, string>();
		for (const rule of rules) {
			if (rule.team === undefined) continue;
			if (!this.#teams.has(rule.team)) throw new ConfigError(`规则 ${rule.id} 写了「团队：${rule.team}」，没有这个团队，现有团队：${[...this.#teams.keys()].join("、")}`);
			pinned.set(rule.id, rule.team);
		}
		return { kinds: new Map([...this.#teams.values()].map((t) => [t.name, t.crew.length ? "crew" : "solo"])), pinned };
	}
}
