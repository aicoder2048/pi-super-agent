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
	export function mkdirSync(path: string, options: { recursive: true }): void;
	export function copyFileSync(from: string, to: string): void;
	export function renameSync(from: string, to: string): void;
	export function mkdtempSync(prefix: string): string;
	export function writeFileSync(path: string, content: string): void;
	export function rmSync(path: string, options: { recursive: true; force: true }): void;
	export interface FSWatcher {
		close(): void;
		on(event: "error", listener: (error: Error) => void): this;
	}
	export function watch(path: string, options: { recursive: true }, listener: (event: string, filename: string | null) => void): FSWatcher;
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
	export function spawnSync(
		command: string,
		args: readonly string[],
		options: { encoding: "utf8"; timeout: number; env: Readonly<Record<string, string>>; cwd: string; input: string },
	): { status: number | null; stdout: string; stderr: string; error?: Error };
	interface Readable {
		setEncoding(encoding: "utf8"): { on(event: "data", listener: (chunk: string) => void): void };
	}
	export interface ChildProcess {
		stdout: Readable;
		stderr: Readable;
		stdin: { on(event: "error", listener: () => void): void; end(data: string): void };
		on(event: "error", listener: (error: Error) => void): void;
		on(event: "close", listener: (status: number | null, signal: string | null) => void): void;
	}
	export function spawn(command: string, args: readonly string[], options: { timeout: number; env: Readonly<Record<string, string>>; cwd: string }): ChildProcess;
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
	argv: string[];
	execPath: string;
	exitCode: number | undefined;
	env: Record<string, string | undefined>;
};
declare function setTimeout(run: () => void, ms: number): unknown;
declare function clearTimeout(timer: unknown): void;
declare const console: {
	log(line: string): void;
};
