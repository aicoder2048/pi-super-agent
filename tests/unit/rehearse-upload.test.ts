import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { askedWith, examsOf } from "../../src/modules/rehearse.ts";
import { scanPackage } from "../../src/modules/validate.ts";
import { attachmentLine } from "../../src/web/view.mjs";

const temp = mkdtempSync(join(tmpdir(), "psa-exam-upload-"));
test.after(() => rmSync(temp, { recursive: true, force: true }));
let made = 0;

function scan(tree: Record<string, string>) {
	const root = join(temp, String(++made), "m");
	const tool = { "tools/t/tool.json": JSON.stringify({ title: "t", description: "d", effect: "read", input: { x: { type: "text", title: "x" } }, output: { y: { type: "text", title: "y" } } }), "tools/t/index.ts": "export default () => ({ y: 'a' });" };
	for (const [path, content] of Object.entries({ "module.json": JSON.stringify({ schema: 1, name: "m", version: "0.1.0" }), ...tool, ...tree })) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return scanPackage(root, { runCases: false });
}

const exam = (upload: string) => `---\nname: q\nexpect: x\nupload: ${upload}\n---\n导入这份`;

test("考题可以写 upload：包里的一个文件，预演时当作使用者在网页上传的（ADR-0032）", () => {
	const got = scan({ "evals/q.md": exam("tools/t/fixtures/a.csv"), "tools/t/fixtures/a.csv": "a,b\n" });
	assert.ok(got.ok, JSON.stringify(got));
	assert.equal(examsOf(got.scan)[0]!.upload, "tools/t/fixtures/a.csv");
});

test("考题的 upload 指向包里没有的文件、或越出包目录：检查报错", () => {
	for (const path of ["tools/t/fixtures/none.csv", "../outside.csv"]) {
		const got = scan({ "evals/q.md": exam(path) });
		assert.ok(!got.ok);
		assert.match(JSON.stringify(got.problems), /upload/, path);
	}
});

test("预演发题：先把文件存成上传，题目末尾接上和网页一样的附件那一行；没有 upload 的题原样发", () => {
	const got = scan({ "evals/q.md": exam("tools/t/fixtures/a.csv"), "tools/t/fixtures/a.csv": "a,b\n" });
	assert.ok(got.ok);
	const [q] = examsOf(got.scan);
	const saved: { name: string; bytes: string }[] = [];
	const up = { id: "up-0123456789ab", name: "a.csv", size: 4 };
	const asked = askedWith(q!, got.scan.dir, (name, bytes) => (saved.push({ name, bytes: bytes.toString("utf8") }), up));
	assert.equal(asked, `导入这份\n${attachmentLine(up)}`);
	assert.deepEqual(saved, [{ name: "a.csv", bytes: "a,b\n" }]);
	assert.equal(askedWith({ ...q!, upload: undefined }, got.scan.dir, () => assert.fail("不该存")), "导入这份");
});
