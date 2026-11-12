import { statSync } from "node:fs";
import { problemLine, scanPackage, summary } from "../modules/validate.ts";

const USAGE = "usage: just module check <packageDir> [--previous <packageDir>] | just module on <name> | just module off <name> | just module import <name> <knowledge> <file or folder>";

const isFolder = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

function check(target: string, previous: string | undefined): number {
	const missing = [target, previous].find((dir) => dir !== undefined && !isFolder(dir));
	if (missing !== undefined) {
		console.log(`${missing}: no such folder`);
		return 1;
	}
	const result = scanPackage(target, { previous });
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
// Loaded only for on/off and import, so `check` runs under plain node without Pi (docs/modules/architecture/check.mjs).
else if ((command === "on" || command === "off") && target !== undefined && flag === undefined) process.exitCode = (await import("./module-switch.ts")).switchModule(target, command === "on");
else if (command === "import" && target !== undefined && flag !== undefined && previous !== undefined && rest.length === 0) process.exitCode = (await import("./module-import.ts")).importModuleKnowledge(target, flag, previous);
else {
	console.error(USAGE);
	process.exitCode = 2;
}
