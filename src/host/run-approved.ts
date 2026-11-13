import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, fstatSync } from "node:fs";
import { RUN_TAIL_MAX } from "../kernel/run-ask.ts";
import { workerEnv } from "./pi-worker.ts";

const SECRET_NAME = /(_TOKEN|_SECRET|_PASSWORD|_KEY)$/i;

export function approvedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	return Object.fromEntries(Object.entries(workerEnv(env)).filter(([name, value]) => value !== undefined && !SECRET_NAME.test(name)));
}

export interface ApprovedRun {
	done: Promise<{ exitCode: number | null; timedOut: boolean; tail: string }>;
	kill(): void;
}

/** Runs `command` once in its own process group, so the time limit and kill() reach what it left in the background too. */
export function runApproved({ command, cwd, env, outputFile, timeoutMs }: { command: string; cwd: string; env: Record<string, string>; outputFile: string; timeoutMs: number }): ApprovedRun {
	const out = openSync(outputFile, "a");
	const child = spawn("bash", ["-lc", command], { cwd, env, detached: true, stdio: ["ignore", out, out] });
	closeSync(out);
	const killGroup = () => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		} catch {}
	};
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killGroup();
	}, timeoutMs);
	const done = new Promise<{ exitCode: number | null; timedOut: boolean; tail: string }>((resolve) => {
		const finish = (exitCode: number | null, failure?: Error) => {
			clearTimeout(timer);
			const tail = tailOf(outputFile);
			resolve({ exitCode, timedOut, tail: failure ? `${tail}\n宿主没能启动 bash：${failure.message}` : tail });
		};
		child.once("error", (error) => finish(null, error));
		child.once("exit", (code) => finish(timedOut ? null : code));
	});
	return { done, kill: killGroup };
}

function tailOf(file: string): string {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return "";
	}
	try {
		const { size } = fstatSync(fd);
		// A character is at most 4 bytes, so this many bytes from the end hold the last RUN_TAIL_MAX characters.
		const length = Math.min(size, RUN_TAIL_MAX * 4);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return buffer.toString("utf8").slice(-RUN_TAIL_MAX);
	} finally {
		closeSync(fd);
	}
}
