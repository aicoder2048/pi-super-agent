import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { judge, type Attempt, type Exam } from "../../src/modules/rehearse.ts";
import { problemLine, scanPackage } from "../../src/modules/validate.ts";

const temp = mkdtempSync(join(tmpdir(), "psa-exports-"));
test.after(() => rmSync(temp, { recursive: true, force: true }));
let made = 0;

function pkg(name: string, tree: Record<string, string | object>): string {
	const root = join(temp, String(++made), name);
	for (const [path, content] of Object.entries(tree)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
	}
	return root;
}

const manifest = (name: string, more: object = {}) => ({ schema: 1, name, version: "0.1.0", ...more });
const tool = (effect?: string) => ({ title: "t", description: "d", ...(effect && { effect }), input: { x: { type: "text", title: "x" } }, output: { y: { type: "text", title: "y" } } });
const agent = (name: string, uses: string) => `---\nname: ${name}\ntitle: ${name}\ndescription: d\ntools: read\nuses: ${uses}\n---\n正文`;
const collection = (cls: string) => ({ title: "c", kind: "record", class: cls, fields: { a: { type: "text", title: "a" } } });

const scan = (root: string) => scanPackage(root, { runCases: false });
const problems = (root: string) => {
	const result = scan(root);
	return result.ok ? [] : result.problems.map(problemLine);
};
const notes = (root: string) => {
	const result = scan(root);
	assert.ok(result.ok, JSON.stringify(result));
	return result.scan.notes;
};

test("exports 开放只读工具和纯计算工具：检查通过", () => {
	const root = pkg("alpha", {
		"module.json": manifest("alpha", { exports: ["tools/quote", "tools/calc"] }),
		"tools/quote/tool.json": tool("read"),
		"tools/quote/index.ts": "export default () => ({});",
		"tools/calc/tool.json": tool(),
		"tools/calc/index.ts": "export default () => ({ y: 'a' });",
		"tools/calc/cases.json": [{ name: "c", input: { x: "a" }, expect: { y: "a" } }],
		"data/prices/collection.json": collection("shareable"),
	});
	assert.deepEqual(problems(root), []);
});

test("exports 开放写工具：检查报错", () => {
	const root = pkg("alpha", { "module.json": manifest("alpha", { exports: ["tools/save"] }), "tools/save/tool.json": tool("write"), "tools/save/index.ts": "export default () => ({});" });
	assert.ok(problems(root).some((p) => p.startsWith("module.json:") && p.includes("tools/save") && p.includes("write")), problems(root).join("\n"));
});

test("有私密集合的模块写 exports：检查报错", () => {
	const root = pkg("alpha", {
		"module.json": manifest("alpha", { exports: ["tools/quote"] }),
		"tools/quote/tool.json": tool("read"),
		"tools/quote/index.ts": "export default () => ({});",
		"data/holdings/collection.json": collection("private"),
	});
	assert.ok(problems(root).some((p) => p.startsWith("module.json:") && p.includes("private") && p.includes("holdings")), problems(root).join("\n"));
});

test("有私密集合的模块写空的 exports：没开放任何工具，检查通过", () => {
	const root = pkg("alpha", { "module.json": manifest("alpha", { exports: [] }), "data/holdings/collection.json": collection("private") });
	assert.deepEqual(problems(root), []);
});

test("exports 写了包里没有的工具、或不是工具：检查报错", () => {
	const root = pkg("alpha", { "module.json": manifest("alpha", { exports: ["tools/none", "data/prices", "knowledge"] }), "data/prices/collection.json": collection("shareable") });
	const found = problems(root);
	for (const name of ["tools/none", "data/prices", "knowledge"]) assert.ok(found.some((p) => p.includes(`"${name}"`)), `${name}\n${found.join("\n")}`);
});

test("专家和考题的 uses 写外部工具全名：只提醒、不报错", () => {
	const root = pkg("beta", {
		"module.json": manifest("beta", { team: "乙队" }),
		"agents/analyst.md": agent("analyst", "stock-ta/tools/structure"),
		"evals/q.md": "---\nname: q\nuses: stock-ta/tools/structure\n---\n问题",
	});
	const found = notes(root);
	assert.ok(found.some((n) => n.startsWith("agents/analyst.md:") && n.includes("stock-ta/tools/structure")), found.join("\n"));
	assert.ok(found.some((n) => n.startsWith("evals/q.md:") && n.includes("stock-ta/tools/structure")), found.join("\n"));
});

test("uses 写本模块的全名、或格式不对的外部名：照旧报不认识", () => {
	const root = pkg("beta", { "module.json": manifest("beta", { team: "乙队" }), "agents/analyst.md": agent("analyst", "beta/tools/x, stock-ta/data/prices, Bad_Name/tools/x") });
	const found = problems(root);
	for (const use of ["beta/tools/x", "stock-ta/data/prices", "Bad_Name/tools/x"]) assert.ok(found.some((p) => p.includes(`uses "${use}"`)), `${use}\n${found.join("\n")}`);
});

test("没有专家的模块在 module.json 写 uses 外部工具：通过，带一行提醒", () => {
	const root = pkg("gamma", { "module.json": manifest("gamma", { uses: ["stock-ta/tools/quote"] }) });
	assert.ok(notes(root).some((n) => n.startsWith("module.json:") && n.includes("stock-ta/tools/quote")));
});

test("module.json 的 uses 写本模块能力：检查报错", () => {
	for (const use of ["knowledge", "tools/x", "data/x", "gamma/tools/x"]) {
		const root = pkg("gamma", { "module.json": manifest("gamma", { uses: [use] }) });
		assert.ok(problems(root).some((p) => p.startsWith("module.json:") && p.includes(`"${use}"`)), `${use}: ${problems(root).join("\n")}`);
	}
});

test("module.json 的 uses 不是字符串列表：检查报错", () => {
	const root = pkg("gamma", { "module.json": manifest("gamma", { uses: "stock-ta/tools/quote" }) });
	assert.ok(problems(root).some((p) => p.startsWith("module.json:") && p.includes(`"uses"`)), problems(root).join("\n"));
});

test("带 agents/ 的包写模块级 uses：检查报错", () => {
	const root = pkg("beta", { "module.json": manifest("beta", { team: "乙队", uses: ["stock-ta/tools/quote"] }), "agents/analyst.md": agent("analyst", "stock-ta/tools/quote") });
	assert.ok(problems(root).some((p) => p.startsWith("module.json:") && p.includes(`"uses"`) && p.includes("agents/")), problems(root).join("\n"));
});

const exam = (uses: string[]): Exam => ({ name: "q", uses: uses as Exam["uses"], expect: [], question: "?" });
const attempt = (gateway: string[]): Attempt => ({ opened: true, ticket: "tkt_1", domain: "beta", report: { status: "done", summary: "ok" }, gateway });

test("预演判分：考题的 uses 写外部全名时，认第一段是提供方、带 from=<预演的模块> 的那一行", () => {
	const line = "[gateway] stock-ta tools/structure tkt_1 analyst inference ok 12 ms from=beta";
	assert.equal(judge("beta", exam(["stock-ta/tools/structure"]), attempt([line])).pass, true);
	assert.equal(judge("beta", exam(["stock-ta/tools/structure"]), attempt([line.replace("from=beta", "from=other")])).pass, false);
	assert.equal(judge("beta", exam(["stock-ta/tools/structure"]), attempt([line.replace("tkt_1", "tkt_2")])).pass, false);
	assert.equal(judge("beta", exam(["tools/structure"]), attempt([line])).pass, false, "本模块的 uses 不认外部调用的行");
});

test("预演判分：本模块的 uses 只认不带 from= 的行，格式不变", () => {
	assert.equal(judge("beta", exam(["tools/own"]), attempt(["[gateway] beta tools/own tkt_1 helper request ok 3 ms"])).pass, true);
	assert.equal(judge("beta", exam(["tools/own"]), attempt(["[gateway] beta tools/own tkt_1 helper request ok 3 ms from=gamma"])).pass, false);
});
