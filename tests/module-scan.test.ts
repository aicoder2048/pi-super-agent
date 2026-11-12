import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Modules } from "../src/modules.ts";

const SAMPLE = fileURLToPath(new URL("../docs/modules/architecture/sample", import.meta.url));
const repoModules = fileURLToPath(new URL("../modules", import.meta.url));
const switches = (values: Record<string, boolean>) => ({ values, file: "/state/config.json" });

function root(packages: Record<string, object> = {}, samples: string[] = []): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-pkgs-"));
	for (const [name, manifest] of Object.entries(packages)) {
		mkdirSync(join(dir, name));
		writeFileSync(join(dir, name, "module.json"), JSON.stringify({ schema: 1, name, version: "0.1.0", ...manifest }));
	}
	for (const name of samples) cpSync(join(SAMPLE, name), join(dir, name), { recursive: true });
	return dir;
}

const legacy = (name: string): string => {
	const dir = mkdtempSync(join(tmpdir(), "psa-mods-"));
	mkdirSync(join(dir, name));
	writeFileSync(join(dir, name, "module.json"), JSON.stringify({ name }));
	return dir;
};

test("schema 1 的坏包不阻止加载：它被记成无效并带原因，旧布局模块照常加载", () => {
	const modules = Modules.load([repoModules, root({ bad: { descripton: "拼错" } })]);
	assert.deepEqual(modules.found.map((m) => m.name), ["pi-pi", "toy-market", "us-market"]);
	const [bad] = modules.packages;
	assert.equal(bad?.name, "bad");
	assert.ok(bad && !bad.scan.ok && bad.scan.problems.some((p) => p.where === "module.json" && p.reason.includes(`unknown key "descripton"`)));
});

test("schema 1 的好包出现在 packages 里，不算旧布局模块，也不贡献规则", () => {
	const modules = Modules.load([root({}, ["personal-tax"])]);
	assert.deepEqual(modules.found, []);
	assert.deepEqual(modules.allRules(), []);
	const [tax] = modules.packages;
	assert.ok(tax?.scan.ok);
	assert.equal(tax.scan.scan.manifest.version, "0.1.0");
});

test("旧布局模块行为不变：没有新布局包时 packages 为空，found 和 modules 和以前一样", () => {
	const modules = Modules.load([repoModules], { switches: switches({ "toy-market": true }) });
	assert.deepEqual(modules.packages, []);
	assert.deepEqual(modules.modules.map((m) => m.name), ["pi-pi", "toy-market", "us-market"]);
});

test("新布局包和旧布局模块同名时报模块重名，和两个旧模块同名一样", () => {
	assert.throws(
		() => Modules.load([legacy("tax"), root({ tax: {} })]),
		(e: Error) => e.name === "ConfigError" && /模块重名：tax 也定义在 .*\/tax/.test(e.message),
	);
});

test("config.json 的开关写了新布局包的名字不算没发现的模块", () => {
	assert.doesNotThrow(() => Modules.load([root({}, ["personal-tax"])], { switches: switches({ "personal-tax": true }) }));
});
