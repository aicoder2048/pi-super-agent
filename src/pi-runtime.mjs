// 优先使用项目依赖；无本地安装时，按运行 pi 的全局安装解析 Pi 及其依赖。
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PI_SPECIFIER = /^(@earendil-works\/[^/]+|typebox)(\/.*)?$/;

let piParentURL;
export function piPackageRoot() {
	const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	return join(root, "@earendil-works/pi-coding-agent");
}

export function piCliPath() {
	return join(piPackageRoot(), "dist/cli.js");
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (error.code !== "ERR_MODULE_NOT_FOUND" || !PI_SPECIFIER.test(specifier)) throw error;
			piParentURL ??= pathToFileURL(join(piPackageRoot(), "dist/index.js")).href;
			if (specifier === "@earendil-works/pi-coding-agent") {
				return { url: piParentURL, shortCircuit: true };
			}
			return nextResolve(specifier, { ...context, parentURL: piParentURL });
		}
	},
});
