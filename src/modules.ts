import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ConfigError, readJsonFile } from "./config-error.ts";
import { CONVERSATION_SOURCE, ruleId, type DomainBook, type SourcePolicy } from "./kernel/types.ts";
import type { TimerEntry } from "./sources/timer.ts";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { feedClass, type CollectionDescriptor, type Digest, type ScanResult } from "./modules/manifest.ts";
import type { FeedEntry } from "./modules/feed-runner.ts";
import { parseModelRef } from "./models.ts";
import { moduleNameProblem, problemLine, scanPackage } from "./modules/validate.ts";
import { loadTeam, type Member, type Team } from "./teams.ts";
import { MEMBER_TOOLS, DOMAIN_GATED_TOOLS, type DomainGatedTool } from "./worker/tools.ts";

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
	/** False: off unless config.json's `modules` turns it on. */
	defaultEnabled?: boolean;
	/** The domain's Chinese name. Required when `description` is written. */
	title?: string;
	/** One sentence for the 幕僚长. A module without it is not offered to the 幕僚长. */
	description?: string;
	/** The team's display name. Written exactly when `agents/` holds a member. */
	team?: string;
	/** The tools this domain turns on for its helper and members. Absent: none. */
	tools?: DomainGatedTool[];
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
	state: ModuleState;
	/** Set for a package served from its copy in the module store. */
	digest?: Digest;
	feeds?: readonly FeedEntry[];
}

export interface FoundPackage {
	name: string;
	dir: string;
	scan: ScanResult;
}

export interface ModuleState {
	enabled: boolean;
	by: "config" | "manifest" | "default";
}

export interface ModuleSwitches {
	values: Record<string, boolean>;
	file: string;
}

/** What a helper is handed from its ticket's domain, however the ticket was opened. */
export interface DomainKit {
	skillsDir: string | undefined;
	knowledgeDir: string | undefined;
	/** Runs once in the ticket's workdir before the helper first starts. Never for an inference ticket. */
	prepare: string | undefined;
	/** The module's members the helper may dispatch to, each with the module's `skills/` ahead of its own and `tools` capped by what the domain turns on. Empty: it works alone. */
	crew: readonly Member[];
	granted: readonly DomainGatedTool[];
}

/** The kit of a ticket with no domain, or whose module is gone. */
export const NO_DOMAIN: DomainKit = { skillsDir: undefined, knowledgeDir: undefined, prepare: undefined, crew: [], granted: [] };

/** The serving modules as the host uses them once tickets belong to them. Asked each time, because modules switch on and off while the host runs. */
export interface Domains {
	readonly book: () => DomainBook;
	/** `pin` is the ticket's package version; null asks the serving table. Undefined: no such module, or that version is gone. */
	readonly kitFor: (domain: string, pin: string | null) => DomainKit | undefined;
}

export interface ModulesLoadOptions {
	/** Its `rules.md` holds the user's rules. Omitted: no user rules, and the state dir is not checked for leftovers. */
	stateDir?: string;
	/** The providers a member's `model` may use. Empty: a member that names a model is rejected. */
	allowedProviders?: readonly string[];
	/** config.json's `modules`. Omitted: every module follows its manifest. */
	switches?: ModuleSwitches;
}

const DESCRIPTION_MAX_CHARS = 60;
const USER_NAMESPACE = "user";
/** These fields are pasted into the 幕僚长's prompt and into log lines; a line break in one could pass for a heading of its own. */
const LINE_BREAK_OR_CONTROL = /[\p{Cc}\u2028\u2029]/u;

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

function stateOf(manifest: ModuleManifest, switches: Record<string, boolean>): ModuleState {
	if (Object.hasOwn(switches, manifest.name)) return { enabled: switches[manifest.name], by: "config" };
	return manifest.defaultEnabled === false ? { enabled: false, by: "manifest" } : { enabled: true, by: "default" };
}

function checkModuleTools(manifestPath: string, tools: unknown, team: Team | undefined): void {
	const isGated = (t: unknown) => (DOMAIN_GATED_TOOLS as readonly unknown[]).includes(t);
	if (tools !== undefined && (!Array.isArray(tools) || !tools.length || !tools.every(isGated))) {
		throw new ConfigError(`${manifestPath}：tools（${JSON.stringify(tools)}）写成要开的工具列表，例如 ["lookup"]；能开的只有 ${DOMAIN_GATED_TOOLS.join("、")}，不开就去掉这个字段`);
	}
	const granted: readonly unknown[] = tools ?? [];
	for (const member of team?.members ?? []) {
		const withheld = member.tools?.find((t) => isGated(t) && !granted.includes(t));
		if (withheld) throw new ConfigError(`${member.file}：tools 里的 ${withheld} 要模块开了才有：在 ${manifestPath} 写 "tools": ["${withheld}"]，或从这位成员的 tools 去掉`);
	}
}

function cappedTools(own: readonly string[] | undefined, granted: readonly DomainGatedTool[]): readonly string[] | undefined {
	const withheld: readonly string[] = DOMAIN_GATED_TOOLS.filter((t) => !granted.includes(t) && MEMBER_TOOLS.includes(t));
	return withheld.length ? (own ?? MEMBER_TOOLS).filter((t) => !withheld.includes(t)) : own;
}

function loadModule(dir: string, allowedProviders: readonly string[], switches: Record<string, boolean>): LoadedModule {
	const manifestPath = join(dir, "module.json");
	const manifest = readJsonFile<ModuleManifest>(manifestPath);
	if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new ConfigError(`${manifestPath}：要写成一个 JSON 对象，例如 {"name": "${basename(dir)}"}，现在写的是 ${JSON.stringify(manifest)}`);
	for (const key of ["name", "title", "description"] as const) {
		const value: unknown = manifest[key];
		if (typeof value === "string" && LINE_BREAK_OR_CONTROL.test(value)) throw new ConfigError(`${manifestPath}：${key}（${JSON.stringify(value)}）里有换行或别的控制字符，写成一行普通文字`);
	}
	if (!manifest.name || manifest.name !== basename(dir)) throw new ConfigError(`${manifestPath}：name 必须等于目录名 ${basename(dir)}`);
	const nameProblem = moduleNameProblem(manifest.name);
	if (nameProblem) throw new ConfigError(`${manifestPath}：${nameProblem}`);
	if (manifest.defaultEnabled !== undefined && typeof manifest.defaultEnabled !== "boolean") {
		throw new ConfigError(`${manifestPath}：defaultEnabled（${JSON.stringify(manifest.defaultEnabled)}）只能是 true 或 false`);
	}
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
	const team = loadTeam(dir, manifestPath, manifest.team, allowedProviders);
	checkModuleTools(manifestPath, manifest.tools, team);
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
		team,
		state: stateOf(manifest, switches),
	};
}

/** "unreadable": not valid JSON, such as one caught half-saved. A folder first seen that way is read as a package, so the scan reports it instead of stopping the host. */
export function manifestLayout(manifestPath: string): "package" | "legacy" | "unreadable" {
	try {
		const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
		return typeof raw === "object" && raw !== null && Object.hasOwn(raw, "schema") ? "package" : "legacy";
	} catch {
		return "unreadable";
	}
}

function rejectLooseTeamFiles(stateDir: string): void {
	const home = `${join(stateDir, "modules")}/<名字>/`;
	const teamsFile = join(stateDir, "teams.yaml");
	if (existsSync(teamsFile)) throw new ConfigError(`${teamsFile}：不再读取状态目录下的 teams.yaml。把团队做成模块：成员放进 ${home}agents/，队名写在 ${home}module.json 的 team。删掉这个文件`);
	const agentsDir = join(stateDir, "agents");
	if (existsSync(agentsDir)) throw new ConfigError(`${agentsDir}：不再读取状态目录下零散的成员。把它们搬到 ${home}agents/，并在 ${home}module.json 写 team（队名）`);
}

const MODULE_PARTS = ["agents", "teams.yaml", "rules.md", "skills"];

function rejectFilesOutsideAnyModule(root: string, entries: readonly string[]): void {
	const home = `${root}/<名字>/`;
	const teamsFile = join(root, "teams.yaml");
	if (entries.includes("teams.yaml")) throw new ConfigError(`${teamsFile}：不再读取 teams.yaml。团队就是一个模块 agents/ 里的全部成员：成员放进 ${home}agents/，队名写在 ${home}module.json 的 team。删掉这个文件`);
	const agentsDir = join(root, "agents");
	if (entries.includes("agents") && !existsSync(join(agentsDir, "module.json")) && statSync(agentsDir).isDirectory() && readdirSync(agentsDir).some((e) => e.endsWith(".md"))) {
		throw new ConfigError(`${agentsDir}：模块目录下零散的成员不会被读取，成员只属于一个模块。把它们搬到 ${home}agents/，并在 ${home}module.json 写 team（队名）`);
	}
}

function rejectModuleWithoutManifest(root: string, dir: string): void {
	const parts = MODULE_PARTS.filter((part) => existsSync(join(dir, part)));
	if (parts.length) throw new ConfigError(`${dir}：有 ${parts.join("、")} 却没有 module.json，这个文件夹不会被当成模块。加上 ${join(dir, "module.json")}，至少写 {"name": "${basename(dir)}"}；不是模块就把它移出 ${root}`);
}

/**
 * A package as the legacy table serves it, read from its copy in the module store. Members
 * get no gated tools: what a package's code may reach goes through the Gateway (F3).
 */
export function packageModule(dir: string, name: string): LoadedModule {
	const result = scanPackage(dir, { runCases: false, folder: name });
	if (!result.ok) throw new Error(`${dir}：模块副本读不出来：${result.problems.map(problemLine).join("；")}`);
	const { manifest, components, digest } = result.scan;
	const members = components.flatMap((c): Member[] => {
		if (c.kind !== "agents") return [];
		const file = join(dir, "agents", `${c.name}.md`);
		const { agent } = c;
		return [{ name: agent.name, title: agent.title, description: agent.description, tools: cappedTools(agent.tools, []), skills: [], model: agent.model === undefined ? undefined : parseModelRef(agent.model, file), prompt: parseFrontmatter(readFileSync(file, "utf8")).body.trim(), file }];
	});
	const [first, ...rest] = members;
	const collections = new Map(components.flatMap((c): [string, CollectionDescriptor][] => (c.kind === "data" ? [[c.name, c.collection]] : [])));
	const feeds = components.flatMap((c): FeedEntry[] =>
		c.kind === "feeds" ? [{ source: `${manifest.name}/${c.name}`, module: manifest.name, dir, name: c.name, feed: c.feed, fixtures: c.fixtures, components, private: feedClass(c.feed, collections) === "private" }] : [],
	);
	const sources = feeds.map(({ source, feed }): SourceFilter => ({
		name: source,
		title: feed.title,
		...(feed.description !== undefined && { description: feed.description }),
		...(feed.ignore !== undefined && { ignore: [...feed.ignore] }),
	}));
	const rulesPath = join(dir, "rules.md");
	const skillsDir = join(dir, "skills");
	return {
		name: manifest.name,
		dir,
		manifest: { name: manifest.name, ...(manifest.title !== undefined && { title: manifest.title }), ...(manifest.description !== undefined && { description: manifest.description }), ...(manifest.team !== undefined && { team: manifest.team }), sources },
		rules: existsSync(rulesPath) ? parseRules(rulesPath, manifest.name, readFileSync(rulesPath, "utf8")).map((r) => ({ ...r, sources: r.sources ?? [] })) : [],
		skillsDir: existsSync(skillsDir) ? skillsDir : undefined,
		...(first !== undefined && manifest.team !== undefined && { team: { name: manifest.team, members: [first, ...rest] } }),
		state: { enabled: true, by: "default" },
		digest,
		feeds,
	};
}

const onRoster = (module: LoadedModule) => module.manifest.description !== undefined;

export class Modules {
	readonly found: LoadedModule[];
	readonly packages: readonly FoundPackage[];
	readonly modules: LoadedModule[];
	readonly userRules: ScopedRule[];
	readonly skippedUserRules: string[];
	readonly book: DomainBook;
	readonly #scopes: Map<string, string[]>;

	constructor(found: LoadedModule[], userRules: ScopedRule[], skippedUserRules: string[], packages: readonly FoundPackage[] = [], serving = found.filter((m) => m.state.enabled)) {
		this.found = found;
		this.packages = packages;
		this.modules = serving;
		this.userRules = userRules;
		this.skippedUserRules = skippedUserRules;
		this.book = new Map(this.modules.map((m) => [m.name, { team: m.team?.name ?? null, onRoster: onRoster(m), ...(m.digest && { digest: m.digest }), ...(m.manifest.title && { title: m.manifest.title }) }]));
		this.#scopes = new Map(this.allRules().map((r) => [r.id, r.sources]));
	}

	static load(dirs: readonly string[], { stateDir, allowedProviders = [], switches = { values: {}, file: "config.json" } }: ModulesLoadOptions = {}): Modules {
		if (stateDir !== undefined) rejectLooseTeamFiles(stateDir);
		const userRulesFile = stateDir === undefined ? undefined : join(stateDir, "rules.md");
		const modules: LoadedModule[] = [];
		const packages: FoundPackage[] = [];
		for (const root of dirs) {
			if (!existsSync(root)) continue;
			const entries = readdirSync(root).sort();
			rejectFilesOutsideAnyModule(root, entries);
			for (const entry of entries) {
				const dir = join(root, entry);
				if (!statSync(dir).isDirectory()) continue;
				const manifestPath = join(dir, "module.json");
				if (!existsSync(manifestPath)) rejectModuleWithoutManifest(root, dir);
				else if (manifestLayout(manifestPath) !== "legacy") packages.push({ name: entry, dir, scan: scanPackage(dir, { runCases: false }) });
				else modules.push(loadModule(dir, allowedProviders, switches.values));
			}
		}
		const all = [...modules, ...packages];
		for (const [i, module] of all.entries()) {
			const first = all.slice(0, i).find((m) => m.name === module.name);
			if (first) throw new ConfigError(`${first.dir}：模块重名：${module.name} 也定义在 ${module.dir}。给其中一个文件夹改名（module.json 的 name 跟着改），或删掉一个`);
		}
		const names = all.map((m) => m.name);
		const unknown = Object.keys(switches.values).find((name) => !names.includes(name));
		if (unknown) throw new ConfigError(`${switches.file}：modules.${unknown} 不是已发现的模块，已发现：${names.join("、") || "（没有）"}`);
		const parsed = userRulesFile && existsSync(userRulesFile) ? parseRules(userRulesFile, USER_NAMESPACE, readFileSync(userRulesFile, "utf8")) : [];
		const userRules = parsed.filter((r): r is ScopedRule => !!r.sources?.length);
		const skipped = parsed.filter((r) => !r.sources?.length).map((r) => r.id);
		return new Modules(modules, userRules, skipped, packages);
	}

	/** The same load serving exactly `modules`, in their order. */
	serve(modules: LoadedModule[]): Modules {
		return new Modules(this.found, this.userRules, this.skippedUserRules, this.packages, modules);
	}

	allRules(): ScopedRule[] {
		return [...this.userRules, ...this.modules.flatMap((m) => m.rules)];
	}

	rulesPrompt(): string {
		return this.allRules().map((r) => `### ${r.id}\n${r.text}`).join("\n\n");
	}

	rosterPrompt(): string {
		return this.modules.filter(onRoster).map((m) => `- ${m.name}（${m.manifest.title}）：${m.manifest.description}`).join("\n");
	}

	kitFor = (domain: string): DomainKit | undefined => {
		const module = this.modules.find((m) => m.name === domain);
		if (!module) return undefined;
		const { skillsDir } = module;
		const shared = skillsDir ? [skillsDir] : [];
		const granted = module.manifest.tools ?? [];
		const knowledgeDir = join(module.dir, "knowledge");
		return {
			skillsDir,
			knowledgeDir: existsSync(knowledgeDir) ? knowledgeDir : undefined,
			prepare: module.manifest.prepare,
			crew: (module.team?.members ?? []).map((m) => ({ ...m, skills: [...shared, ...m.skills], tools: cappedTools(m.tools, granted) })),
			granted,
		};
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

	feeds(): FeedEntry[] {
		return this.modules.flatMap((m) => m.feeds ?? []);
	}

	isMarketSource = (source: string): boolean =>
		this.modules.some((m) => (m.manifest.sources ?? []).some((s) => s.name === source && s.market === true));

	timers(): TimerEntry[] {
		return this.modules.flatMap((m) => (m.manifest.timers ?? []).map((t) => ({ ...t, id: `${m.name}/${t.id}`, source: t.source ?? m.name })));
	}
}
