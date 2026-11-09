import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiWorkerSpawner } from "../src/host/pi-worker.ts";
import { BUILTIN_ROLES_DIR, Roster } from "../src/roles.ts";

const FAKE_PI = `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync("worker-env.json", JSON.stringify(process.env));
writeFileSync("worker-argv.json", JSON.stringify(process.argv.slice(2)));
createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, type } = JSON.parse(line);
	process.stdout.write(JSON.stringify({ type: "response", id, command: type, success: true }) + "\\n");
});
`;

test("Worker 子进程和模块 prepare 拿不到宿主环境里的密钥类变量，只拿到宿主给它的 PSA_ 变量", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-env-"));
	const cliPath = join(dir, "fake-pi.mjs");
	writeFileSync(cliPath, FAKE_PI);
	const planted = { MASSIVE_API_KEY: "sk-market", FOO_TOKEN: "tok-foo", DEEPSEEK_API_KEY: "sk-ds", DB_PASSWORD: "pw", SECRET_SAUCE: "s", PSA_KEEP_HOME: "kept" };
	const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
	Object.assign(process.env, planted);
	t.after(() => {
		for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	});
	const spawner = new PiWorkerSpawner({
		socketPath: join(dir, "h.sock"),
		roster: Roster.load(["openai-codex"], [BUILTIN_ROLES_DIR]),
		sessionDir: join(dir, "sessions"),
		cliPath,
		moduleFor: () => ({ prepare: "env > prepare-env.txt" }),
	});
	const events = { turnStarted() {}, toolCalled() {}, usage() {}, settled() {}, exited() {}, transcript() {} };
	const handle = await spawner.spawn({ ticketId: "tkt_1", sessionId: "s1", workdir: dir, basis: "request", ruleId: null, role: "general", token: "secret-ticket-token", model: { provider: "openai-codex", id: "gpt" } }, events);
	t.after(() => handle.stop());
	const env = JSON.parse(readFileSync(join(dir, "worker-env.json"), "utf8")) as Record<string, string>;
	for (const name of ["MASSIVE_API_KEY", "FOO_TOKEN", "DEEPSEEK_API_KEY", "DB_PASSWORD", "SECRET_SAUCE"]) assert.equal(env[name], undefined, `Worker 环境里不该有 ${name}`);
	assert.equal(env.PSA_TOKEN, "secret-ticket-token");
	assert.equal(env.PSA_KEEP_HOME, "kept");
	assert.equal(env.PATH, process.env.PATH);
	const prepared = readFileSync(join(dir, "prepare-env.txt"), "utf8");
	assert.ok(!/MASSIVE_API_KEY|FOO_TOKEN|DEEPSEEK_API_KEY/.test(prepared), "prepare 环境里不该有密钥类变量");
});

test("牵头角色的 Worker：提示词和专家名册接在后面，技能先角色后模块，工具白名单经环境变量交给扩展；名册里没有的角色不启动", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psa-role-"));
	const cliPath = join(dir, "fake-pi.mjs");
	writeFileSync(cliPath, FAKE_PI);
	const roles = join(dir, "roles");
	mkdirSync(join(roles, "news-skills"), { recursive: true });
	writeFileSync(join(roles, "desk.md"), "---\nname: desk-lead\ntitle: 看盘主管\ndescription: d\nconsult: true\ntools: read, web_get\nskills: ./news-skills\n---\n每条结论写出处。\n");
	writeFileSync(join(roles, "news.md"), "---\nname: news\ntitle: 新闻研究员\ndescription: 查新闻\n---\n不该出现\n");
	const spawner = new PiWorkerSpawner({
		socketPath: join(dir, "h.sock"),
		roster: Roster.load(["openai-codex"], [BUILTIN_ROLES_DIR, roles]),
		sessionDir: join(dir, "sessions"),
		cliPath,
		moduleFor: () => ({ skillsDir: "/modules/m/skills" }),
	});
	const events = { turnStarted() {}, toolCalled() {}, usage() {}, settled() {}, exited() {}, transcript() {} };
	const spec = { ticketId: "tkt_1", sessionId: "s1", workdir: dir, basis: "rule" as const, ruleId: "m/r", role: "desk-lead", token: "tok", model: { provider: "openai-codex", id: "gpt" } };
	const handle = await spawner.spawn(spec, events);
	t.after(() => handle.stop());
	const argv = JSON.parse(readFileSync(join(dir, "worker-argv.json"), "utf8")) as string[];
	const all = (name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
	const persona = all("--append-system-prompt").at(-1)!;
	assert.match(persona, /^每条结论写出处。\n\n## 专家名册\n- general（通用助手）：[^\n]+\n- news（新闻研究员）：查新闻$/);
	assert.deepEqual(all("--skill"), [join(roles, "news-skills"), "/modules/m/skills"]);
	const env = JSON.parse(readFileSync(join(dir, "worker-env.json"), "utf8")) as Record<string, string>;
	assert.equal(env.PSA_ROLE_TOOLS, "read,web_get");
	await assert.rejects(spawner.spawn({ ...spec, role: "ghost" }, events), /ghost/);
});
