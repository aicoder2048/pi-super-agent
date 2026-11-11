import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { OutsideWrite, ScanCursor, WriteCheck, Writer } from "../kernel/types.ts";

export interface SessionToScan {
	file: string;
	key: string;
	by: Writer;
}

export type Placement = (absolutePath: string) => "inside" | "outside";

const OUTSIDE_MAX = 50;
const COMMAND_MAX = 160;

interface ToolCall {
	type?: string;
	name?: string;
	arguments?: { path?: unknown; command?: unknown };
}

/** Scans each session from its cursor for write, edit, bash and bg_start calls, and keeps the ones that reach outside. */
export function scanSessions(sessions: readonly SessionToScan[], since: ScanCursor, place: Placement, home: string): WriteCheck {
	const scanned: Record<string, number> = { ...since };
	const found: OutsideWrite[] = [];
	const problems: string[] = [];
	for (const session of sessions) {
		let text: string;
		try {
			text = readFileSync(session.file, "utf8");
		} catch (error) {
			problems.push(`读不了会话 ${session.key}：${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const lines = text.split("\n");
		const complete = lines.length - 1;
		const cwd = sessionCwd(lines[0]);
		for (let i = since[session.key] ?? 0; i < complete; i++) {
			for (const call of toolCalls(lines[i])) {
				const write = outsideWrite(call, cwd, home, place, session.by);
				if (write) found.push(write);
			}
		}
		scanned[session.key] = Math.max(complete, since[session.key] ?? 0);
	}
	const outside = unique(found);
	return { outside: outside.slice(0, OUTSIDE_MAX), omitted: Math.max(0, outside.length - OUTSIDE_MAX), scanned, ...(problems.length && { problem: problems.join("；") }) };
}

function sessionCwd(line: string | undefined): string {
	try {
		const head = JSON.parse(line ?? "") as { type?: string; cwd?: unknown };
		if (head.type === "session" && typeof head.cwd === "string") return head.cwd;
	} catch {}
	return "/";
}

function toolCalls(line: string): ToolCall[] {
	try {
		const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) return [];
		return (entry.message.content as ToolCall[]).filter((c) => c?.type === "toolCall");
	} catch {
		return [];
	}
}

function outsideWrite(call: ToolCall, cwd: string, home: string, place: Placement, by: Writer): OutsideWrite | undefined {
	const args = call.arguments ?? {};
	if ((call.name === "write" || call.name === "edit") && typeof args.path === "string") {
		const path = resolveToolPath(args.path, cwd, home);
		return place(path) === "outside" ? { kind: "wrote", path, tool: call.name, by } : undefined;
	}
	if ((call.name === "bash" || call.name === "bg_start") && typeof args.command === "string") {
		const paths = bashTargets(args.command, cwd, home).filter((p) => place(p) === "outside");
		return paths.length ? { kind: "maybe", paths, command: [...args.command].slice(0, COMMAND_MAX).join(""), tool: call.name, by } : undefined;
	}
	return undefined;
}

function unique(writes: OutsideWrite[]): OutsideWrite[] {
	const seen = new Set<string>();
	return writes.filter((w) => {
		const key = w.kind === "wrote" ? `wrote ${w.path}` : `maybe ${w.command}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const UNICODE_SPACES = /[  -   　]/g;

/** The same as Pi's resolveToCwd: a leading @ dropped, ~ expanded, unusual spaces made plain, then resolved against cwd. */
export function resolveToolPath(raw: string, cwd: string, home: string): string {
	let path = raw.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = home;
	else if (path.startsWith("~/")) path = join(home, path.slice(2));
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

const REDIRECT = /^(\d*|&)>>?$/;
const PACKAGE_MANAGERS: Record<string, readonly string[]> = {
	npm: ["i", "install", "add", "init", "ci"],
	pnpm: ["i", "install", "add", "init"],
	yarn: ["install", "add", "init"],
	bun: ["i", "install", "add", "init"],
	uv: ["add", "init", "sync", "pip", "venv"],
	pip: ["install"],
	pip3: ["install"],
};
const GIT_WRITES = ["add", "commit", "checkout", "switch", "reset", "restore", "apply", "mv", "rm", "stash", "merge", "rebase", "pull", "clone", "init"];
const SHELLS = ["bash", "sh", "zsh"];
const INTERPRETERS = ["python", "python3", "node", "deno", "bun", "tsx"];
const WRITES_IN_CODE = /write|open\s*\([^)]*,\s*['"][wax]|mkdir|makedirs|rename|unlink|remove|rmtree|copy|move|symlink|touch|appendFile|rmSync|cpSync|\brm\(/;
const PI_WRITES = ["install", "remove", "uninstall", "update"];

/**
 * A best guess at the absolute paths one shell command may write. It errs on reporting more, since the result reads as "may have written".
 * Heredoc bodies are dropped, the command splits at unquoted && || ; | & and newlines, and a cd holds for the rest of the command.
 * An interpreter's script and its arguments do not count, nor does running something in a directory: only what the command itself writes.
 */
export function bashTargets(command: string, cwd: string, home: string): string[] {
	const targets: string[] = [];
	let here = cwd;
	for (const segment of segments(withoutHeredocBodies(command))) {
		const { words, redirects } = parseSegment(segment, home);
		const at = (p: string) => resolve(here, p);
		targets.push(...redirects.map(at));
		const start = words.findIndex((w) => !/^\w+=/.test(w));
		if (start < 0) continue;
		const [cmd, ...rest] = words.slice(start);
		const plain = rest.filter((a) => !a.startsWith("-"));
		if (cmd === "cd") {
			here = at(plain[0] ?? home);
			continue;
		}
		targets.push(...commandTargets(cmd, rest, plain, here, home).map(at));
	}
	return [...new Set(targets)].filter((p) => !p.startsWith("/dev/"));
}

function commandTargets(cmd: string, rest: string[], plain: string[], here: string, home: string): string[] {
	const valueOf = (...flags: string[]) => {
		const i = rest.findIndex((a) => flags.includes(a));
		return i >= 0 ? rest[i + 1] : undefined;
	};
	switch (cmd) {
		case "tee":
		case "mkdir":
		case "touch":
		case "rm":
		case "rmdir":
		case "truncate":
			return plain;
		case "cp":
		case "mv":
		case "ln":
		case "install":
		case "rsync":
			return plain.slice(-1);
		case "sed":
		case "perl":
			return rest.some((a) => a.startsWith("-i") || a === "--in-place") ? plain.slice(-1) : [];
		case "curl": {
			const out = valueOf("-o", "--output");
			return out ? [out] : rest.includes("-O") ? [here] : [];
		}
		case "wget": {
			const out = valueOf("-O", "--output-document");
			return out ? [out] : [here];
		}
		case "unzip":
			return [valueOf("-d") ?? here];
		case "tar":
			return rest.some((a) => /^-?[a-zA-Z]*x/.test(a) || a === "--extract") ? [valueOf("-C", "--directory") ?? here] : [];
		case "git": {
			const dir = rest[0] === "-C" ? rest[1] : undefined;
			const sub = dir === undefined ? rest[0] : rest[2];
			return sub !== undefined && GIT_WRITES.includes(sub) ? [dir ?? here] : [];
		}
	}
	if (PACKAGE_MANAGERS[cmd]?.includes(rest[0] ?? "")) return [here];
	if (cmd === "pi" && PI_WRITES.includes(plain[0] ?? "")) return [rest.includes("-l") || rest.includes("--local") ? join(here, ".pi") : join(home, ".pi", "agent")];
	if (SHELLS.includes(cmd)) {
		const code = valueOf("-c");
		return code === undefined ? [] : bashTargets(code, here, home);
	}
	if (INTERPRETERS.includes(cmd)) {
		const code = valueOf("-c", "-e", "--eval");
		return code !== undefined && WRITES_IN_CODE.test(code) ? absolutePathsIn(code) : [];
	}
	return [];
}

function absolutePathsIn(text: string): string[] {
	return [...text.matchAll(/(?:^|[\s'"=(,:])(\/[^\s'"),;:]+)/g)].map((m) => m[1]);
}

function withoutHeredocBodies(command: string): string {
	const kept: string[] = [];
	let end: string | undefined;
	for (const line of command.split("\n")) {
		if (end !== undefined) {
			if (line.trim() === end) end = undefined;
			continue;
		}
		kept.push(line);
		end = /<<-?\s*['"]?(\w+)['"]?/.exec(line)?.[1];
	}
	return kept.join("\n");
}

function segments(command: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			if (c === quote) quote = undefined;
			else if (c === "\\" && quote === '"') current += command[i++];
			current += c;
			continue;
		}
		if (c === "'" || c === '"') quote = c;
		const ampersandSplits = c === "&" && command[i - 1] !== ">" && command[i + 1] !== ">";
		if (c === ";" || c === "\n" || c === "|" || ampersandSplits) {
			out.push(current);
			current = "";
			if (command[i + 1] === c) i++;
			continue;
		}
		current += c;
	}
	out.push(current);
	return out.map((s) => s.trim()).filter(Boolean);
}

/** Splits one segment into words, with quotes removed, a leading unquoted ~ and any $HOME outside single quotes expanded, and pulls out the redirect targets. */
function parseSegment(segment: string, home: string): { words: string[]; redirects: string[] } {
	const tokens: string[] = [];
	let current: string | undefined;
	let quote: string | undefined;
	const flush = () => {
		if (current !== undefined) tokens.push(current);
		current = undefined;
	};
	for (let i = 0; i < segment.length; i++) {
		const c = segment[i];
		const homeVar = quote === "'" || c !== "$" ? undefined : /^\$(HOME\b|\{HOME\})/.exec(segment.slice(i))?.[0];
		if (homeVar) {
			current = (current ?? "") + home;
			i += homeVar.length - 1;
			continue;
		}
		if (quote) {
			if (c === quote) quote = undefined;
			else current += c === "\\" && quote === '"' ? segment[++i] : c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			current ??= "";
			continue;
		}
		if (/\s/.test(c)) {
			flush();
			continue;
		}
		if (c === ">" || c === "<") {
			let op = current !== undefined && /^(\d+|&)$/.test(current) && c === ">" ? current : (flush(), "");
			current = undefined;
			op += c;
			while (segment[i + 1] === c || (c === "<" && segment[i + 1] === "-")) op += segment[++i];
			if (c === ">" && segment[i + 1] === "&") {
				op += segment[++i];
				while (/[\d-]/.test(segment[i + 1] ?? "")) op += segment[++i];
			}
			tokens.push(op);
			continue;
		}
		if (current === undefined && c === "~" && (segment[i + 1] === undefined || segment[i + 1] === "/" || /\s/.test(segment[i + 1]))) {
			current = home;
			continue;
		}
		current = (current ?? "") + (c === "\\" ? segment[++i] ?? "" : c);
	}
	flush();
	const words: string[] = [];
	const redirects: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (REDIRECT.test(t)) {
			if (tokens[i + 1] !== undefined) redirects.push(tokens[++i]);
		} else if (t.startsWith("<")) i++;
		else if (!/^(\d*|&)>>?&/.test(t)) words.push(t);
	}
	return { words, redirects };
}
