import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ConfigError, readJsonFile } from "./config-error.ts";
import { CONVERSATION_SOURCE, type SourcePolicy } from "./kernel/types.ts";
import type { TimerEntry } from "./sources/timer.ts";

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
}

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
		if (heading) rules.push({ id: `${namespace}/${heading[1]}`, text: "" });
		else if (!rule) continue;
		else if (sources) rule.sources = sources[1].split(/[,，\s]+/).filter(Boolean);
		else if (RULE_TEAM.test(line.trim())) {
			throw new ConfigError(`${file}：规则 ${rule.id} 写了「团队：」。规则不再指定团队，模块规则开的任务属于规则所在的模块，队伍是模块 agents/ 里的成员，使用者规则的任务由幕僚长选领域。删掉这一行`);
		} else rule.text += line + "\n";
	}
	return rules.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text);
}

function loadModule(dir: string): LoadedModule {
	const manifestPath = join(dir, "module.json");
	const manifest = readJsonFile<ModuleManifest>(manifestPath);
	if (!manifest.name || manifest.name !== basename(dir)) throw new ConfigError(`${manifestPath}：name 必须等于目录名 ${basename(dir)}`);
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
	};
}

export class Modules {
	readonly modules: LoadedModule[];
	readonly userRules: ScopedRule[];
	readonly skippedUserRules: string[];
	readonly #scopes: Map<string, string[]>;

	constructor(modules: LoadedModule[], userRules: ScopedRule[], skippedUserRules: string[]) {
		this.modules = modules;
		this.userRules = userRules;
		this.skippedUserRules = skippedUserRules;
		this.#scopes = new Map(this.allRules().map((r) => [r.id, r.sources]));
	}

	static load(dirs: string[], userRulesFile?: string): Modules {
		const modules: LoadedModule[] = [];
		for (const root of dirs) {
			if (!existsSync(root)) continue;
			for (const entry of readdirSync(root).sort()) {
				const dir = join(root, entry);
				if (statSync(dir).isDirectory() && existsSync(join(dir, "module.json"))) modules.push(loadModule(dir));
			}
		}
		const names = modules.map((m) => m.name);
		const dup = names.find((n, i) => names.indexOf(n) !== i);
		if (dup) throw new ConfigError(`模块重名：${dup}`);
		const parsed = userRulesFile && existsSync(userRulesFile) ? parseRules(userRulesFile, "user", readFileSync(userRulesFile, "utf8")) : [];
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

	moduleForRule(ruleId: string | null): LoadedModule | undefined {
		if (!ruleId) return undefined;
		return this.modules.find((m) => ruleId.startsWith(`${m.name}/`));
	}
}
