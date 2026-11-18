/**
 * Reading the assistant's answers aloud (ADR-0033): edge-tts with the 晓伊 voice, one sentence per request. The user chose it on
 * 2026-11-18 knowing the text, numbers included, goes to Microsoft's service. Results are cached by voice and text.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VOICE = "zh-CN-XiaoyiNeural";
export const SPEAK_MAX_CHARS = 400;
const SYNTH_TIMEOUT_MS = 30_000;

const loaded = JSON.parse(readFileSync(new URL("./pronounce.json", import.meta.url), "utf8")) as Record<string, string>;
export const PRONOUNCE: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(loaded).filter(([k]) => !k.startsWith("_")));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole words only: a word next to another letter is part of a longer word and stays; next to a digit it still changes (HV20). */
export function pronounced(text: string, table: Readonly<Record<string, string>> = PRONOUNCE): string {
	const words = Object.keys(table).sort((a, b) => b.length - a.length);
	if (words.length === 0) return text;
	const pattern = new RegExp(`(?<![A-Za-z])(${words.map(escape).join("|")})(?![A-Za-z])`, "g");
	return text.replace(pattern, (word) => table[word] ?? word);
}

/** Returns the mp3 bytes, or null when it could not. */
export type Synthesize = (text: string, voice: string) => Promise<Buffer | null>;

/** `command` runs as `<command…> --voice V --text T --write-media F`. The old Mac's uv shim needs `realpath`, which it lacks, so it goes through python -m. */
export function edgeTts(command: readonly string[] = ["uvx", "--from", "edge-tts", "python", "-m", "edge_tts"], log: (line: string) => void = () => {}): Synthesize {
	return (text, voice) =>
		new Promise((resolve) => {
			const dir = mkdtempSync(join(tmpdir(), "psa-tts-"));
			const file = join(dir, "out.mp3");
			const child = spawn(command[0]!, [...command.slice(1), "--voice", voice, "--text", text, "--write-media", file], { stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.on("data", (c) => (stderr += String(c)));
			const timer = setTimeout(() => child.kill("SIGKILL"), SYNTH_TIMEOUT_MS);
			const done = (bytes: Buffer | null) => {
				clearTimeout(timer);
				rmSync(dir, { recursive: true, force: true });
				resolve(bytes);
			};
			child.on("error", (error) => {
				log(`[assistant] 语音合成起不来：${error.message}`);
				done(null);
			});
			child.on("close", (code) => {
				const ok = code === 0 && existsSync(file);
				if (!ok) log(`[assistant] 语音合成失败（退出码 ${code}）：${stderr.trim().split("\n").at(-1) ?? ""}`);
				done(ok ? readFileSync(file) : null);
			});
		});
}

/** The host's table, overridden and extended by `<stateDir>/pronounce.json` when there is one: tickers and other private words stay off the repo. */
export function pronounceTable(privateFile: string | undefined): Record<string, string> {
	if (privateFile === undefined || !existsSync(privateFile)) return { ...PRONOUNCE };
	try {
		const own = JSON.parse(readFileSync(privateFile, "utf8")) as Record<string, unknown>;
		return { ...PRONOUNCE, ...Object.fromEntries(Object.entries(own).filter((e): e is [string, string] => !e[0].startsWith("_") && typeof e[1] === "string")) };
	} catch {
		return { ...PRONOUNCE };
	}
}

export class Speech {
	readonly #o: { dir: string; voice: string; synthesize: Synthesize; table: () => Readonly<Record<string, string>> };

	/** `table` is read for every sentence, so an edit of the private table takes effect at once. */
	constructor(options: { dir: string; voice?: string; synthesize: Synthesize; table?: () => Readonly<Record<string, string>> }) {
		this.#o = { voice: VOICE, table: () => PRONOUNCE, ...options };
	}

	async speak(text: string): Promise<Buffer | null> {
		const said = pronounced(text.trim(), this.#o.table());
		if (said === "" || [...said].length > SPEAK_MAX_CHARS) return null;
		const file = join(this.#o.dir, `${createHash("sha256").update(`${this.#o.voice}\n${said}`).digest("hex")}.mp3`);
		if (existsSync(file)) return readFileSync(file);
		const bytes = await this.#o.synthesize(said, this.#o.voice);
		if (bytes === null || bytes.length === 0) return null;
		mkdirSync(this.#o.dir, { recursive: true, mode: 0o700 });
		writeFileSync(file, bytes, { mode: 0o600 });
		return bytes;
	}
}
