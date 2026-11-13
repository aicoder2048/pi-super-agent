import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, exitOnConfigError } from "../config-error.ts";
import { loadConfig, loadModules } from "../host/config.ts";
import { moduleNameProblem } from "../modules/validate.ts";

const TEMPLATES = ["notes", "team", "full"];
const TEMPLATES_DIR = join(import.meta.dirname, "..", "modules", "templates");

export function newModule(name: string, template: string): number {
	try {
		const problem = moduleNameProblem(name);
		if (problem) throw new ConfigError(`${problem}。用法：just module new <名字> [--template ${TEMPLATES.join("|")}]`);
		if (!TEMPLATES.includes(template)) throw new ConfigError(`没有叫 ${template} 的模板，有：${TEMPLATES.join("、")}`);
		const config = loadConfig();
		const root = join(config.stateDir, "modules");
		const dir = join(root, name);
		if (existsSync(dir)) throw new ConfigError(`${dir} 已存在，不覆盖。换个名字，或直接编辑那里的文件`);
		const modules = loadModules(config);
		const clash = [...modules.found, ...modules.packages].find((m) => m.name === name);
		if (clash) throw new ConfigError(`已有同名模块 ${name}（${clash.dir}），换个名字`);

		// Built outside modules/ and renamed in, so a running host's watcher sees one finished package.
		const staging = mkdtempSync(join(config.stateDir, ".module-new-"));
		try {
			cpSync(join(TEMPLATES_DIR, template), staging, { recursive: true });
			const manifestFile = join(staging, "module.json");
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
			writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, name, title: name }, null, 2)}\n`);
			mkdirSync(root, { recursive: true });
			renameSync(staging, dir);
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}

		console.log(`从模板 ${template} 生成了模块 ${name}：${dir}（已停用）`);
		console.log(`下一步：改里面的文件（README.md 说明每个文件夹放什么），然后 just module check ${dir}，有考题就 just module try ${name}，最后 just module on ${name}`);
		if (!config.modulesDirs.map((d) => resolve(d)).includes(resolve(root))) {
			console.log(`注意：config.json 的 modulesDirs 不包含 ${root}，宿主不会加载这个模块，请把它加进 modulesDirs`);
		}
		return 0;
	} catch (error) {
		return exitOnConfigError(error);
	}
}
