import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SourcePolicy } from "./kernel/types.ts";
import type { TimerEntry } from "./sources/timer.ts";

export interface SourceFilter {
	name: string;
	mode?: "candidate" | "ignore";
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
	rules: { id: string; text: string }[];
	skillsDir: string | undefined;
}

const RULE_HEADING = /^##\s+([\w-]+)\s*$/;

export function parseRules(namespace: string, markdown: string): { id: string; text: string }[] {
	const rules: { id: string; text: string }[] = [];
	for (const line of markdown.split("\n")) {
		const heading = line.match(RULE_HEADING);
		if (heading) rules.push({ id: `${namespace}/${heading[1]}`, text: "" });
		else if (rules.length) rules[rules.length - 1].text += line + "\n";
	}
	return rules.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text);
}

function loadModule(dir: string): LoadedModule {
	const manifestPath = join(dir, "module.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ModuleManifest;
	if (!manifest.name || manifest.name !== basename(dir)) throw new Error(`${manifestPath}：name 必须等于目录名 ${basename(dir)}`);
	for (const s of manifest.sources ?? []) for (const pattern of s.ignore ?? []) new RegExp(pattern);
	const rulesPath = join(dir, "rules.md");
	const skillsDir = join(dir, "skills");
	return {
		name: manifest.name,
		dir,
		manifest,
		rules: existsSync(rulesPath) ? parseRules(manifest.name, readFileSync(rulesPath, "utf8")) : [],
		skillsDir: existsSync(skillsDir) ? skillsDir : undefined,
	};
}

export class Modules {
	readonly modules: LoadedModule[];
	readonly userRules: { id: string; text: string }[];

	constructor(modules: LoadedModule[], userRules: { id: string; text: string }[]) {
		this.modules = modules;
		this.userRules = userRules;
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
		if (dup) throw new Error(`模块重名：${dup}`);
		const userRules = userRulesFile && existsSync(userRulesFile) ? parseRules("user", readFileSync(userRulesFile, "utf8")) : [];
		return new Modules(modules, userRules);
	}

	allRules(): { id: string; text: string }[] {
		return [...this.userRules, ...this.modules.flatMap((m) => m.rules)];
	}

	rulesPrompt(): string {
		return this.allRules().map((r) => `### ${r.id}\n${r.text}`).join("\n\n");
	}

	isKnownRule = (ruleId: string): boolean => this.allRules().some((r) => r.id === ruleId);

	sourcePolicy: SourcePolicy = (trigger) => {
		const filter = this.modules.flatMap((m) => m.manifest.sources ?? []).find((s) => s.name === trigger.source);
		if (!filter) return "candidate";
		if (filter.mode === "ignore") return "ignore";
		return (filter.ignore ?? []).some((p) => new RegExp(p).test(trigger.body)) ? "ignore" : "candidate";
	};

	timers(): TimerEntry[] {
		return this.modules.flatMap((m) => (m.manifest.timers ?? []).map((t) => ({ ...t, id: `${m.name}/${t.id}`, source: t.source ?? m.name })));
	}

	moduleForRule(ruleId: string | null): LoadedModule | undefined {
		if (!ruleId) return undefined;
		return this.modules.find((m) => ruleId.startsWith(`${m.name}/`));
	}
}
