import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runModuleCodeAsync } from "../src/modules/run-code.ts";
import { codeSite } from "./helpers/code-site.ts";
import { until, within } from "./helpers/fakes.ts";

const TEST_LIMIT_MS = 2000;

function toolDir(t: TestContext, code: string): string {
	const dir = mkdtempSync(join(tmpdir(), "psa-run-code-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "index.ts"), code);
	return dir;
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const run = (dir: string) => runModuleCodeAsync(codeSite(dir), "index.ts", {}, {}, { limitMs: TEST_LIMIT_MS });
const failsInTime = async (dir: string) => assert.equal((await within(run(dir), TEST_LIMIT_MS + 1500, "到时限没有结束")).ok, false);
const pidGone = (dir: string) => {
	const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
	return until(() => !alive(pid), `进程 ${pid} 还活着`);
};

test("工具的子进程继承了 stdout 还在跑：到时限这次调用照样按时失败，子进程也被收掉", async (t) => {
	const dir = toolDir(t, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
export default async () => { writeFileSync("pid", String(spawn("sleep", ["30"], { stdio: "inherit" }).pid)); await new Promise(() => {}); };`);
	await failsInTime(dir);
	await pidGone(dir);
});

test("工具不理 SIGTERM：到时限照样结束这次调用，进程不留下", async (t) => {
	const dir = toolDir(t, `import { writeFileSync } from "node:fs";
export default async () => { writeFileSync("pid", String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); await new Promise(() => {}); };`);
	await failsInTime(dir);
	await pidGone(dir);
});

test("工具死循环时开的孙进程：到时限一起收掉", async (t) => {
	const dir = toolDir(t, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
export default () => { writeFileSync("pid", String(spawn("sleep", ["7"], { stdio: "ignore" }).pid)); for (;;) {} };`);
	await failsInTime(dir);
	await pidGone(dir);
});

test("工具输出超过 1 MB：这次调用失败，说明输出太大", async (t) => {
	const dir = toolDir(t, `export default () => "x".repeat(1_100_000);`);
	assert.match(JSON.stringify(await run(dir)), /"ok":false.*1 MB/);
});

test("工具什么都不返回：结果是 null，不是 undefined", async (t) => {
	const dir = toolDir(t, `export default () => undefined;`);
	assert.deepEqual(await run(dir), { ok: true, output: null });
});
