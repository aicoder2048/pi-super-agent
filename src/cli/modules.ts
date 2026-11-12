import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { exitOnConfigError } from "../config-error.ts";
import { loadConfig, loadModules } from "../host/config.ts";
import { feedSpecs } from "../host/wiring.ts";
import type { LoadedModule, ModuleState, SourceFilter } from "../modules.ts";
import { problemLine } from "../modules/validate.ts";

function stateText({ enabled, by }: ModuleState): string {
	if (by === "config") return enabled ? "启用（config.json 打开）" : "停用（config.json 关闭）";
	return enabled ? "启用（默认）" : "停用（模块默认关闭）";
}

function skillNames(skillsDir: string | undefined): string[] {
	if (!skillsDir) return [];
	return readdirSync(skillsDir, { withFileTypes: true })
		.filter((e) => (e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md"))) || (e.isFile() && e.name.endsWith(".md")))
		.map((e) => e.name.replace(/\.md$/, ""))
		.sort();
}

function width(text: string): number {
	return [...text].reduce((n, ch) => n + (ch.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0);
}

const pad = (text: string, to: number) => text + " ".repeat(Math.max(0, to - width(text)));

function columns(rows: readonly string[][]): (row: readonly string[]) => string {
	const widths = [0, 1].map((i) => Math.max(...rows.map((r) => width(r[i]))));
	return ([name, state, dir]) => `${pad(name, widths[0])}  ${pad(state, widths[1])}  ${dir}`;
}

function folder(dir: string): string {
	const rel = relative(process.cwd(), dir);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : dir;
}

function main(): void {
	const config = loadConfig();
	const modules = loadModules(config);
	const feedStatus = new Map(feedSpecs(config, modules, () => {}).map((f) => [f.source, f.status]));
	const sourceText = (m: LoadedModule, s: SourceFilter) => {
		if (!s.feed) return `${s.name} 投递`;
		return `${s.name} ${s.feed.kind}：${m.state.enabled ? feedStatus.get(s.name) : "模块停用"}`;
	};
	const detailRows: { label: string; values(m: LoadedModule): string[] }[] = [
		{ label: "来源", values: (m) => (m.manifest.sources ?? []).map((s) => sourceText(m, s)) },
		{ label: "工具", values: (m) => [(m.manifest.tools ?? []).join("、")].filter(Boolean) },
		{ label: "规则", values: (m) => [m.rules.map((r) => r.id).join("、")].filter(Boolean) },
		{ label: "技能", values: (m) => [skillNames(m.skillsDir).join("、")].filter(Boolean) },
	];

	const rows = modules.found.map((m) => [m.name, stateText(m.state), folder(m.dir)]);
	const line = columns(rows);
	console.log(`模块 ${modules.found.length} 个，启用 ${modules.modules.length} 个；状态目录 ${config.stateDir}`);
	modules.found.forEach((m, i) => {
		console.log(line(rows[i]));
		for (const d of detailRows) {
			const values = d.values(m);
			console.log(`  ${d.label}  ${values.length ? values.join(`\n  ${" ".repeat(width(d.label))}  `) : "无"}`);
		}
	});
	if (modules.packages.length) {
		console.log(`新布局包 ${modules.packages.length} 个`);
		const packageRows = modules.packages.map((p) => [p.name, `新布局  ${p.scan.ok ? "有效，已停用" : "无效"}`, folder(p.dir)]);
		const packageLine = columns(packageRows);
		modules.packages.forEach(({ scan }, i) => {
			console.log(packageLine(packageRows[i]));
			if (!scan.ok) for (const problem of scan.problems) console.log(`  ${problemLine(problem)}`);
		});
	}
	console.log(`开关模块：在 ${join(config.stateDir, "config.json")} 写 "modules": { "<模块名>": true 或 false }，重启宿主生效。`);
}

try {
	main();
} catch (error) {
	exitOnConfigError(error);
}
