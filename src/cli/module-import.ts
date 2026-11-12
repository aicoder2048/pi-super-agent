import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { exitOnConfigError } from "../config-error.ts";
import { loadConfig, loadModules } from "../host/config.ts";
import { buildIndex, importKnowledge, moduleDataDir, type Knowledge } from "../modules/knowledge.ts";
import type { ModuleName } from "../modules/manifest.ts";

export function importModuleKnowledge(module: string, doc: string, from: string): number {
	try {
		const config = loadConfig();
		const found = loadModules(config).packages.find((p) => p.name === module);
		const refuse = (line: string) => (console.log(line), 1);
		if (found === undefined || !found.scan.ok) return refuse(`${module} 不是已发现的新布局模块，或者包没通过检查（just modules 看状态）`);
		const docs = found.scan.scan.components.filter((c): c is Knowledge => c.kind === "knowledge");
		const target = docs.find((d) => d.name === doc);
		if (target === undefined) return refuse(`${module} 没有叫 ${doc} 的知识，有：${docs.map((d) => d.name).join("、") || "（没有）"}`);
		if (target.source.license !== "user-import") return refuse(`${doc} 随模块自带全文（license 是 bundled），不用导入`);
		if (!existsSync(from)) return refuse(`${from}：没有这个文件或目录`);
		const dataDir = moduleDataDir(config.stateDir, module);
		const count = importKnowledge(dataDir, doc, resolve(from));
		if (count === 0) return refuse(`${from} 里没有 Markdown 文件（.md），没有导入`);
		const { digest, dir } = found.scan.scan;
		buildIndex({ module: module as ModuleName, digest, copyDir: dir, dataDir, docs });
		console.log(`导入了 ${module} 的 ${doc}：${count} 个 Markdown 文件，放在 ${join(dataDir, "knowledge", doc)}，索引已重建`);
		return 0;
	} catch (error) {
		return exitOnConfigError(error);
	}
}
