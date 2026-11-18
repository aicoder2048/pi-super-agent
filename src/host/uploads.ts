/**
 * Files the user uploads on the web page (ADR-0032). They stay in `<stateDir>/uploads/`, never leave this computer, and a module
 * tool with `fetch: "upload.file"` gets a copy for one call by the upload's id.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fetched } from "../modules/connectors/attachment.ts";
import type { Json } from "../modules/protocol.ts";

/** The same bound as a mail attachment a tool fetches. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_ID = /^up-[0-9a-f]{12}$/;
const NAME_MAX_CHARS = 200;

export type Upload = { id: string; name: string; type: string; size: number; at: number };

const dirOf = (stateDir: string) => join(stateDir, "uploads");

/** The last path segment without control characters: the name is shown and handed to tools, never used as a path. */
function cleanName(name: string): string {
	const last = name.split(/[/\\]/).pop() ?? "";
	const clean = [...last.replace(/[\u0000-\u001f\u007f]/g, "").trim()].slice(0, NAME_MAX_CHARS).join("");
	return clean === "" ? "未命名" : clean;
}

export function saveUpload(stateDir: string, { name, type, bytes, at }: { name: string; type: string; bytes: Buffer; at: number }): Upload {
	const dir = dirOf(stateDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const upload: Upload = { id: `up-${randomBytes(6).toString("hex")}`, name: cleanName(name), type: type.trim(), size: bytes.length, at };
	writeFileSync(join(dir, upload.id), bytes, { mode: 0o600, flag: "wx" });
	writeFileSync(join(dir, `${upload.id}.json`), JSON.stringify(upload), { mode: 0o600, flag: "wx" });
	return upload;
}

export function findUpload(stateDir: string, id: string): { upload: Upload; file: string } | undefined {
	if (!UPLOAD_ID.test(id)) return undefined;
	const file = join(dirOf(stateDir), id);
	const meta = `${file}.json`;
	if (!existsSync(file) || !existsSync(meta)) return undefined;
	return { upload: JSON.parse(readFileSync(meta, "utf8")) as Upload, file };
}

/** `fetch: "upload.file"`. A string is the refusal the caller sees. */
export function fetchUpload(stateDir: string, input: Json, dir: string): Fetched | string {
	const id = (input as Record<string, unknown> | null)?.["upload_id"];
	if (typeof id !== "string" || id === "") return "要给 upload_id：使用者那句话里「附件：…（上传编号 up-…）」的编号";
	const found = findUpload(stateDir, id);
	if (found === undefined) return `没有上传编号为 ${id} 的文件：先核对任务说明里「附件：…」那一行的上传编号，原样再试；编号对上了还是没有，再请使用者在网页上用附件按钮重新上传`;
	const file = join(dir, "upload");
	copyFileSync(found.file, file);
	const { name, type, size } = found.upload;
	return { file, filename: name, mimeType: type.split(";")[0]!.trim(), contentType: type, size };
}
