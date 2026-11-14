import { realpathSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { averageConfidence, OCR_OFF, pagesText, type Ocr } from "../ocr/result.ts";
import { filesDir } from "./files.ts";
import type { Json } from "./protocol.ts";

const NOT_IN_FILES = "要 OCR 的文件要直接放在模块数据的 files/ 下面，写成 files/<文件名>";

/** Venvs also live in `files/`; only a regular file directly in it qualifies. */
function namedFile(dataDir: string, file: unknown): string | undefined {
	if (typeof file !== "string") return undefined;
	try {
		const real = realpathSync(resolve(dataDir, file));
		return dirname(real) === realpathSync(filesDir(dataDir)) && statSync(real).isFile() ? real : undefined;
	} catch {
		return undefined;
	}
}

/** A tool that read some text itself (a PDF with only some pages scanned) gets that text back with the reason instead of a refusal. */
function fallBack(rest: { readonly [key: string]: Json }, why: string): { output: Json } | string {
	if (typeof rest["text"] !== "string" || rest["text"].trim() === "") return why;
	return { output: { ...rest, ocr: { failed: `${why}。text 只有工具不用 OCR 读出的字，扫描的部分没读出来` } } };
}

export async function readForTool(ocr: Ocr | undefined, dataDir: string, output: Json): Promise<{ output: Json } | string> {
	if (output === null || typeof output !== "object" || Array.isArray(output) || !("ocr" in output)) return { output };
	const { ocr: asked, ...rest } = output as { readonly [key: string]: Json };
	const file = namedFile(dataDir, (asked as { file?: unknown } | null)?.file);
	if (file === undefined) return NOT_IN_FILES;
	try {
		if (ocr === undefined) return fallBack(rest, OCR_OFF);
		const read = await ocr.read(file);
		const done = {
			engine: read.engine,
			pagesRead: read.pages.length,
			totalPages: read.totalPages,
			seconds: Math.round(read.seconds * 10) / 10,
			confidence: averageConfidence(read.pages),
			notes: [...read.notes],
		};
		return { output: { ...rest, text: pagesText(read.pages), truncated: rest["truncated"] === true || read.truncated, ocr: done } };
	} catch (error) {
		return fallBack(rest, `OCR 没读成：${(error as Error).message}`);
	} finally {
		rmSync(file, { force: true });
	}
}
