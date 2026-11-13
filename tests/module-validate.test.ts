import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runModuleCode, secretsFor } from "../src/modules/run-code.ts";
import { scanPackage } from "../src/modules/validate.ts";
import { codeSite } from "./helpers/code-site.ts";

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "modules", "architecture", "sample");
const update = (to: string) => scanPackage(join(SAMPLE, "update", to, "health-lite"), { previous: join(SAMPLE, "update", "0.1.0", "health-lite") });
const notesOf = (to: string): string => {
	const result = update(to);
	assert(result.ok, `${to} should be accepted`);
	return result.scan.notes.join("\n");
};

test("both sample modules pass the scan, a health domain and a tax domain with the same layout", () => {
	for (const name of ["personal-health", "personal-tax"]) assert.equal(scanPackage(join(SAMPLE, name)).ok, true, name);
});

test("a tool may bring its own data file and read it", () => {
	const reply = runModuleCode(codeSite(join(SAMPLE, "personal-tax"), "tools/tax-bracket"), "index.ts", { taxableIncome: 25000 });
	assert.deepEqual(reply, { ok: true, output: { bracket: 2, marginalRate: 0.2, tax: 4000 } });
});

test("module code gets the secrets its descriptor names as environment variables, and no other secret of the host", () => {
	const dir = mkdtempSync(join(tmpdir(), "module-env-"));
	writeFileSync(join(dir, "index.ts"), "export default () => ({ named: process.env.NAMED_KEY ?? null, other: process.env.OTHER_KEY ?? null });\n");
	process.env["NAMED_KEY"] = "n";
	process.env["OTHER_KEY"] = "o";
	try {
		assert.deepEqual(runModuleCode(codeSite(dir), "index.ts", {}, secretsFor(["NAMED_KEY"], (name) => process.env[name])), { ok: true, output: { named: "n", other: null } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a crash in module code fails that one call and says why", () => {
	const reply = runModuleCode(codeSite(join(SAMPLE, "personal-tax"), "tools/tax-bracket"), "index.ts", { taxableIncome: -1 });
	assert.deepEqual(reply, { ok: false, note: "应税所得不能是负数" });
});

test("an update may add, rename or remove a field: stored values are carried over or kept, and the note says which", () => {
	assert.equal(notesOf("0.2.0-adds-field"), "");
	assert(notesOf("0.2.0-renames-field").includes(`field "laboratory" renamed from "lab"`));
	const removed = notesOf("0.2.0-removes-field");
	assert(removed.includes("kept and hidden") && removed.includes(`"was": "lab"`));
});

test("an update that changes a field's unit is refused, because stored numbers would mean something else", () => {
	const result = update("0.2.0-changes-unit");
	assert(!result.ok && result.problems.some((problem) => problem.reason.includes("changed unit from mmol/L to mg/dL")));
});
