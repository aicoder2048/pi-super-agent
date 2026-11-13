import { statSync } from "node:fs";
import { exitOnConfigError } from "../config-error.ts";
import { moduleDataDir } from "../modules/knowledge.ts";
import { problemLine, scanPackage, summary } from "../modules/validate.ts";
import { configuredSecretsFile, secretLookup } from "../secrets.ts";
import { defaultStateDir } from "../state-dir.ts";

const USAGE = "usage: just module check <packageDir> [--previous <packageDir>] | just module new <name> [--template notes|team|full] | just module try <name or packageDir> | just module on <name> | just module off <name> | just module import <name> <knowledge> <file or folder> | just module purge <name> [--confirm <name>] | just module setup <name>";

const isFolder = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

function check(target: string, previous: string | undefined): number {
	const missing = [target, previous].find((dir) => dir !== undefined && !isFolder(dir));
	if (missing !== undefined) {
		console.log(`${missing}: no such folder`);
		return 1;
	}
	let secretsFile: string | undefined;
	const stateDir = defaultStateDir();
	try {
		secretsFile = configuredSecretsFile(stateDir);
	} catch (error) {
		return exitOnConfigError(error);
	}
	const result = scanPackage(target, { previous, secret: secretLookup(secretsFile), dataDirOf: (name) => moduleDataDir(stateDir, name) });
	if (result.ok) {
		for (const note of result.scan.notes) console.log(`note ${note}`);
		console.log(summary(result.scan));
		return 0;
	}
	for (const problem of result.problems) console.log(problemLine(problem));
	console.log(`rejected ${result.name}: ${result.problems.length} problem(s)`);
	return 1;
}

const [command, target, flag, previous, ...rest] = process.argv.slice(2);
if (command === "check" && target !== undefined && rest.length === 0 && (flag === undefined || (flag === "--previous" && previous !== undefined))) process.exitCode = check(target, previous);
// Loaded only for the commands that read config.json, so `check` runs under plain node without Pi (docs/modules/architecture/check.mjs).
else if ((command === "on" || command === "off") && target !== undefined && flag === undefined) process.exitCode = (await import("./module-switch.ts")).switchModule(target, command === "on");
else if (command === "new" && target !== undefined && rest.length === 0 && (flag === undefined || (flag === "--template" && previous !== undefined))) process.exitCode = (await import("./module-new.ts")).newModule(target, previous ?? "notes");
else if (command === "try" && target !== undefined && flag === undefined) process.exitCode = await (await import("./module-try.ts")).tryModule(target);
else if (command === "import" && target !== undefined && flag !== undefined && previous !== undefined && rest.length === 0) process.exitCode = (await import("./module-import.ts")).importModuleKnowledge(target, flag, previous);
else if (command === "setup" && target !== undefined && flag === undefined) process.exitCode = (await import("./module-setup.ts")).setupModule(target);
else if (command === "purge" && target !== undefined && rest.length === 0 && (flag === undefined || (flag === "--confirm" && previous !== undefined))) process.exitCode = await (await import("./module-purge.ts")).purgeModule(target, previous);
else {
	console.error(USAGE);
	process.exitCode = 2;
}
