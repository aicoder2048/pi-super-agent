import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanPackage } from "../../src/modules/validate.ts";

const temp = mkdtempSync(join(tmpdir(), "psa-reminders-"));
test.after(() => rmSync(temp, { recursive: true, force: true }));
let made = 0;

function pkg(tree: Record<string, string | Buffer>): string {
	const root = join(temp, String(++made), "alpha");
	const files = { "module.json": JSON.stringify({ schema: 1, name: "alpha", version: "0.1.0", description: "d" }), "skills/how/SKILL.md": "---\nname: how\ndescription: d\n---\n做法", ...tree };
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

function notes(root: string): string[] {
	const result = scanPackage(root, { runCases: false });
	assert.ok(result.ok, JSON.stringify(result));
	return result.scan.notes;
}

const pathNotes = (root: string) => notes(root).filter((note) => note.includes("local absolute path"));

test("包里的文本写了本机绝对路径：给一行提醒，写明文件、行号和开头，不挡检查", () => {
	for (const [prefix, line] of [["/Users/", "/Users/someone/state/modules/alpha"], ["/home/", "cd /home/someone/psa"], ["/private/var/", "`/private/var/folders/x/T/tmp.1`"], ["/var/folders/", "STATE=/var/folders/ab/T/tmp.2"], ["/tmp/", "mktemp 给的 /tmp/tmp.3"]] as const) {
		const root = pkg({ "README.md": `# alpha\n\n${line}\n` });
		assert.deepEqual(pathNotes(root), [`README.md: line 3 has a local absolute path starting "${prefix}"; write <状态目录>, $STATE or $PSA_REPO instead, a package may be published`]);
	}
});

test("网址里的 /home/、相对路径、占位符和二进制文件不提醒", () => {
	const root = pkg({
		"README.md": "见 https://example.com/home/docs 和 docs/home/x，状态目录写 <状态目录>/home/alpha，或 ${STATE}/tmp/alpha\n",
		"skills/how/blob.bin": Buffer.from([0, 47, 85, 115, 101, 114, 115, 47]),
	});
	assert.deepEqual(pathNotes(root), []);
});

test("file:// 网址里的本机路径、/private/tmp/ 和 /var/tmp/ 也提醒", () => {
	for (const [prefix, line] of [["/Users/", "打开 file:///Users/someone/report.html"], ["/private/tmp/", "输出在 /private/tmp/psa-1"], ["/var/tmp/", "缓存在 /var/tmp/psa-2"]] as const) {
		const root = pkg({ "README.md": `# alpha\n\n${line}\n` });
		assert.deepEqual(pathNotes(root), [`README.md: line 3 has a local absolute path starting "${prefix}"; write <状态目录>, $STATE or $PSA_REPO instead, a package may be published`]);
	}
});

test("~/tmp/ 和网址查询串里的 =/tmp/ 不提醒；网址外的 STATE=/tmp/ 仍提醒", () => {
	assert.deepEqual(pathNotes(pkg({ "README.md": "草稿放 ~/tmp/x，登录后跳到 https://example.com/login?next=/tmp/x&from=/Users/\n" })), []);
	assert.deepEqual(pathNotes(pkg({ "README.md": "见 https://example.com/a?b=/tmp/x 再跑 STATE=/tmp/y\n" })), [
		'README.md: line 1 has a local absolute path starting "/tmp/"; write <状态目录>, $STATE or $PSA_REPO instead, a package may be published',
	]);
});

const question = (body: string) => `---\nname: q\nexpect: x\n---\n${body}\n`;

test("考题题面超过 300 字给一行提醒，不挡检查；300 字以内不提醒", () => {
	assert.deepEqual(notes(pkg({ "evals/q.md": question("问".repeat(300)) })).filter((n) => n.startsWith("evals/")), []);
	assert.deepEqual(notes(pkg({ "evals/q.md": question("问".repeat(301)) })).filter((n) => n.startsWith("evals/")), [
		"evals/q.md: the question is 301 characters; ask it in the user's words in a sentence or two, and leave how to answer to the members and skills",
	]);
});
