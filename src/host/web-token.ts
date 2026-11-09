import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN = /^[0-9a-f]{64}$/;

export const webTokenPath = (stateDir: string) => join(stateDir, "web-token");

// Reused across restarts so an open page reconnects by itself after the watchdog restarts the host.
export function loadWebToken(stateDir: string, log: (line: string) => void): string {
	const path = webTokenPath(stateDir);
	let text: string;
	try {
		text = readFileSync(path, "utf8").trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return writeWebToken(path);
	}
	if (!TOKEN.test(text)) return writeWebToken(path);
	const mode = statSync(path).mode & 0o777;
	if (mode & 0o077) {
		chmodSync(path, 0o600);
		log(`[host] ${path} 的权限是 ${mode.toString(8).padStart(4, "0")}，已收紧到 0600`);
	}
	return text;
}

export function removeWebToken(stateDir: string): void {
	rmSync(webTokenPath(stateDir), { force: true });
}

// Created 0600 rather than chmod-ed afterwards, so the token is never readable by others even for a moment.
function writeWebToken(path: string): string {
	const token = randomBytes(32).toString("hex");
	const tmp = `${path}.tmp`;
	rmSync(tmp, { force: true });
	writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
	renameSync(tmp, path);
	return token;
}
