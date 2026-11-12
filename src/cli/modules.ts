import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { exitOnConfigError } from "../config-error.ts";
import { loadConfig, loadModules } from "../host/config.ts";
import { feedSpecs } from "../host/wiring.ts";
import { moduleRows, openStore, type ModuleRow } from "../kernel/store.ts";
import type { LoadedModule, ModuleState, SourceFilter } from "../modules.ts";
import { describe } from "../modules/lifecycle.ts";
import { problemLine } from "../modules/validate.ts";

function stateText({ enabled, by }: ModuleState): string {
	if (by === "config") return enabled ? "启用（config.json 打开）" : "停用（config.json 关闭）";
	return enabled ? "启用（默认）" : "停用（模块默认关闭）";
}

/** Read only when the host has made one, so listing never creates state.db. */
function rowsOf(stateDir: string): Map<string, ModuleRow> {
	const file = join(stateDir, "state.db");
	if (!existsSync(file)) return new Map();
	const db = openStore(file);
	try {
		return new Map(moduleRows(db).map((r) => [r.name, r]));
	} finally {
		db.close();
	}
}

const NEXT_START = "启用（宿主下次启动时生效）";

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
	const rows = rowsOf(config.stateDir);
	/** The record once the host has seen the module; before that, what its next start will do. */
	const status = (name: string, before: { on: boolean; text: string }) => {
		const row = rows.get(name);
		if (row?.record) return { on: row.record.state.at === "active", text: describe(row.record).label };
		if (row?.switch === true) return { on: false, text: NEXT_START };
		if (row?.switch === false) return { on: false, text: "已停用" };
		return before;
	};
	const legacy = (m: LoadedModule) => status(m.name, { on: m.state.enabled, text: stateText(m.state) });
	const feedStatus = new Map(feedSpecs(config, modules, () => {}).map((f) => [f.source, f.status]));
	const sourceText = (m: LoadedModule, s: SourceFilter) => {
		if (!s.feed) return `${s.name} 投递`;
		return `${s.name} ${s.feed.kind}：${legacy(m).on ? feedStatus.get(s.name) : "模块停用"}`;
	};
	const detailRows: { label: string; values(m: LoadedModule): string[] }[] = [
		{ label: "来源", values: (m) => (m.manifest.sources ?? []).map((s) => sourceText(m, s)) },
		{ label: "工具", values: (m) => [(m.manifest.tools ?? []).join("、")].filter(Boolean) },
		{ label: "规则", values: (m) => [m.rules.map((r) => r.id).join("、")].filter(Boolean) },
		{ label: "技能", values: (m) => [skillNames(m.skillsDir).join("、")].filter(Boolean) },
	];

	const packageStatus = (p: (typeof modules.packages)[number]) => (p.scan.ok || rows.get(p.name)?.record ? status(p.name, { on: false, text: config.moduleSwitches[p.name] ? NEXT_START : "已停用" }) : { on: false, text: "无效" });
	const table = modules.found.map((m) => [m.name, legacy(m).text, folder(m.dir)]);
	const line = columns(table);
	const on = modules.found.filter((m) => legacy(m).on).length + modules.packages.filter((p) => packageStatus(p).on).length;
	console.log(`模块 ${modules.found.length + modules.packages.length} 个，启用 ${on} 个；状态目录 ${config.stateDir}`);
	modules.found.forEach((m, i) => {
		console.log(line(table[i]));
		for (const d of detailRows) {
			const values = d.values(m);
			console.log(`  ${d.label}  ${values.length ? values.join(`\n  ${" ".repeat(width(d.label))}  `) : "无"}`);
		}
	});
	if (modules.packages.length) {
		console.log(`新布局包 ${modules.packages.length} 个`);
		const packageRows = modules.packages.map((p) => {
			return [p.name, `新布局  ${packageStatus(p).text}`, folder(p.dir)];
		});
		const packageLine = columns(packageRows);
		modules.packages.forEach(({ name, scan }, i) => {
			console.log(packageLine(packageRows[i]));
			const record = rows.get(name)?.record;
			if (record?.state.at === "active") {
				console.log(`  版本  ${record.state.serving.label}（${record.state.serving.digest.slice(0, 12)}）`);
				if (record.state.update !== null) console.log(`  说明  ${describe(record).reason}`);
			}
			if (!scan.ok) for (const problem of scan.problems) console.log(`  ${problemLine(problem)}`);
		});
	}
	console.log("开关模块：just module on <名字> 或 just module off <名字>，宿主已发现的模块马上生效，不用重启。");
}

try {
	main();
} catch (error) {
	exitOnConfigError(error);
}
