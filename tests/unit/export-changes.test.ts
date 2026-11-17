import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanPackage } from "../../src/modules/validate.ts";

const temp = mkdtempSync(join(tmpdir(), "psa-export-changes-"));
test.after(() => rmSync(temp, { recursive: true, force: true }));
let made = 0;

type Tree = Record<string, string | object>;
function pkg(tree: Tree): string {
	const root = join(temp, String(++made), "alpha");
	for (const [path, content] of Object.entries(tree)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
	}
	return root;
}

const level = { type: "number", title: "价位" };
const tool = (output: object = { level, note: { type: "text", title: "说明" } }, input: object = { code: { type: "text", title: "代码" } }) => ({ title: "t", description: "d", effect: "read", input, output });
const BASE: Tree = {
	"module.json": { schema: 1, name: "alpha", version: "0.1.0", exports: ["tools/level"] },
	"tools/level/tool.json": tool(),
	"tools/level/index.ts": "export default () => ({ level: 1, note: 'x', bands: [{ low: 1, high: 2 }] });",
	"tools/level/cases.json": [{ name: "一档", input: { code: "A" }, expect: { level: 1, bands: [{ low: 1, high: 2 }] } }],
	"tools/inside/tool.json": tool(),
	"tools/inside/index.ts": "export default () => ({ level: 1 });",
};
const before = pkg(BASE);

const notesAfter = (change: Tree): string[] => {
	const result = scanPackage(pkg({ ...BASE, ...change }), { previous: before, runCases: false });
	assert.ok(result.ok, JSON.stringify(result));
	return result.scan.notes;
};
const EXPORTED = "这个工具开放给了别的模块";

test("开放工具的 output 少了字段：--previous 提醒，写明开放给了别的模块", () => {
	assert.deepEqual(notesAfter({ "tools/level/tool.json": tool({ level }) }), [`tools/level/tool.json: ${EXPORTED}，output 少了字段 "note"，用它的模块可能会坏`]);
});

test("开放工具的字段改了 type 或 title、input 少了字段：各提醒一行", () => {
	const input = { code: { type: "text", title: "代码" } };
	assert.deepEqual(notesAfter({ "tools/level/tool.json": tool({ level: { type: "text", title: "价位" }, note: { type: "text", title: "备注" } }, input) }), [
		`tools/level/tool.json: ${EXPORTED}，output 的字段 "level" 的 type 从 number 改成 text，用它的模块可能会坏`,
		`tools/level/tool.json: ${EXPORTED}，output 的字段 "note" 的 title 从「说明」改成「备注」，用它的模块可能会坏`,
	]);
	assert.deepEqual(notesAfter({ "tools/level/tool.json": tool(undefined, { symbol: { type: "text", title: "代码" } }), "tools/level/cases.json": [{ name: "一档", input: { symbol: "A" }, expect: { level: 1, bands: [{ low: 1, high: 2 }] } }] }), [`tools/level/tool.json: ${EXPORTED}，input 少了字段 "code"，用它的模块可能会坏`]);
});

test("从 exports 里拿掉开放的工具：提醒", () => {
	assert.deepEqual(notesAfter({ "module.json": { schema: 1, name: "alpha", version: "0.2.0", exports: [] } }), [`module.json: ${EXPORTED}的 tools/level 不在 exports 里了，用它的模块会调不到`]);
});

test("cases.json 同名用例的输出形状变了（少了键、改了类型）：提醒，写出哪一处", () => {
	const changed = (expect: object) => notesAfter({ "tools/level/cases.json": [{ name: "一档", input: { code: "A" }, expect }] });
	assert.deepEqual(changed({ level: 1, bands: [{ low: 1 }] }), [`tools/level/cases.json: ${EXPORTED}，用例「一档」的输出形状变了（bands[0].high 没了），用它的模块可能会坏`]);
	assert.deepEqual(changed({ level: "1", bands: [{ low: 1, high: 2 }] }), [`tools/level/cases.json: ${EXPORTED}，用例「一档」的输出形状变了（level 从 number 变成 string），用它的模块可能会坏`]);
});

test("只加字段、只改数值、改了没开放的工具：不提醒", () => {
	assert.deepEqual(notesAfter({ "tools/level/tool.json": tool({ level, note: { type: "text", title: "说明" }, extra: { type: "text", title: "新" } }) }), []);
	assert.deepEqual(notesAfter({ "tools/level/cases.json": [{ name: "一档", input: { code: "A" }, expect: { level: 2, bands: [{ low: 3, high: 4 }], more: true } }] }), []);
	assert.deepEqual(notesAfter({ "tools/inside/tool.json": tool({ other: { type: "text", title: "别的" } }) }), []);
});

const STOCK_TA = join(import.meta.dirname, "../../docs/modules/examples/stock-ta");

test("stock-ta：structure 的 output 去掉 levels，--previous 对着仓库里的版本给提醒", () => {
	const copy = join(temp, "stock-ta-next", "stock-ta");
	cpSync(STOCK_TA, copy, { recursive: true });
	const file = join(copy, "tools/structure/tool.json");
	const descriptor = JSON.parse(readFileSync(file, "utf8"));
	delete descriptor.output.levels;
	writeFileSync(file, JSON.stringify(descriptor));
	const result = scanPackage(copy, { previous: STOCK_TA, runCases: false });
	assert.ok(result.ok, JSON.stringify(result));
	assert.deepEqual(result.scan.notes.filter((n) => n.includes(EXPORTED)), [`tools/structure/tool.json: ${EXPORTED}，output 少了字段 "levels"，用它的模块可能会坏`]);
});
