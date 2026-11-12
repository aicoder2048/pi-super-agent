/**
 * node sketch/validate.ts <packageDir> [--previous <packageDir>]
 *
 * Scans a module package and prints one summary line (exit 0), or every reason it is
 * rejected (exit 1). The host's `checking` stage and `just module check` are this scan.
 * With `--previous`, the scan also refuses a version that removes or renames a collection
 * or a field the previous version had, or changes a field's type or unit.
 *
 * Tool cases run module code, so they run behind both walls of sandbox.ts and never
 * without them.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CONNECTORS,
	DATA_CLASSES,
	DECLARED_EFFECTS,
	derivePermissions,
	feedClass,
	KIND_DIRS,
	MEMBER_TOOLS,
	needsCard,
	SERVED_EFFECTS,
	structureProblems,
	TOP_FILES,
} from "./manifest.ts";
import type {
	AgentDescriptor,
	CapabilityUse,
	CollectionDescriptor,
	Component,
	ComponentName,
	DataClass,
	Digest,
	EvalDescriptor,
	FeedDescriptor,
	FieldDescriptor,
	KindDir,
	KnowledgeSource,
	MemberTool,
	ModuleManifest,
	ModuleName,
	NetworkUse,
	Problem,
	RuleRef,
	ScanResult,
	ToolCase,
	ToolDescriptor,
} from "./manifest.ts";
import { SANDBOX_EXEC, sandboxedCommand } from "./sandbox.ts";

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const EVERY = /^\d+(s|m|h|d)$/;
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const CODE_FILE = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|py|sh|rb|pl|php|wasm|node)$/;
const FIELD_TYPES = ["text", "number", "date", "blob"] as const;
const AGENT_KEYS = ["name", "title", "description", "tools", "uses", "model"];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

class Report {
	readonly problems: Problem[] = [];
	add(where: string, reason: string): void {
		this.problems.push({ where, reason });
	}
}

function isObject(value: Json | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<const T extends readonly string[]>(options: T, value: Json | undefined): value is T[number] {
	return typeof value === "string" && options.includes(value);
}

/** Reads one JSON object and checks its keys. Returns undefined after reporting. */
function readObject(
	report: Report,
	root: string,
	where: string,
	required: readonly string[],
	optional: readonly string[],
): JsonObject | undefined {
	const path = join(root, where);
	if (!existsSync(path)) {
		report.add(where, "is missing");
		return undefined;
	}
	let parsed: Json;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as Json;
	} catch (error) {
		report.add(where, `is not valid JSON: ${(error as Error).message}`);
		return undefined;
	}
	if (!isObject(parsed)) {
		report.add(where, "must be a JSON object");
		return undefined;
	}
	let sound = true;
	for (const key of Object.keys(parsed)) {
		if (!required.includes(key) && !optional.includes(key)) {
			report.add(where, `unknown key "${key}"`);
			sound = false;
		}
	}
	for (const key of required) {
		if (!Object.hasOwn(parsed, key)) {
			report.add(where, `needs "${key}"`);
			sound = false;
		}
	}
	return sound ? parsed : undefined;
}

function text(report: Report, where: string, object: JsonObject, key: string): string {
	const value = object[key];
	if (typeof value === "string" && value.trim() !== "") return value;
	report.add(where, `"${key}" must be a non-empty string`);
	return "";
}

interface FrontMatter {
	meta: Record<string, string>;
	/** The lines between the two `---` lines, exactly as written. */
	block: string;
	body: string;
}

function parseFrontMatter(source: string): { block: string; body: string } | undefined {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source);
	return match === null ? undefined : { block: match[1] ?? "", body: (match[2] ?? "").trim() };
}

function frontMatter(report: Report, root: string, where: string): FrontMatter | undefined {
	const path = join(root, where);
	if (!existsSync(path)) {
		report.add(where, "is missing");
		return undefined;
	}
	const parsed = parseFrontMatter(readFileSync(path, "utf8"));
	if (parsed === undefined) {
		report.add(where, "must start with a front matter block between --- lines");
		return undefined;
	}
	const meta: Record<string, string> = {};
	for (const line of parsed.block.split("\n")) {
		if (line.trim() === "") continue;
		const colon = line.indexOf(":");
		if (colon < 1) {
			report.add(where, `front matter line "${line}" is not "key: value"`);
			continue;
		}
		const key = line.slice(0, colon).trim();
		if (Object.hasOwn(meta, key)) report.add(where, `front matter has "${key}" twice`);
		meta[key] = line.slice(colon + 1).trim();
	}
	return { meta, block: parsed.block, body: parsed.body };
}

function commaList(value: string | undefined): string[] {
	if (value === undefined || value.trim() === "") return [];
	return value.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

/**
 * Every entry that is not a real file or a real folder: symbolic links first of all. A
 * link could point the scan, the hash or a Worker at a file outside the package, so one
 * link anywhere rejects the package before anything else is read. Folders whose name
 * starts with a dot are not entered, but a link is reported even when its name does.
 */
function irregularEntries(root: string, where = ""): { path: string; link: boolean }[] {
	const found: { path: string; link: boolean }[] = [];
	for (const entry of readdirSync(join(root, where), { withFileTypes: true })) {
		const path = where === "" ? entry.name : `${where}/${entry.name}`;
		if (entry.isSymbolicLink()) found.push({ path, link: true });
		else if (entry.isDirectory()) {
			if (!entry.name.startsWith(".")) found.push(...irregularEntries(root, path));
		} else if (!entry.isFile()) found.push({ path, link: false });
	}
	return found;
}

/**
 * Names that start with a dot are not part of the package. They are never hashed and
 * never copied into the staged copy or the store, so module code cannot import them.
 */
function entries(root: string, where: string): { dirs: string[]; files: string[] } {
	const dirs: string[] = [];
	const files: string[] = [];
	for (const entry of readdirSync(join(root, where), { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory()) dirs.push(entry.name);
		else if (entry.isFile()) files.push(entry.name);
	}
	return { dirs: dirs.sort(), files: files.sort() };
}

function allFiles(root: string, where = ""): string[] {
	const found = entries(root, where);
	const here = found.files.map((name) => (where === "" ? name : `${where}/${name}`));
	return [...here, ...found.dirs.flatMap((name) => allFiles(root, where === "" ? name : `${where}/${name}`))];
}

/**
 * The closure rule. A file the layout does not define is rejected, and code gets its own
 * reason: the only code in a package is a tool's index.ts and a feed's handler.
 */
function reject(report: Report, where: string, layout: string): void {
	report.add(where, CODE_FILE.test(where) ? "is code, but not the entry of a tool or a feed handler; no other code may be in a package" : layout);
}

/**
 * Rejects everything in a component folder except the named files. A subfolder is
 * rejected whole, unless it is in `jsonFolders`, which may hold JSON files only.
 */
function closeFolder(report: Report, root: string, dir: string, allowed: readonly string[], layout: string, jsonFolders: readonly string[] = []): void {
	const found = entries(root, dir);
	for (const file of found.files) if (!allowed.includes(file)) reject(report, `${dir}/${file}`, layout);
	for (const sub of found.dirs) {
		if (jsonFolders.includes(sub)) {
			for (const file of allFiles(root, `${dir}/${sub}`)) {
				if (!file.endsWith(".json")) reject(report, file, `${sub}/ holds JSON files only`);
			}
			continue;
		}
		const code = allFiles(root, `${dir}/${sub}`).filter((file) => CODE_FILE.test(file));
		if (code.length === 0) report.add(`${dir}/${sub}`, layout);
		for (const file of code) reject(report, file, layout);
	}
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

function sha256(content: Uint8Array): Digest {
	return createHash("sha256").update(content).digest("hex") as Digest;
}

/**
 * One hash over named contents. Each entry goes in as path length, path, content length,
 * content, so no two different sets of entries produce the same byte stream.
 */
function framedHash(parts: readonly { path: string; content: Uint8Array }[]): Digest {
	const hash = createHash("sha256");
	for (const part of [...parts].sort((left, right) => (left.path < right.path ? -1 : 1))) {
		const path = utf8.encode(part.path);
		hash.update(`${path.length}:`).update(path).update(`${part.content.length}:`).update(part.content);
	}
	return hash.digest("hex") as Digest;
}

/**
 * What the user's click covers. The rule is one sentence: every file of the package,
 * except Markdown bodies and test material.
 *
 * - Markdown bodies are left out: skills, knowledge texts, evals, `README.md`, `NOTICE.md`
 *   and the prompt of each `agents/*.md`. They change what a Worker says, not what it can reach.
 * - Test material is left out: a tool's `cases.json` and a feed's `fixtures/`.
 * - `rules.md` is kept whole. It decides when a ticket opens.
 * - The front matter of each `agents/*.md` is kept. It lists the member's tools and `uses`.
 * - `module.json` is kept without `version`, so a version bump alone asks nothing.
 * - Everything else is kept whole: every descriptor and every code file.
 */
function grantParts(root: string, files: readonly string[], manifest: ModuleManifest): { path: string; content: Uint8Array }[] {
	const parts: { path: string; content: Uint8Array }[] = [];
	for (const path of files) {
		if (path === "module.json") {
			const identity = { schema: manifest.schema, name: manifest.name, title: manifest.title ?? null, description: manifest.description ?? null, team: manifest.team ?? null };
			parts.push({ path, content: utf8.encode(JSON.stringify(identity)) });
		} else if (/^agents\/[^/]+\.md$/.test(path)) {
			parts.push({ path, content: utf8.encode(parseFrontMatter(readFileSync(join(root, path), "utf8"))?.block ?? "") });
		} else if (path === "rules.md" || !path.endsWith(".md")) {
			if (/^tools\/[^/]+\/cases\.json$/.test(path) || /^feeds\/[^/]+\/fixtures\//.test(path)) continue;
			parts.push({ path, content: readFileSync(join(root, path)) });
		}
	}
	return parts;
}

function componentName(report: Report, where: string, name: string): ComponentName {
	if (!NAME.test(name)) report.add(where, `"${name}" is not a valid name (lowercase letters, digits and hyphens)`);
	return name as ComponentName;
}

function fields(report: Report, where: string, key: string, value: Json | undefined): Record<string, FieldDescriptor> {
	const result: Record<string, FieldDescriptor> = {};
	if (!isObject(value) || Object.keys(value).length === 0) {
		report.add(where, `"${key}" must describe at least one field`);
		return result;
	}
	for (const [name, raw] of Object.entries(value)) {
		if (!FIELD_NAME.test(name)) {
			report.add(where, `${key}.${name} is not a valid field name (a letter, then letters, digits and underscores)`);
			continue;
		}
		if (!isObject(raw) || !oneOf(FIELD_TYPES, raw["type"]) || typeof raw["title"] !== "string") {
			report.add(where, `${key}.${name} needs a "type" (${FIELD_TYPES.join(", ")}) and a "title"`);
			continue;
		}
		const unit = raw["unit"];
		result[name] = typeof unit === "string" ? { type: raw["type"], title: raw["title"], unit } : { type: raw["type"], title: raw["title"] };
	}
	return result;
}

// ---------------------------------------------------------------------------
// module.json
// ---------------------------------------------------------------------------

function readManifest(report: Report, root: string): ModuleManifest | undefined {
	const where = "module.json";
	const path = join(root, where);
	if (!existsSync(path)) {
		report.add(where, "is missing, so this folder is not a module package");
		return undefined;
	}
	let raw: Json;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as Json;
	} catch (error) {
		report.add(where, `is not valid JSON: ${(error as Error).message}`);
		return undefined;
	}
	if (!isObject(raw)) {
		report.add(where, "must be a JSON object");
		return undefined;
	}
	const allowed = ["schema", "name", "version", "title", "description", "team"];
	const derived = ["components", "tools", "skills", "feeds", "sources", "timers", "agents", "knowledge", "data"];
	for (const key of Object.keys(raw)) {
		if (derived.includes(key)) {
			report.add(where, `must not list "${key}": components are derived from the folders, not declared`);
		} else if (!allowed.includes(key)) {
			report.add(where, `unknown key "${key}"`);
		}
	}
	if (raw["schema"] !== 1) report.add(where, `"schema" must be 1: that key is what marks a folder as a package of this layout`);
	const name = text(report, where, raw, "name");
	if (name !== "" && name !== basename(root)) report.add(where, `"name" is "${name}" but the folder is "${basename(root)}"`);
	if (name !== "" && (!NAME.test(name) || name === "user" || name === "host")) report.add(where, `"${name}" is not a usable module name`);
	const version = text(report, where, raw, "version");
	if (version !== "" && !SEMVER.test(version)) report.add(where, `"version" must look like 1.2.3`);
	const description = raw["description"];
	if (description !== undefined && (typeof description !== "string" || description.length > 60)) {
		report.add(where, `"description" must be a string of at most 60 characters`);
	}
	const manifest: ModuleManifest = { schema: 1, name: name as ModuleName, version };
	if (typeof raw["title"] === "string") manifest.title = raw["title"];
	if (typeof description === "string") manifest.description = description;
	if (typeof raw["team"] === "string") manifest.team = raw["team"];
	return manifest;
}

/** `Api.Example.com.` and `api.example.com` are one host, so every comparison uses this form. */
function normalHost(host: string): string {
	const lower = host.toLowerCase();
	return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/** `network` on a tool or a feed: each entry is one exact host with its budget and, if needed, a secret name. */
function networkUses(report: Report, where: string, raw: Json | undefined): NetworkUse[] {
	const uses: NetworkUse[] = [];
	if (!Array.isArray(raw) || raw.length === 0) {
		report.add(where, `"network" must be a non-empty list of { "host", "perMinute" } entries`);
		return uses;
	}
	for (const entry of raw) {
		if (!isObject(entry) || typeof entry["host"] !== "string" || typeof entry["perMinute"] !== "number" || !(entry["perMinute"] > 0)) {
			report.add(where, `each network entry needs a "host" and a "perMinute" above 0`);
			continue;
		}
		for (const key of Object.keys(entry)) {
			if (!["host", "perMinute", "secret"].includes(key)) report.add(where, `network entry for "${entry["host"]}" has unknown key "${key}"`);
		}
		const host = normalHost(entry["host"]);
		if (!HOST_NAME.test(host)) report.add(where, `network host "${entry["host"]}" must be one exact host name`);
		const secret = entry["secret"];
		if (secret !== undefined && typeof secret !== "string") report.add(where, `network entry for "${host}": "secret" is the name of a secret, as a string`);
		uses.push(typeof secret === "string" ? { host, perMinute: entry["perMinute"], secret } : { host, perMinute: entry["perMinute"] });
	}
	return uses;
}

// ---------------------------------------------------------------------------
// Components, one reader per kind directory
// ---------------------------------------------------------------------------

function readKnowledge(report: Report, root: string, name: string): Component | undefined {
	const dir = `knowledge/${name}`;
	const where = `${dir}/source.json`;
	const raw = readObject(report, root, where, ["title", "version", "published", "authority", "license", "origin"], []);
	if (raw === undefined) return undefined;
	const authority = raw["authority"];
	const license = raw["license"];
	if (!oneOf(["authoritative", "reference"] as const, authority)) {
		report.add(where, `"authority" must be authoritative or reference`);
		return undefined;
	}
	if (!oneOf(["bundled", "user-import"] as const, license)) {
		report.add(where, `"license" must be bundled or user-import`);
		return undefined;
	}
	const found = entries(root, dir);
	const texts = found.files.filter((file) => file.endsWith(".md"));
	closeFolder(report, root, dir, ["source.json", ...texts], "knowledge holds source.json and Markdown only");
	if (license === "user-import" && texts.length > 0) {
		report.add(`${dir}/${texts[0]}`, "license is user-import, so the text must not be in the package; the user imports it into instance data");
	}
	if (license === "bundled" && texts.length === 0) report.add(dir, "license is bundled but there is no Markdown text");
	const source: KnowledgeSource = {
		title: text(report, where, raw, "title"),
		version: text(report, where, raw, "version"),
		published: text(report, where, raw, "published"),
		authority,
		license,
		origin: text(report, where, raw, "origin"),
	};
	return { kind: "knowledge", name: componentName(report, dir, name), source, texts };
}

function readCollection(report: Report, root: string, name: string): Component | undefined {
	const dir = `data/${name}`;
	const where = `${dir}/collection.json`;
	const raw = readObject(report, root, where, ["title", "kind", "class", "fields"], ["watch"]);
	if (raw === undefined) return undefined;
	const kind = raw["kind"];
	const dataClass = raw["class"];
	if (!oneOf(["record", "series"] as const, kind)) {
		report.add(where, `"kind" must be record or series`);
		return undefined;
	}
	if (!oneOf(DATA_CLASSES, dataClass)) {
		report.add(where, `"class" must be one of ${DATA_CLASSES.join(", ")}`);
		return undefined;
	}
	const described = fields(report, where, "fields", raw["fields"]);
	const collection: CollectionDescriptor = { title: text(report, where, raw, "title"), kind, class: dataClass, fields: described };
	const watch = raw["watch"];
	if (watch !== undefined) {
		if (!isObject(watch) || typeof watch["key"] !== "string" || typeof watch["value"] !== "string" || typeof watch["at"] !== "string") {
			report.add(where, `"watch" needs "key", "value" and "at", each naming a field`);
		} else {
			if (kind !== "series") report.add(where, "only a series can be watched");
			const field = (part: "key" | "value" | "at"): FieldDescriptor | undefined => {
				const named = watch[part] as string;
				if (Object.hasOwn(described, named)) return described[named];
				report.add(where, `watch.${part} names "${named}", which is not a field`);
				return undefined;
			};
			field("key");
			field("at");
			const value = field("value");
			if (value !== undefined && value.type !== "number") report.add(where, "watch.value must name a number field");
			collection.watch = { key: watch["key"], value: watch["value"], at: watch["at"] };
		}
	}
	closeFolder(report, root, dir, ["collection.json", "seed.json"], "a collection folder holds collection.json and at most seed.json; rows belong in instance data");
	const seeded = existsSync(join(root, dir, "seed.json"));
	if (seeded && dataClass !== "shareable") {
		report.add(`${dir}/seed.json`, `seed.json is only allowed in a shareable collection; a ${dataClass} collection's rows are instance data`);
	}
	return { kind: "data", name: componentName(report, dir, name), collection, seeded };
}

function readTool(report: Report, root: string, name: string): Component | undefined {
	const dir = `tools/${name}`;
	const where = `${dir}/tool.json`;
	closeFolder(report, root, dir, ["tool.json", "index.ts", "cases.json"], "a tool folder holds tool.json, index.ts and cases.json");
	const raw = readObject(report, root, where, ["title", "description", "input", "output"], ["cites", "network", "effect", "servedBy"]);
	if (raw === undefined) return undefined;
	const tool: ToolDescriptor = {
		title: text(report, where, raw, "title"),
		description: text(report, where, raw, "description"),
		input: fields(report, where, "input", raw["input"]),
		output: fields(report, where, "output", raw["output"]),
	};
	if (typeof raw["cites"] === "string") tool.cites = raw["cites"];
	if (raw["network"] !== undefined) tool.network = networkUses(report, where, raw["network"]);
	const servedBy = raw["servedBy"];
	const hostServed = servedBy !== undefined;
	const served = Object.keys(SERVED_EFFECTS);
	if (typeof servedBy === "string" && Object.hasOwn(SERVED_EFFECTS, servedBy)) tool.servedBy = servedBy as keyof typeof SERVED_EFFECTS;
	else if (hostServed) report.add(where, `"servedBy" must name a host power that serves tools (${served.join(", ")})`);
	const effect = raw["effect"];
	if (hostServed) {
		if (effect !== undefined) {
			const fixed = tool.servedBy === undefined ? "" : ` (${tool.servedBy} is ${SERVED_EFFECTS[tool.servedBy]})`;
			report.add(where, `must not state "effect": the host serves this tool and fixes its effect${fixed}`);
		}
	} else if (tool.network !== undefined && !oneOf(DECLARED_EFFECTS, effect)) {
		report.add(where, `needs "effect" (${DECLARED_EFFECTS.join(" or ")}): the tool reaches outside its sandbox, so it must say whether a call changes anything there`);
	} else if (tool.network === undefined && effect !== undefined) {
		report.add(where, `must not state "effect": a tool with no network is pure, and the host derives that`);
	} else if (oneOf(DECLARED_EFFECTS, effect)) {
		tool.effect = effect;
	}
	const cases: ToolCase[] = [];
	const hasCode = existsSync(join(root, dir, "index.ts"));
	const casesWhere = `${dir}/cases.json`;
	if (hostServed) {
		if (tool.network !== undefined) report.add(where, `the host serves this tool, so it has no code and no "network"`);
		if (hasCode) report.add(`${dir}/index.ts`, "the host serves this tool, so the package must not bring code for it");
		if (existsSync(join(root, casesWhere))) report.add(casesWhere, "the host serves this tool and tests it, so the package brings no cases");
		return { kind: "tools", name: componentName(report, dir, name), tool, cases };
	}
	if (!hasCode) report.add(`${dir}/index.ts`, "is missing; a tool is tool.json, index.ts and cases.json");
	if (!existsSync(join(root, casesWhere))) {
		report.add(casesWhere, "is missing; a tool without test cases cannot be enabled");
	} else {
		let parsed: Json = null;
		try {
			parsed = JSON.parse(readFileSync(join(root, casesWhere), "utf8")) as Json;
		} catch (error) {
			report.add(casesWhere, `is not valid JSON: ${(error as Error).message}`);
		}
		if (!Array.isArray(parsed) || parsed.length === 0) {
			report.add(casesWhere, "has no test cases; a tool without test cases cannot be enabled");
		} else {
			for (const [index, entry] of parsed.entries()) {
				if (!isObject(entry) || typeof entry["name"] !== "string" || !isObject(entry["input"]) || !isObject(entry["expect"])) {
					report.add(casesWhere, `case ${index + 1} needs "name", "input" and "expect"`);
					continue;
				}
				for (const key of Object.keys(entry["input"])) {
					if (!Object.hasOwn(tool.input, key)) report.add(casesWhere, `case "${entry["name"]}" passes "${key}", which tool.json does not describe`);
				}
				const testCase: ToolCase = { name: entry["name"], input: entry["input"], expect: entry["expect"] };
				if (typeof entry["tolerance"] === "number") testCase.tolerance = entry["tolerance"];
				const replay = entry["replay"];
				if (Array.isArray(replay)) {
					testCase.replay = replay.flatMap((item) =>
						isObject(item) && typeof item["url"] === "string" && typeof item["status"] === "number" && typeof item["body"] === "string"
							? [{ url: item["url"], status: item["status"], body: item["body"] }]
							: [],
					);
				}
				if (tool.network !== undefined && testCase.replay === undefined) {
					report.add(casesWhere, `case "${entry["name"]}" needs "replay": the tool uses the network, and the check never does`);
				}
				cases.push(testCase);
			}
		}
	}
	return { kind: "tools", name: componentName(report, dir, name), tool, cases };
}

function readSkill(report: Report, root: string, name: string): Component | undefined {
	const where = `skills/${name}/SKILL.md`;
	const parsed = frontMatter(report, root, where);
	if (parsed === undefined) return undefined;
	if (parsed.meta["name"] !== name) report.add(where, `front matter name is "${parsed.meta["name"] ?? ""}" but the folder is "${name}"`);
	const description = parsed.meta["description"] ?? "";
	if (description === "") report.add(where, `front matter needs a "description"`);
	if (parsed.body === "") report.add(where, "has no body");
	for (const file of allFiles(root, `skills/${name}`)) {
		if (!file.endsWith(".md")) reject(report, file, "a skill folder holds Markdown only");
	}
	return { kind: "skills", name: componentName(report, `skills/${name}`, name), skill: { name, description } };
}

function readFeed(report: Report, root: string, name: string): Component | undefined {
	const dir = `feeds/${name}`;
	const where = `${dir}/feed.json`;
	const raw = readObject(report, root, where, ["title"], ["description", "connector", "handler", "network", "every", "settings", "ask", "into", "notice", "ignore"]);
	if (raw === undefined) return undefined;
	const feed: FeedDescriptor = { title: text(report, where, raw, "title") };
	const connector = raw["connector"];
	if (oneOf(CONNECTORS, connector)) feed.connector = connector;
	else if (connector !== undefined) report.add(where, `connector ${JSON.stringify(connector)} is not one of the host's connectors (${CONNECTORS.join(", ")})`);
	for (const key of ["description", "handler", "every", "into", "notice"] as const) {
		const value = raw[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value === "") report.add(where, `"${key}" must be a non-empty string`);
		else feed[key] = value;
	}
	if (raw["network"] !== undefined) feed.network = networkUses(report, where, raw["network"]);
	if (feed.handler !== undefined && !/^[a-z0-9-]+\.ts$/.test(feed.handler)) report.add(where, `"handler" must be a .ts file in this folder`);
	closeFolder(report, root, dir, ["feed.json", ...(feed.handler === undefined ? [] : [feed.handler])], "a feed folder holds feed.json, the handler it names, and fixtures/ for dry runs", ["fixtures"]);
	if (connector === undefined && feed.handler === undefined) report.add(where, `needs a "connector", a "handler", or both`);
	if (feed.into === undefined && feed.notice === undefined) report.add(where, `needs "into" (store records), "notice" (tell the Router), or both`);
	if (feed.every !== undefined && !EVERY.test(feed.every)) report.add(where, `"every" must look like 30s, 15m, 6h or 1d`);
	if (feed.handler !== undefined && !existsSync(join(root, dir, feed.handler))) report.add(`${dir}/${feed.handler}`, "is named as the handler but is missing");
	if (feed.network !== undefined && feed.handler === undefined) report.add(where, `"network" is only for a feed with a handler`);
	const settings = raw["settings"];
	if (settings !== undefined) {
		if (isObject(settings)) feed.settings = settings;
		else report.add(where, `"settings" must be an object`);
	}
	const ask = raw["ask"];
	if (ask !== undefined) {
		const asked: Record<string, { title: string; type: string }> = {};
		if (!isObject(ask)) report.add(where, `"ask" must be an object`);
		else {
			for (const [key, value] of Object.entries(ask)) {
				if (isObject(value) && typeof value["title"] === "string" && typeof value["type"] === "string") {
					asked[key] = { title: value["title"], type: value["type"] };
				} else report.add(where, `ask.${key} needs a "title" and a "type"`);
			}
		}
		feed.ask = asked;
	}
	const ignore = raw["ignore"];
	if (ignore !== undefined) {
		const patterns: string[] = [];
		if (!Array.isArray(ignore) || ignore.length === 0) report.add(where, `"ignore" must be a non-empty list of regular expressions`);
		else {
			for (const pattern of ignore) {
				if (typeof pattern !== "string") {
					report.add(where, `"ignore" must hold strings`);
					continue;
				}
				try {
					new RegExp(pattern);
					patterns.push(pattern);
				} catch (error) {
					report.add(where, `ignore pattern ${JSON.stringify(pattern)} is not a regular expression: ${(error as Error).message}`);
				}
			}
		}
		if (feed.notice === undefined) report.add(where, `"ignore" filters triggers, so it needs a "notice"`);
		feed.ignore = patterns;
	}
	return { kind: "feeds", name: componentName(report, dir, name), feed };
}

function readAgent(report: Report, root: string, file: string): Component | undefined {
	const where = `agents/${file}`;
	if (!file.endsWith(".md")) {
		report.add(where, "agents holds one Markdown file per member");
		return undefined;
	}
	const name = file.slice(0, -3);
	const parsed = frontMatter(report, root, where);
	if (parsed === undefined) return undefined;
	for (const key of Object.keys(parsed.meta)) {
		if (!AGENT_KEYS.includes(key)) report.add(where, `front matter has unknown key "${key}"`);
	}
	if (parsed.meta["name"] !== name) report.add(where, `front matter name is "${parsed.meta["name"] ?? ""}" but the file is "${file}"`);
	for (const key of ["title", "description"]) {
		if ((parsed.meta[key] ?? "") === "") report.add(where, `front matter needs "${key}"`);
	}
	if (parsed.body === "") report.add(where, "has no prompt");
	const listed = commaList(parsed.meta["tools"]);
	if (listed.length === 0) report.add(where, `front matter needs "tools": a member gets only the Pi tools it lists`);
	const tools: MemberTool[] = [];
	for (const tool of listed) {
		if (oneOf(MEMBER_TOOLS, tool)) tools.push(tool);
		else report.add(where, `tools lists "${tool}", which is not a Pi tool a member can have (${MEMBER_TOOLS.join(", ")})`);
	}
	const agent: AgentDescriptor = {
		name,
		title: parsed.meta["title"] ?? "",
		description: parsed.meta["description"] ?? "",
		tools,
		uses: commaList(parsed.meta["uses"]) as CapabilityUse[],
	};
	const model = parsed.meta["model"];
	if (model !== undefined) agent.model = model;
	return { kind: "agents", name: componentName(report, where, name), agent };
}

function readEval(report: Report, root: string, file: string): Component | undefined {
	const where = `evals/${file}`;
	if (!file.endsWith(".md")) {
		report.add(where, "evals holds one Markdown file per question");
		return undefined;
	}
	const name = file.slice(0, -3);
	const parsed = frontMatter(report, root, where);
	if (parsed === undefined) return undefined;
	if (parsed.meta["name"] !== name) report.add(where, `front matter name is "${parsed.meta["name"] ?? ""}" but the file is "${file}"`);
	if (parsed.body === "") report.add(where, "has no question");
	const described: EvalDescriptor = {
		name,
		uses: commaList(parsed.meta["uses"]) as CapabilityUse[],
		expect: commaList(parsed.meta["expect"]),
	};
	if (described.uses.length === 0 && described.expect.length === 0) report.add(where, `needs "uses" or "expect", or it checks nothing`);
	return { kind: "evals", name: componentName(report, where, name), eval: described };
}

function readRules(report: Report, root: string, module: string, feeds: ReadonlySet<string>): RuleRef[] {
	const where = "rules.md";
	if (!existsSync(join(root, where))) return [];
	const rules: RuleRef[] = [];
	let current: { id: string; sources: string[] } | undefined;
	for (const line of readFileSync(join(root, where), "utf8").split("\n")) {
		const heading = /^## +(.+?)\s*$/.exec(line);
		if (heading !== null) {
			const id = `${module}/${heading[1]}`;
			if (rules.some((rule) => rule.id === id)) report.add(where, `rule "${heading[1]}" appears twice`);
			current = { id, sources: [] };
			rules.push(current);
			continue;
		}
		const scope = /^来源[:：]\s*(.+)$/.exec(line);
		if (scope !== null && current !== undefined) {
			for (const source of commaList((scope[1] ?? "").replaceAll("，", ","))) {
				current.sources.push(source);
				const [owner, feed] = source.split("/");
				if (owner !== module) report.add(where, `rule "${current.id}" names source "${source}", which is not this module's`);
				else if (feed !== undefined && !feeds.has(feed)) report.add(where, `rule "${current.id}" names source "${source}", but there is no feeds/${feed}`);
			}
		}
	}
	return rules;
}

// ---------------------------------------------------------------------------
// Cross-checks: every reference resolves. Permissions are derived, so no list exists to compare them with.
// ---------------------------------------------------------------------------

function crossCheck(report: Report, manifest: ModuleManifest, components: readonly Component[]): void {
	const has = (kind: Component["kind"], name: string): boolean => components.some((item) => item.kind === kind && item.name === name);
	const collections = new Map<string, CollectionDescriptor>();
	for (const item of components) if (item.kind === "data") collections.set(item.name, item.collection);

	const resolves = (use: string): boolean => {
		if (use === "knowledge") return components.some((item) => item.kind === "knowledge");
		const [kind, name, more] = use.split("/");
		if (name === undefined || more !== undefined) return false;
		if (kind === "data") return has("data", name);
		if (kind === "tools") return has("tools", name);
		if (kind === "watch") return collections.get(name)?.watch !== undefined;
		return false;
	};

	const budgets = new Map<string, { use: NetworkUse; where: string }>();
	const agree = (where: string, uses: readonly NetworkUse[] | undefined): void => {
		for (const use of uses ?? []) {
			const first = budgets.get(use.host);
			if (first === undefined) budgets.set(use.host, { use, where });
			else if (first.use.perMinute !== use.perMinute || first.use.secret !== use.secret) {
				report.add(where, `network host "${use.host}" has a different "perMinute" or "secret" in ${first.where}; a module has one budget and one secret per host`);
			}
		}
	};

	for (const item of components) {
		if (item.kind === "feeds") {
			const where = `feeds/${item.name}/feed.json`;
			const feed = item.feed;
			agree(where, feed.network);
			if (feed.into !== undefined && !collections.has(feed.into)) report.add(where, `"into" names "${feed.into}", but there is no data/${feed.into}`);
			const ownClass = feedClass(feed, collections);
			const because = feed.into === undefined ? `the feed has no "into", so its class is ${ownClass}` : `the feed fills data/${feed.into}, so its class is ${ownClass}`;
			if (ownClass !== "shareable" && feed.notice !== undefined && feed.notice.includes("{{")) {
				report.add(where, `notice must be fixed text: ${because}, and a notice with {{fields}} would carry the feed's content to the Router`);
			}
			if (ownClass !== "shareable" && feed.network !== undefined) {
				report.add(where, `a handler with "network" is only allowed on a shareable feed: ${because}, and code that reaches a host could send the feed's items there`);
			}
		}
		if (item.kind === "tools") agree(`tools/${item.name}/tool.json`, item.tool.network);
		if (item.kind === "agents" || item.kind === "evals") {
			const where = item.kind === "agents" ? `agents/${item.name}.md` : `evals/${item.name}.md`;
			const uses = item.kind === "agents" ? item.agent.uses : item.eval.uses;
			for (const use of uses) {
				if (!resolves(use)) report.add(where, `uses "${use}", which this package does not have`);
			}
		}
	}

	const where = "module.json";
	const members = components.filter((item) => item.kind === "agents").length;
	if (members > 0 && manifest.team === undefined) report.add(where, `needs "team" because agents/ has members`);
	if (members === 0 && manifest.team !== undefined) report.add(where, `has "team" but agents/ has no members`);
}

// ---------------------------------------------------------------------------
// Tool cases. One sandboxed process per case, started from a staged copy of the package.
// The process gets the case's input and canned replies. It never gets `expect`, and the
// comparison happens here, outside the sandbox.
// ---------------------------------------------------------------------------

const CASE_RUNNER = `
const [file, payload] = process.argv.slice(1);
const { input, replay } = JSON.parse(payload);
const host = {
	async fetch(url) {
		const canned = replay.find((entry) => entry.url === url);
		if (canned === undefined) throw new Error("no replay for " + url);
		return { status: canned.status, body: canned.body };
	},
};
let result;
try {
	const tool = (await import(file)).default;
	result = { ok: true, value: await tool(input, host) };
} catch (error) {
	result = { ok: false, error: [error?.code, error?.cause?.code, error?.message ?? error].filter(Boolean).join(" ") };
}
process.stdout.write(JSON.stringify(result));
`;

function same(actual: Json | undefined, expected: Json, tolerance: number): boolean {
	if (typeof expected === "number") return typeof actual === "number" && Math.abs(actual - expected) <= tolerance;
	if (Array.isArray(expected)) {
		return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => same(actual[index], item, tolerance));
	}
	if (isObject(expected)) {
		return isObject(actual) && Object.keys(expected).every((key) => same(Object.hasOwn(actual, key) ? actual[key] : undefined, expected[key] ?? null, tolerance));
	}
	return actual === expected;
}

/** Copies exactly the files the scan accepted. Dot files and anything the closure rule would reject are not there to import. */
function stage(root: string, files: readonly string[]): string {
	const staged = mkdtempSync(join(realpathSync(tmpdir()), "module-check-"));
	for (const file of files) {
		mkdirSync(dirname(join(staged, file)), { recursive: true });
		copyFileSync(join(root, file), join(staged, file));
	}
	return staged;
}

function runCases(report: Report, staged: string, name: string, cases: readonly ToolCase[]): void {
	const entry = join(staged, "tools", name, "index.ts");
	const where = `tools/${name}/cases.json`;
	if (!existsSync(SANDBOX_EXEC)) {
		report.add(`tools/${name}/index.ts`, `cannot be checked: ${SANDBOX_EXEC} is missing, and module code never runs outside the operating system's sandbox`);
		return;
	}
	for (const [index, item] of cases.entries()) {
		const label = `test case ${index + 1} "${item.name}"`;
		const payload = JSON.stringify({ input: item.input, replay: item.replay ?? [] });
		const launch = sandboxedCommand(entry, realpathSync(process.execPath), CASE_RUNNER, [pathToFileURL(entry).href, payload]);
		const run = spawnSync(launch.command, launch.args, { encoding: "utf8", timeout: 20_000, env: launch.env, cwd: launch.cwd });
		if (run.error !== undefined || run.status !== 0) {
			const detail = (run.error?.message ?? run.stderr).trim().split("\n").slice(0, 3).join(" ");
			report.add(`tools/${name}/index.ts`, `${label} could not run in the sandbox: ${detail || `exit ${run.status}`}`);
			continue;
		}
		let result: Json;
		try {
			result = JSON.parse(run.stdout) as Json;
		} catch {
			report.add(`tools/${name}/index.ts`, `${label}: the process's stdout was not one result; stdout belongs to the host, and module code must not write to it`);
			continue;
		}
		if (!isObject(result) || result["ok"] !== true) {
			report.add(where, `${label} threw: ${isObject(result) && typeof result["error"] === "string" ? result["error"] : "no result"}`);
		} else if (!same(result["value"], item.expect as Json, item.tolerance ?? 1e-9)) {
			report.add(where, `${label} failed: expected ${JSON.stringify(item.expect)}, got ${JSON.stringify(result["value"])}`);
		}
	}
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

const READERS: Record<KindDir, { each: "folder" | "file"; read(report: Report, root: string, name: string): Component | undefined }> = {
	knowledge: { each: "folder", read: readKnowledge },
	data: { each: "folder", read: readCollection },
	tools: { each: "folder", read: readTool },
	skills: { each: "folder", read: readSkill },
	feeds: { each: "folder", read: readFeed },
	agents: { each: "file", read: readAgent },
	evals: { each: "file", read: readEval },
};

export function scanPackage(packageDir: string, previousDir?: string): ScanResult {
	const root = resolve(packageDir);
	const report = new Report();
	const fallbackName = basename(root);
	const rejected = (): ScanResult => ({ ok: false, name: fallbackName, problems: report.problems });

	if (!existsSync(root)) {
		report.add(".", `${packageDir} does not exist`);
		return rejected();
	}
	for (const entry of irregularEntries(root)) {
		report.add(entry.path, entry.link ? "is a symbolic link; a package holds real files and folders only" : "is not a regular file or a folder");
	}
	if (report.problems.length > 0) return rejected();

	const manifest = readManifest(report, root);
	if (manifest === undefined) return rejected();

	const top = entries(root, "");
	for (const file of top.files) {
		if (!(TOP_FILES as readonly string[]).includes(file)) reject(report, file, `is not part of a module package (top-level files are ${TOP_FILES.join(", ")})`);
	}
	const components: Component[] = [];
	for (const dir of top.dirs) {
		if (!oneOf(KIND_DIRS, dir)) {
			const code = allFiles(root, dir).filter((file) => CODE_FILE.test(file));
			for (const file of code) reject(report, file, "");
			report.add(dir, `is not a component kind (the kinds are ${KIND_DIRS.join(", ")}); instance data never lives in the package`);
			continue;
		}
		const reader = READERS[dir];
		const found = entries(root, dir);
		const names = reader.each === "folder" ? found.dirs : found.files;
		for (const stray of reader.each === "folder" ? found.files : found.dirs) {
			reject(report, `${dir}/${stray}`, reader.each === "folder" ? `${dir} holds one folder per component` : `${dir} holds one file per component`);
		}
		for (const name of names) {
			const component = reader.read(report, root, name);
			if (component !== undefined) components.push(component);
		}
	}

	const feeds = new Set(components.filter((item) => item.kind === "feeds").map((item) => item.name as string));
	const rules = readRules(report, root, manifest.name, feeds);
	crossCheck(report, manifest, components);

	const files = allFiles(root);
	if (report.problems.length === 0) {
		const tools = components.flatMap((item) => (item.kind === "tools" && item.tool.servedBy === undefined ? [item] : []));
		if (tools.length > 0) {
			const staged = stage(root, files);
			try {
				for (const item of tools) runCases(report, staged, item.name, item.cases);
			} finally {
				rmSync(staged, { recursive: true, force: true });
			}
		}
	}
	if (report.problems.length > 0) return { ok: false, name: manifest.name || fallbackName, problems: report.problems };

	if (previousDir !== undefined) {
		const before = readStructure(resolve(previousDir));
		if (before === undefined) report.add(".", `--previous ${previousDir} is not a module package whose data/ can be read`);
		else report.problems.push(...structureProblems(before, components));
		if (report.problems.length > 0) return { ok: false, name: manifest.name, problems: report.problems };
	}

	const code = components.flatMap((item) => {
		if (item.kind === "tools" && item.tool.servedBy === undefined) return [`tools/${item.name}/index.ts`];
		if (item.kind === "feeds" && item.feed.handler !== undefined) return [`feeds/${item.name}/${item.feed.handler}`];
		return [];
	});
	const parts = grantParts(root, files, manifest);
	return {
		ok: true,
		scan: {
			dir: root,
			manifest,
			components,
			rules,
			permissions: derivePermissions(components),
			code,
			digest: framedHash(files.map((path) => ({ path, content: readFileSync(join(root, path)) }))),
			granted: Object.fromEntries(parts.map((part) => [part.path, sha256(part.content)])),
			grantKey: framedHash(parts),
			asks: needsCard({ rules: files.includes("rules.md"), code, components }),
		},
	};
}

/** The collections of a previous version, for the add-only comparison. Nothing else of it is checked. */
function readStructure(root: string): Component[] | undefined {
	if (!existsSync(join(root, "module.json"))) return undefined;
	if (!existsSync(join(root, "data"))) return [];
	const report = new Report();
	const collections = entries(root, "data").dirs.flatMap((name) => readCollection(report, root, name) ?? []);
	return report.problems.length === 0 ? collections : undefined;
}

function summary(result: Extract<ScanResult, { ok: true }>): string {
	const scan = result.scan;
	const count = (kind: Component["kind"]): number => scan.components.filter((item) => item.kind === kind).length;
	const classes = new Map<DataClass, number>();
	for (const item of scan.components) {
		if (item.kind === "data") classes.set(item.collection.class, (classes.get(item.collection.class) ?? 0) + 1);
	}
	const permissions = scan.permissions;
	const network = permissions.network.map((use) => `${use.host}@${use.perMinute}/min${use.secret === undefined ? "" : `+${use.secret}`}`);
	const members = permissions.members.map((entry) => `${entry.member}:${entry.tools.join("+")}`);
	const parts = [
		`ok ${scan.manifest.name}@${scan.manifest.version}`,
		(["knowledge", "data", "tools", "skills", "feeds", "agents", "evals"] as const).map((kind) => `${kind}=${count(kind)}`).join(" "),
		`rules=${scan.rules.length} code=${scan.code.length}`,
		`data-classes=${DATA_CLASSES.filter((name) => classes.has(name)).map((name) => `${name}:${classes.get(name)}`).join(",") || "none"}`,
		`derived-permissions=connectors:${permissions.connectors.join("+") || "none"} network:${network.join("+") || "none"} host:${permissions.host.join("+") || "none"} members:${members.join(",") || "none"}`,
		`card=${scan.asks ? "yes" : "no"}`,
		`digest=${scan.digest.slice(0, 12)} grant-key=${scan.grantKey.slice(0, 12)} granted-files=${Object.keys(scan.granted).length}`,
	];
	return parts.join(" | ");
}

const args = process.argv.slice(2);
const flag = args.indexOf("--previous");
const previous = flag === -1 ? undefined : args[flag + 1];
const target = args.find((arg, index) => arg !== "--previous" && (flag === -1 || index !== flag + 1));
if (target === undefined || (flag !== -1 && previous === undefined)) {
	console.log("usage: node validate.ts <packageDir> [--previous <packageDir>]");
	process.exitCode = 2;
} else {
	const result = scanPackage(target, previous);
	if (result.ok) {
		console.log(summary(result));
	} else {
		for (const problem of result.problems) console.log(`${problem.where}: ${problem.reason}`);
		console.log(`rejected ${result.name}: ${result.problems.length} problem(s)`);
		process.exitCode = 1;
	}
}
