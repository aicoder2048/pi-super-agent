/**
 * Where module code runs: one short-lived process per call, behind two walls.
 *
 * The main wall is the operating system's sandbox (`sandbox-exec` on macOS). The second
 * layer is Node's own permission model (`--permission`). Module code never runs without
 * both. `--permission` alone is not enough: `node:sqlite` opens and creates files past it,
 * and it does not stop `process.kill` or `os.setPriority`.
 *
 * The host is macOS-only today. Another operating system needs its own profile generator
 * here before module code runs there.
 */

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** V8's heap limit for one call, in megabytes. */
const HEAP_MB = 256;

/** A path as an SBPL string literal. Refuses a path that could end the literal or is not absolute. */
function quoted(path: string): string {
	if (!path.startsWith("/") || /[\u0000-\u001f]/.test(path)) throw new Error(`not a usable absolute path: ${JSON.stringify(path)}`);
	return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The libraries the Node binary loads. A Homebrew Node is linked against libraries under
 * the same prefix (`<prefix>/Cellar` and `<prefix>/opt`). Any other Node gets its own
 * binary and the system libraries, which is what a statically linked build needs.
 */
function nodeLibraries(nodePath: string): string[] {
	const cellar = nodePath.indexOf("/Cellar/");
	if (cellar === -1) return [];
	const prefix = nodePath.slice(0, cellar);
	return [`${prefix}/Cellar`, `${prefix}/opt`];
}

/**
 * The sandbox-exec profile for one call. Both paths must be real paths, because the
 * sandbox compares paths after it resolves links.
 *
 * Everything is denied unless a line allows it. The process may execute the Node binary
 * and nothing else. It may read the system libraries, Node's libraries, and exactly one
 * file of the package: `entryFile`. It may not write any file, open any socket, create a
 * process, or signal any process except itself.
 */
export function sandboxProfile(entryFile: string, nodePath: string): string {
	const system = ['(subpath "/usr/lib")', '(subpath "/System")', '(subpath "/private/var/db/dyld")', '(literal "/dev/null")', '(literal "/dev/urandom")', '(literal "/")'];
	const libraries = nodeLibraries(nodePath).map((path) => `(subpath ${quoted(path)})`);
	return [
		"(version 1)",
		"(deny default)",
		`(allow process-exec (literal ${quoted(nodePath)}))`,
		`(allow file-read* ${[...system, ...libraries].join(" ")})`,
		`(allow file-read* (literal ${quoted(nodePath)}) (literal ${quoted(entryFile)}))`,
		"(allow file-read-metadata)",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow signal (target self))",
		"",
	].join("\n");
}

export interface SandboxedCommand {
	command: string;
	args: string[];
	/** Always empty. Module code gets no environment variable of the host. */
	env: Record<string, never>;
	/** `/`: the one directory every profile lets a process stand in. */
	cwd: string;
}

/**
 * The command line for one call. `runner` is host code: it imports `entryFile`, calls its
 * default export and speaks to the host on stdin and stdout. `args` are the runner's own.
 *
 * `--openssl-config=/dev/null` keeps Node from reading a configuration file outside the
 * profile at start.
 */
export function sandboxedCommand(entryFile: string, nodePath: string, runner: string, args: readonly string[]): SandboxedCommand {
	return {
		command: SANDBOX_EXEC,
		args: [
			"-p",
			sandboxProfile(entryFile, nodePath),
			nodePath,
			"--openssl-config=/dev/null",
			`--max-old-space-size=${HEAP_MB}`,
			"--permission",
			`--allow-fs-read=${entryFile}`,
			"--input-type=module",
			"-e",
			runner,
			...args,
		],
		env: {},
		cwd: "/",
	};
}
