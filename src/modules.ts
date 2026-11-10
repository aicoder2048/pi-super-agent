import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ConfigError, readJsonFile } from "./config-error.ts";
import { CONVERSATION_SOURCE, ruleId, type DomainBook, type SourcePolicy } from "./kernel/types.ts";
import type { TimerEntry } from "./sources/timer.ts";
import { loadTeam, type Member, type Team } from "./teams.ts";

export interface SourceFilter {
	name: string;
	title?: string;
	description?: string;
	/** A source the host runs itself; kind must be a key of FEEDS. */
	feed?: { kind: string; settings?: unknown };
	mode?: "candidate" | "ignore";
	/** Market quotes: a rule ticket opened from this source gets a 行情助手. */
	market?: boolean;
	ignore?: string[];
}

export interface ModuleManifest {
	name: string;
	/** The domain's Chinese name. Required when `description` is written. */
	title?: string;
	/** One sentence for the 幕僚长. A module without it is not offered to the 幕僚长. */
	description?: string;
	/** The team's display name. Written exactly when `agents/` holds a member. */
	team?: string;
	sources?: SourceFilter[];
	timers?: TimerEntry[];
	prepare?: string;
}

export interface LoadedModule {
	name: string;
	dir: string;
	manifest: ModuleManifest;
	rules: ScopedRule[];
	skillsDir: string | undefined;
	/** The members in `agents/`. Absent: a ticket of this module is one helper. */
	team?: Team;
}

/** What a helper is handed from its ticket's domain, however the ticket was opened. */
export interface DomainKit {
	skillsDir: string | undefined;
	/** Runs once in the ticket's workdir before the helper first starts. */
	prepare: string | undefined;
	/** The module's members the helper may dispatch to, each with the module's `skills/` ahead of its own. Empty: it works alone. */
	crew: readonly Member[];
}

/** The kit of a ticket with no domain, or whose module is gone. */
export const NO_DOMAIN: DomainKit = { skillsDir: undefined, prepare: undefined, crew: [] };

/** The loaded modules as the host uses them once tickets belong to them. `Modules` is the real one. */
export interface Domains {
	readonly book: DomainBook;
	/** Undefined: no loaded module has that name. */
	readonly kitFor: (domain: string) => DomainKit | undefined;
}

export interface ModulesLoadOptions {
	/** Its `rules.md` holds the user's rules. Omitted: no user rules, and the state dir is not checked for leftovers. */
	stateDir?: string;
	/** The providers a member's `model` may use. Empty: a member that names a model is rejected. */
	allowedProviders?: readonly string[];
}

const DESCRIPTION_MAX_CHARS = 60;
const USER_NAMESPACE = "user";

export interface Rule {
	id: string;
	text: string;
	sources?: string[];
}

export interface ScopedRule extends Rule {
	sources: string[];
}

const RULE_HEADING = /^##\s+([\w-]+)\s*$/;
const RULE_SOURCES = /^来源\s*[:：]\s*(.+)$/;
const RULE_TEAM = /^团队\s*[:：]/;

export function parseRules(file: string, namespace: string, markdown: string): Rule[] {
	const rules: Rule[] = [];
	for (const line of markdown.split("\n")) {
		const heading = line.match(RULE_HEADING);
		const sources = line.trim().match(RULE_SOURCES);
		const rule = rules.at(-1);
		if (heading) rules.push({ id: ruleId(namespace, heading[1]), text: "" });
		else if (!rule) continue;
		else if (sources) rule.sources = sources[1].split(/[,，\s]+/).filter(Boolean);
		else if (RULE_TEAM.test(line.trim())) {
			throw new ConfigError(`${file}：规则 ${rule.id} 写了「团队：」。规则不再指定团队，模块规则开的任务属于规则所在的模块，队伍是模块 agents/ 里的成员，使用者规则的任务由幕僚长选领域。删掉这一行`);
		} else rule.text += line + "\n";
	}
	return rules.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text);
}

function loadModule(dir: string, allowedProviders: readonly string[]): LoadedModule {
	const manifestPath = join(dir, "module.json");
	const manifest = readJsonFile<ModuleManifest>(manifestPath);
	if (!manifest.name || manifest.name !== basename(dir)) throw new ConfigError(`${manifestPath}：name 必须等于目录名 ${basename(dir)}`);
	if (manifest.name === USER_NAMESPACE) throw new ConfigError(`${manifestPath}：模块不能叫 ${USER_NAMESPACE}，这个名字留给状态目录 rules.md 里你自己的规则。给模块目录换个名字`);
	for (const key of ["title", "description"] as const) {
		const value: unknown = manifest[key];
		if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new ConfigError(`${manifestPath}：${key}（${JSON.stringify(value)}）要写成一句不为空的话`);
	}
	if (manifest.description !== undefined && manifest.title === undefined) throw new ConfigError(`${manifestPath}：写了 description 就要写 title（领域的中文名），幕僚长的名册两样都列`);
	if ([...(manifest.description ?? "")].length > DESCRIPTION_MAX_CHARS) throw new ConfigError(`${manifestPath}：description 超过 ${DESCRIPTION_MAX_CHARS} 字，只写一句给幕僚长看的说明`);
	const teamsFile = join(dir, "teams.yaml");
	if (existsSync(teamsFile)) throw new ConfigError(`${teamsFile}：不再读取 teams.yaml。团队就是这个模块 agents/ 里的全部成员，队名写在 module.json 的 team。删掉这个文件`);
	for (const s of manifest.sources ?? []) {
		for (const pattern of s.ignore ?? []) {
			try {
				new RegExp(pattern);
			} catch (error) {
				throw new ConfigError(`${manifestPath}：sources 里 ${s.name} 的 ignore「${pattern}」不是合法的正则：${(error as Error).message}`);
			}
		}
	}
	const rulesPath = join(dir, "rules.md");
	const skillsDir = join(dir, "skills");
	const moduleSources = [manifest.name, ...(manifest.sources ?? []).map((s) => s.name), ...(manifest.timers ?? []).map((t) => t.source ?? manifest.name)];
	const rules = existsSync(rulesPath) ? parseRules(rulesPath, manifest.name, readFileSync(rulesPath, "utf8")) : [];
	return {
		name: manifest.name,
		dir,
		manifest,
		rules: rules.map((r) => ({ ...r, sources: r.sources ?? [...new Set(moduleSources)] })),
		skillsDir: existsSync(skillsDir) ? skillsDir : undefined,
		team: loadTeam(dir, manifestPath, manifest.team, allowedProviders),
	};
}

function rejectLooseTeamFiles(stateDir: string): void {
	const home = `${join(stateDir, "modules")}/<名字>/`;
	const teamsFile = join(stateDir, "teams.yaml");
	if (existsSync(teamsFile)) throw new ConfigError(`${teamsFile}：不再读取状态目录下的 teams.yaml。把团队做成模块：成员放进 ${home}agents/，队名写在 ${home}module.json 的 team。删掉这个文件`);
	const agentsDir = join(stateDir, "agents");
	if (existsSync(agentsDir)) throw new ConfigError(`${agentsDir}：不再读取状态目录下零散的成员。把它们搬到 ${home}agents/，并在 ${home}module.json 写 team（队名）`);
}

export class Modules implements Domains {
	readonly modules: LoadedModule[];
	readonly userRules: ScopedRule[];
	readonly skippedUserRules: string[];
	readonly book: DomainBook;
	readonly #scopes: Map<string, string[]>;

	constructor(modules: LoadedModule[], userRules: ScopedRule[], skippedUserRules: string[]) {
		this.modules = modules;
		this.userRules = userRules;
		this.skippedUserRules = skippedUserRules;
		this.book = new Map(modules.map((m) => [m.name, m.team?.name ?? null]));
		this.#scopes = new Map(this.allRules().map((r) => [r.id, r.sources]));
	}

	static load(dirs: readonly string[], { stateDir, allowedProviders = [] }: ModulesLoadOptions = {}): Modules {
		if (stateDir !== undefined) rejectLooseTeamFiles(stateDir);
		const userRulesFile = stateDir === undefined ? undefined : join(stateDir, "rules.md");
		const modules: LoadedModule[] = [];
		for (const root of dirs) {
			if (!existsSync(root)) continue;
			for (const entry of readdirSync(root).sort()) {
				const dir = join(root, entry);
				if (statSync(dir).isDirectory() && existsSync(join(dir, "module.json"))) modules.push(loadModule(dir, allowedProviders));
			}
		}
		const names = modules.map((m) => m.name);
		const dup = names.find((n, i) => names.indexOf(n) !== i);
		if (dup) throw new ConfigError(`模块重名：${dup}`);
		const parsed = userRulesFile && existsSync(userRulesFile) ? parseRules(userRulesFile, USER_NAMESPACE, readFileSync(userRulesFile, "utf8")) : [];
		const userRules = parsed.filter((r): r is ScopedRule => !!r.sources?.length);
		const skipped = parsed.filter((r) => !r.sources?.length).map((r) => r.id);
		return new Modules(modules, userRules, skipped);
	}

	allRules(): ScopedRule[] {
		return [...this.userRules, ...this.modules.flatMap((m) => m.rules)];
	}

	rulesPrompt(): string {
		return this.allRules().map((r) => `### ${r.id}\n${r.text}`).join("\n\n");
	}

	rosterPrompt(): string {
		return this.modules.filter((m) => m.manifest.description).map((m) => `- ${m.name}（${m.manifest.title}）：${m.manifest.description}`).join("\n");
	}

	kitFor = (domain: string): DomainKit | undefined => {
		const module = this.modules.find((m) => m.name === domain);
		if (!module) return undefined;
		const { skillsDir } = module;
		const shared = skillsDir ? [skillsDir] : [];
		return { skillsDir, prepare: module.manifest.prepare, crew: (module.team?.members ?? []).map((m) => ({ ...m, skills: [...shared, ...m.skills] })) };
	};

	ruleAllows = (ruleId: string, triggerSource: string): boolean => {
		return triggerSource !== CONVERSATION_SOURCE && (this.#scopes.get(ruleId)?.includes(triggerSource) ?? false);
	};

	rulesFor = (triggerSource: string): string[] => [...this.#scopes.keys()].filter((id) => this.ruleAllows(id, triggerSource));

	sourcePolicy: SourcePolicy = (trigger) => {
		const filter = this.modules.flatMap((m) => m.manifest.sources ?? []).find((s) => s.name === trigger.source);
		if (!filter) return "candidate";
		if (filter.mode === "ignore") return "ignore";
		return (filter.ignore ?? []).some((p) => new RegExp(p).test(trigger.body)) ? "ignore" : "candidate";
	};

	isMarketSource = (source: string): boolean =>
		this.modules.some((m) => (m.manifest.sources ?? []).some((s) => s.name === source && s.market === true));

	timers(): TimerEntry[] {
		return this.modules.flatMap((m) => (m.manifest.timers ?? []).map((t) => ({ ...t, id: `${m.name}/${t.id}`, source: t.source ?? m.name })));
	}
}
