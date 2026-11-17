import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { providersOf } from "../../src/modules/rehearse.ts";
import { scanPackage } from "../../src/modules/validate.ts";

const temp = mkdtempSync(join(tmpdir(), "psa-providers-"));
test.after(() => rmSync(temp, { recursive: true, force: true }));
let made = 0;

function scanned(name: string, tree: Record<string, string | object>) {
	const root = join(temp, String(++made), name);
	for (const [path, content] of Object.entries(tree)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
	}
	const result = scanPackage(root, { runCases: false });
	assert.ok(result.ok, JSON.stringify(result));
	return result.scan;
}

const manifest = (name: string, more: object = {}) => ({ schema: 1, name, version: "0.1.0", ...more });
const agent = (name: string, uses: string) => `---\nname: ${name}\ntitle: ${name}\ndescription: d\ntools: read\nuses: ${uses}\n---\n正文`;
const exam = (uses: string) => `---\nname: q\nuses: ${uses}\nexpect: x\n---\n问题`;

test("预演要带的提供方：专家、考题和 module.json 的 uses 里外部工具的模块，去重，不含本模块", () => {
	const team = scanned("beta", {
		"module.json": manifest("beta", { team: "乙队" }),
		"tools/own/tool.json": { title: "t", description: "d", effect: "read", input: { x: { type: "text", title: "x" } }, output: { y: { type: "text", title: "y" } } },
		"tools/own/index.ts": "export default () => ({ y: 'a' });",
		"agents/a.md": agent("a", "tools/own, alpha/tools/level, alpha/tools/other"),
		"evals/q.md": exam("delta/tools/quote"),
	});
	assert.deepEqual(providersOf(team), ["alpha", "delta"]);
});

test("预演要带的提供方：只在 module.json 的 uses 里写了 alpha 的模块，也带上 alpha", () => {
	const solo = scanned("gamma", { "module.json": manifest("gamma", { uses: ["alpha/tools/level"] }), "evals/q.md": `---\nname: q\nexpect: 42\n---\n问题` });
	assert.deepEqual(providersOf(solo), ["alpha"]);
});

test("预演要带的提供方：没有外部工具的模块一个也不带", () => {
	const plain = scanned("plain", { "module.json": manifest("plain"), "evals/q.md": `---\nname: q\nexpect: 42\n---\n问题` });
	assert.deepEqual(providersOf(plain), []);
});
