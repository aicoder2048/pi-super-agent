/**
 * Scans a module package and lists every mistake it finds. Its job is to help the author: a
 * key that is a typo, a missing file, a reference to nothing, a failing test case. The host's
 * `checking` stage and `just module check` are this scan. `previous` adds what the new version
 * does to stored data.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CONNECTORS, DATA_CLASSES, KIND_DIRS, MEMBER_TOOLS, RUNTIMES, structureChanges, TOOL_EFFECTS } from "./manifest.ts";
import type {
	AgentDescriptor, CapabilityUse, CollectionDescriptor, Component, ComponentName, Digest, FeedDescriptor, FieldDescriptor, KindDir, MemberTool, ModuleManifest, ModuleName, Problem, RuleRef, Runtime, ScanResult, ToolCase, ToolDescriptor,
} from "./manifest.ts";

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const EVERY = /^\d+(s|m|h|d)$/;
const FIELD_TYPES = ["text", "number", "date", "blob"] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Report = (where: string, reason: string) => void;

function isObject(value: Json | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<const T extends readonly string[]>(options: T, value: Json | undefined): value is T[number] {
	return typeof value === "string" && options.includes(value);
}

function readJson(report: Report, root: string, where: string): Json | undefined {
	if (!existsSync(join(root, where))) return void report(where, "is missing");
	try {
		return JSON.parse(readFileSync(join(root, where), "utf8")) as Json;
	} catch (error) {
		return void report(where, `is not valid JSON: ${(error as Error).message}`);
	}
}

/** Reports an unknown key: it is usually a typo, and a host that ignores it hides the mistake. */
function checkKeys(report: Report, where: string, parsed: Json | undefined, required: readonly string[], optional: readonly string[]): JsonObject | undefined {
	if (parsed === undefined) return undefined;
	if (!isObject(parsed)) return void report(where, "must be a JSON object");
	for (const key of Object.keys(parsed)) {
		if (!required.includes(key) && !optional.includes(key)) report(where, `unknown key "${key}" (known keys: ${[...required, ...optional].join(", ")})`);
	}
	for (const key of required) {
		const value = parsed[key];
		if (value === undefined || (typeof value === "string" && value.trim() === "")) report(where, `needs "${key}"`);
	}
	return parsed;
}

function readObject(report: Report, root: string, where: string, required: readonly string[], optional: readonly string[]): JsonObject | undefined {
	return checkKeys(report, where, readJson(report, root, where), required, optional);
}

function optionalText(report: Report, where: string, raw: JsonObject, key: string): string | undefined {
	const value = raw[key];
	if (value === undefined || (typeof value === "string" && value !== "")) return value;
	report(where, `"${key}" must be a non-empty string`);
	return undefined;
}

function nameList(report: Report, where: string, raw: JsonObject, key: string, shape: RegExp): string[] | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (Array.isArray(value) && value.every((item) => typeof item === "string" && shape.test(item))) return value as string[];
	report(where, `"${key}" must be a list of names`);
	return undefined;
}

/** The `key: value` lines between the two `---` lines at the top of a Markdown file, and whether a body follows. */
function frontMatter(report: Report, root: string, where: string, known: readonly string[]): Record<string, string> | undefined {
	if (!existsSync(join(root, where))) return void report(where, "is missing");
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(readFileSync(join(root, where), "utf8"));
	if (match === null) return void report(where, "must start with a front matter block between --- lines");
	const meta: Record<string, string> = {};
	for (const line of (match[1] ?? "").split("\n")) {
		const colon = line.indexOf(":");
		if (line.trim() === "") continue;
		if (colon < 1) report(where, `front matter line "${line}" is not "key: value"`);
		else meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}
	for (const key of Object.keys(meta)) if (!known.includes(key)) report(where, `front matter has unknown key "${key}" (known keys: ${known.join(", ")})`);
	if ((match[2] ?? "").trim() === "") report(where, "has nothing after the front matter");
	return meta;
}

function commaList(value: string | undefined): string[] {
	return (value ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
}

/** Names that start with a dot are skipped, so a `.git` or `.DS_Store` in the folder does not matter. */
function entries(root: string, where: string): { dirs: string[]; files: string[] } {
	const found = readdirSync(join(root, where), { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
	return {
		dirs: found.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
		files: found.filter((entry) => entry.isFile()).map((entry) => entry.name).sort(),
	};
}

function allFiles(root: string, where = ""): string[] {
	const found = entries(root, where);
	const path = (name: string): string => (where === "" ? name : `${where}/${name}`);
	return [...found.files.map(path), ...found.dirs.flatMap((name) => allFiles(root, path(name)))];
}

/** One hash over every file. Each file goes in as its path, its length and its content. */
function digestOf(root: string): Digest {
	const hash = createHash("sha256");
	for (const path of allFiles(root).sort()) {
		const content = readFileSync(join(root, path));
		hash.update(`${path}\n${content.length}\n`).update(content);
	}
	return hash.digest("hex") as Digest;
}

function fields(report: Report, where: string, key: string, value: Json | undefined): Record<string, FieldDescriptor> {
	const result: Record<string, FieldDescriptor> = {};
	if (!isObject(value) || Object.keys(value).length === 0) report(where, `"${key}" must describe at least one field`);
	for (const [name, raw] of Object.entries(isObject(value) ? value : {})) {
		if (!FIELD_NAME.test(name)) report(where, `${key}.${name} is not a valid field name (a letter, then letters, digits and underscores)`);
		else if (!isObject(raw) || !oneOf(FIELD_TYPES, raw["type"]) || typeof raw["title"] !== "string") {
			report(where, `${key}.${name} needs a "type" (${FIELD_TYPES.join(", ")}) and a "title"`);
		} else {
			const field: FieldDescriptor = { type: raw["type"], title: raw["title"] };
			if (typeof raw["unit"] === "string") field.unit = raw["unit"];
			if (typeof raw["was"] === "string") field.was = raw["was"];
			result[name] = field;
		}
	}
	return result;
}

function readManifest(report: Report, root: string): ModuleManifest | undefined {
	const where = "module.json";
	const derived = ["components", "tools", "skills", "feeds", "sources", "timers", "agents", "knowledge", "data"];
	const parsed = readJson(report, root, where);
	const declared = isObject(parsed) ? Object.keys(parsed).filter((key) => derived.includes(key)) : [];
	for (const key of declared) report(where, `must not list "${key}": components are derived from the folders, not declared`);
	const raw = checkKeys(report, where, parsed, ["schema", "name", "version"], ["title", "description", "team", ...declared]);
	if (raw === undefined) return undefined;
	if (raw["schema"] !== 1) report(where, `"schema" must be 1: that key is what marks a folder as a package of this layout`);
	const name = typeof raw["name"] === "string" ? raw["name"] : "";
	if (name !== basename(root)) report(where, `"name" is "${name}" but the folder is "${basename(root)}"`);
	else if (!NAME.test(name)) report(where, `"${name}" is not a usable module name (lowercase letters, digits and hyphens)`);
	const version = typeof raw["version"] === "string" ? raw["version"] : "";
	if (!/^\d+\.\d+\.\d+$/.test(version)) report(where, `"version" must look like 1.2.3`);
	const manifest: ModuleManifest = { schema: 1, name: name as ModuleName, version };
	for (const key of ["title", "description", "team"] as const) {
		const value = optionalText(report, where, raw, key);
		if (value !== undefined) manifest[key] = value;
	}
	if ((manifest.description ?? "").length > 60) report(where, `"description" is the Router's roster line, at most 60 characters`);
	return manifest;
}

function readKnowledge(report: Report, root: string, name: string): Component | undefined {
	const dir = `knowledge/${name}`;
	const where = `${dir}/source.json`;
	const raw = readObject(report, root, where, ["title", "version", "published", "authority", "license", "origin"], []);
	if (raw === undefined) return undefined;
	const authority = raw["authority"];
	const license = raw["license"];
	if (!oneOf(["authoritative", "reference"] as const, authority)) return void report(where, `"authority" must be authoritative or reference`);
	if (!oneOf(["bundled", "user-import"] as const, license)) return void report(where, `"license" must be bundled or user-import`);
	const texts = entries(root, dir).files.filter((file) => file.endsWith(".md"));
	if (license === "user-import" && texts.length > 0) {
		report(`${dir}/${texts[0]}`, "license is user-import, so the text must not be in the package; import it on the modules page");
	}
	if (license === "bundled" && texts.length === 0) report(dir, "license is bundled but there is no Markdown text");
	const source = { title: String(raw["title"]), version: String(raw["version"]), published: String(raw["published"]), authority, license, origin: String(raw["origin"]) };
	return { kind: "knowledge", name: name as ComponentName, source, texts };
}

function readCollection(report: Report, root: string, name: string): Component | undefined {
	const dir = `data/${name}`;
	const where = `${dir}/collection.json`;
	const raw = readObject(report, root, where, ["title", "kind", "class", "fields"], ["watch", "was"]);
	if (raw === undefined) return undefined;
	const kind = raw["kind"];
	const dataClass = raw["class"];
	if (!oneOf(["record", "series"] as const, kind)) return void report(where, `"kind" must be record or series`);
	if (!oneOf(DATA_CLASSES, dataClass)) return void report(where, `"class" must be one of ${DATA_CLASSES.join(", ")}`);
	const described = fields(report, where, "fields", raw["fields"]);
	const collection: CollectionDescriptor = { title: String(raw["title"]), kind, class: dataClass, fields: described };
	const was = optionalText(report, where, raw, "was");
	if (was !== undefined) collection.was = was;
	const watch = raw["watch"];
	if (watch !== undefined) {
		if (!isObject(watch) || typeof watch["key"] !== "string" || typeof watch["value"] !== "string" || typeof watch["at"] !== "string") {
			report(where, `"watch" needs "key", "value" and "at", each naming a field`);
		} else {
			if (kind !== "series") report(where, "only a series can be watched");
			for (const part of ["key", "value", "at"] as const) {
				const named = watch[part] as string;
				if (!Object.hasOwn(described, named)) report(where, `watch.${part} names "${named}", which is not a field`);
				else if (part === "value" && described[named]?.type !== "number") report(where, "watch.value must name a number field");
			}
			collection.watch = { key: watch["key"], value: watch["value"], at: watch["at"] };
		}
	}
	return { kind: "data", name: name as ComponentName, collection, seeded: existsSync(join(root, dir, "seed.json")) };
}

function runtimeOf(report: Report, where: string, raw: JsonObject): Runtime {
	const runtime = raw["runtime"] ?? "node";
	if (typeof runtime === "string" && Object.hasOwn(RUNTIMES, runtime)) return runtime as Runtime;
	report(where, `"runtime" ${JSON.stringify(runtime)} is not supported yet (supported: ${Object.keys(RUNTIMES).join(", ")})`);
	return "node";
}

function readTool(report: Report, root: string, name: string): Component | undefined {
	const dir = `tools/${name}`;
	const where = `${dir}/tool.json`;
	const raw = readObject(report, root, where, ["title", "description", "input", "output"], ["cites", "effect", "secrets", "runtime"]);
	if (raw === undefined) return undefined;
	const tool: ToolDescriptor = {
		title: String(raw["title"]),
		description: String(raw["description"]),
		input: fields(report, where, "input", raw["input"]),
		output: fields(report, where, "output", raw["output"]),
		runtime: runtimeOf(report, where, raw),
	};
	if (typeof raw["cites"] === "string") tool.cites = raw["cites"];
	const effect = raw["effect"];
	if (oneOf(TOOL_EFFECTS, effect)) tool.effect = effect;
	else if (effect !== undefined) report(where, `"effect" must be ${TOOL_EFFECTS.join(" or ")}; leave it out for a tool that only computes`);
	const secrets = nameList(report, where, raw, "secrets", SECRET_NAME);
	if (secrets !== undefined) tool.secrets = secrets;
	const entry = RUNTIMES[tool.runtime ?? "node"];
	if (!existsSync(join(root, dir, entry))) report(`${dir}/${entry}`, `is missing; a tool is tool.json and ${entry}, whose default export is the tool`);
	const cases: ToolCase[] = [];
	const casesWhere = `${dir}/cases.json`;
	if (!existsSync(join(root, casesWhere))) {
		if (tool.effect === undefined) report(casesWhere, `is missing; a tool that only computes needs test cases (a tool that reaches outside states "effect" and may go without)`);
		return { kind: "tools", name: name as ComponentName, tool, cases };
	}
	const parsed = readJson(report, root, casesWhere);
	if (!Array.isArray(parsed) || parsed.length === 0) report(casesWhere, "must be a non-empty list of test cases");
	for (const [index, entryCase] of (Array.isArray(parsed) ? parsed : []).entries()) {
		if (!isObject(entryCase) || typeof entryCase["name"] !== "string" || !isObject(entryCase["input"]) || !isObject(entryCase["expect"])) {
			report(casesWhere, `case ${index + 1} needs "name", "input" and "expect"`);
			continue;
		}
		for (const key of Object.keys(entryCase["input"])) {
			if (!Object.hasOwn(tool.input, key)) report(casesWhere, `case "${entryCase["name"]}" passes "${key}", which tool.json does not describe`);
		}
		const testCase: ToolCase = { name: entryCase["name"], input: entryCase["input"], expect: entryCase["expect"] };
		if (typeof entryCase["tolerance"] === "number") testCase.tolerance = entryCase["tolerance"];
		cases.push(testCase);
	}
	return { kind: "tools", name: name as ComponentName, tool, cases };
}

function readSkill(report: Report, root: string, name: string): Component | undefined {
	const where = `skills/${name}/SKILL.md`;
	const meta = frontMatter(report, root, where, ["name", "description"]);
	if (meta === undefined) return undefined;
	if (meta["name"] !== name) report(where, `front matter name is "${meta["name"] ?? ""}" but the folder is "${name}"`);
	if ((meta["description"] ?? "") === "") report(where, `front matter needs a "description"`);
	return { kind: "skills", name: name as ComponentName, description: meta["description"] ?? "" };
}

function readFeed(report: Report, root: string, name: string): Component | undefined {
	const dir = `feeds/${name}`;
	const where = `${dir}/feed.json`;
	const raw = readObject(report, root, where, ["title"], ["description", "connector", "handler", "secrets", "every", "settings", "ask", "into", "reads", "notice", "ignore"]);
	if (raw === undefined) return undefined;
	const feed: FeedDescriptor = { title: String(raw["title"]) };
	const connector = raw["connector"];
	if (oneOf(CONNECTORS, connector)) feed.connector = connector;
	else if (connector !== undefined) report(where, `connector ${JSON.stringify(connector)} is not one of the host's connectors (${CONNECTORS.join(", ")})`);
	for (const key of ["description", "handler", "every", "into", "notice"] as const) {
		const value = optionalText(report, where, raw, key);
		if (value !== undefined) feed[key] = value;
	}
	if (connector === undefined && feed.handler === undefined) report(where, `needs a "connector", a "handler", or both`);
	if (feed.into === undefined && feed.notice === undefined) report(where, `needs "into" (store records), "notice" (tell the Router), or both`);
	if (feed.every !== undefined && !EVERY.test(feed.every)) report(where, `"every" must look like 30s, 15m, 6h or 1d`);
	if (feed.handler !== undefined && !existsSync(join(root, dir, feed.handler))) report(`${dir}/${feed.handler}`, "is named as the handler but is missing");
	const secrets = nameList(report, where, raw, "secrets", SECRET_NAME);
	if (secrets !== undefined) feed.secrets = secrets;
	if (secrets !== undefined && feed.handler === undefined) report(where, `"secrets" is for a feed with a handler; a connector keeps its own authorization`);
	const reads = nameList(report, where, raw, "reads", NAME);
	if (reads !== undefined) feed.reads = reads;
	if (isObject(raw["settings"])) feed.settings = raw["settings"];
	else if (raw["settings"] !== undefined) report(where, `"settings" must be an object`);
	const ask = raw["ask"];
	if (ask !== undefined && !isObject(ask)) report(where, `"ask" must be an object`);
	for (const [key, value] of Object.entries(isObject(ask) ? ask : {})) {
		if (isObject(value) && typeof value["title"] === "string" && typeof value["type"] === "string") feed.ask = { ...feed.ask, [key]: { title: value["title"], type: value["type"] } };
		else report(where, `ask.${key} needs a "title" and a "type"`);
	}
	const ignore = nameList(report, where, raw, "ignore", /[\s\S]/);
	for (const pattern of ignore ?? []) {
		try {
			new RegExp(pattern);
		} catch (error) {
			report(where, `ignore pattern ${JSON.stringify(pattern)} is not a regular expression: ${(error as Error).message}`);
		}
	}
	if (ignore !== undefined) feed.ignore = ignore;
	if (ignore !== undefined && feed.notice === undefined) report(where, `"ignore" filters triggers, so it needs a "notice"`);
	return { kind: "feeds", name: name as ComponentName, feed };
}

function readAgent(report: Report, root: string, file: string): Component | undefined {
	const where = `agents/${file}`;
	if (!file.endsWith(".md")) return void report(where, "agents holds one Markdown file per member");
	const name = file.slice(0, -3);
	const meta = frontMatter(report, root, where, ["name", "title", "description", "tools", "uses", "model"]);
	if (meta === undefined) return undefined;
	if (meta["name"] !== name) report(where, `front matter name is "${meta["name"] ?? ""}" but the file is "${file}"`);
	for (const key of ["title", "description"]) if ((meta[key] ?? "") === "") report(where, `front matter needs "${key}"`);
	const listed = commaList(meta["tools"]);
	if (listed.length === 0) report(where, `front matter needs "tools": a member gets only the Pi tools it lists`);
	const tools: MemberTool[] = [];
	for (const tool of listed) {
		if (oneOf(MEMBER_TOOLS, tool)) tools.push(tool);
		else report(where, `tools lists "${tool}", which is not a Pi tool a member can have (${MEMBER_TOOLS.join(", ")})`);
	}
	const agent: AgentDescriptor = { name, title: meta["title"] ?? "", description: meta["description"] ?? "", tools, uses: commaList(meta["uses"]) as CapabilityUse[] };
	if (meta["model"] !== undefined) agent.model = meta["model"];
	return { kind: "agents", name: name as ComponentName, agent };
}

function readEval(report: Report, root: string, file: string): Component | undefined {
	const where = `evals/${file}`;
	if (!file.endsWith(".md")) return void report(where, "evals holds one Markdown file per question");
	const name = file.slice(0, -3);
	const meta = frontMatter(report, root, where, ["name", "uses", "expect"]);
	if (meta === undefined) return undefined;
	if (meta["name"] !== name) report(where, `front matter name is "${meta["name"] ?? ""}" but the file is "${file}"`);
	const described = { name, uses: commaList(meta["uses"]) as CapabilityUse[], expect: commaList(meta["expect"]) };
	if (described.uses.length === 0 && described.expect.length === 0) report(where, `needs "uses" or "expect", or it checks nothing`);
	return { kind: "evals", name: name as ComponentName, eval: described };
}

function readRules(report: Report, root: string, module: string, feeds: ReadonlySet<string>): RuleRef[] {
	const where = "rules.md";
	const rules: { id: string; sources: string[] }[] = [];
	for (const line of existsSync(join(root, where)) ? readFileSync(join(root, where), "utf8").split("\n") : []) {
		const heading = /^## +(.+?)\s*$/.exec(line);
		const scope = /^来源[:：]\s*(.+)$/.exec(line);
		const current = rules.at(-1);
		if (heading !== null) {
			if (rules.some((rule) => rule.id === `${module}/${heading[1]}`)) report(where, `rule "${heading[1]}" appears twice`);
			rules.push({ id: `${module}/${heading[1]}`, sources: [] });
		} else if (scope !== null && current !== undefined) {
			for (const source of commaList((scope[1] ?? "").replaceAll("，", ","))) {
				current.sources.push(source);
				const [owner, feed] = source.split("/");
				if (owner !== module) report(where, `rule "${current.id}" names source "${source}", which is not this module's`);
				else if (feed === undefined || !feeds.has(feed)) report(where, `rule "${current.id}" names source "${source}", but there is no feeds/${feed ?? ""}`);
			}
		}
	}
	return rules;
}

/** Every reference from one component to another resolves. */
function crossCheck(report: Report, manifest: ModuleManifest, components: readonly Component[]): void {
	const has = (kind: Component["kind"], name: string | undefined): boolean => components.some((item) => item.kind === kind && item.name === name);
	const resolves = (use: string): boolean => {
		const [kind, name, more] = use.split("/");
		if (use === "knowledge") return components.some((item) => item.kind === "knowledge");
		if (more !== undefined || (kind !== "data" && kind !== "tools" && kind !== "watch")) return false;
		return kind === "watch" ? components.some((item) => item.kind === "data" && item.name === name && item.collection.watch !== undefined) : has(kind, name);
	};
	for (const item of components) {
		if (item.kind === "feeds") {
			for (const collection of [item.feed.into, ...(item.feed.reads ?? [])]) {
				if (collection !== undefined && !has("data", collection)) report(`feeds/${item.name}/feed.json`, `names collection "${collection}", but there is no data/${collection}`);
			}
		}
		if (item.kind === "agents" || item.kind === "evals") {
			for (const use of item.kind === "agents" ? item.agent.uses : item.eval.uses) {
				if (!resolves(use)) report(`${item.kind}/${item.name}.md`, `uses "${use}", which this package does not have`);
			}
		}
	}
	const members = components.filter((item) => item.kind === "agents").length;
	if (members > 0 && manifest.team === undefined) report("module.json", `needs "team" because agents/ has members`);
	if (members === 0 && manifest.team !== undefined) report("module.json", `has "team" but agents/ has no members`);
}

/**
 * The whole contract between the host and a module's code: one fresh process per call, the
 * call as one JSON line on stdin, the reply as the last line of stdout. The process is an
 * ordinary one. Its working directory is the component's folder, and its environment is
 * `PATH` and `HOME` plus the secrets the descriptor names.
 */
const NODE_RUNNER = `
let text = "";
for await (const chunk of process.stdin) text += chunk;
let reply;
try {
	reply = { ok: true, output: await (await import(process.argv[1])).default(JSON.parse(text).input) };
} catch (error) {
	reply = { ok: false, note: String(error?.message ?? error) };
}
console.log(JSON.stringify(reply));
`;

export function runModuleCode(dir: string, entry: string, input: unknown, secrets: readonly string[] = []): { ok: true; output: Json } | { ok: false; note: string } {
	const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
	for (const name of secrets) env[name] = process.env[name] ?? "";
	const args = ["--input-type=module", "-e", NODE_RUNNER, pathToFileURL(join(dir, entry)).href];
	const run = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20_000, env, cwd: dir, input: JSON.stringify({ input }) });
	const last = run.stdout.trim().split("\n").at(-1) ?? "";
	try {
		if (run.error === undefined && run.status === 0) return JSON.parse(last) as { ok: true; output: Json } | { ok: false; note: string };
	} catch {
		return { ok: false, note: `the last line of stdout was not a reply: ${last}` };
	}
	return { ok: false, note: (run.error?.message ?? run.stderr).trim().split("\n").slice(0, 3).join(" ") || `exit ${run.status}` };
}

function same(actual: Json | undefined, expected: Json, tolerance: number): boolean {
	if (typeof expected === "number") return typeof actual === "number" && Math.abs(actual - expected) <= tolerance;
	if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => same(actual[index], item, tolerance));
	if (isObject(expected)) return isObject(actual) && Object.keys(expected).every((key) => same(actual[key], expected[key] ?? null, tolerance));
	return actual === expected;
}

function runToolCases(report: Report, root: string, name: string, tool: ToolDescriptor, cases: readonly ToolCase[]): void {
	for (const [index, item] of cases.entries()) {
		const label = `test case ${index + 1} "${item.name}"`;
		const reply = runModuleCode(join(root, "tools", name), RUNTIMES[tool.runtime ?? "node"], item.input, tool.secrets);
		if (!reply.ok) report(`tools/${name}/cases.json`, `${label} threw: ${reply.note}`);
		else if (!same(reply.output, item.expect as Json, item.tolerance ?? 1e-9)) {
			report(`tools/${name}/cases.json`, `${label} failed: expected ${JSON.stringify(item.expect)}, got ${JSON.stringify(reply.output)}`);
		}
	}
}

const READERS: Record<KindDir, { each: "dirs" | "files"; read(report: Report, root: string, name: string): Component | undefined }> = {
	knowledge: { each: "dirs", read: readKnowledge },
	data: { each: "dirs", read: readCollection },
	tools: { each: "dirs", read: readTool },
	skills: { each: "dirs", read: readSkill },
	feeds: { each: "dirs", read: readFeed },
	agents: { each: "files", read: readAgent },
	evals: { each: "files", read: readEval },
};

function readComponents(report: Report, root: string): Component[] {
	const components: Component[] = [];
	for (const dir of entries(root, "").dirs) {
		if (!oneOf(KIND_DIRS, dir)) {
			report(dir, `is not a component kind (the kinds are ${KIND_DIRS.join(", ")})`);
			continue;
		}
		for (const name of entries(root, dir)[READERS[dir].each]) {
			if (READERS[dir].each === "dirs" && !NAME.test(name)) report(`${dir}/${name}`, `"${name}" is not a valid name (lowercase letters, digits and hyphens)`);
			const component = READERS[dir].read(report, root, name);
			if (component !== undefined) components.push(component);
		}
	}
	return components;
}

/** `runCases: false` skips the tools' test cases, which spawn a process each: the host does that when it finds a package, and runs them when the user switches the package on. */
export function scanPackage(packageDir: string, { previous, runCases = true }: { previous?: string | undefined; runCases?: boolean } = {}): ScanResult {
	const root = resolve(packageDir);
	const problems: Problem[] = [];
	const report: Report = (where, reason) => void problems.push({ where, reason });
	const rejected = (name: string): ScanResult => ({ ok: false, name, problems });
	const manifest = readManifest(report, root);
	if (manifest === undefined) return rejected(basename(root));
	const components = readComponents(report, root);
	const feeds = new Set(components.filter((item) => item.kind === "feeds").map((item) => item.name as string));
	const rules = readRules(report, root, manifest.name, feeds);
	crossCheck(report, manifest, components);
	if (runCases && problems.length === 0) {
		for (const item of components) if (item.kind === "tools") runToolCases(report, root, item.name, item.tool, item.cases);
	}
	let notes: string[] = [];
	if (previous !== undefined && problems.length === 0) {
		const before = readComponents(() => undefined, resolve(previous));
		const changes = structureChanges(before, components);
		problems.push(...changes.problems);
		notes = changes.notes;
	}
	if (problems.length > 0) return rejected(manifest.name);
	return { ok: true, scan: { dir: root, manifest, components, rules, digest: digestOf(root), notes } };
}

export const problemLine = (problem: Problem): string => `${problem.where}: ${problem.reason}`;

export function summary(scan: Extract<ScanResult, { ok: true }>["scan"]): string {
	const count = (kind: Component["kind"]): number => scan.components.filter((item) => item.kind === kind).length;
	const classes = DATA_CLASSES.map((name) => `${name}:${scan.components.filter((item) => item.kind === "data" && item.collection.class === name).length}`);
	const secrets = new Set(scan.components.flatMap((item) => (item.kind === "tools" ? item.tool.secrets : item.kind === "feeds" ? item.feed.secrets : undefined) ?? []));
	const kinds = KIND_DIRS.map((kind) => `${kind}=${count(kind)}`).join(" ");
	return `ok ${scan.manifest.name}@${scan.manifest.version} | ${kinds} | rules=${scan.rules.length} | data-classes=${classes.join(",")} | secrets=${[...secrets].sort().join(",") || "none"} | digest=${scan.digest.slice(0, 12)}`;
}
