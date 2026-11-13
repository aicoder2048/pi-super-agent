/**
 * The whole contract between the host and a module's code: one fresh process per call, the
 * call as one JSON line on stdin, the reply as the last line of stdout. The process is an
 * ordinary one. Its working directory is the component's folder, and its environment is
 * `PATH` and `HOME` plus the secrets the descriptor names.
 */
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FeedFixture } from "./manifest.ts";
import type { Json } from "./protocol.ts";

const NODE_RUNNER = `
let text = "";
for await (const chunk of process.stdin) text += chunk;
const call = JSON.parse(text);
if (call.responses) {
	globalThis.fetch = async (url) => {
		const key = String(url?.url ?? url);
		if (!Object.hasOwn(call.responses, key)) throw new Error("the fixture has no response for " + key);
		const body = call.responses[key];
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { headers: { "content-type": "application/json" } });
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

export type RunOptions = { limitMs?: number; responses?: Responses };

export type SecretLookup = (name: string) => string | undefined;

export const secretsFor = (names: readonly string[], secret: SecretLookup): Secrets => Object.fromEntries(names.map((name) => [name, secret(name) ?? ""]));

function codeProcess(dir: string, entry: string, secrets: Secrets) {
	const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...secrets };
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

export function runModuleCode(dir: string, entry: string, input: unknown, secrets: Secrets = {}, { responses }: Pick<RunOptions, "responses"> = {}): CodeReply {
	const { args, options } = codeProcess(dir, entry, secrets);
	const run = spawnSync(process.execPath, args, { ...options, timeout: LIMIT_MS, encoding: "utf8", input: JSON.stringify({ input, responses }) });
	return readReply(run.stdout, run.stderr, run.status, run.error);
}

/** Node's "close" waits for every process holding the stdio pipes, so a grandchild could keep a call open forever. The tool's whole process group is SIGKILLed at the limit, past the stdout cap, or once the tool exits. */
export function runModuleCodeAsync(dir: string, entry: string, input: unknown, secrets: Secrets = {}, { limitMs = LIMIT_MS, responses }: RunOptions = {}): Promise<CodeReply> {
	const { args, options } = codeProcess(dir, entry, secrets);
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
			done(reply);
		};
		child.on("error", (error) => finish(readReply(stdout, stderr, null, error)));
		child.on("close", (status) => finish(readReply(stdout, stderr, status, stopped === undefined ? undefined : new Error(stopped))));
		child.stdin.end(JSON.stringify({ input, responses }));
	});
}
