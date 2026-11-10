import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { busyPort, startHost, tempStateDir } from "./helpers/fakes.ts";

const tokenFile = (stateDir: string) => join(stateDir, "client-token");
const readToken = (stateDir: string) => readFileSync(tokenFile(stateDir), "utf8").trim();
const mode = (path: string) => statSync(path).mode & 0o777;

async function runHostOnce(stateDir: string): Promise<void> {
	const { host } = await startHost(() => [], () => {}, { stateDir });
	await host.stop();
}

test("凭据文件：宿主启动后状态目录里有 client-token，64 位十六进制，权限 0600，和 web-token 不是同一个", async (t) => {
	const stateDir = tempStateDir();
	const { host } = await startHost(() => [], () => {}, { stateDir, webPort: 0 });
	t.after(() => host.stop());
	assert.match(readToken(stateDir), /^[0-9a-f]{64}$/);
	assert.equal(mode(tokenFile(stateDir)), 0o600);
	assert.notEqual(readToken(stateDir), readFileSync(join(stateDir, "web-token"), "utf8").trim());
});

test("凭据文件：同一状态目录重启后 client-token 不变", async () => {
	const stateDir = tempStateDir();
	await runHostOnce(stateDir);
	const token = readToken(stateDir);
	await runHostOnce(stateDir);
	assert.equal(readToken(stateDir), token);
});

test("凭据文件：client-token 权限比 0600 宽时收紧到 0600，内容照用，日志说一次且不含凭据", async (t) => {
	const stateDir = tempStateDir();
	const kept = "cd".repeat(32);
	writeFileSync(tokenFile(stateDir), `${kept}\n`);
	chmodSync(tokenFile(stateDir), 0o644);
	const lines: string[] = [];
	const { host } = await startHost(() => [], () => {}, { stateDir, log: (line) => lines.push(line) });
	t.after(() => host.stop());
	assert.equal(readToken(stateDir), kept);
	assert.equal(mode(tokenFile(stateDir)), 0o600);
	assert.equal(lines.filter((l) => l.includes("client-token")).length, 1, lines.join("\n"));
	assert.ok(!lines.some((l) => l.includes(kept)), "日志里不该有凭据");
});

test("凭据文件：网页端口被占用、宿主起不来时，不创建 client-token", async (t) => {
	const port = await busyPort(t);
	const stateDir = tempStateDir();
	await assert.rejects(startHost(() => [], () => {}, { stateDir, webPort: port }));
	assert.equal(existsSync(tokenFile(stateDir)), false);
});

test("just client-token-rotate 删掉 client-token，宿主下次启动生成新的", async () => {
	const stateDir = tempStateDir();
	await runHostOnce(stateDir);
	const old = readToken(stateDir);
	const rotate = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/cli/client-token-rotate.ts"], {
		env: { ...process.env, PSA_STATE_DIR: stateDir },
		encoding: "utf8",
	});
	assert.equal(rotate.status, 0, rotate.stderr);
	assert.equal(existsSync(tokenFile(stateDir)), false);
	assert.ok(!rotate.stdout.includes(old), "不打印凭据");
	await runHostOnce(stateDir);
	assert.notEqual(readToken(stateDir), old);
});
