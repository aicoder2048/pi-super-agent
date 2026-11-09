import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { TriggerSubmission } from "../kernel/types.ts";

export interface GenericDrop {
	source?: string;
	id?: string;
	thread: string;
	threadTitle?: string;
	sender?: string;
	body: string;
	occurredAt?: string | number;
}

export function threadId(source: string, thread: string): string {
	return `thr_${source}:${thread}`;
}

function optionalString(d: Record<string, unknown>, field: keyof GenericDrop): string | undefined {
	const value = d[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${field} 必须是字符串，实际是 ${JSON.stringify(value)}`);
	return value;
}

export function parseDrop(fallbackId: string, text: string, now: number): TriggerSubmission {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(`不是合法的 JSON：${(error as Error).message}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("内容必须是 JSON 对象");
	const d = raw as Record<string, unknown>;
	const thread = optionalString(d, "thread");
	const body = optionalString(d, "body");
	if (!thread?.trim()) throw new Error("缺少 thread（线程标识）");
	if (!body?.trim()) throw new Error("缺少 body（正文）");
	const source = optionalString(d, "source")?.trim() || "generic";
	if (source === "conversation") throw new Error("通用来源不能冒充对话");
	const id = optionalString(d, "id");
	const threadTitle = optionalString(d, "threadTitle");
	const sender = optionalString(d, "sender");
	if (d.occurredAt !== undefined && typeof d.occurredAt !== "string" && typeof d.occurredAt !== "number") {
		throw new Error(`occurredAt 必须是字符串或数字，实际是 ${JSON.stringify(d.occurredAt)}`);
	}
	const occurredAt = d.occurredAt === undefined ? now : new Date(d.occurredAt).getTime();
	if (Number.isNaN(occurredAt)) throw new Error(`occurredAt 无法解析：${String(d.occurredAt)}`);
	return {
		source,
		externalId: id || fallbackId,
		threads: [{ id: threadId(source, thread), title: threadTitle }],
		sender: sender || source,
		body,
		occurredAt,
	};
}

function fileExternalId(file: string, mtimeMs: number, text: string): string {
	return `${file}@${mtimeMs}#${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

function freeName(dir: string, file: string): string {
	const stem = file.replace(/\.json$/, "");
	let name = file;
	for (let n = 1; existsSync(join(dir, name)); n++) name = `${stem}.${n}.json`;
	return join(dir, name);
}

export interface GenericSourceOptions {
	inboxDir: string;
	submit(trigger: TriggerSubmission): void;
	now(): number;
	log(line: string): void;
	pollMs?: number;
	settleMs?: number;
}

export class GenericSource {
	readonly #o: GenericSourceOptions;
	readonly #settleMs: number;
	#watcher: FSWatcher | undefined;
	#poll: NodeJS.Timeout | undefined;
	#retry: NodeJS.Timeout | undefined;
	#scanning = false;
	#rescan = false;

	constructor(options: GenericSourceOptions) {
		this.#o = options;
		this.#settleMs = options.settleMs ?? 1000;
		for (const sub of ["", "processed", "rejected"]) mkdirSync(join(options.inboxDir, sub), { recursive: true });
	}

	// fs.watch can delay or drop events under load on macOS, so a slow poll backs it up.
	start(): void {
		this.#poll = setInterval(() => this.scan(), this.#o.pollMs ?? 10_000);
		this.#poll.unref();
		this.scan();
		this.#watcher = watch(this.#o.inboxDir, () => this.scan());
	}

	stop(): void {
		this.#watcher?.close();
		clearInterval(this.#poll);
		clearTimeout(this.#retry);
		this.#poll = undefined;
		this.#retry = undefined;
	}

	scan(): void {
		if (this.#scanning) {
			this.#rescan = true;
			return;
		}
		this.#scanning = true;
		try {
			do {
				this.#rescan = false;
				const files = readdirSync(this.#o.inboxDir).filter((f) => f.endsWith(".json")).sort();
				for (const file of files) {
					try {
						this.#take(file);
					} catch (error) {
						this.#o.log(`[generic] 处理 ${file} 出错，下次扫描重试：${String(error)}`);
					}
				}
			} while (this.#rescan);
		} finally {
			this.#scanning = false;
		}
	}

	#take(file: string): void {
		const path = join(this.#o.inboxDir, file);
		if (!existsSync(path)) return;
		const { mtimeMs } = statSync(path);
		const text = readFileSync(path, "utf8");
		let trigger: TriggerSubmission;
		try {
			trigger = parseDrop(fileExternalId(file, mtimeMs, text), text, this.#o.now());
		} catch (error) {
			if (Date.now() - mtimeMs < this.#settleMs) return this.#retryLater();
			return this.#reject(path, file, (error as Error).message);
		}
		try {
			this.#o.submit(trigger);
		} catch (error) {
			this.#o.log(`[generic] 提交 ${file} 失败，留在投递目录，下次扫描重试：${(error as Error).message}`);
			return;
		}
		renameSync(path, freeName(join(this.#o.inboxDir, "processed"), file));
	}

	#reject(path: string, file: string, reason: string): void {
		const target = freeName(join(this.#o.inboxDir, "rejected"), file);
		renameSync(path, target);
		writeFileSync(`${target}.error.txt`, reason + "\n");
		this.#o.log(`[generic] 拒收 ${file}：${reason}`);
	}

	#retryLater(): void {
		if (!this.#poll || this.#retry) return;
		this.#retry = setTimeout(() => {
			this.#retry = undefined;
			this.scan();
		}, this.#settleMs);
		this.#retry.unref();
	}
}

export function dropTrigger(inboxDir: string, drop: GenericDrop): string {
	mkdirSync(inboxDir, { recursive: true });
	const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
	const tmp = join(inboxDir, `.${name}.tmp`);
	writeFileSync(tmp, JSON.stringify(drop));
	renameSync(tmp, join(inboxDir, name));
	return name;
}
