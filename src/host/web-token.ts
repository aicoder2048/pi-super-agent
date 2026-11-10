import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN = /^[0-9a-f]{64}$/;

export type TokenFile = "web-token" | "client-token";

export const tokenPath = (stateDir: string, file: TokenFile) => join(stateDir, file);

export function loadToken(stateDir: string, file: TokenFile, log: (line: string) => void): string {
	const path = tokenPath(stateDir, file);
	let text: string;
	try {
		text = readFileSync(path, "utf8").trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return writeToken(path);
	}
	if (!TOKEN.test(text)) return writeToken(path);
	const mode = statSync(path).mode & 0o777;
	if (mode & 0o077) {
		chmodSync(path, 0o600);
		log(`[host] ${path} 的权限是 ${mode.toString(8).padStart(4, "0")}，已收紧到 0600`);
	}
	return text;
}

export function removeToken(stateDir: string, file: TokenFile): void {
	rmSync(tokenPath(stateDir, file), { force: true });
}

export function tokenMatches(given: string, token: string): boolean {
	const got = Buffer.from(given);
	const want = Buffer.from(token);
	return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

// Created 0600 rather than chmod-ed afterwards, so the token is never readable by others even for a moment.
function writeToken(path: string): string {
	const token = randomBytes(32).toString("hex");
	const tmp = `${path}.tmp`;
	rmSync(tmp, { force: true });
	writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
	renameSync(tmp, path);
	return token;
}
