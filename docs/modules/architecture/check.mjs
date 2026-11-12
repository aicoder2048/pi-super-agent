#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
const passes = [];

function check(name, run) {
  try {
    const note = run();
    passes.push(note ? `${name}: ${note}` : name);
  } catch (error) {
    failures.push(`${name}: ${error.message.trim().split("\n").slice(0, 12).join("\n    ")}`);
  }
}

function read(relative) {
  const path = join(here, relative);
  if (!existsSync(path)) throw new Error(`${relative} does not exist`);
  return readFileSync(path, "utf8");
}

function node(args) {
  return execFileSync(process.execPath, args, { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

check("design.md answers every requirement id", () => {
  const ids = [...read("requirements.md").matchAll(/^\| ([A-Z]\d+) \|/gm)].map((match) => match[1]);
  if (ids.length === 0) throw new Error("requirements.md lists no ids");
  const design = read("design.md");
  const missing = ids.filter((id) => !new RegExp(`\\b${id}\\b`).test(design));
  if (missing.length > 0) throw new Error(`design.md never mentions ${missing.join(", ")}`);
  return `${ids.length} ids`;
});

check("the type sketch passes tsc", () => {
  read("sketch/tsconfig.json");
  try {
    execFileSync("npx", ["--yes", "-p", "typescript@5.9", "tsc", "-p", "sketch/tsconfig.json"], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`${error.stdout ?? ""}${error.stderr ?? ""}` || error.message);
  }
});

for (const sample of ["personal-health", "personal-tax"]) {
  check(`the ${sample} sample package validates`, () => {
    read("sketch/validate.ts");
    try {
      return node(["sketch/validate.ts", `sample/${sample}`]).trim().split("\n").at(-1);
    } catch (error) {
      throw new Error(`${error.stdout ?? ""}${error.stderr ?? ""}` || error.message);
    }
  });
}

check("each broken sample package is rejected with its reason", () => {
  const cases = JSON.parse(read("sample/broken/expected.json"));
  const names = Object.keys(cases);
  if (names.length === 0) throw new Error("sample/broken/expected.json lists no cases");
  for (const name of names) {
    let output = "";
    try {
      output = node(["sketch/validate.ts", `sample/broken/${name}`]);
    } catch (error) {
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      if (!output.includes(cases[name])) {
        throw new Error(`${name} failed without the reason "${cases[name]}":\n${output}`);
      }
      continue;
    }
    throw new Error(`${name} was accepted:\n${output}`);
  }
  return `${names.length} cases`;
});

check("an update may add or rename a field and may not change a unit", () => {
  const previous = "sample/update/0.1.0/health-lite";
  read(`${previous}/module.json`);
  node(["sketch/validate.ts", "sample/update/0.2.0-adds-field/health-lite", "--previous", previous]);
  const renamed = node(["sketch/validate.ts", "sample/update/0.2.0-renames-field/health-lite", "--previous", previous]);
  if (!renamed.includes('renamed from "lab"')) throw new Error(`the rename was accepted without the note 'renamed from "lab"':\n${renamed}`);
  let output = "";
  try {
    output = node(["sketch/validate.ts", "sample/update/0.2.0-changes-unit/health-lite", "--previous", previous]);
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (!output.includes("changed unit")) throw new Error(`the unit change failed without "changed unit":\n${output}`);
    return;
  }
  throw new Error(`the unit change was accepted:\n${output}`);
});

check("the lifecycle, access and validator tests pass", () => {
  const tests = ["sketch/lifecycle.test.ts", "sketch/protocol.test.ts", "sketch/validate.test.ts"];
  for (const test of tests) read(test);
  try {
    const output = node(["--test", ...tests]);
    return output.match(/^ℹ pass \d+$/m)?.[0].slice(2);
  } catch (error) {
    throw new Error(`${error.stdout ?? ""}`.split("\n").filter((line) => /^not ok|✖/.test(line)).join("\n") || error.message);
  }
});

for (const line of passes) console.log(`ok    ${line}`);
for (const line of failures) console.log(`FAIL  ${line}`);
process.exit(failures.length === 0 ? 0 : 1);
