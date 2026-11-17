import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { exitOnConfigError } from "../config-error.ts";
import { moduleNameProblem, SECRET_NAME } from "../modules/validate.ts";
import { moduleEnvFile, writeSecret } from "../secrets.ts";
import { defaultStateDir } from "../state-dir.ts";

/** Typed keys are not echoed. Piped input is read whole, so a key can be copied from another file without reaching the screen. */
function readValue(name: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) return Promise.resolve(readFileSync(0, "utf8").replace(/\r?\n$/, ""));
	process.stderr.write(`${name}（输入不显示，回车结束）：`);
	return new Promise((done) => {
		let value = "";
		const finish = (result: string) => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off("data", onData);
			process.stderr.write("\n");
			done(result);
		};
		const onData = (chunk: string) => {
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n") return finish(value);
				if (ch === "\u0003") return finish("");
				if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
				else value += ch;
			}
		};
		stdin.setRawMode(true);
		stdin.setEncoding("utf8");
		stdin.on("data", onData);
		stdin.resume();
	});
}

export async function setModuleSecret(module: string, name: string): Promise<number> {
	const refuse = (line: string) => (console.log(line), 1);
	const badModule = moduleNameProblem(module);
	if (badModule !== undefined) return refuse(badModule);
	if (!SECRET_NAME.test(name)) return refuse(`${name} 不是可用的密钥名（大写字母开头，只用大写字母、数字和下划线）`);
	const value = await readValue(name);
	if (value === "") return refuse(`没有输入 ${name} 的值，什么都没写`);
	const file = moduleEnvFile(defaultStateDir(), module);
	const newDir = existsSync(dirname(file)) ? undefined : mkdirSync(dirname(file), { recursive: true });
	const created = !existsSync(file);
	try {
		if (created) writeFileSync(file, "", { mode: 0o600 });
		writeSecret(file, name, value);
	} catch (error) {
		if (newDir !== undefined) rmSync(newDir, { recursive: true, force: true });
		else if (created) rmSync(file, { force: true });
		return exitOnConfigError(error);
	}
	console.log(`已把 ${name} 写进 ${file}（权限 600）`);
	return 0;
}
