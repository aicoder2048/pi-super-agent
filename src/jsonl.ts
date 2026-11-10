import { readFileSync } from "node:fs";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";

// readline also splits on U+2028/U+2029, which are legal inside JSON strings.
export function onJsonLines(socket: Socket | Readable, handle: (record: Record<string, unknown>) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line.trim()) {
				let record: unknown;
				try {
					record = JSON.parse(line);
				} catch {
					socket.destroy(new Error(`收到无法解析的 JSON 行：${line.slice(0, 80)}`));
					return;
				}
				if (typeof record !== "object" || record === null || Array.isArray(record)) {
					socket.destroy(new Error(`收到的 JSON 行不是对象：${line.slice(0, 80)}`));
					return;
				}
				handle(record as Record<string, unknown>);
			}
			newline = buffer.indexOf("\n");
		}
	});
}

export function writeJsonLine(socket: Socket, record: unknown): void {
	if (!socket.destroyed) socket.write(JSON.stringify(record) + "\n");
}

export interface SessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string };
}

/** A Pi session file's entries. A process killed mid-write leaves an unterminated last line; Pi skips such lines when it reopens the session, and so do we. */
export function readSessionEntries(file: string): SessionEntry[] {
	return readFileSync(file, "utf8").split("\n").flatMap((line) => {
		if (!line) return [];
		try {
			return [JSON.parse(line) as SessionEntry];
		} catch {
			return [];
		}
	});
}
