import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PiWorkerSpawner } from "../src/host/pi-worker.ts";
import { until } from "./helpers/fakes.ts";

const RESPOND = `
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync("pi.pid", String(process.pid));
createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, type } = JSON.parse(line);
	process.stdout.write(JSON.stringify({ type: "response", id, command: type, success: true }) + "\\n");
});
`;

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const events = { turnStarted() {}, toolCalled() {}, usage() {}, settled() {}, exited() {}, transcript() {} };

async function spawnWorker(t: TestContext, fakePi: string, resume = false) {
	const dir = mkdtempSync(join(tmpdir(), "psa-launch-"));
	writeFileSync(join(dir, "fake-pi.mjs"), RESPOND + fakePi);
	const spawner = new PiWorkerSpawner({ socketPath: join(dir, "h.sock"), sessionDir: join(dir, "sessions"), cliPath: join(dir, "fake-pi.mjs") });
	const handle = await spawner.spawn({ ticketId: "tkt_1", sessionId: "s1", workdir: dir, basis: "request", crew: [], token: "t", model: { provider: "openai-codex", id: "gpt" }, resume }, events);
	await until(() => existsSync(join(dir, "pi.pid")), "Pi 已启动");
	const pids = () => ["pi.pid", "child.pid"].filter((f) => existsSync(join(dir, f))).map((f) => Number(readFileSync(join(dir, f), "utf8")));
	t.after(() => {
		for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	});
	return { handle, dir, pids };
}

function captureStderr(t: TestContext): () => string {
	let captured = "";
	const write = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
		captured += chunk.toString();
		return write(chunk, ...(rest as []));
	}) as typeof process.stderr.write;
	t.after(() => (process.stderr.write = write));
	return () => captured;
}

test("新建的 Worker 会话：Pi 的 No project session found 不转给使用者，其他警告照常显示", async (t) => {
	const stderr = captureStderr(t);
	const { handle } = await spawnWorker(t, `
console.error("Warning: No project session found with id 's1'; creating a new session with that id.");
console.error("Warning: something else worth seeing");
`);
	await until(() => stderr().includes("something else worth seeing"), "其他警告");
	await handle.stop();
	assert.doesNotMatch(stderr(), /No project session found|找不到要恢复/);
});

test("Pi 不理 SIGTERM 也不理 stdin 关闭时，停止 Worker 后 Pi 仍被结束", async (t) => {
	const { handle, pids } = await spawnWorker(t, `
process.on("SIGTERM", () => {});
process.stdin.on("end", () => {});
setInterval(() => {}, 1000);
`);
	const [pi] = pids();
	await handle.stop();
	await until(() => !alive(pi), "Pi 已结束", 3000);
});

test("Pi 退出后，它留在自己进程组里的子进程也被结束", async (t) => {
	const { handle, dir, pids } = await spawnWorker(t, `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync("child.pid", String(child.pid));
process.on("SIGTERM", () => process.exit(143));
`);
	await until(() => existsSync(join(dir, "child.pid")), "子进程已启动");
	const child = pids()[1];
	await handle.stop();
	await until(() => !alive(child), "子进程已结束", 3000);
});
