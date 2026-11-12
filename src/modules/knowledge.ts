/**
 * A module's knowledge search: Markdown split by headings into a SQLite FTS5 index at
 * `<stateDir>/modules-data/<module>/index/knowledge.db`. Bundled texts come from the pinned
 * copy, `user-import` texts from `modules-data/<module>/knowledge/<doc>/`. The index is
 * rebuilt whenever its fingerprint (the copy's digest and the imported files) no longer
 * matches, always to a temp file renamed into place.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Component, ComponentName, Digest, ModuleName } from "./manifest.ts";
import type { Passage } from "./protocol.ts";
import { allFiles } from "./validate.ts";

export type Knowledge = Extract<Component, { kind: "knowledge" }>;

/** Everything one search reads: the pinned copy, the module's instance data, the docs the copy declares. */
export interface KnowledgeBase {
	module: ModuleName;
	digest: Digest;
	copyDir: string;
	dataDir: string;
	docs: readonly Knowledge[];
}

type Found = { passages: readonly Passage[]; notImported: readonly Knowledge[] };
/** Each doc with the Markdown files it is indexed from, listed once per search. */
type Texts = readonly { doc: Knowledge; files: readonly string[] }[];

const LIMIT = 8;
const EXCERPT = 360;
const indexPath = (dataDir: string) => join(dataDir, "index", "knowledge.db");
const importedDir = (dataDir: string, doc: string) => join(dataDir, "knowledge", doc);

export const moduleDataDir = (stateDir: string, module: string) => join(stateDir, "modules-data", module);

/** Dot files are skipped, as in a package, so a copied `.git` or `._x.md` is never indexed. */
const markdownIn = (dir: string): string[] => (existsSync(dir) ? allFiles(dir).filter((f) => f.endsWith(".md")).sort().map((f) => join(dir, f)) : []);

const textsOf = (base: KnowledgeBase): Texts =>
	base.docs.map((doc) => ({
		doc,
		files: doc.source.license === "bundled" ? doc.texts.map((f) => join(base.copyDir, "knowledge", doc.name, f)) : markdownIn(importedDir(base.dataDir, doc.name)),
	}));

const notImported = (texts: Texts) => texts.filter((t) => t.doc.source.license === "user-import" && t.files.length === 0).map((t) => t.doc);

function fingerprint(digest: Digest, texts: Texts): string {
	const imported = texts
		.filter((t) => t.doc.source.license === "user-import")
		.flatMap((t) => t.files.map((f) => {
			const { size, mtimeMs } = statSync(f);
			return `${f} ${size} ${mtimeMs}`;
		}));
	return [digest, ...imported].join("\n");
}

/** One passage per heading that has text under it. `section` is the heading path, e.g. `指南 > 7.3 心衰`. */
function splitByHeadings(markdown: string, fallback: string): { section: string; text: string }[] {
	const out: { section: string; text: string }[] = [];
	const path: string[] = [];
	let body: string[] = [];
	let fenced = false;
	const flush = () => {
		const text = body.join("\n").trim();
		if (text) out.push({ section: path.filter(Boolean).join(" > ") || fallback, text });
		body = [];
	};
	for (const line of markdown.split(/\r?\n/)) {
		if (line.startsWith("```")) fenced = !fenced;
		const heading = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (!heading) {
			body.push(line);
			continue;
		}
		flush();
		const level = heading[1]!.length;
		path.length = level - 1;
		path[level - 1] = heading[2]!;
	}
	flush();
	return out;
}

/** Idempotent: the same inputs give the same index, and a reader never sees a half-built file. */
export function buildIndex(base: KnowledgeBase, texts = textsOf(base)): void {
	const target = indexPath(base.dataDir);
	mkdirSync(join(target, ".."), { recursive: true });
	const temp = `${target}.${process.pid}.${Date.now()}.partial`;
	const db = new DatabaseSync(temp);
	try {
		db.exec(`CREATE TABLE meta (fingerprint TEXT NOT NULL);
			CREATE VIRTUAL TABLE passages USING fts5(doc UNINDEXED, title UNINDEXED, version UNINDEXED, authority UNINDEXED, section, text, tokenize = 'trigram')`);
		db.exec("BEGIN");
		db.prepare("INSERT INTO meta VALUES (?)").run(fingerprint(base.digest, texts));
		const insert = db.prepare("INSERT INTO passages VALUES (?, ?, ?, ?, ?, ?)");
		for (const { doc, files } of texts) {
			for (const file of files) {
				for (const p of splitByHeadings(readFileSync(file, "utf8"), basename(file, ".md"))) {
					insert.run(doc.name, doc.source.title, doc.source.version, doc.source.authority, p.section, p.text);
				}
			}
		}
		db.exec("COMMIT");
		db.close();
		renameSync(temp, target);
	} catch (error) {
		db.close();
		rmSync(temp, { recursive: true, force: true });
		throw error;
	}
}

function openFresh(base: KnowledgeBase, texts: Texts): DatabaseSync {
	const path = indexPath(base.dataDir);
	if (existsSync(path)) {
		const db = new DatabaseSync(path, { readOnly: true });
		const row = db.prepare("SELECT fingerprint FROM meta").get() as { fingerprint: string } | undefined;
		if (row?.fingerprint === fingerprint(base.digest, texts)) return db;
		db.close();
	}
	buildIndex(base, texts);
	return new DatabaseSync(path, { readOnly: true });
}

/**
 * Trigram MATCH finds nothing for a term under 3 characters (most two-character Chinese
 * words), so a query with such a term ranks by plain substring hits instead.
 */
function rowsFor(db: DatabaseSync, terms: readonly string[]): Passage[] {
	const columns = "doc, title, version, authority, section, text";
	if (terms.every((t) => [...t].length >= 3)) {
		const match = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
		return db.prepare(`SELECT ${columns} FROM passages WHERE passages MATCH ? ORDER BY bm25(passages) LIMIT ${LIMIT}`).all(match) as Passage[];
	}
	const score = terms.map(() => "(instr(lower(section || ' ' || text), lower(?)) > 0)").join(" + ");
	return db.prepare(`SELECT ${columns} FROM (SELECT *, rowid AS at, ${score} AS score FROM passages) WHERE score > 0 ORDER BY score DESC, at LIMIT ${LIMIT}`).all(...terms) as Passage[];
}

function excerpt(text: string, terms: readonly string[]): string {
	const lower = text.toLowerCase();
	const at = Math.min(...terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0), text.length);
	const start = at === text.length ? 0 : Math.max(0, at - 60);
	const end = Math.min(text.length, start + EXCERPT);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function searchKnowledge(base: KnowledgeBase, query: string): Found {
	const texts = textsOf(base);
	const missing = notImported(texts);
	const terms = [...new Set(query.split(/\s+/).filter(Boolean))];
	if (terms.length === 0) return { passages: [], notImported: missing };
	const db = openFresh(base, texts);
	try {
		const passages = rowsFor(db, terms).map((r) => ({ ...r, text: excerpt(r.text, terms) }));
		return { passages, notImported: missing };
	} finally {
		db.close();
	}
}

const AUTHORITY_TEXT = { authoritative: "权威", reference: "参考" } as const;

const importCommand = (module: ModuleName, doc: ComponentName) => `just module import ${module} ${doc} <文件或目录>`;

/** What the Worker reads: numbered excerpts with their citation, then what is still to import. */
export function foundText(module: ModuleName, query: string, found: Found): string {
	const hits = found.passages.length
		? [
				`查「${query}」找到 ${found.passages.length} 段（最多 ${LIMIT} 段，每段只是摘录）。引用时写明文档、版本和章节：`,
				...found.passages.map((p, i) => `${i + 1}. 《${p.title}》（${p.doc}，版本 ${p.version}，${AUTHORITY_TEXT[p.authority]}）章节：${p.section}\n   ${p.text.replaceAll("\n", " ")}`),
			]
		: [`没有找到和「${query}」相关的段落。换个说法或更短的词再查。`];
	const missing = found.notImported.map((d) => `《${d.source.title}》（${d.name}）还没导入，查不到它的内容。全文要使用者自己取得后导入：${importCommand(module, d.name)}`);
	return ["[模块知识]", ...hits, ...missing].join("\n");
}

/** The docs a caller may search, one line each, for the `knowledge` tool's description. */
export function catalogueText(base: KnowledgeBase): string {
	const missing = notImported(textsOf(base));
	return base.docs
		.map((d) => {
			const imported = !missing.includes(d);
			return `${d.name} · 《${d.source.title}》版本 ${d.source.version}，${AUTHORITY_TEXT[d.source.authority]}${imported ? "" : `，还没导入（${importCommand(base.module, d.name)}）`}`;
		})
		.join("\n");
}

/**
 * Replaces the imported text of `doc` with the Markdown at `from` (a file, or every `.md` under
 * a folder) and returns the number of files. With none, the old import stays. Copies into a
 * temp folder first, so a crash never leaves half an import.
 */
export function importKnowledge(dataDir: string, doc: string, from: string): number {
	const files = statSync(from).isDirectory() ? markdownIn(from) : [from];
	if (files.length === 0) return 0;
	const target = importedDir(dataDir, doc);
	const temp = `${target}.partial`;
	rmSync(temp, { recursive: true, force: true });
	mkdirSync(temp, { recursive: true });
	files.forEach((file, i) => copyFileSync(file, join(temp, `${String(i).padStart(3, "0")}-${basename(file)}`)));
	rmSync(target, { recursive: true, force: true });
	renameSync(temp, target);
	return files.length;
}
