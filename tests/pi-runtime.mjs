// 优先使用项目依赖；无本地安装时，复用运行 pi 所需的全局依赖。
import { execFileSync } from "node:child_process";
import { createRequire, registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let globalRequire;
let agentEntry;
registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (error.code !== "ERR_MODULE_NOT_FOUND" ||
				!/^@earendil-works\/(pi-tui|pi-coding-agent)$/.test(specifier)) throw error;
			if (!globalRequire) {
				const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
				agentEntry = join(root, "@earendil-works/pi-coding-agent/dist/index.js");
				globalRequire = createRequire(agentEntry);
			}
			const entry = specifier === "@earendil-works/pi-coding-agent" ? agentEntry : globalRequire.resolve(specifier);
			return { url: pathToFileURL(entry).href, shortCircuit: true };
		}
	},
});
