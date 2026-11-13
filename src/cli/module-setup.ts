import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exitOnConfigError } from "../config-error.ts";
import { loadConfig, loadModules } from "../host/config.ts";
import { filesDir, lockOf, PY_DIR, VENV_MARK, venvDir, venvsIn } from "../modules/files.ts";
import { moduleDataDir } from "../modules/knowledge.ts";

const GUIDE = "docs/modules/stock-ta.md";

const markOf = (venv: string): string | undefined => (existsSync(join(venv, VENV_MARK)) ? readFileSync(join(venv, VENV_MARK), "utf8") : undefined);

/** Keeps `current` and the most recently finished other one, for tickets still pinned to the version before. */
function dropOlder(dataDir: string, current: string): void {
	const others = venvsIn(dataDir).map((name) => join(filesDir(dataDir), name)).filter((venv) => venv !== current);
	const finishedAt = (venv: string) => statSync(join(venv, VENV_MARK), { throwIfNoEntry: false })?.mtimeMs ?? -1;
	const [, ...older] = others.filter((venv) => finishedAt(venv) >= 0).sort((a, b) => finishedAt(b) - finishedAt(a));
	for (const venv of [...older, ...others.filter((venv) => finishedAt(venv) < 0)]) rmSync(venv, { recursive: true, force: true });
}

export function setupModule(module: string): number {
	try {
		const config = loadConfig();
		const refuse = (line: string) => (console.log(line), 1);
		const found = loadModules(config).packages.find((p) => p.name === module);
		if (found === undefined || !found.scan.ok) return refuse(`${module} 不是已发现的新布局模块，或者包没通过检查（just modules 看状态）`);
		const lock = lockOf(found.dir);
		if (lock === undefined) {
			console.log(`${module} 没有 ${PY_DIR}/ 子项目，不用装`);
			return 0;
		}
		const dataDir = moduleDataDir(config.stateDir, module);
		const venv = venvDir(dataDir, lock);
		if (markOf(venv) === lock) {
			console.log(`${module} 的 Python 环境已经装好：${venv}`);
			return 0;
		}
		rmSync(venv, { recursive: true, force: true });
		mkdirSync(filesDir(dataDir), { recursive: true });
		// The environment goes outside the package: the package folder is watched and copied per version.
		const uv = spawnSync("uv", ["sync", "--frozen", "--compile-bytecode", "--project", join(found.dir, PY_DIR)], { env: { ...process.env, UV_PROJECT_ENVIRONMENT: venv }, stdio: ["ignore", "inherit", "inherit"] });
		if (uv.error !== undefined) return refuse(`找不到 uv（${uv.error.message}）：先装 uv 并让它在 PATH 里，再重跑 just module setup ${module}，见 ${GUIDE}`);
		if (uv.status !== 0) return refuse(`uv 没装成（退出码 ${uv.status}）：依赖在私有 git 仓库里的话，先让这台机器的 git 能拿到它，再重跑 just module setup ${module}，见 ${GUIDE}`);
		writeFileSync(join(venv, VENV_MARK), lock);
		dropOlder(dataDir, venv);
		console.log(`装好了 ${module} 的 Python 环境：${venv}`);
		return 0;
	} catch (error) {
		return exitOnConfigError(error);
	}
}
