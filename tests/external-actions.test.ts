import assert from "node:assert/strict";
import test from "node:test";
import { blockedExternalAction } from "../src/worker/external-actions.ts";

test("推断任务的对外动作被识别", () => {
	for (const cmd of [
		"git push origin main", "cd repo && git push", "gh pr create --fill", "gh issue comment 3 -b hi",
		"gh api repos/a/b/issues -X POST -f title=x", "curl -X POST https://x.io", "curl -d 'a=1' https://x.io",
		"npm publish", "echo hi | mail -s t a@b.c", "osascript -e 'tell application \"Mail\" to send'",
	]) assert.ok(blockedExternalAction(cmd), cmd);
});

test("只读或本地命令不被拦截", () => {
	for (const cmd of ["git status", "git log --oneline", "gh pr view 3", "curl https://example.com", "ls -la", "npm test", "grep mail notes.txt"]) {
		assert.equal(blockedExternalAction(cmd), undefined, cmd);
	}
});

test("拦截理由指向草稿", () => {
	assert.match(blockedExternalAction("git push")!, /drafts/);
});
