/**
 * The whole contract between the host and a module's code: one fresh process per call, the
 * call as one JSON line on stdin, the reply as the last line of stdout. The process is an
 * ordinary one. Its working directory is the component's folder, and its environment is
 * `PATH` and `HOME` plus the secrets the descriptor names, `PSA_MODULE_DATA` (the module's instance data, where
 * it may write under `files/`) and, for a package with a `py/` project, `PSA_MODULE_VENV`.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { filesDir, lockOf, venvDir } from "./files.ts";
import type { FeedFixture, ModuleName } from "./manifest.ts";
import type { Json } from "./protocol.ts";

// The encoding keeps a character split across two pipe chunks whole.
const NODE_RUNNER = `
let text = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) text += chunk;
const call = JSON.parse(text);
if (call.responses) {
	globalThis.fetch = async (url) => {
		const key = String(url?.url ?? url);
		if (!Object.hasOwn(call.responses, key)) throw new Error("the fixture has no response for " + key);
		const { status, headers, body } = call.responses[key];
		const head = new Headers({ "content-type": "application/json" });
		for (const [name, value] of Object.entries(headers)) head.set(name, value);
		const text = [204, 205, 304].includes(status) ? null : typeof body === "string" ? body : JSON.stringify(body);
		return new Response(text, { status, headers: head });
	};
}
let reply;
try {
	reply = { ok: true, output: (await (await import(process.argv[1])).default(call.input)) ?? null };
} catch (error) {
	reply = { ok: false, note: String(error?.message ?? error) };
}
console.log(JSON.stringify(reply));
`;

export const LIMIT_MS = 20_000;
const STDOUT_CAP = 1024 * 1024;

export type CodeReply = { ok: true; output: Json } | { ok: false; note: string };

export type Secrets = Readonly<Record<string, string>>;

export type Responses = FeedFixture["responses"];

/** What the replaying `fetch` answers with. A fixture's reply is just the body, with status 200, or this shape with `status` given. */
type Replay = { status: number; headers: Readonly<Record<string, string>>; body?: unknown };

const REPLAY_KEYS = new Set(["status", "headers", "body"]);

/** An object with a numeric "status" and no other keys than "headers" and "body". An API body with a text "status" (`{ "status": "ERROR" }`) or with more keys stays a body. */
const isReplay = (reply: unknown): reply is { status: number; headers?: unknown; body?: unknown } =>
	typeof reply === "object" && reply !== null && !Array.isArray(reply) && typeof (reply as { status?: unknown }).status === "number" && Object.keys(reply).every((key) => REPLAY_KEYS.has(key));

/** Why `reply` cannot be replayed, or undefined. `Response` takes only 200 to 599, the statuses `fetch` can resolve with. */
export function replayProblem(reply: unknown): string | undefined {
	if (!isReplay(reply)) return undefined;
	const { status, headers } = reply;
	if (!Number.isInteger(status) || status < 200 || status > 599) return `"status" ${JSON.stringify(status)}, which is not a whole number from 200 to 599`;
	const text = typeof headers === "object" && headers !== null && !Array.isArray(headers) && Object.values(headers).every((value) => typeof value === "string");
	if (headers !== undefined && !text) return `"headers" that are not names to text`;
	return undefined;
}

const replays = (responses: Responses | undefined): Record<string, Replay> | undefined =>
	responses && Object.fromEntries(Object.entries(responses).map(([url, reply]) => [url, isReplay(reply) ? { headers: {}, ...reply } as Replay : { status: 200, headers: {}, body: reply }]));

export type RunOptions = { limitMs?: number; responses?: Responses; signal?: AbortSignal };

export type SecretLookup = (name: string) => string | undefined;

/** A value from `module`'s own `.env`. Module code gets secrets only this way (ADR-0031). */
export type ModuleSecretLookup = (module: ModuleName, name: string) => string | undefined;

export const secretsFor = (names: readonly string[], secret: SecretLookup): Secrets => Object.fromEntries(names.map((name) => [name, secret(name) ?? ""]));

const FIXTURE_SECRET = "fixture";

export const fixtureSecrets = (names: readonly string[]): Secrets => Object.fromEntries(names.map((name) => [name, FIXTURE_SECRET]));

/**
 * Where one call's code runs. `component` is its folder inside the package, e.g. `tools/add`.
 * `dataDir` is the module's instance data, or a scratch one when the call is a test case.
 * `packageDir` is the copy the caller is pinned to, so the venv is the one that copy's lock names.
 */
export type CodeSite = { packageDir: string; component: string; dataDir: string };

function codeProcess({ packageDir, component, dataDir }: CodeSite, entry: string, secrets: Secrets) {
	const dir = join(packageDir, component);
	const lock = lockOf(packageDir);
	mkdirSync(filesDir(dataDir), { recursive: true });
	const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...secrets, PSA_MODULE_DATA: dataDir, ...(lock !== undefined && { PSA_MODULE_VENV: venvDir(dataDir, lock) }) };
	const args = ["--input-type=module", "-e", NODE_RUNNER, pathToFileURL(join(dir, entry)).href];
	return { args, options: { env, cwd: dir } };
}

function readReply(stdout: string, stderr: string, status: number | null, error: Error | undefined): CodeReply {
	const last = stdout.trim().split("\n").at(-1) ?? "";
	try {
		if (error === undefined && status === 0) return JSON.parse(last) as CodeReply;
	} catch {
		return { ok: false, note: `the last line of stdout was not a reply: ${last}` };
	}
	return { ok: false, note: (error?.message ?? stderr).trim().split("\n").slice(0, 3).join(" ") || `exit ${status}` };
}

export function runModuleCode(site: CodeSite, entry: string, input: unknown, secrets: Secrets = {}, { responses }: Pick<RunOptions, "responses"> = {}): CodeReply {
	const { args, options } = codeProcess(site, entry, secrets);
	const run = spawnSync(process.execPath, args, { ...options, timeout: LIMIT_MS, encoding: "utf8", input: JSON.stringify({ input, responses: replays(responses) }) });
	return readReply(run.stdout, run.stderr, run.status, run.error);
}

/** Node's "close" waits for every process holding the stdio pipes, so a grandchild could keep a call open forever. The tool's whole process group is SIGKILLed at the limit, past the stdout cap, or once the tool exits. */
export function runModuleCodeAsync(site: CodeSite, entry: string, input: unknown, secrets: Secrets = {}, { limitMs = LIMIT_MS, responses, signal }: RunOptions = {}): Promise<CodeReply> {
	const { args, options } = codeProcess(site, entry, secrets);
	return new Promise((done) => {
		const child = spawn(process.execPath, args, { ...options, detached: true });
		const killGroup = () => {
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				// macOS answers EPERM, not ESRCH, when the group holds only the not-yet-reaped tool.
				if (!["ESRCH", "EPERM"].includes((error as { code?: string }).code ?? "")) throw error;
			}
		};
		let stdout = "";
		let stderr = "";
		let stopped: string | undefined;
		const stop = (why: string) => {
			stopped ??= why;
			killGroup();
		};
		const timer = setTimeout(() => stop(`stopped at the limit of ${limitMs / 1000} s`), limitMs);
		const cancel = () => stop("stopped by the host (its feed was switched off, or the host is stopping)");
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			if (stopped !== undefined) return;
			stdout += chunk;
			if (stdout.length > STDOUT_CAP) stop(`stdout passed ${STDOUT_CAP / 1024 / 1024} MB, so the call was stopped`);
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
		// A child that dies before reading stdin breaks the pipe; its exit is the reply that counts.
		child.stdin.on("error", () => undefined);
		child.on("exit", killGroup);
		const finish = (reply: CodeReply) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			done(reply);
		};
		child.on("error", (error) => finish(readReply(stdout, stderr, null, error)));
		child.on("close", (status) => finish(readReply(stdout, stderr, status, stopped === undefined ? undefined : new Error(stopped))));
		child.stdin.end(JSON.stringify({ input, responses: replays(responses) }));
	});
}
