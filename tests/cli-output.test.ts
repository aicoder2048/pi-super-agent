import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tempStateDir } from "./helpers/fakes.ts";

const run = (script: string, args: string[], stateDir: string) =>
	spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", script, ...args], { env: { ...process.env, PSA_STATE_DIR: stateDir }, encoding: "utf8" });

test("just drop 写明投递到了哪个目录", () => {
	const dir = tempStateDir();
	const out = run("src/cli/drop.ts", ["ci", "pr-7", "CI", "失败"], dir);
	assert.equal(out.status, 0, out.stderr);
	assert.ok(out.stdout.includes(dir), out.stdout);
});

test("just toy-feed 写明投递到了哪个目录", () => {
	const dir = tempStateDir();
	const out = run("modules/toy-market/feed.ts", ["TOYX", "-2", "100"], dir);
	assert.equal(out.status, 0, out.stderr);
	assert.ok(out.stdout.includes(dir), out.stdout);
});

test("just log 没有记录时写明查的是哪个状态目录", () => {
	const dir = tempStateDir();
	const out = run("src/cli/log.ts", ["5"], dir);
	assert.equal(out.status, 0, out.stderr);
	assert.ok(out.stdout.includes(dir), out.stdout);
});
