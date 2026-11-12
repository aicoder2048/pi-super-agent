/** The few Node declarations the sketch needs, so it type-checks with no dependencies. */
declare module "node:fs" {
	export interface Dirent {
		name: string;
		isDirectory(): boolean;
		isFile(): boolean;
		isSymbolicLink(): boolean;
	}
	export function existsSync(path: string): boolean;
	export function readFileSync(path: string): Uint8Array;
	export function readFileSync(path: string, encoding: "utf8"): string;
	export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
	export function realpathSync(path: string): string;
	export function mkdtempSync(prefix: string): string;
	export function mkdirSync(path: string, options: { recursive: true }): void;
	export function copyFileSync(from: string, to: string): void;
	export function rmSync(path: string, options: { recursive: true; force: true }): void;
	export function writeFileSync(path: string, content: string): void;
}
declare module "node:os" {
	export function tmpdir(): string;
}
declare module "node:path" {
	export function basename(path: string): string;
	export function dirname(path: string): string;
	export function join(...parts: string[]): string;
	export function resolve(...parts: string[]): string;
}
declare module "node:url" {
	export function pathToFileURL(path: string): { href: string };
	export function fileURLToPath(url: string): string;
}
declare module "node:crypto" {
	export interface Hash {
		update(data: string | Uint8Array): Hash;
		digest(encoding: "hex"): string;
	}
	export function createHash(algorithm: "sha256"): Hash;
}
declare module "node:child_process" {
	export interface SpawnSyncResult {
		status: number | null;
		stdout: string;
		stderr: string;
		error?: Error;
	}
	export function spawnSync(
		command: string,
		args: readonly string[],
		options: { encoding: "utf8"; timeout: number; env: Readonly<Record<string, string>>; cwd: string },
	): SpawnSyncResult;
}
declare module "node:test" {
	export function test(name: string, run: () => void | Promise<void>): void;
}
declare module "node:assert/strict" {
	const assert: {
		(value: unknown, message?: string): asserts value;
		equal(actual: unknown, expected: unknown, message?: string): void;
		notEqual(actual: unknown, expected: unknown, message?: string): void;
		deepEqual(actual: unknown, expected: unknown, message?: string): void;
	};
	export default assert;
}
interface ImportMeta {
	url: string;
}
declare class TextEncoder {
	encode(text: string): Uint8Array;
}
declare const process: {
	argv: string[];
	execPath: string;
	exitCode: number | undefined;
};
declare const console: {
	log(line: string): void;
};
