/** The few Node declarations src/modules/ and its tests need, so it type-checks with no dependencies. */
declare module "node:fs" {
	export interface Dirent {
		name: string;
		isDirectory(): boolean;
		isFile(): boolean;
	}
	export function existsSync(path: string): boolean;
	export function readFileSync(path: string): Uint8Array;
	export function readFileSync(path: string, encoding: "utf8"): string;
	export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
	export function readdirSync(path: string): string[];
	export function readdirSync(path: string, options: { recursive: true }): string[];
	export function statSync(path: string): { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean };
	export function realpathSync(path: string): string;
	export function mkdirSync(path: string, options: { recursive: true }): void;
	export function copyFileSync(from: string, to: string): void;
	export function renameSync(from: string, to: string): void;
	export const constants: { COPYFILE_FICLONE: number };
	export function cpSync(from: string, to: string, options: { recursive: true; mode?: number; filter?(path: string): boolean }): void;
	export function symlinkSync(target: string, path: string): void;
	export function mkdtempSync(prefix: string): string;
	export function writeFileSync(path: string, content: string): void;
	export function rmSync(path: string, options: { recursive?: true; force: true }): void;
	export interface FSWatcher {
		close(): void;
		on(event: "error", listener: (error: Error) => void): this;
	}
	export function watch(path: string, options: { recursive: true }, listener: (event: string, filename: string | null) => void): FSWatcher;
}
declare module "node:sqlite" {
	export type SQLInputValue = null | number | bigint | string;
	export interface StatementSync {
		run(...values: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
		get(...values: SQLInputValue[]): unknown;
		all(...values: SQLInputValue[]): unknown[];
	}
	export class DatabaseSync {
		constructor(path: string, options?: { readOnly: boolean });
		exec(sql: string): void;
		prepare(sql: string): StatementSync;
		close(): void;
		readonly isOpen: boolean;
	}
}
declare module "node:os" {
	export function tmpdir(): string;
}
declare module "node:path" {
	export function basename(path: string, suffix?: string): string;
	export function dirname(path: string): string;
	export function join(...parts: string[]): string;
	export function resolve(...parts: string[]): string;
}
declare module "node:url" {
	export function pathToFileURL(path: string): { href: string };
	export function fileURLToPath(url: string): string;
}
declare module "node:buffer" {
	export const Buffer: { from(text: string, encoding?: "utf8" | "base64"): { toString(encoding?: "utf8" | "base64url"): string }; byteLength(text: string): number };
}
declare module "node:crypto" {
	export interface Hash {
		update(data: string | Uint8Array): Hash;
		digest(encoding: "hex"): string;
	}
	export function createHash(algorithm: "sha256"): Hash;
	export function randomUUID(): string;
}
declare module "node:child_process" {
	export function spawnSync(
		command: string,
		args: readonly string[],
		options: { encoding: "utf8"; timeout: number; env: Readonly<Record<string, string>>; cwd: string; input: string },
	): { status: number | null; stdout: string; stderr: string; error?: Error };
	interface Readable {
		setEncoding(encoding: "utf8"): { on(event: "data", listener: (chunk: string) => void): void };
	}
	export interface ChildProcess {
		pid?: number;
		stdout: Readable;
		stderr: Readable;
		stdin: { on(event: "error", listener: () => void): void; end(data: string): void };
		on(event: "error", listener: (error: Error) => void): void;
		on(event: "exit", listener: () => void): void;
		on(event: "close", listener: (status: number | null, signal: string | null) => void): void;
	}
	export function spawn(command: string, args: readonly string[], options: { detached: boolean; env: Readonly<Record<string, string>>; cwd: string }): ChildProcess;
}
declare module "node:test" {
	export function test(name: string, run: () => void | Promise<void>): void;
}
declare module "node:assert/strict" {
	const assert: {
		(value: unknown, message?: string): asserts value;
		equal(actual: unknown, expected: unknown, message?: string): void;
		deepEqual(actual: unknown, expected: unknown, message?: string): void;
	};
	export default assert;
}
interface ImportMeta {
	url: string;
}
declare const process: {
	pid: number;
	argv: string[];
	execPath: string;
	exitCode: number | undefined;
	env: Record<string, string | undefined>;
	kill(pid: number, signal: string): void;
	once(event: "exit", listener: () => void): void;
};
declare interface AbortSignal {
	readonly aborted: boolean;
	addEventListener(type: "abort", listener: () => void, options?: { once: true }): void;
	removeEventListener(type: "abort", listener: () => void): void;
}
declare const AbortSignal: { timeout(ms: number): AbortSignal };
declare class URLSearchParams {
	constructor(init: Record<string, string>);
}
declare function fetch(url: string, init: { method: "POST"; body: string | URLSearchParams; headers?: Record<string, string>; redirect: "error"; signal: AbortSignal }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
declare class AbortController {
	readonly signal: AbortSignal;
	abort(): void;
}
declare function setTimeout(run: () => void, ms: number): unknown;
declare function clearTimeout(timer: unknown): void;
declare function setInterval(run: () => void, ms: number): { unref(): void };
declare function clearInterval(timer: unknown): void;
declare const console: {
	log(line: string): void;
};
