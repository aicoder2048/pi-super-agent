import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { problemLine, scanPackage } from "../src/modules/validate.ts";

const REPO = join(import.meta.dirname, "..");
const MODELS = { router: "psa-fake/router", worker: "psa-fake/worker", fallback: "psa-fake/fallback" };

function scratch(t: TestContext, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function write(root: string, files: Record<string, string>): string {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

function keyed(t: TestContext, module: string, secrets: string[], on: "feed" | "tool" = "feed"): string {
	const root = join(scratch(t, "psa-owners-"), module);
	const component: Record<string, string> =
		on === "feed"
			? {
					"feeds/inbox/feed.json": JSON.stringify({ title: "inbox", handler: "index.ts", secrets, every: "5m", into: "items" }),
					"feeds/inbox/index.ts": "export default async () => [];\n",
					"data/items/collection.json": JSON.stringify({ title: "items", kind: "record", class: "private", fields: { text: { type: "text", title: "text" } } }),
				}
			: {
					"tools/probe/tool.json": JSON.stringify({ title: "probe", description: "probe", input: { x: { type: "number", title: "x" } }, output: { y: { type: "number", title: "y" } }, secrets }),
					"tools/probe/index.ts": "export default async () => ({ y: 1 });\n",
					"tools/probe/cases.json": JSON.stringify([{ name: "one", input: { x: 1 }, expect: { y: 1 } }]),
				};
	return write(root, { "module.json": JSON.stringify({ schema: 1, name: module, version: "0.1.0", title: module, description: module }), ...component });
}

const problems = (dir: string): string[] => {
	const result = scanPackage(dir);
	return result.ok ? [] : result.problems.map(problemLine);
};

function cli(stateDir: string, args: string[]) {
	const run = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/cli/module.ts", ...args], { cwd: REPO, env: { ...process.env, PSA_STATE_DIR: stateDir }, encoding: "utf8", timeout: 20_000 });
	return { status: run.status, out: run.stdout + run.stderr };
}

test("a package that names another module's secret is refused, with the secret and its owner on one line", (t) => {
	assert.deepEqual(problems(keyed(t, "mail", ["POLYGON_API_KEY"])), ["feeds/inbox/feed.json: POLYGON_API_KEY 属于模块 stock-ta，别的模块不能用"]);
});

test("a package that names a host secret is refused, on a feed and on a tool", (t) => {
	assert.deepEqual(problems(keyed(t, "mail", ["TELEGRAM_BOT_TOKEN"])), ["feeds/inbox/feed.json: TELEGRAM_BOT_TOKEN 属于宿主，模块不能用"]);
	assert.deepEqual(problems(keyed(t, "mail", ["GMAIL_DRAFT_REFRESH_TOKEN"], "tool")), ["tools/probe/tool.json: GMAIL_DRAFT_REFRESH_TOKEN 属于宿主，模块不能用"]);
});

test("a model provider key the host may keep in its environment is the host's", (t) => {
	for (const [module, secret] of [["deepseek", "DEEPSEEK_API_KEY"], ["openai", "OPENAI_API_KEY"], ["anthropic", "ANTHROPIC_API_KEY"], ["github", "GITHUB_TOKEN"]]) {
		assert.deepEqual(problems(keyed(t, module!, [secret!])), [`feeds/inbox/feed.json: ${secret} 属于宿主，模块不能用`]);
	}
});

test("a secret the table does not list passes only with the module's own prefix", (t) => {
	assert.deepEqual(problems(keyed(t, "stock-ta", ["STOCK_TA__EXTRA_KEY"])), []);
	assert.deepEqual(problems(keyed(t, "mail", ["FOO_KEY"])), ["feeds/inbox/feed.json: FOO_KEY 不在密钥归属表里，本模块自己的密钥要以 MAIL__ 开头"]);
});

test("a module cannot name a secret under the prefix of a module whose name continues its own", (t) => {
	assert.deepEqual(problems(keyed(t, "mail", ["MAIL_X_TOKEN"])), ["feeds/inbox/feed.json: MAIL_X_TOKEN 不在密钥归属表里，本模块自己的密钥要以 MAIL__ 开头"]);
	assert.deepEqual(problems(keyed(t, "stock", ["STOCK_TA_KEY"])), ["feeds/inbox/feed.json: STOCK_TA_KEY 不在密钥归属表里，本模块自己的密钥要以 STOCK__ 开头"]);
	assert.deepEqual(problems(keyed(t, "mail-x", ["MAIL_X__TOKEN"])), []);
});

test("a module name with a doubled or trailing hyphen is refused, so no two modules share a secret prefix", (t) => {
	for (const name of ["mail--x", "mail-"]) assert.match(problems(keyed(t, name, []))[0] ?? "", /is not a usable module name/, name);
});

test("the owner of a secret may name it", (t) => {
	assert.deepEqual(problems(keyed(t, "mail", ["GMAIL_READ_REFRESH_TOKEN", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"])), []);
	assert.deepEqual(problems(join(REPO, "docs/modules/examples/stock-ta")), []);
});

test("FINNHUB_API_KEY belongs to stock-ta: stock-ta may name it, another module may not", (t) => {
	assert.deepEqual(problems(keyed(t, "stock-ta", ["FINNHUB_API_KEY"], "tool")), []);
	assert.deepEqual(problems(keyed(t, "mail", ["FINNHUB_API_KEY"], "tool")), ["tools/probe/tool.json: FINNHUB_API_KEY 属于模块 stock-ta，别的模块不能用"]);
});

test("just module check prints the refusal and exits 1", (t) => {
	const run = cli(scratch(t, "psa-owners-state-"), ["check", keyed(t, "mail", ["TELEGRAM_BOT_TOKEN"])]);
	assert.equal(run.status, 1, run.out);
	assert.match(run.out, /^feeds\/inbox\/feed\.json: TELEGRAM_BOT_TOKEN 属于宿主，模块不能用$/m);
});

test("just module try refuses the same package before starting a host", (t) => {
	const state = scratch(t, "psa-owners-state-");
	writeFileSync(join(state, "config.json"), JSON.stringify({ models: MODELS }));
	const run = cli(state, ["try", keyed(t, "mail", ["POLYGON_API_KEY"])]);
	assert.equal(run.status, 1, run.out);
	assert.match(run.out, /POLYGON_API_KEY 属于模块 stock-ta，别的模块不能用/);
	assert.doesNotMatch(run.out, /预演 mail/);
});

test("a tool's test cases get a fake value for its secret, never the one in secretsFile", (t) => {
	const state = scratch(t, "psa-owners-state-");
	writeFileSync(join(state, "config.json"), JSON.stringify({ secretsFile: "secrets.env" }));
	writeFileSync(join(state, "secrets.env"), "MAIL__PROBE_KEY=real-value-from-secrets-file\n");
	const pkg = write(join(scratch(t, "psa-owners-"), "mail"), {
		"module.json": JSON.stringify({ schema: 1, name: "mail", version: "0.1.0", title: "mail", description: "mail" }),
		"tools/probe/tool.json": JSON.stringify({ title: "probe", description: "echoes its key", input: { x: { type: "number", title: "x" } }, output: { set: { type: "number", title: "set" }, real: { type: "number", title: "real" } }, secrets: ["MAIL__PROBE_KEY"] }),
		"tools/probe/index.ts": `export default async () => ({ set: process.env.MAIL__PROBE_KEY ? 1 : 0, real: process.env.MAIL__PROBE_KEY === "real-value-from-secrets-file" ? 1 : 0 });\n`,
		"tools/probe/cases.json": JSON.stringify([{ name: "fake-key", input: { x: 1 }, expect: { set: 1, real: 0 } }]),
	});
	const run = cli(state, ["check", pkg]);
	assert.equal(run.status, 0, run.out);
	assert.match(run.out, /^ok mail@0\.1\.0 .*secrets=MAIL__PROBE_KEY/m);
});
