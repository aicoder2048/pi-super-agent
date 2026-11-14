import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OCR_OFF, type Ocr, type OcrPage } from "./result.ts";

export type OcrLimits = { maxPages: number; timeoutSeconds: number };

export type OcrConfig = { engine: "off" } | ({ engine: "vision" } & OcrLimits) | ({ engine: "unlimited"; home: string } & OcrLimits);

export const OCR_EXTENSIONS: readonly string[] = [".pdf", ".png", ".jpg", ".jpeg", ".heic", ".heif", ".tif", ".tiff", ".webp", ".bmp"];

export const UNLIMITED = { python: ".venv/bin/python", script: ".claude/skills/unlimited-ocr/scripts/ocr.py", model: "models/unlimited_ocr_official" } as const;

type Read = { pages: OcrPage[]; totalPages: number | null };

type Engine = { prepare(): Promise<void>; run(file: string, maxPages: number, timeoutMs: number): Promise<Read> };

const VISION_SOURCE = fileURLToPath(new URL("./vision.swift", import.meta.url));
/** Outside every state dir, so a host in a temporary state dir (tests, just module try) reuses the build instead of compiling again. */
const VISION_BUILD_DIR = join(homedir(), "Library", "Caches", "pi-super-agent", "ocr");
/** The first build on a machine also builds Swift's module cache: 55 s on the old Mac. */
const COMPILE_MS = 300_000;

/** Kills the whole process group at the limit, so a stuck model leaves no children. */
function run(command: string, args: readonly string[], timeoutMs: number, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<string> {
	return new Promise((done, fail) => {
		const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let late = false;
		const timer = setTimeout(() => {
			late = true;
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {}
		}, timeoutMs);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
		child.on("error", (error) => {
			clearTimeout(timer);
			fail(new Error(`OCR 引擎起不来：${error.message}`));
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			if (late) return fail(new Error(`OCR ${timeoutMs / 1000} 秒内没读完，停下了`));
			if (status !== 0) return fail(new Error(`OCR 引擎出错（退出码 ${status}）：${stderr.trim().split("\n").slice(-2).join(" ")}`));
			done(stdout);
		});
	});
}

function visionEngine(): Engine {
	const binary = join(VISION_BUILD_DIR, `vision-${createHash("sha256").update(readFileSync(VISION_SOURCE)).digest("hex").slice(0, 12)}`);
	let built: Promise<void> | undefined;
	const build = async () => {
		if (existsSync(binary)) return;
		mkdirSync(VISION_BUILD_DIR, { recursive: true });
		const partial = `${binary}.${process.pid}.partial`;
		await run("swiftc", ["-O", "-o", partial, VISION_SOURCE], COMPILE_MS).catch((error: Error) => {
			throw new Error(`准备 Vision 的 OCR 程序失败（要有 Xcode 命令行工具里的 swiftc）：${error.message}`);
		});
		renameSync(partial, binary);
	};
	const prepare = () =>
		(built ??= build().catch((error) => {
			built = undefined;
			throw error;
		}));
	return {
		prepare,
		async run(file, maxPages, timeoutMs) {
			await prepare();
			const reply = JSON.parse((await run(binary, [file, String(maxPages)], timeoutMs)).trim().split("\n").at(-1) || "{}");
			if (reply.error === "encrypted") throw new Error("PDF 有密码，读不了");
			if (reply.error === "unreadable") throw new Error("文件打不开，可能坏了，或者不是它扩展名说的格式");
			if (reply.error !== undefined) throw new Error(`Vision 出错：${reply.error}`);
			return { pages: reply.pages, totalPages: reply.totalPages };
		},
	};
}

/** ocr.py writes `pages/page_NNNN/result.md` per page; "Free OCR." asks for plain text instead of layout markdown. */
function unlimitedEngine(home: string): Engine {
	return {
		prepare: async () => {},
		async run(file, maxPages, timeoutMs) {
			const out = mkdtempSync(join(tmpdir(), "psa-unlimited-"));
			try {
				const pdf = extname(file).toLowerCase() === ".pdf";
				const args = [join(home, UNLIMITED.script), file, "--no-crop", "--prompt", "Free OCR.", "--model-dir", join(home, UNLIMITED.model), "--out-root", out, "--out", "doc", ...(pdf ? ["--pages", `1-${maxPages}`] : [])];
				const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", UNLIMITED_OCR_HOME: home };
				await run(join(home, UNLIMITED.python), args, timeoutMs, { env, cwd: home });
				const dir = join(out, "doc", "pages");
				const pages = (existsSync(dir) ? readdirSync(dir) : [])
					.filter((name) => /^page_\d+$/.test(name))
					.sort()
					.map((name) => ({ page: Number(name.slice(5)), text: readFileSync(join(dir, name, "result.md"), "utf8").trim(), confidence: null }));
				// ocr.py does not say how many pages a PDF has, so a PDF that filled the page cap may have more.
				return { pages, totalPages: pdf && pages.length >= maxPages ? null : pages.length };
			} finally {
				rmSync(out, { recursive: true, force: true });
			}
		},
	};
}

export function createOcr(config: OcrConfig): Ocr {
	if (config.engine === "off") {
		return {
			prepare: async () => {},
			read: async () => {
				throw new Error(OCR_OFF);
			},
		};
	}
	const engine = config.engine === "vision" ? visionEngine() : unlimitedEngine(config.home);
	return {
		prepare: () => engine.prepare(),
		async read(file) {
			if (!OCR_EXTENSIONS.includes(extname(file).toLowerCase())) throw new Error(`OCR 只读 PDF 和图片（${OCR_EXTENSIONS.join("、")}）`);
			const started = performance.now();
			const { pages, totalPages } = await engine.run(file, config.maxPages, config.timeoutSeconds * 1000);
			const seconds = Math.round(performance.now() - started) / 1000;
			const truncated = totalPages === null || totalPages > pages.length;
			const notes = [
				...(truncated ? [`只读了前 ${pages.length} 页，${totalPages === null ? "后面可能还有" : `共 ${totalPages} 页`}`] : []),
				...(pages.every((p) => p.text.trim() === "") ? ["没认出文字"] : []),
			];
			return { engine: config.engine, pages, totalPages, truncated, seconds, notes };
		},
	};
}
