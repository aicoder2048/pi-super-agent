import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { htmlToText } from "../../feeds/inbox/message.ts";
import { accessToken, AUTH_TEXT, gmailClient, type Gmail, type Settings } from "../../google.ts";

type Input = { messageId: string; partId: string };

/** One entry of a `messages` row's `attachments` JSON, as the inbox feed stores it. */
type Listed = { partId: string; filename: string; mimeType: string; size: number };

type Part = { partId?: string; mimeType?: string; filename?: string; body?: { size?: number; attachmentId?: string }; parts?: Part[] };

type Extracted = { text: string; pages: number | null; truncated: boolean };

export type Result = { name: string; type: string; pages: number | null; text: string; truncated: boolean };

export type Limits = { maxBytes: number; downloadMs: number; pdfMs: number; rssBytes: number; pollMs: number; maxChars: number };

/** The gateway gives a call 20 s: about 2 s for the token and messages.get, 10 s to download, 6 s for the PDF, 2 s spare. */
export const LIMITS: Limits = { maxBytes: 10 * 1024 * 1024, downloadMs: 10_000, pdfMs: 6_000, rssBytes: 512 * 1024 * 1024, pollMs: 250, maxChars: 100_000 };

type Reader = { extensions: readonly string[]; read: (bytes: Buffer, limits: Limits) => Promise<Extracted> | Extracted };

/** A type is read only when its MIME type and the file's extension agree. */
const READERS: Readonly<Record<string, Reader>> = {
	"text/plain": { extensions: [".txt", ".text"], read: (bytes) => plain(utf8(bytes)) },
	"text/markdown": { extensions: [".md", ".markdown"], read: (bytes) => plain(utf8(bytes)) },
	"text/csv": { extensions: [".csv"], read: (bytes) => plain(utf8(bytes)) },
	"text/html": { extensions: [".html", ".htm"], read: (bytes) => plain(htmlToText(utf8(bytes))) },
	"application/pdf": { extensions: [".pdf"], read: (bytes, limits) => pdfText(bytes, limits) },
};

const PDF_SCRIPT = fileURLToPath(new URL("../../py/pdf_text.py", import.meta.url));
const FEED_JSON = fileURLToPath(new URL("../../feeds/inbox/feed.json", import.meta.url));
const SETUP = "mail 的 Python 环境还没装：在跑宿主的机器上跑 just module setup mail，见 docs/modules/mail.md";

/** Bytes that are not UTF-8 become U+FFFD, and a leading BOM is dropped. */
const utf8 = (bytes: Buffer) => new TextDecoder("utf-8").decode(bytes);

const plain = (text: string): Extracted => ({ text, pages: null, truncated: false });

function parseInput(input: unknown): Input {
	const { messageId, partId } = (input ?? {}) as Record<string, unknown>;
	if (typeof messageId !== "string" || messageId === "" || typeof partId !== "string" || partId === "") throw new Error("要给 messageId 和 partId 两个文字：messages 里那一行的 gmailId 和它 attachments 里一项的 partId");
	return { messageId, partId };
}

/** The only module data read is this one row's attachment list, so an unknown id is refused before any request. */
function listed({ messageId, partId }: Input): Listed {
	const db = join(process.env["PSA_MODULE_DATA"] ?? "", "data.db");
	const notFound = new Error(`messages 里没有 gmailId 为 ${messageId} 的信`);
	if (!existsSync(db)) throw notFound;
	const reader = new DatabaseSync(db, { readOnly: true });
	try {
		const row = reader.prepare("SELECT attachments FROM messages WHERE gmailId = ? LIMIT 1").get(messageId) as { attachments: string | null } | undefined;
		if (row === undefined) throw notFound;
		const attachments = JSON.parse(row.attachments ?? "[]") as Listed[];
		const found = attachments.find((a) => a.partId === partId);
		if (found === undefined) throw new Error(`这封信没有 partId 为 ${partId} 的附件，它的附件 partId 有：${attachments.map((a) => a.partId).join("、") || "（没有附件）"}`);
		return found;
	} finally {
		reader.close();
	}
}

const partsOf = (part: Part | undefined): Part[] => (part === undefined ? [] : [part, ...(part.parts ?? []).flatMap(partsOf)]);

function readerFor(part: Part): Reader {
	const filename = part.filename ?? "";
	const reader = READERS[(part.mimeType ?? "").toLowerCase()];
	const extension = filename.includes(".") ? filename.toLowerCase().slice(filename.lastIndexOf(".")) : "";
	if (reader === undefined || !reader.extensions.includes(extension)) throw new Error(`这个附件是 ${part.mimeType}（${filename}），只读 txt、md、csv、html、pdf`);
	return reader;
}

/** Gmail's attachmentId may change between two messages.get calls, so the part is looked up afresh each time. */
async function download(gmail: Gmail, { messageId, partId }: Input, limits: Limits): Promise<{ part: Part; bytes: Buffer; reader: Reader }> {
	const path = `/messages/${encodeURIComponent(messageId)}`;
	const message = await gmail(path, { format: "full" });
	if (message.status === 404) throw new Error("这封信在 Gmail 里已经删了");
	if (message.status !== 200) throw new Error(`Gmail ${path} 返回 HTTP ${message.status}`);
	const part = partsOf(message.body?.payload).find((p) => p.partId === partId && p.body?.attachmentId);
	if (part === undefined) throw new Error(`Gmail 里这封信已经没有 partId 为 ${partId} 的附件`);
	const reader = readerFor(part);
	const size = part.body?.size ?? 0;
	if (size > limits.maxBytes) throw new Error(`附件有 ${(size / 1024 / 1024).toFixed(1)} MB，超过 ${limits.maxBytes / 1024 / 1024} MB，不下载`);
	try {
		const got = await gmail(`${path}/attachments/${encodeURIComponent(part.body!.attachmentId!)}`, {}, AbortSignal.timeout(limits.downloadMs));
		if (got.status !== 200 || typeof got.body?.data !== "string") throw new Error(`Gmail 的附件接口返回 HTTP ${got.status}`);
		return { part, bytes: Buffer.from(got.body.data, "base64url"), reader };
	} catch (error) {
		if ((error as Error).name === "TimeoutError") throw new Error("附件下载超时");
		throw error;
	}
}

const rssBytes = (pid: number) => new Promise<number>((done) => execFile("ps", ["-o", "rss=", "-p", String(pid)], (error, out) => done(error ? 0 : Number(out.trim()) * 1024)));

/**
 * The PDF reaches a fresh Python process on stdin, so it never touches disk. The process gets only `PATH` and
 * `PSA_MODULE_VENV`, never the module's secrets. macOS cannot cap its memory with setrlimit, so its RSS is polled.
 */
function pdfText(bytes: Buffer, limits: Limits): Promise<Extracted> {
	const venv = process.env["PSA_MODULE_VENV"] ?? "";
	if (venv === "" || !existsSync(join(venv, ".psa-lock"))) throw new Error(SETUP);
	const child = spawn(join(venv, "bin/python"), ["-I", PDF_SCRIPT], { env: { PATH: process.env["PATH"] ?? "", PSA_MODULE_VENV: venv }, stdio: ["pipe", "pipe", "ignore"] });
	return new Promise((done, fail) => {
		let stdout = "";
		let stopped: string | undefined;
		const stop = (why: string) => {
			stopped ??= why;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => stop(`PDF 太复杂，${limits.pdfMs / 1000} 秒内读不完`), limits.pdfMs);
		const poll = setInterval(async () => {
			if (child.pid !== undefined && (await rssBytes(child.pid)) > limits.rssBytes) stop("PDF 太大，读不了");
		}, limits.pollMs);
		const settle = () => {
			clearTimeout(timer);
			clearInterval(poll);
		};
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stdin.on("error", () => undefined);
		child.stdin.end(bytes);
		child.on("error", (error) => {
			settle();
			fail(new Error(`${SETUP}（${error.message}）`));
		});
		child.on("close", () => {
			settle();
			if (stopped !== undefined) return fail(new Error(stopped));
			const reply = JSON.parse(stdout.trim().split("\n").at(-1) || "{}");
			if (reply.error === "encrypted") return fail(new Error("PDF 有密码，读不了"));
			if (reply.error === "too-big") return fail(new Error("PDF 太大，读不了"));
			if (typeof reply.text !== "string") return fail(new Error("PDF 读不出来，文件可能坏了"));
			done({ text: reply.text, pages: reply.pages, truncated: reply.truncated === true });
		});
	});
}

function clip(text: string, maxChars: number): { text: string; clipped: boolean } {
	const chars = [...text];
	return chars.length <= maxChars ? { text, clipped: false } : { text: chars.slice(0, maxChars).join(""), clipped: true };
}

export async function readAttachment(input: unknown, limits: Limits = LIMITS): Promise<Result> {
	const ids = parseInput(input);
	const entry = listed(ids);
	const settings: Settings = JSON.parse(readFileSync(FEED_JSON, "utf8")).settings;
	const token = await accessToken(settings);
	if (token === undefined) throw new Error(AUTH_TEXT);
	const { part, bytes, reader } = await download(gmailClient(settings.baseUrl, token), ids, limits);
	const extracted = await reader.read(bytes, limits);
	const { text, clipped } = clip(extracted.text, limits.maxChars);
	return { name: part.filename ?? entry.filename, type: part.mimeType ?? entry.mimeType, pages: extracted.pages, text, truncated: extracted.truncated || clipped };
}

export default (input: unknown) => readAttachment(input);
