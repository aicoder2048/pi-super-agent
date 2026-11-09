import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { relocateState } from "../src/host/relocate.ts";

function sessionFile(dir: string, name: string, cwd: string) {
	mkdirSync(dir, { recursive: true });
	const lines = [{ type: "session", version: 3, id: name, cwd }, { type: "message", message: { role: "user", content: "hi" } }];
	writeFileSync(join(dir, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
const header = (file: string) => JSON.parse(readFileSync(file, "utf8").split("\n")[0]);

test("状态目录换了位置时，Router 和 Worker 会话记录的工作目录改到新位置，内容不变", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "psa-reloc-")));
	const a = join(root, "A"), b = join(root, "B");
	mkdirSync(a);
	relocateState(a);
	sessionFile(join(a, "sessions", "router"), "r1", join(a, "router"));
	sessionFile(join(a, "sessions", "workers"), "w1", join(a, "workers", "tkt_1"));
	sessionFile(join(a, "sessions", "workers"), "other", "/somewhere/else");
	cpSync(a, b, { recursive: true });
	rmSync(a, { recursive: true });

	assert.equal(relocateState(b), true);
	assert.equal(header(join(b, "sessions", "router", "r1.jsonl")).cwd, join(b, "router"));
	assert.equal(header(join(b, "sessions", "workers", "w1.jsonl")).cwd, join(b, "workers", "tkt_1"));
	assert.equal(header(join(b, "sessions", "workers", "other.jsonl")).cwd, "/somewhere/else");
	assert.match(readFileSync(join(b, "sessions", "workers", "w1.jsonl"), "utf8"), /"content":"hi"/);
	assert.equal(relocateState(b), false);
});

test("第一次启动只记下位置，不改任何文件", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "psa-reloc-")));
	assert.equal(relocateState(dir), false);
	assert.equal(JSON.parse(readFileSync(join(dir, "location.json"), "utf8")).path, dir);
});
