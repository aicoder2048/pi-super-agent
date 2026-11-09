import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiWorkerSpawner } from "../src/host/pi-worker.ts";

const FAKE_PI = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync("worker-env.json", JSON.stringify(process.env));
createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, type } = JSON.parse(line);
	process.stdout.write(JSON.stringify({ type: "response", id, command: type, success: true }) + "\\n");
});
`;

test("Worker 子进程和模块 prepare 拿不到宿主环境里的密钥类变量，只拿到宿主给它的 PSA_ 变量", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-env-"));
	const cliPath = join(dir, "fake-pi.mjs");
	writeFileSync(cliPath, FAKE_PI);
	const planted = { MASSIVE_API_KEY: "sk-market", FINNHUB_API_KEY: "fh-market", FOO_TOKEN: "tok-foo", DEEPSEEK_API_KEY: "sk-ds", DB_PASSWORD: "pw", SECRET_SAUCE: "s", PSA_KEEP_HOME: "kept" };
	const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
	Object.assign(process.env, planted);
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	});
	const spawner = new PiWorkerSpawner({
		socketPath: join(dir, "h.sock"),
		sessionDir: join(dir, "sessions"),
		cliPath,
		moduleFor: () => ({ prepare: "env > prepare-env.txt" }),
	});
	const events = { turnStarted() {}, toolCalled() {}, usage() {}, settled() {}, exited() {}, transcript() {} };
	const handle = await spawner.spawn({ ticketId: "tkt_1", sessionId: "s1", workdir: dir, basis: "request", ruleId: null, token: "secret-ticket-token", model: { provider: "openai-codex", id: "gpt" } }, events);
	t.after(() => handle.stop());
	const env = JSON.parse(readFileSync(join(dir, "worker-env.json"), "utf8")) as Record<string, string>;
	for (const name of ["MASSIVE_API_KEY", "FINNHUB_API_KEY", "FOO_TOKEN", "DEEPSEEK_API_KEY", "DB_PASSWORD", "SECRET_SAUCE"]) assert.equal(env[name], undefined, `Worker 环境里不该有 ${name}`);
	assert.equal(env.PSA_TOKEN, "secret-ticket-token");
	assert.equal(env.PSA_KEEP_HOME, "kept");
	assert.equal(env.PATH, process.env.PATH);
	const prepared = readFileSync(join(dir, "prepare-env.txt"), "utf8");
	assert.ok(!/MASSIVE_API_KEY|FINNHUB_API_KEY|FOO_TOKEN|DEEPSEEK_API_KEY/.test(prepared), "prepare 环境里不该有密钥类变量");
});
