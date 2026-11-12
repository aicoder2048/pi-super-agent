import { statSync } from "node:fs";
import { problemLine, scanPackage, summary } from "../modules/validate.ts";

const USAGE = "usage: just module check <packageDir> [--previous <packageDir>]";

function check(target: string, previous: string | undefined): number {
	if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
		console.log(`${target}: no such folder`);
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
const wellFormed = command === "check" && target !== undefined && rest.length === 0 && (flag === undefined || (flag === "--previous" && previous !== undefined));
if (wellFormed) process.exitCode = check(target, previous);
else {
	console.error(USAGE);
	process.exitCode = 2;
}
