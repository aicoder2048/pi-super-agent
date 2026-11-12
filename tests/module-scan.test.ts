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
	assert.deepEqual(modules.found.map((m) => m.name), ["toy-market", "us-market"]);
	const bad = modules.packages.find((p) => p.name === "bad");
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

test("旧布局模块行为不变：仓库里只有 pi-pi 是新布局包，其余的 found 和 modules 和以前一样", () => {
	const modules = Modules.load([repoModules], { switches: switches({ "toy-market": true }) });
	assert.deepEqual(modules.packages.map((p) => p.name), ["pi-pi"]);
	assert.deepEqual(modules.modules.map((m) => m.name), ["toy-market", "us-market"]);
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

test("扫描一个包时读文件出错（SKILL.md 是个目录）：这个包记成无效并带原因，加载照常", () => {
	const dir = root({ odd: {} });
	mkdirSync(join(dir, "odd/skills/foo/SKILL.md"), { recursive: true });
	const modules = Modules.load([dir]);
	const [odd] = modules.packages;
	assert.ok(odd && !odd.scan.ok, "odd is invalid");
	assert.match(odd.scan.problems[0]!.reason, /could not read the package: .*EISDIR/);
});

test("新布局包叫 user 或 conversation：和旧布局一样不许用这两个名字，包记成无效", () => {
	const modules = Modules.load([root({ user: {}, conversation: {} })]);
	assert.deepEqual(
		modules.packages.map((p) => [p.name, p.scan.ok ? "ok" : p.scan.problems[0]!.reason]),
		[
			["conversation", `"conversation" is reserved: "user" names your own rules and "conversation" names the chat source`],
			["user", `"user" is reserved: "user" names your own rules and "conversation" names the chat source`],
		],
	);
});

test("module.json 存了一半、不是合法 JSON：加载不报错，这个文件夹记成无效包并写明原因", () => {
	const dir = root();
	mkdirSync(join(dir, "half"));
	writeFileSync(join(dir, "half", "module.json"), '{"schema":1,');
	const modules = Modules.load([dir]);
	const [half] = modules.packages;
	assert.equal(half?.name, "half");
	assert.ok(half && !half.scan.ok && half.scan.problems.some((p) => p.where === "module.json" && /not valid JSON/.test(p.reason)));
});
