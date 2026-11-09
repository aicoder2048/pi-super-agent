import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "./config-error.ts";
import { DEFAULT_LEAD, GENERAL_ROLE } from "./kernel/types.ts";
import { parseModelRef, type ModelRef } from "./models.ts";
import { WORKER_TOOLS } from "./worker/tools.ts";

export const BUILTIN_ROLES_DIR = fileURLToPath(new URL("../roles", import.meta.url));

/** lead: owns a ticket and may consult (frontmatter `consult: true`); expert: answers a lead's questions. */
export type RoleKind = "lead" | "expert";

/** A helper's standing identity, from a `.pi/agents`-style Markdown file. */
export interface Role {
	name: string;
	title: string;
	description: string;
	/** Undefined: no limit beyond the task's basis. */
	tools: readonly string[] | undefined;
	skills: readonly string[];
	model: ModelRef | undefined;
	kind: RoleKind;
	prompt: string;
	file: string;
}

const FIELDS = ["name", "title", "description", "tools", "skills", "model", "consult"];
const NAME = /^[a-z][a-z0-9-]*$/;
// The prompt goes to the Worker as one argv string; well under macOS's 1 MiB ARG_MAX with room for the rest.
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

/** allowedProviders: the providers the user already runs router or worker on; a role may only use these. */
export function parseRole(file: string, content: string, allowedProviders: readonly string[]): Role {
	const { frontmatter: fm, body } = parseFrontmatter(content);
	const unknown = Object.keys(fm).find((k) => !FIELDS.includes(k));
	if (unknown) throw new ConfigError(`${file}：不认识的字段 ${unknown}，可写：${FIELDS.join("、")}`);
	const name = text(fm.name, file, "name");
	if (!NAME.test(name)) throw new ConfigError(`${file}：name「${name}」只能用小写英文字母、数字和连字符，以字母开头`);
	const tools = list(fm.tools, file, "tools");
	const badTool = tools?.find((t) => !(WORKER_TOOLS as readonly string[]).includes(t));
	if (badTool) throw new ConfigError(`${file}：tools 里的 ${badTool} 不是 Worker 的工具，可用：${WORKER_TOOLS.join("、")}`);
	const skills = (list(fm.skills, file, "skills") ?? []).map((s) => resolve(dirname(file), s));
	const outside = skills.find((s) => !inside(dirname(file), s));
	if (outside) throw new ConfigError(`${file}：skills 的 ${outside} 不行，技能目录必须在 ${dirname(file)} 里面`);
	const missing = skills.find((s) => !existsSync(s));
	if (missing) throw new ConfigError(`${file}：skills 指向的 ${missing} 不存在`);
	let model: ModelRef | undefined;
	if (fm.model !== undefined) {
		model = parseModelRef(text(fm.model, file, "model"), `${file}：model`);
		if (!allowedProviders.includes(model.provider)) {
			throw new ConfigError(`${file}：model：拒绝使用 ${model.provider}/${model.id}，角色只能用 config.json 里 router 或 worker 已经在用的提供方：${allowedProviders.join("、")}`);
		}
	}
	if (fm.consult !== undefined && typeof fm.consult !== "boolean") throw new ConfigError(`${file}：consult 只能写 true 或 false`);
	const description = text(fm.description, file, "description");
	if ([...description].length > DESCRIPTION_MAX_CHARS) throw new ConfigError(`${file}：description 超过 ${DESCRIPTION_MAX_CHARS} 字，名册里每个角色只写一句`);
	const prompt = body.trim();
	if ([...prompt].length > PROMPT_MAX_CHARS) throw new ConfigError(`${file}：正文（系统提示词）超过 ${PROMPT_MAX_CHARS} 字`);
	return {
		name,
		title: text(fm.title, file, "title"),
		description,
		tools,
		skills,
		model,
		kind: fm.consult === true ? "lead" : "expert",
		prompt,
		file,
	};
}

/** Every role the Router can pick, from the built-in, module and state-dir `roles/` folders. */
export class Roster {
	readonly #roles: Map<string, Role>;

	constructor(roles: Role[]) {
		this.#roles = new Map();
		for (const role of roles) {
			const other = this.#roles.get(role.name);
			if (other) throw new ConfigError(`角色重名：${role.name} 同时定义在 ${other.file} 和 ${role.file}`);
			this.#roles.set(role.name, role);
		}
		if (this.#roles.get(GENERAL_ROLE)?.kind !== "expert") throw new ConfigError(`名册里没有内置专家 ${GENERAL_ROLE}`);
		if (this.#roles.get(DEFAULT_LEAD)?.kind !== "lead") throw new ConfigError(`名册里没有内置牵头角色 ${DEFAULT_LEAD}`);
	}

	static load(allowedProviders: readonly string[], dirs: readonly string[]): Roster {
		const roles: Role[] = [];
		for (const dir of dirs) {
			if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
			for (const entry of readdirSync(dir).sort()) {
				const file = join(dir, entry);
				if (entry.endsWith(".md") && statSync(file).isFile()) roles.push(parseRole(file, readFileSync(file, "utf8"), allowedProviders));
			}
		}
		return new Roster(roles);
	}

	get(name: string): Role | undefined {
		return this.#roles.get(name);
	}

	names(kind?: RoleKind): string[] {
		return [...this.#roles.values()].filter((r) => !kind || r.kind === kind).map((r) => r.name).sort();
	}

	/** name → title, all the kernel needs to check a role and show it. */
	titles(kind: RoleKind): ReadonlyMap<string, string> {
		return new Map(this.names(kind).map((n) => [n, this.#roles.get(n)!.title]));
	}

	/** One line per role of that kind: name, title, description. Leads go to the Router, experts to a lead. */
	rosterPrompt(kind: RoleKind): string {
		return this.names(kind).map((n) => this.#roles.get(n)!).map((r) => `- ${r.name}（${r.title}）：${r.description}`).join("\n");
	}
}
