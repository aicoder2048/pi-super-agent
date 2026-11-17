import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ModuleName } from "../../src/modules/manifest.ts";
import { problemLine, scanPackage } from "../../src/modules/validate.ts";
import { moduleSecretLookup } from "../../src/secrets.ts";

const REPO = join(import.meta.dirname, "../..");

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
	const root = join(scratch(t, "psa-secrets-"), module);
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

test("a package may name any secret: it reads only its own .env, so another module's key name is just a name", (t) => {
	assert.deepEqual(problems(keyed(t, "mail", ["POLYGON_API_KEY"])), []);
	assert.deepEqual(problems(keyed(t, "mail", ["FOO_KEY"], "tool")), []);
	assert.deepEqual(problems(join(REPO, "docs/modules/examples/mail")), []);
	assert.deepEqual(problems(join(REPO, "docs/modules/examples/stock-ta")), []);
});

test("an identity secret name passes with one note per name that says to use a connector", (t) => {
	for (const secret of ["GMAIL_READ_REFRESH_TOKEN", "GMAIL_DRAFT_REFRESH_TOKEN", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "TELEGRAM_BOT_TOKEN", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) {
		const result = scanPackage(keyed(t, "probe", [secret]));
		assert.ok(result.ok, secret);
		assert.deepEqual(result.scan.notes, [`feeds/inbox/feed.json: ${secret} 是代表你本人的身份类密钥，应该走宿主的连接器；模块只能从自己的 .env 读到它`], secret);
	}
	const plain = scanPackage(keyed(t, "probe", ["POLYGON_API_KEY"]));
	assert.ok(plain.ok);
	assert.deepEqual(plain.scan.notes, []);
});

test("a module name with a doubled or trailing hyphen is refused", (t) => {
	for (const name of ["mail--x", "mail-"]) assert.match(problems(keyed(t, name, []))[0] ?? "", /is not a usable module name/, name);
});

test("just module check prints the identity note and still passes", (t) => {
	const run = cli(scratch(t, "psa-secrets-state-"), ["check", keyed(t, "mail", ["TELEGRAM_BOT_TOKEN"])]);
	assert.equal(run.status, 0, run.out);
	assert.match(run.out, /^note feeds\/inbox\/feed\.json: TELEGRAM_BOT_TOKEN 是代表你本人的身份类密钥，应该走宿主的连接器/m);
	assert.match(run.out, /^ok mail@0\.1\.0 .*secrets=TELEGRAM_BOT_TOKEN/m);
});

test("a tool's test cases get a fake value for its secret, never the one in the module's .env or secretsFile", (t) => {
	const state = scratch(t, "psa-secrets-state-");
	writeFileSync(join(state, "config.json"), JSON.stringify({ secretsFile: "secrets.env" }));
	writeFileSync(join(state, "secrets.env"), "PROBE_KEY=real-value\n");
	mkdirSync(join(state, "modules-data", "mail"), { recursive: true });
	writeFileSync(join(state, "modules-data", "mail", ".env"), "PROBE_KEY=real-value\n");
	const pkg = write(join(scratch(t, "psa-secrets-"), "mail"), {
		"module.json": JSON.stringify({ schema: 1, name: "mail", version: "0.1.0", title: "mail", description: "mail" }),
		"tools/probe/tool.json": JSON.stringify({ title: "probe", description: "echoes its key", input: { x: { type: "number", title: "x" } }, output: { set: { type: "number", title: "set" }, real: { type: "number", title: "real" } }, secrets: ["PROBE_KEY"] }),
		"tools/probe/index.ts": `export default async () => ({ set: process.env.PROBE_KEY ? 1 : 0, real: process.env.PROBE_KEY === "real-value" ? 1 : 0 });\n`,
		"tools/probe/cases.json": JSON.stringify([{ name: "fake-key", input: { x: 1 }, expect: { set: 1, real: 0 } }]),
	});
	const run = cli(state, ["check", pkg]);
	assert.equal(run.status, 0, run.out);
	assert.match(run.out, /^ok mail@0\.1\.0 .*secrets=PROBE_KEY/m);
});

function secretCli(stateDir: string, args: string[], input: string) {
	const run = spawnSync(process.execPath, ["--import", "./src/pi-runtime.mjs", "src/cli/module.ts", "secret", ...args], { cwd: REPO, env: { ...process.env, PSA_STATE_DIR: stateDir }, input, encoding: "utf8", timeout: 20_000 });
	return { status: run.status, out: run.stdout + run.stderr };
}

test("a module .env that holds a malformed value fails that read with the file named and the value left out", (t) => {
	const state = scratch(t, "psa-secrets-state-");
	mkdirSync(join(state, "modules-data", "stock-ta"), { recursive: true });
	writeFileSync(join(state, "modules-data", "stock-ta", ".env"), 'POLYGON_API_KEY="bad value-xyz"\n');
	assert.throws(() => moduleSecretLookup(state)("stock-ta" as ModuleName, "POLYGON_API_KEY"), (e: Error) => e.message.includes("modules-data/stock-ta/.env") && !e.message.includes("value-xyz") && !e.message.includes("secretsFile"));
	assert.equal(moduleSecretLookup(state)("mail" as ModuleName, "POLYGON_API_KEY"), undefined);
});

test("just module secret writes one line into the module's own .env with mode 600, creating the folder and the file, and never prints the value", (t) => {
	const state = scratch(t, "psa-secrets-state-");
	const run = secretCli(state, ["stock-ta", "POLYGON_API_KEY"], "pk-test-value-123\n");
	assert.equal(run.status, 0, run.out);
	assert.doesNotMatch(run.out, /pk-test-value-123/);
	const file = join(state, "modules-data", "stock-ta", ".env");
	assert.equal(readFileSync(file, "utf8"), "POLYGON_API_KEY=pk-test-value-123\n");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.match(run.out, /POLYGON_API_KEY/);
});

test("just module secret replaces the line of the same name and keeps every other line", (t) => {
	const state = scratch(t, "psa-secrets-state-");
	mkdirSync(join(state, "modules-data", "stock-ta"), { recursive: true });
	const file = join(state, "modules-data", "stock-ta", ".env");
	writeFileSync(file, "# keys\nFINNHUB_API_KEY=fh-old\nPOLYGON_API_KEY=pk-old\nOTHER=x\n");
	const run = secretCli(state, ["stock-ta", "POLYGON_API_KEY"], "pk-new");
	assert.equal(run.status, 0, run.out);
	assert.equal(readFileSync(file, "utf8"), "# keys\nFINNHUB_API_KEY=fh-old\nPOLYGON_API_KEY=pk-new\nOTHER=x\n");
	assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("just module secret refuses a bad module name, a bad secret name, or an empty value, and writes nothing", (t) => {
	const state = scratch(t, "psa-secrets-state-");
	for (const [args, input] of [[["../x", "KEY"], "v"], [["stock-ta", "lower_case"], "v"], [["stock-ta", "POLYGON_API_KEY"], "\n"], [["stock-ta", "POLYGON_API_KEY"], "has space-in-value"], [["stock-ta", "POLYGON_API_KEY"], "line-one\nline-two\n"]] as const) {
		const run = secretCli(state, [...args], input);
		assert.equal(run.status, 1, `${args.join(" ")}: ${run.out}`);
		assert.doesNotMatch(run.out, /space-in-value|line-one/);
	}
	assert.equal(existsSync(join(state, "modules-data")), false);
});
