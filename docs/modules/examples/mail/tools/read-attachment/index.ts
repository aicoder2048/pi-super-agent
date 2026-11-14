import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { decodeText, htmlToText, partsOf, type Attachment, type Part } from "../../feeds/inbox/message.ts";
import { accessToken, AUTH_TEXT, gmailClient, type Gmail, type Settings } from "../../google.ts";

type Input = { messageId: string; partId: string };

type Extracted = { text: string; pages: number | null; truncated: boolean; ocr?: { file: string } };

export type Result = { name: string; type: string; pages: number | null; text: string; truncated: boolean; ocr?: { file: string } };

/** The gateway gives a call 20 s: about 2 s for the token and messages.get, 10 s to download, 6 s for the PDF, 2 s spare. */
export const LIMITS = { maxBytes: 10 * 1024 * 1024, downloadMs: 10_000, pdfMs: 6_000, rssBytes: 512 * 1024 * 1024, pollMs: 250, maxChars: 100_000 };

export type Limits = typeof LIMITS;

const asText = (bytes: Buffer, part: Part): Extracted => plain(decodeText(bytes, part, "附件"));

type Reader = { extensions: readonly string[]; read: (bytes: Buffer, part: Part, limits: Limits) => Promise<Extracted> | Extracted };

const image = (extensions: readonly string[]): Reader => ({ extensions, read: (bytes, part) => forOcr(bytes, extensionOf(part), null) });

const READERS: Readonly<Record<string, Reader>> = {
	"text/plain": { extensions: [".txt", ".text"], read: asText },
	"text/markdown": { extensions: [".md", ".markdown"], read: asText },
	"text/csv": { extensions: [".csv"], read: asText },
	"text/html": { extensions: [".html", ".htm"], read: (bytes, part) => plain(htmlToText(decodeText(bytes, part, "附件"))) },
	"application/pdf": { extensions: [".pdf"], read: (bytes, _part, limits) => pdfText(bytes, limits) },
	"image/png": image([".png"]),
	"image/jpeg": image([".jpg", ".jpeg"]),
	"image/jpg": image([".jpg", ".jpeg"]),
	"image/heic": image([".heic"]),
	"image/heif": image([".heif"]),
	"image/tiff": image([".tif", ".tiff"]),
	"image/webp": image([".webp"]),
	"image/bmp": image([".bmp"]),
};

const PDF_SCRIPT = fileURLToPath(new URL("../../py/pdf_text.py", import.meta.url));
const FEED_JSON = fileURLToPath(new URL("../../feeds/inbox/feed.json", import.meta.url));
const TOO_BIG = "PDF 太大，读不了";
const SETUP = "mail 的 Python 环境还没装：在跑宿主的机器上跑 just module setup mail，见 docs/modules/mail.md";

const plain = (text: string): Extracted => ({ text, pages: null, truncated: false });

const extensionOf = (part: Part): string => {
	const filename = part.filename ?? "";
	return filename.includes(".") ? filename.toLowerCase().slice(filename.lastIndexOf(".")) : "";
};

function forOcr(bytes: Buffer, extension: string, pages: number | null): Extracted {
	const name = `ocr-${randomBytes(8).toString("hex")}${extension}`;
	writeFileSync(join(process.env["PSA_MODULE_DATA"] ?? "", "files", name), bytes);
	return { text: "", pages, truncated: false, ocr: { file: `files/${name}` } };
}

function parseInput(input: unknown): Input {
	const { messageId, partId } = (input ?? {}) as Record<string, unknown>;
	if (typeof messageId !== "string" || messageId === "" || typeof partId !== "string" || partId === "") throw new Error("要给 messageId 和 partId 两个文字：messages 里那一行的 gmailId 和它 attachments 里一项的 partId");
	return { messageId, partId };
}

/** Only letters the inbox feed stored (listed senders) can be read, and that is checked before any Gmail request. */
function stored({ messageId, partId }: Input): Attachment {
	const db = join(process.env["PSA_MODULE_DATA"] ?? "", "data.db");
	const notFound = new Error(`messages 里没有 gmailId 为 ${messageId} 的信`);
	if (!existsSync(db)) throw notFound;
	const reader = new DatabaseSync(db, { readOnly: true });
	try {
		const row = reader.prepare("SELECT attachments FROM messages WHERE gmailId = ? LIMIT 1").get(messageId) as { attachments: string | null } | undefined;
		if (row === undefined) throw notFound;
		const attachments = JSON.parse(row.attachments ?? "[]") as Attachment[];
		const found = attachments.find((a) => a.partId === partId);
		if (found === undefined) throw new Error(`这封信没有 partId 为 ${partId} 的附件，它的附件 partId 有：${attachments.map((a) => a.partId).join("、") || "（没有附件）"}`);
		return found;
	} finally {
		reader.close();
	}
}

/** Clients such as QQ Mail label every attachment with one of these, so the extension picks the reader. */
const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-download"]);

function readerFor(part: Part): Reader {
	const filename = part.filename ?? "";
	const mimeType = (part.mimeType ?? "").toLowerCase();
	const extension = extensionOf(part);
	const generic = GENERIC.has(mimeType);
	const reader = generic ? Object.values(READERS).find((r) => r.extensions.includes(extension)) : READERS[mimeType];
	if (reader === undefined || !reader.extensions.includes(extension)) throw new Error(`这个附件是 ${part.mimeType}（${filename}），只读 txt、md、csv、html、pdf 和图片（png、jpg、heic、tiff、webp、bmp）`);
	if (!generic || reader !== READERS["application/pdf"]) return reader;
	return {
		...reader,
		read: (bytes, part, limits) => {
			if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error(`${filename} 不是 PDF：开头没有 %PDF-`);
			return reader.read(bytes, part, limits);
		},
	};
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

/** macOS cannot cap a child's memory with setrlimit, so its RSS is polled. */
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
		let checking = false;
		const poll = setInterval(async () => {
			if (checking || child.pid === undefined) return;
			checking = true;
			if ((await rssBytes(child.pid)) > limits.rssBytes) stop(TOO_BIG);
			checking = false;
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
			if (reply.error === "too-big") return fail(new Error(TOO_BIG));
			if (typeof reply.text !== "string") return fail(new Error("PDF 读不出来，文件可能坏了"));
			done(reply.scan === true ? { ...forOcr(bytes, ".pdf", reply.pages), truncated: reply.truncated === true } : { text: reply.text, pages: reply.pages, truncated: reply.truncated === true });
		});
	});
}

/** Counts code points without spreading a 10 MB string into an array. */
function clip(text: string, maxChars: number): { text: string; clipped: boolean } {
	for (let i = 0, count = 0; i < text.length; count++) {
		if (count === maxChars) return { text: text.slice(0, i), clipped: true };
		i += text.codePointAt(i)! > 0xffff ? 2 : 1;
	}
	return { text, clipped: false };
}

export async function readAttachment(input: unknown, limits: Limits = LIMITS): Promise<Result> {
	const ids = parseInput(input);
	const entry = stored(ids);
	const settings: Settings = JSON.parse(readFileSync(FEED_JSON, "utf8")).settings;
	const token = await accessToken(settings);
	if (token === undefined) throw new Error(AUTH_TEXT);
	const { part, bytes, reader } = await download(gmailClient(settings.baseUrl, token), ids, limits);
	const extracted = await reader.read(bytes, part, limits);
	const { text, clipped } = clip(extracted.text, limits.maxChars);
	return { name: part.filename ?? entry.filename, type: part.mimeType ?? entry.mimeType, pages: extracted.pages, text, truncated: extracted.truncated || clipped, ...(extracted.ocr && { ocr: extracted.ocr }) };
}

export default (input: unknown) => readAttachment(input);
