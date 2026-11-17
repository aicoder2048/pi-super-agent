import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { problemLine, runCasesAsync, scanPackage } from "../../src/modules/validate.ts";

const READER = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default () => {
	const file = join(process.env.PSA_MODULE_DATA, "files", "level.txt");
	const level = existsSync(file) ? Number(readFileSync(file, "utf8")) : null;
	if (level !== null) writeFileSync(file, "0");
	return { level };
};`;

const FETCHER = `export default async (input) => {
	const reply = await fetch("https://quotes.example/v1/last?symbol=" + input.symbol, { headers: { authorization: process.env.QUOTE_KEY } });
	return { price: (await reply.json()).last };
};`;

const tool = (extra: object = {}) => JSON.stringify({ title: "t", description: "d", effect: "read", input: { symbol: { type: "text", title: "代码" } }, output: { level: { type: "number", title: "价位" } }, ...extra });

function pkg(t: TestContext, cases: Record<string, object[]>): string {
	const root = join(mkdtempSync(join(tmpdir(), "psa-check-fixtures-")), "alpha");
	t.after(() => rmSync(join(root, ".."), { recursive: true, force: true }));
	const tree: Record<string, string> = {
		"module.json": JSON.stringify({ schema: 1, name: "alpha", version: "0.1.0" }),
		"tools/reader/tool.json": tool(),
		"tools/reader/index.ts": READER,
		"tools/reader/fixtures/data/files/level.txt": "42",
		"tools/fetcher/tool.json": tool({ secrets: ["QUOTE_KEY"] }),
		"tools/fetcher/index.ts": FETCHER,
		...Object.fromEntries(Object.entries(cases).map(([name, list]) => [`tools/${name}/cases.json`, JSON.stringify(list)])),
	};
	for (const [path, content] of Object.entries(tree)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

const FROM_FIXTURE = { name: "夹具里的价位", input: { symbol: "X" }, expect: { level: 42 }, data: "tools/reader/fixtures/data" };
const WITHOUT_DATA = { name: "没有夹具时数据目录是空的", input: { symbol: "X" }, expect: { level: null } };
const REPLAYED = { name: "回放的应答", input: { symbol: "X" }, expect: { price: 9.5 }, responses: { "https://quotes.example/v1/last?symbol=X": { last: 9.5 } } };

const problems = (root: string) => {
	const result = scanPackage(root);
	return result.ok ? [] : result.problems.map(problemLine);
};

test("用例带夹具数据目录：工具读到夹具里的文件；同一次检查里没带夹具的用例看到的是空目录", (t) => {
	const root = pkg(t, { reader: [FROM_FIXTURE, WITHOUT_DATA] });
	assert.deepEqual(problems(root), []);
});

test("用例在夹具的一份副本上跑：工具改了数据目录，包里的夹具不变", (t) => {
	const root = pkg(t, { reader: [FROM_FIXTURE] });
	assert.deepEqual(problems(root), []);
	assert.equal(readFileSync(join(root, "tools/reader/fixtures/data/files/level.txt"), "utf8"), "42");
});

test("用例带 responses：工具的 fetch 按网址回放应答，不联网", (t) => {
	const root = pkg(t, { fetcher: [REPLAYED] });
	assert.deepEqual(problems(root), []);
	const missing = pkg(t, { fetcher: [{ ...REPLAYED, responses: {} }] });
	assert.match(problems(missing).join("\n"), /threw: the fixture has no response for https:\/\/quotes\.example/);
});

test("宿主跑用例（runCasesAsync）也带夹具数据目录和回放应答", async (t) => {
	const root = pkg(t, { reader: [FROM_FIXTURE, WITHOUT_DATA], fetcher: [REPLAYED] });
	const scan = scanPackage(root, { runCases: false });
	assert.ok(scan.ok, JSON.stringify(scan));
	assert.deepEqual(await runCasesAsync(scan.scan), []);
});

test("夹具数据目录不在包里、不是目录：检查报错", (t) => {
	for (const data of ["../outside", "tools/reader/index.ts", "tools/none", "/tmp"]) {
		const root = pkg(t, { reader: [{ ...FROM_FIXTURE, data }] });
		assert.match(problems(root).join("\n"), /tools\/reader\/cases\.json: case "夹具里的价位" has "data" .* a folder of this package/, data);
	}
	const root = pkg(t, { fetcher: [{ ...REPLAYED, responses: ["x"] }] });
	assert.match(problems(root).join("\n"), /case "回放的应答" has "responses" that is not an object/);
});

test("检查用完就删掉夹具的副本", (t) => {
	const root = pkg(t, { reader: [FROM_FIXTURE, WITHOUT_DATA] });
	const temp = mkdtempSync(join(tmpdir(), "psa-check-tmp-"));
	t.after(() => rmSync(temp, { recursive: true, force: true }));
	const saved = process.env["TMPDIR"];
	process.env["TMPDIR"] = temp;
	try {
		assert.deepEqual(problems(root), []);
	} finally {
		process.env["TMPDIR"] = saved;
	}
	assert.deepEqual(readdirSync(temp), []);
});
