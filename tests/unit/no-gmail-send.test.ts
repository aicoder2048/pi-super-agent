import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

const SEND = /messages\.send|drafts\.send|\/messages\/send|\/drafts\/send|gmail\.send/;
const ROOT = join(import.meta.dirname, "../..");
const SCANNED = ["src", "docs/modules/examples"];

function sendLines(root: string, dirs: readonly string[]): string[] {
	return dirs.flatMap((dir) =>
		readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && !entry.parentPath.split("/").includes("node_modules"))
			.flatMap((entry) => {
				const file = join(entry.parentPath, entry.name);
				return readFileSync(file, "utf8")
					.split("\n")
					.flatMap((line, i) => (SEND.test(line) ? [`${relative(root, file)}:${i + 1}: ${line.trim()}`] : []));
			}),
	);
}

test("不发信：src/ 和 docs/modules/examples/ 里没有一处提到 Gmail 的发送接口", () => {
	assert.deepEqual(sendLines(ROOT, SCANNED), []);
});

test("不发信：扫描抓得到加进去的一行 drafts.send，写出文件和行号；草稿箱链接不算", () => {
	const root = mkdtempSync(join(tmpdir(), "psa-no-send-"));
	try {
		mkdirSync(join(root, "src", "modules"), { recursive: true });
		writeFileSync(join(root, "src", "modules", "x.ts"), 'const drafts = "https://mail.google.com/mail/u/0/#drafts";\nawait fetch(`${base}/gmail/v1/users/me/drafts/send`);\n');
		assert.deepEqual(sendLines(root, ["src"]), ["src/modules/x.ts:2: await fetch(`${base}/gmail/v1/users/me/drafts/send`);"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
