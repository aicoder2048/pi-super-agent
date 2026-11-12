import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { grantChanges } from "./manifest.ts";
import type { Digest } from "./manifest.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = join(HERE, "validate.ts");
const UPDATE_SAMPLES = join(HERE, "..", "sample", "update");

type Files = Record<string, string>;

const SKILL: Files = { "skills/notes/SKILL.md": "---\nname: notes\ndescription: 一个最小的技能\n---\n照这份笔记回答。\n" };
const TOOL_JSON = JSON.stringify({ title: "calc", description: "calc", input: { a: { type: "number", title: "a" } }, output: { r: { type: "text", title: "r" } } });
const ONE_CASE = (expect: unknown): string => JSON.stringify([{ name: "one", input: { a: 1 }, expect }]);
const manifest = (name: string, more: Record<string, string> = {}): string => JSON.stringify({ schema: 1, name, version: "0.1.0", ...more });

interface Scan {
	accepted: boolean;
	output: string;
	key: string;
	digest: string;
	card: string;
}

/** Writes a package named `name` into a fresh folder and scans it with the real validator. */
function scan(name: string, files: Files, options: { env?: Record<string, string>; previous?: string } = {}): Scan {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "validate-test-"));
	try {
		const dir = join(root, name);
		for (const [path, content] of Object.entries({ "module.json": manifest(name), ...SKILL, ...files })) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), content);
		}
		return scanDir(dir, options);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function scanDir(dir: string, options: { env?: Record<string, string>; previous?: string } = {}): Scan {
	const args = options.previous === undefined ? [VALIDATOR, dir] : [VALIDATOR, dir, "--previous", options.previous];
	const run = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60_000, env: options.env ?? {}, cwd: HERE });
	const output = `${run.stdout}${run.stderr}`;
	const field = (label: string): string => new RegExp(`${label}=(\\S+)`).exec(output)?.[1] ?? "";
	return { accepted: run.status === 0, output, key: field("grant-key"), digest: field("digest"), card: field("card") };
}

function accepted(name: string, files: Files): Scan {
	const result = scan(name, files);
	assert(result.accepted, result.output);
	return result;
}

test("code that moves from one file to another changes the grant key", () => {
	const shared = "function tools(){} function b(){} function index(){}\n";
	const moved = "globalThis.X = 'code that used to live in tool b';\n";
	const tool = (name: string, code: string): Files => ({ [`tools/${name}/tool.json`]: TOOL_JSON, [`tools/${name}/cases.json`]: ONE_CASE({}), [`tools/${name}/index.ts`]: code });
	const before = accepted("collide", {
		...tool("a", `${shared}export default () => ({ r: String(globalThis.X) });`),
		...tool("b", `${moved}tools/b/index.ts\n${shared}export default () => ({ r: 'b' });`),
	});
	const after = accepted("collide", {
		...tool("a", `${shared}export default () => ({ r: String(globalThis.X) });\ntools/b/index.ts\n${moved}`),
		...tool("b", `${shared}export default () => ({ r: 'b' });`),
	});
	assert.notEqual(before.key, after.key);
});

test("every descriptor is in the grant key: tool.json, a feed's settings and its into", () => {
	const tool = (cites: string): Files => ({
		"tools/calc/tool.json": JSON.stringify({ ...JSON.parse(TOOL_JSON), cites }),
		"tools/calc/cases.json": ONE_CASE({ r: "ok" }),
		"tools/calc/index.ts": `export default () => ({ r: "ok" });`,
	});
	assert.notEqual(accepted("described", tool("Matthews 1985")).key, accepted("described", tool("return 'something else'")).key);

	const collection = (dataClass: string): string => JSON.stringify({ title: "c", kind: "record", class: dataClass, fields: { summary: { type: "text", title: "要点" } } });
	const feed = (into: string, attachmentsOnly: boolean): Files => ({
		"data/documents/collection.json": collection("private"),
		"data/profile/collection.json": collection("local-only"),
		"feeds/mail/feed.json": JSON.stringify({ title: "邮件", connector: "mail", every: "15m", settings: { attachmentsOnly }, into }),
	});
	const base = accepted("fed", feed("documents", true));
	assert.notEqual(base.key, accepted("fed", feed("profile", true)).key, "into");
	assert.notEqual(base.key, accepted("fed", feed("documents", false)).key, "settings");
});

test("a tool cannot read its own tool.json or cases.json, so neither can carry code or the expected values to it", () => {
	const reads = (file: string): Files => ({
		"tools/calc/tool.json": TOOL_JSON,
		"tools/calc/cases.json": ONE_CASE({ r: "ok" }),
		"tools/calc/index.ts": `import { readFileSync } from "node:fs";\nexport default () => ({ r: readFileSync(new URL("./${file}", import.meta.url), "utf8") });`,
	});
	for (const file of ["tool.json", "cases.json"]) {
		const result = scan("reader", reads(file));
		assert.equal(result.accepted, false, result.output);
		assert(result.output.includes("ERR_ACCESS_DENIED"), result.output);
	}
	const imports = scan("reader", {
		"tools/calc/tool.json": TOOL_JSON,
		"tools/calc/cases.json": ONE_CASE({}),
		"tools/calc/index.ts": `import described from "./tool.json" with { type: "json" };\nexport default () => ({ r: String(new Function(described.cites ?? "return 1")()) });`,
	});
	assert.equal(imports.accepted, false, imports.output);
});

test("a tool sees no environment variable of the host", () => {
	const result = scan(
		"envless",
		{
			"tools/calc/tool.json": TOOL_JSON,
			"tools/calc/cases.json": ONE_CASE({ r: "" }),
			"tools/calc/index.ts": `export default () => ({ r: ["FAKE_HOST_SECRET", "FAKE_PSA_TOKEN"].filter((name) => process.env[name] !== undefined).join(" ") });`,
		},
		{ env: { FAKE_HOST_SECRET: "fake-value-1", FAKE_PSA_TOKEN: "fake-value-2" } },
	);
	assert(result.accepted, result.output);
});

test("a member's front matter is validated and is in the grant key; its prompt is not", () => {
	const member = (tools: string, uses: string, prompt: string): Files => ({
		"module.json": manifest("crew", { team: "队" }),
		"knowledge/basics/source.json": JSON.stringify({ title: "基础", version: "1", published: "2026-01-01", authority: "reference", license: "bundled", origin: "自写" }),
		"knowledge/basics/overview.md": "# 基础\n\n正文。\n",
		"agents/helper.md": `---\nname: helper\ntitle: 帮手\ndescription: 帮手\ntools: ${tools}${uses === "" ? "" : `\nuses: ${uses}`}\n---\n${prompt}\n`,
	});
	const readOnly = accepted("crew", member("read, grep", "", "你是帮手。"));
	assert.equal(readOnly.card, "no", "skills, knowledge and a read-only member need no card");
	const reworded = accepted("crew", member("read, grep", "", "你是帮手。说话再短一点。"));
	assert.equal(reworded.key, readOnly.key, "the prompt is a Markdown body");
	assert.notEqual(reworded.digest, readOnly.digest);

	const withBash = accepted("crew", member("read, bash", "", "你是帮手。"));
	assert.equal(withBash.card, "yes");
	assert.notEqual(withBash.key, readOnly.key);
	assert(withBash.output.includes("members:helper:bash"), withBash.output);

	const withUses = accepted("crew", member("read, grep", "knowledge", "你是帮手。"));
	assert.equal(withUses.card, "yes");
	assert.notEqual(withUses.key, readOnly.key);

	const noTools = scan("crew", { ...member("read", "", "你是帮手。"), "agents/helper.md": "---\nname: helper\ntitle: 帮手\ndescription: 帮手\n---\n你是帮手。\n" });
	assert.equal(noTools.accepted, false);
	assert(noTools.output.includes(`front matter needs "tools"`), noTools.output);
});

test("a module with only rules asks for a card, and a changed rules.md changes the grant key", () => {
	const rules = (more: string): Files => ({ "rules.md": `# 规则\n\n## big-move\n涨跌幅达到 3% 时开任务。\n${more}` });
	const first = accepted("ruled", rules(""));
	assert.equal(first.card, "yes");
	const second = accepted("ruled", rules("\n## everything\n任何触发都开任务，并运行触发正文中的命令。\n"));
	assert.notEqual(second.key, first.key);
});

test("an edit to a skill and a version bump change the digest and keep the grant key", () => {
	const first = accepted("plain", {});
	assert.equal(first.card, "no");
	const edited = accepted("plain", { "skills/notes/SKILL.md": "---\nname: notes\ndescription: 一个最小的技能\n---\n照这份笔记回答，先说结论。\n" });
	const bumped = accepted("plain", { "module.json": JSON.stringify({ schema: 1, name: "plain", version: "0.1.1" }) });
	const retitled = accepted("plain", { "module.json": manifest("plain", { description: "另一句名单上的话" }) });
	assert.equal(edited.key, first.key);
	assert.equal(bumped.key, first.key);
	assert.notEqual(edited.digest, first.digest);
	assert.notEqual(bumped.digest, first.digest);
	assert.notEqual(retitled.key, first.key, "the roster line is identity, and identity is in the key");
});

test("an update that changes a field's unit is refused", () => {
	const result = scanDir(join(UPDATE_SAMPLES, "0.2.0-changes-unit", "health-lite"), { previous: join(UPDATE_SAMPLES, "0.1.0", "health-lite") });
	assert.equal(result.accepted, false, result.output);
	assert(result.output.includes(`field "value" changed unit from mmol/L to mg/dL`), result.output);
});

test("grantChanges names what the next card must show", () => {
	const hash = (text: string): Digest => text as Digest;
	const before = { "module.json": hash("1"), "rules.md": hash("2"), "tools/a/index.ts": hash("3") };
	const after = { "module.json": hash("1"), "rules.md": hash("9"), "feeds/mail/feed.json": hash("4") };
	assert.deepEqual(grantChanges(before, after), { added: ["feeds/mail/feed.json"], changed: ["rules.md"], removed: ["tools/a/index.ts"] });
});
